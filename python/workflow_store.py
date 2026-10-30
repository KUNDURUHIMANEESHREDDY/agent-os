"""Durable workflow state backed by the shared agent-os SQLite database.

The workflow store is deliberately separate from conversational memory APIs but
uses the same SQLite file and WAL connection settings. It provides idempotent
run creation, optimistic state transitions, step checkpoints, and dead-letter
redrive primitives. No external service or non-stdlib dependency is required.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any

from memory_store import connect, now_iso

RUN_STATUSES = {
    "queued", "awaiting_approval", "planning", "executing", "verifying",
    "completed_unverified", "verified", "needs_review", "failed",
    "cancelled", "dead_letter",
}
TERMINAL_STATUSES = {"verified", "completed_unverified", "failed", "cancelled", "dead_letter"}

RUN_TRANSITIONS = {
    "queued": {"awaiting_approval", "planning", "failed", "cancelled", "needs_review"},
    "awaiting_approval": {"planning", "cancelled", "failed", "needs_review"},
    "planning": {"executing", "verifying", "completed_unverified", "failed", "needs_review", "dead_letter"},
    "executing": {"planning", "verifying", "completed_unverified", "failed", "needs_review", "dead_letter"},
    "verifying": {"verified", "completed_unverified", "failed", "needs_review", "dead_letter"},
    "completed_unverified": {"verifying", "verified", "needs_review"},
    "verified": set(),
    "needs_review": {"queued", "planning", "executing", "verifying", "cancelled", "failed"},
    "failed": {"queued", "needs_review"},
    "cancelled": set(),
    "dead_letter": {"queued", "needs_review"},
}

STEP_STATUSES = {"pending", "running", "completed", "failed", "needs_review"}
STEP_TRANSITIONS = {
    "pending": {"running", "failed", "cancelled"},
    "running": {"completed", "failed", "needs_review"},
    "failed": {"running", "needs_review"},
    "needs_review": {"running", "failed"},
    "completed": set(),
}

WORKFLOW_SCHEMA = """
CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    request_hash TEXT NOT NULL,
    goal TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    checkpoint_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    error_code TEXT,
    error_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_updated
    ON workflow_runs(status, updated_at DESC);
