"""Lease-fenced worker operations and tamper-evident workflow audit events.

Workers never receive supervisor/admin credentials. A lease token is returned
once at claim time; only its SHA-256 digest is stored. Expired running steps are
not replayed automatically because side-effect idempotency is not yet proven.
"""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from memory_store import now_iso
from workflow_store import WorkflowStoreError, _db

SCHEMA = """
CREATE TABLE IF NOT EXISTS workflow_worker_leases (
  run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  lease_owner TEXT,
  token_hash TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_key),
  FOREIGN KEY (run_id, step_key) REFERENCES workflow_steps(run_id, step_key)
    ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workflow_audit_events (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_data_json TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_audit_run ON workflow_audit_events(run_id, audit_id);
CREATE TRIGGER IF NOT EXISTS workflow_audit_no_update
BEFORE UPDATE ON workflow_audit_events
BEGIN SELECT RAISE(ABORT, 'workflow audit events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS workflow_audit_no_delete
BEFORE DELETE ON workflow_audit_events
BEGIN SELECT RAISE(ABORT, 'workflow audit events are append-only'); END;
"""

def _iso_after(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()

def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

def _audit(conn, run_id: str, event_type: str, actor: str, payload: dict | None = None) -> None:
    previous = conn.execute(
        "SELECT event_hash FROM workflow_audit_events WHERE run_id=? ORDER BY audit_id DESC LIMIT 1",
        (run_id,),
    ).fetchone()
    prev_hash = previous[0] if previous else "0" * 64
    created = now_iso()
    body = {"run_id": run_id, "event_type": event_type, "actor": actor,
            "payload": payload or {}, "created_at": created}
    encoded = _canonical(body)
    digest = hashlib.sha256((prev_hash + "\n" + encoded).encode("utf-8")).hexdigest()
    conn.execute(
        "INSERT INTO workflow_audit_events(run_id,event_data_json,previous_hash,event_hash,created_at) "
        "VALUES(?,?,?,?,?)", (run_id, encoded, prev_hash, digest, created)
    )

def _ready(path=None):
    conn = _db(path)
    conn.executescript(SCHEMA)
    return conn

def claim_step(run_id: str, step_key: str, worker_id: str, lease_seconds: int = 60,
               path=None) -> dict:
    run_id, step_key, worker_id = str(run_id or "").strip(), str(step_key or "").strip(), str(worker_id or "").strip()
    if not run_id or not step_key or not worker_id or len(worker_id) > 128:
        raise WorkflowStoreError("invalid_worker_claim", "run_id, step_key and a worker_id (max 128 chars) are required.")
    lease_seconds = int(lease_seconds)
    if not 5 <= lease_seconds <= 3600:
        raise WorkflowStoreError("invalid_lease_duration", "lease_seconds must be between 5 and 3600.")
    conn = _ready(path)
    token = secrets.token_urlsafe(32)
    now = now_iso()
    try:
        conn.execute("BEGIN IMMEDIATE")
        run = conn.execute("SELECT status FROM workflow_runs WHERE run_id=?", (run_id,)).fetchone()
        if not run:
            raise WorkflowStoreError("run_not_found", "Workflow run not found.", 404)
        if run[0] != "executing":
            raise WorkflowStoreError("run_not_executing", "Workers can claim steps only while the run is executing.", 409)
        step = conn.execute(
            "SELECT step_id,status,attempt,input_json FROM workflow_steps WHERE run_id=? AND step_key=?",
            (run_id, step_key),
        ).fetchone()
        if not step:
            raise WorkflowStoreError("step_not_found", "Workflow step not found.", 404)
        lease = conn.execute(
            "SELECT lease_owner,lease_expires_at,generation FROM workflow_worker_leases WHERE run_id=? AND step_key=?",
            (run_id, step_key),
        ).fetchone()
        if step[1] == "running":
            if lease and lease[1] and lease[1] > now:
                raise WorkflowStoreError("lease_held", "Another worker currently holds this step lease.", 409)
            raise WorkflowStoreError("step_requires_review", "An interrupted running step requires review; it is never replayed implicitly.", 409)
        if step[1] != "pending":
            raise WorkflowStoreError("step_not_claimable", "Only pending steps may be claimed.", 409)
        if lease and lease[1] and lease[1] > now:
            raise WorkflowStoreError("lease_held", "Another worker currently holds this step lease.", 409)
        generation = (lease[2] if lease else 0) + 1
        expires = _iso_after(lease_seconds)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        conn.execute(
            "INSERT INTO workflow_worker_leases(run_id,step_key,lease_owner,token_hash,lease_expires_at,heartbeat_at,generation) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,step_key) DO UPDATE SET "
            "lease_owner=excluded.lease_owner,token_hash=excluded.token_hash,"
            "lease_expires_at=excluded.lease_expires_at,heartbeat_at=excluded.heartbeat_at,generation=excluded.generation",
            (run_id, step_key, worker_id, token_hash, expires, now, generation),
        )
        conn.execute(
            "UPDATE workflow_steps SET status='running',started_at=?,finished_at=NULL,updated_at=?,version=version+1 "
            "WHERE run_id=? AND step_key=? AND status='pending'",
            (now, now, run_id, step_key),
        )
        _audit(conn, run_id, "worker.step.claimed", worker_id,
               {"step_key": step_key, "lease_generation": generation, "lease_seconds": lease_seconds})
        conn.commit()
        return {"run_id": run_id, "step_id": step[0], "step_key": step_key,
                "worker_id": worker_id, "lease_token": token, "lease_expires_at": expires,
                "generation": generation, "attempt": step[2],
                "input": json.loads(step[3]) if step[3] else None}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def _assert_lease(conn, run_id: str, step_key: str, worker_id: str, lease_token: str):
    row = conn.execute(
        "SELECT lease_owner,token_hash,lease_expires_at FROM workflow_worker_leases WHERE run_id=? AND step_key=?",
        (run_id, step_key),
    ).fetchone()
    expected = hashlib.sha256(str(lease_token or "").encode()).hexdigest()
    if not row or row[0] != worker_id or not secrets.compare_digest(row[1] or "", expected):
        raise WorkflowStoreError("invalid_lease", "Worker lease owner or token is invalid.", 403)
    if not row[2] or row[2] <= now_iso():
        raise WorkflowStoreError("lease_expired", "Worker lease expired; step requires review before replay.", 409)

def heartbeat_step(run_id: str, step_key: str, worker_id: str, lease_token: str,
                   lease_seconds: int = 60, path=None) -> dict:
    lease_seconds = int(lease_seconds)
    if not 5 <= lease_seconds <= 3600:
        raise WorkflowStoreError("invalid_lease_duration", "lease_seconds must be between 5 and 3600.")
    conn = _ready(path)
    now, expires = now_iso(), _iso_after(lease_seconds)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _assert_lease(conn, run_id, step_key, worker_id, lease_token)
        conn.execute(
            "UPDATE workflow_worker_leases SET heartbeat_at=?,lease_expires_at=? WHERE run_id=? AND step_key=?",
            (now, expires, run_id, step_key),
        )
        _audit(conn, run_id, "worker.step.heartbeat", worker_id, {"step_key": step_key})
        conn.commit()
        return {"run_id": run_id, "step_key": step_key, "lease_expires_at": expires}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def finish_step(run_id: str, step_key: str, worker_id: str, lease_token: str,
                *, output: dict | None = None, error_code: str | None = None,
                path=None) -> dict:
    conn = _ready(path)
    now = now_iso()
    target = "failed" if error_code else "completed"
    try:
        conn.execute("BEGIN IMMEDIATE")
        _assert_lease(conn, run_id, step_key, worker_id, lease_token)
        row = conn.execute(
            "SELECT status FROM workflow_steps WHERE run_id=? AND step_key=?", (run_id, step_key)
        ).fetchone()
        if not row or row[0] != "running":
            raise WorkflowStoreError("step_not_running", "Only a running step can be completed by its lease owner.", 409)
        conn.execute(
            "UPDATE workflow_steps SET status=?,output_json=?,error_code=?,updated_at=?,finished_at=?,version=version+1 "
            "WHERE run_id=? AND step_key=?",
            (target, _canonical(output) if output is not None else None,
             str(error_code or "")[:100] or None, now, now, run_id, step_key),
        )
        conn.execute(
            "UPDATE workflow_worker_leases SET lease_owner=NULL,token_hash=NULL,lease_expires_at=NULL "
            "WHERE run_id=? AND step_key=?", (run_id, step_key)
        )
        _audit(conn, run_id, "worker.step." + target, worker_id,
               {"step_key": step_key, "error_code": str(error_code or "")[:100] or None})
        conn.commit()
        return {"run_id": run_id, "step_key": step_key, "status": target}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def verify_audit_chain(run_id: str, path=None) -> dict:
    if not str(run_id or "").strip():
        raise WorkflowStoreError("run_id_required", "run_id is required to verify the audit chain.")
    conn = _ready(path)
    try:
        rows = conn.execute(
            "SELECT audit_id,event_data_json,previous_hash,event_hash FROM workflow_audit_events "
            "WHERE run_id=? ORDER BY audit_id", (run_id,)
        ).fetchall()
        previous = "0" * 64
        for audit_id, encoded, stored_previous, stored_hash in rows:
            expected = hashlib.sha256((previous + "\n" + encoded).encode("utf-8")).hexdigest()
            if stored_previous != previous or not secrets.compare_digest(stored_hash, expected):
                return {"valid": False, "records": len(rows), "failed_audit_id": audit_id,
                        "last_valid_hash": previous}
            previous = stored_hash
        return {"valid": True, "records": len(rows), "last_hash": previous}
    finally:
        conn.close()
