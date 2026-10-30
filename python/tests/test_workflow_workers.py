import sqlite3
import sys
from pathlib import Path

import pytest

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from workflow_store import WorkflowStoreError, create_run, update_run, upsert_step
from workflow_workers import claim_step, finish_step, heartbeat_step, verify_audit_chain


def _pending_step(db):
    create_run("run-worker", "Execute a worker task", path=db)
    update_run("run-worker", status="planning", path=db)
    update_run("run-worker", status="executing", path=db)
    upsert_step("run-worker", "compile", 1, "pending",
                input_data={"task": "compile"}, path=db)


def test_lease_is_exclusive_fenced_and_audited(tmp_path):
    db = tmp_path / "worker.db"
    _pending_step(db)
    lease = claim_step("run-worker", "compile", "worker-a", 30, db)
    assert lease["attempt"] == 1
    assert lease["generation"] == 1
    assert lease["input"] == {"task": "compile"}

    with pytest.raises(WorkflowStoreError) as busy:
        claim_step("run-worker", "compile", "worker-b", 30, db)
    assert busy.value.code == "lease_held"

    with pytest.raises(WorkflowStoreError) as wrong:
        heartbeat_step("run-worker", "compile", "worker-a", "not-the-token", path=db)
    assert wrong.value.code == "invalid_lease"

    renewed = heartbeat_step(
        "run-worker", "compile", "worker-a", lease["lease_token"], 45, db
    )
    assert renewed["lease_expires_at"] > lease["lease_expires_at"]

    result = finish_step(
        "run-worker", "compile", "worker-a", lease["lease_token"],
        output={"exit_code": 0}, path=db,
    )
    assert result["status"] == "completed"
    assert verify_audit_chain("run-worker", db)["valid"] is True
    with pytest.raises(WorkflowStoreError) as replay:
        finish_step("run-worker", "compile", "worker-a", lease["lease_token"], path=db)
    assert replay.value.code == "invalid_lease"


def test_expired_running_lease_is_not_automatically_replayed(tmp_path):
    db = tmp_path / "expired.db"
    _pending_step(db)
    lease = claim_step("run-worker", "compile", "worker-a", 30, db)
    conn = sqlite3.connect(db)
    try:
        conn.execute(
            "UPDATE workflow_worker_leases SET lease_expires_at=? WHERE run_id=? AND step_key=?",
            ("2000-01-01T00:00:00+00:00", "run-worker", "compile"),
        )
        conn.commit()
    finally:
        conn.close()

    with pytest.raises(WorkflowStoreError) as expired:
        heartbeat_step("run-worker", "compile", "worker-a", lease["lease_token"], path=db)
    assert expired.value.code == "lease_expired"

    with pytest.raises(WorkflowStoreError) as review:
        claim_step("run-worker", "compile", "worker-b", 30, db)
    assert review.value.code == "step_requires_review"


def test_audit_chain_detects_modified_event_payload(tmp_path):
    db = tmp_path / "audit.db"
    _pending_step(db)
    claim_step("run-worker", "compile", "worker-a", 30, db)
    assert verify_audit_chain("run-worker", db)["valid"] is True

    conn = sqlite3.connect(db)
    try:
        # Simulate a privileged host administrator deliberately bypassing the
        # append-only trigger; the hash chain must still detect the alteration.
        conn.execute("DROP TRIGGER workflow_audit_no_update")
        conn.execute(
            "UPDATE workflow_audit_events SET event_data_json='{}' WHERE run_id=?",
            ("run-worker",),
        )
        conn.commit()
    finally:
        conn.close()

    report = verify_audit_chain("run-worker", db)
    assert report["valid"] is False
    assert report["failed_audit_id"] == 1


def test_worker_cannot_claim_unexecuting_run(tmp_path):
    db = tmp_path / "status.db"
    create_run("run-worker", "Not yet executing", path=db)
    upsert_step("run-worker", "compile", 1, "pending", path=db)
    with pytest.raises(WorkflowStoreError) as exc:
        claim_step("run-worker", "compile", "worker-a", path=db)
    assert exc.value.code == "run_not_executing"