CREATE TABLE IF NOT EXISTS workflow_steps (
    step_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    input_json TEXT,
    output_json TEXT,
    error_code TEXT,
    error_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    UNIQUE(run_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_ordinal
    ON workflow_steps(run_id, ordinal);
CREATE TABLE IF NOT EXISTS workflow_dead_letters (
    dead_letter_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
    step_key TEXT NOT NULL DEFAULT '',
    error_code TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    redriven_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_dead_letters_run
    ON workflow_dead_letters(run_id, created_at DESC);
"""


class WorkflowStoreError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _db(path=None) -> sqlite3.Connection:
    conn = connect(path)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(WORKFLOW_SCHEMA)
    return conn


def _json(value: Any) -> str:
    try:
        return json.dumps(value if value is not None else {}, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise WorkflowStoreError("invalid_json", "Workflow state must be JSON serializable.") from exc


def _decode(value: str | None, default=None):
    if value is None:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _run_dict(row) -> dict | None:
    if row is None:
        return None
    keys = [
        "run_id", "idempotency_key", "goal", "model", "status", "attempt",
        "checkpoint_json", "result_json", "error_code", "error_summary",
        "created_at", "updated_at", "started_at", "finished_at", "version",
    ]
    item = dict(zip(keys, row))
    item["checkpoint"] = _decode(item.pop("checkpoint_json"), {})
    item["result"] = _decode(item.pop("result_json"), None)
    return item


def _step_dict(row) -> dict:
    keys = [
        "step_id", "run_id", "step_key", "ordinal", "status", "attempt",
        "input_json", "output_json", "error_code", "error_summary",
        "created_at", "updated_at", "started_at", "finished_at", "version",
    ]
    item = dict(zip(keys, row))
    item["input"] = _decode(item.pop("input_json"), None)
    item["output"] = _decode(item.pop("output_json"), None)
    return item


def create_run(run_id: str, goal: str, model: str = "auto",
               idempotency_key: str | None = None, path=None) -> tuple[dict, bool]:
    run_id = str(run_id or "").strip()
    goal = str(goal or "").strip()
    model = str(model or "auto").strip() or "auto"
    if not run_id or len(run_id) > 128:
        raise WorkflowStoreError("invalid_run_id", "run_id must contain 1–128 characters.")
    if not goal or len(goal) > 100_000:
        raise WorkflowStoreError("invalid_goal", "goal must contain 1–100000 characters.")
    if idempotency_key is not None:
        idempotency_key = str(idempotency_key).strip()
        if not idempotency_key or len(idempotency_key) > 200:
            raise WorkflowStoreError("invalid_idempotency_key", "Idempotency-Key must contain 1–200 characters.")
    request_hash = hashlib.sha256(_json({"goal": goal, "model": model}).encode()).hexdigest()
    now = now_iso()
    conn = _db(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        if idempotency_key:
            existing = conn.execute(
                "SELECT run_id, request_hash FROM workflow_runs WHERE idempotency_key=?",
                (idempotency_key,),
            ).fetchone()
            if existing:
                if existing[1] != request_hash:
                    raise WorkflowStoreError(
                        "idempotency_conflict",
                        "This Idempotency-Key was already used for a different goal or model.",
                        409,
                    )
                row = conn.execute(
                    "SELECT run_id, idempotency_key, goal, model, status, attempt, checkpoint_json, result_json, "
                    "error_code, error_summary, created_at, updated_at, started_at, finished_at, version "
                    "FROM workflow_runs WHERE run_id=?",
                    (existing[0],),
                ).fetchone()
                conn.commit()
                return _run_dict(row), False

        conn.execute(
            "INSERT INTO workflow_runs "
            "(run_id, idempotency_key, request_hash, goal, model, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
            (run_id, idempotency_key, request_hash, goal, model, now, now),
        )
        conn.commit()
        return get_run(run_id, path=path), True
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        raise WorkflowStoreError("run_id_conflict", "run_id already exists.", 409) from exc
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_run(run_id: str, path=None) -> dict | None:
    conn = _db(path)
    try:
        row = conn.execute(
            "SELECT run_id, idempotency_key, goal, model, status, attempt, checkpoint_json, result_json, "
            "error_code, error_summary, created_at, updated_at, started_at, finished_at, version "
            "FROM workflow_runs WHERE run_id=?",
            (str(run_id),),
        ).fetchone()
        return _run_dict(row)
    finally:
        conn.close()


def list_runs(status: str | None = None, limit: int = 100, path=None) -> list[dict]:
    limit = max(1, min(int(limit), 500))
    conn = _db(path)
    try:
        query = (
            "SELECT run_id, idempotency_key, goal, model, status, attempt, checkpoint_json, result_json, "
            "error_code, error_summary, created_at, updated_at, started_at, finished_at, version "
            "FROM workflow_runs"
        )
        params = []
        if status:
            statuses = [x.strip() for x in str(status).split(",") if x.strip()]
            unknown = set(statuses) - RUN_STATUSES
            if unknown:
                raise WorkflowStoreError("invalid_status", "Unknown workflow status.")
            query += " WHERE status IN (" + ",".join("?" for _ in statuses) + ")"
            params.extend(statuses)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [_run_dict(r) for r in conn.execute(query, params).fetchall()]
    finally:
        conn.close()


def update_run(run_id: str, status: str | None = None, checkpoint: dict | None = None,
               result: dict | None = None, error_code: str | None = None,
               error_summary: str | None = None, expected_version: int | None = None,
               path=None) -> dict:
    if status is not None and status not in RUN_STATUSES:
        raise WorkflowStoreError("invalid_status", "Unknown workflow status.")
    checkpoint_json = _json(checkpoint) if checkpoint is not None else None
    result_json = _json(result) if result is not None else None
    now = now_iso()
    conn = _db(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT status, version, started_at, finished_at FROM workflow_runs WHERE run_id=?",
            (str(run_id),),
        ).fetchone()
        if row is None:
            raise WorkflowStoreError("run_not_found", "Workflow run not found.", 404)
        current, version, started_at, finished_at = row
        if expected_version is not None and int(expected_version) != version:
            raise WorkflowStoreError("version_conflict", "Workflow run changed; reload the current version.", 409)
        target = status or current
        if target != current and target not in RUN_TRANSITIONS[current]:
            raise WorkflowStoreError("invalid_transition", f"Workflow cannot transition from {current} to {target}.", 409)
        if target in {"planning", "executing", "verifying"} and not started_at:
            started_at = now
        if target in TERMINAL_STATUSES:
            finished_at = now
        elif target in {"queued", "awaiting_approval", "planning", "executing", "verifying", "needs_review"}:
            finished_at = None

        conn.execute(
            "UPDATE workflow_runs SET status=?, checkpoint_json=COALESCE(?, checkpoint_json), "
            "result_json=COALESCE(?, result_json), error_code=?, error_summary=?, "
            "started_at=?, finished_at=?, updated_at=?, version=version+1 WHERE run_id=?",
            (target, checkpoint_json, result_json, error_code,
             str(error_summary or "")[:1000] or None, started_at, finished_at, now, str(run_id)),
        )
        conn.commit()
        updated = get_run(run_id, path=path)
        return updated
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def upsert_step(run_id: str, step_key: str, ordinal: int,
                status: str = "pending", input_data: dict | None = None,
                output_data: dict | None = None, error_code: str | None = None,
                error_summary: str | None = None, path=None) -> dict:
    if status not in STEP_STATUSES:
        raise WorkflowStoreError("invalid_step_status", "Unknown workflow step status.")
    step_key = str(step_key or "").strip()
    if not step_key or len(step_key) > 200:
        raise WorkflowStoreError("invalid_step_key", "step_key must contain 1–200 characters.")
    input_json = _json(input_data) if input_data is not None else None
    output_json = _json(output_data) if output_data is not None else None
    now = now_iso()
    conn = _db(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute("SELECT 1 FROM workflow_runs WHERE run_id=?", (str(run_id),)).fetchone():
            raise WorkflowStoreError("run_not_found", "Workflow run not found.", 404)
        row = conn.execute(
            "SELECT step_id, status, attempt, version, created_at, started_at, finished_at "
            "FROM workflow_steps WHERE run_id=? AND step_key=?",
            (str(run_id), step_key),
        ).fetchone()
        if row is None:
            import uuid
            step_id = "s-" + uuid.uuid4().hex
            started_at = now if status == "running" else None
            finished_at = now if status in {"completed", "failed"} else None
            conn.execute(
                "INSERT INTO workflow_steps "
                "(step_id, run_id, step_key, ordinal, status, input_json, output_json, error_code, error_summary, "
                "created_at, updated_at, started_at, finished_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (step_id, str(run_id), step_key, int(ordinal), status, input_json, output_json,
                 error_code, str(error_summary or "")[:1000] or None, now, now, started_at, finished_at),
            )
        else:
            step_id, current, attempt, version, created_at, started_at, finished_at = row
            if status != current and status not in STEP_TRANSITIONS[current]:
                raise WorkflowStoreError("invalid_step_transition", f"Step cannot transition from {current} to {status}.", 409)
            if status == "running" and current in {"failed", "needs_review"}:
                attempt += 1
                started_at = now
                finished_at = None
            if status in {"completed", "failed"}:
                finished_at = now
            conn.execute(
                "UPDATE workflow_steps SET ordinal=?, status=?, attempt=?, "
                "input_json=COALESCE(?, input_json), output_json=COALESCE(?, output_json), "
                "error_code=?, error_summary=?, started_at=?, finished_at=?, updated_at=?, version=version+1 "
                "WHERE run_id=? AND step_key=?",
                (int(ordinal), status, attempt, input_json, output_json, error_code,
                 str(error_summary or "")[:1000] or None, started_at, finished_at, now,
                 str(run_id), step_key),
            )
        conn.commit()
        return get_step(run_id, step_key, path=path)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_step(run_id: str, step_key: str, path=None) -> dict | None:
    conn = _db(path)
    try:
        row = conn.execute(
            "SELECT step_id, run_id, step_key, ordinal, status, attempt, input_json, output_json, "
            "error_code, error_summary, created_at, updated_at, started_at, finished_at, version "
            "FROM workflow_steps WHERE run_id=? AND step_key=?",
            (str(run_id), str(step_key)),
        ).fetchone()
        return _step_dict(row) if row else None
    finally:
        conn.close()


def list_steps(run_id: str, path=None) -> list[dict]:
    conn = _db(path)
    try:
        rows = conn.execute(
            "SELECT step_id, run_id, step_key, ordinal, status, attempt, input_json, output_json, "
            "error_code, error_summary, created_at, updated_at, started_at, finished_at, version "
            "FROM workflow_steps WHERE run_id=? ORDER BY ordinal, created_at",
            (str(run_id),),
        ).fetchall()
        return [_step_dict(r) for r in rows]
    finally:
        conn.close()


def dead_letter(run_id: str, error_code: str, payload: dict | None = None,
                step_key: str = "", attempts: int = 1, path=None) -> dict:
    now = now_iso()
    conn = _db(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute("SELECT 1 FROM workflow_runs WHERE run_id=?", (str(run_id),)).fetchone():
            raise WorkflowStoreError("run_not_found", "Workflow run not found.", 404)
        payload_json = _json(payload)
        cur = conn.execute(
            "INSERT INTO workflow_dead_letters (run_id, step_key, error_code, payload_json, attempts, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (str(run_id), str(step_key or "")[:200], str(error_code or "unknown")[:100],
             payload_json, max(1, int(attempts)), now),
        )
        row = conn.execute(
            "SELECT status FROM workflow_runs WHERE run_id=?", (str(run_id),)
        ).fetchone()
        if row and row[0] != "dead_letter":
            if "dead_letter" not in RUN_TRANSITIONS[row[0]]:
                raise WorkflowStoreError("invalid_transition", f"Workflow cannot enter dead_letter from {row[0]}.", 409)
            conn.execute(
                "UPDATE workflow_runs SET status='dead_letter', error_code=?, error_summary=?, "
                "finished_at=?, updated_at=?, version=version+1 WHERE run_id=?",
                (str(error_code or "unknown")[:100], str(payload or {})[:1000], now, now, str(run_id)),
            )
        conn.commit()
        return {"dead_letter_id": cur.lastrowid, "run_id": str(run_id), "step_key": step_key,
                "error_code": error_code, "attempts": max(1, int(attempts)), "created_at": now}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def list_dead_letters(limit: int = 100, path=None) -> list[dict]:
    conn = _db(path)
    try:
        rows = conn.execute(
            "SELECT dead_letter_id, run_id, step_key, error_code, payload_json, attempts, created_at, redriven_at "
            "FROM workflow_dead_letters ORDER BY dead_letter_id DESC LIMIT ?",
            (max(1, min(int(limit), 500)),),
        ).fetchall()
        result = []
        for row in rows:
            item = dict(zip(
                ["dead_letter_id", "run_id", "step_key", "error_code", "payload_json", "attempts", "created_at", "redriven_at"],
                row,
            ))
            item["payload"] = _decode(item.pop("payload_json"), {})
            result.append(item)
        return result
    finally:
        conn.close()


def redrive_dead_letter(dead_letter_id: int, path=None) -> dict:
    now = now_iso()
    conn = _db(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT run_id, redriven_at FROM workflow_dead_letters WHERE dead_letter_id=?",
            (int(dead_letter_id),),
        ).fetchone()
        if row is None:
            raise WorkflowStoreError("dead_letter_not_found", "Dead-letter record not found.", 404)
        run_id, redriven_at = row
        if redriven_at:
            raise WorkflowStoreError("already_redriven", "Dead-letter record was already redriven.", 409)
        run = conn.execute("SELECT status, attempt FROM workflow_runs WHERE run_id=?", (run_id,)).fetchone()
        if run is None or run[0] != "dead_letter":
            raise WorkflowStoreError("not_redrivable", "Workflow is not in dead_letter state.", 409)
        conn.execute(
            "UPDATE workflow_dead_letters SET redriven_at=? WHERE dead_letter_id=?",
            (now, int(dead_letter_id)),
        )
        conn.execute(
            "UPDATE workflow_runs SET status='queued', attempt=attempt+1, error_code=NULL, "
            "error_summary=NULL, finished_at=NULL, updated_at=?, version=version+1 WHERE run_id=?",
            (now, run_id),
        )
        conn.commit()
        return get_run(run_id, path=path)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()