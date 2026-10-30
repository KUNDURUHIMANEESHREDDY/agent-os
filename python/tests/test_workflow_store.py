import sys
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

import pytest
from workflow_store import (
    WorkflowStoreError,
    create_run,
    dead_letter,
    get_run,
    list_dead_letters,
    list_steps,
    redrive_dead_letter,
    update_run,
    upsert_step,
)


def test_idempotency_key_returns_original_run_and_rejects_payload_reuse(tmp_path):
    db = tmp_path / "workflows.db"
    run, created = create_run("run-a", "Build the API", "auto", "request-1", db)
    duplicate, duplicate_created = create_run("run-b", "Build the API", "auto", "request-1", db)
    assert created is True
    assert duplicate_created is False
    assert duplicate["run_id"] == run["run_id"]
    assert duplicate["status"] == "queued"

    with pytest.raises(WorkflowStoreError) as exc:
        create_run("run-c", "Delete the database", "auto", "request-1", db)
    assert exc.value.code == "idempotency_conflict"
    assert exc.value.status_code == 409


def test_checkpoint_and_optimistic_version_are_durable(tmp_path):
    db = tmp_path / "workflows.db"
    create_run("run-a", "Build the API", "opencode/free-model", path=db)
    planning = update_run(
        "run-a",
        status="planning",
        checkpoint={"phase": "planning", "plan": ["inspect", "implement"]},
        expected_version=0,
        path=db,
    )
    assert planning["version"] == 1
    reloaded = get_run("run-a", path=db)
    assert reloaded["checkpoint"]["plan"] == ["inspect", "implement"]

    with pytest.raises(WorkflowStoreError) as exc:
        update_run("run-a", status="executing", expected_version=0, path=db)
    assert exc.value.code == "version_conflict"
    executing = update_run("run-a", status="executing", expected_version=1, path=db)
    assert executing["status"] == "executing"

    with pytest.raises(WorkflowStoreError) as invalid:
        update_run("run-a", status="verified", path=db)
    assert invalid.value.code == "verification_required"
    assert invalid.value.status_code == 403


def test_steps_are_idempotent_versioned_and_retryable(tmp_path):
    db = tmp_path / "workflows.db"
    create_run("run-a", "Inspect and test", path=db)
    update_run("run-a", status="planning", path=db)
    first = upsert_step("run-a", "inspect", 1, "running", input_data={"path": "src"}, path=db)
    assert first["attempt"] == 1
    failed = upsert_step("run-a", "inspect", 1, "failed", error_code="timeout", path=db)
    assert failed["version"] == 1
    retry = upsert_step("run-a", "inspect", 1, "running", path=db)
    assert retry["attempt"] == 2
    completed = upsert_step("run-a", "inspect", 1, "completed", output_data={"files": 4}, path=db)
    assert completed["status"] == "completed"
    assert completed["output"] == {"files": 4}
    assert len(list_steps("run-a", path=db)) == 1


def test_dead_letter_redrive_is_single_use_and_increments_attempt(tmp_path):
    db = tmp_path / "workflows.db"
    create_run("run-a", "Run an isolated task", path=db)
    update_run("run-a", status="planning", path=db)
    update_run("run-a", status="executing", path=db)
    record = dead_letter("run-a", "retry_exhausted", {"step": "execute"}, "execute", 3, db)
    assert record["attempts"] == 3
    assert get_run("run-a", path=db)["status"] == "dead_letter"
    assert len(list_dead_letters(path=db)) == 1

    redriven = redrive_dead_letter(record["dead_letter_id"], path=db)
    assert redriven["status"] == "queued"
    assert redriven["attempt"] == 2
    with pytest.raises(WorkflowStoreError) as exc:
        redrive_dead_letter(record["dead_letter_id"], path=db)
    assert exc.value.code == "already_redriven"


def test_completed_runs_cannot_be_silently_reopened(tmp_path):
    db = tmp_path / "workflows.db"
    create_run("run-a", "Answer a question", path=db)
    update_run("run-a", status="planning", path=db)
    update_run("run-a", status="completed_unverified", result={"answer": "42"}, path=db)
    with pytest.raises(WorkflowStoreError) as verify:
        update_run("run-a", status="verified", path=db)
    assert verify.value.code == "verification_required"

    with pytest.raises(WorkflowStoreError) as exc:
        update_run("run-a", status="executing", path=db)
    assert exc.value.code == "invalid_transition"