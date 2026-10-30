import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PYTHON_DIR.parent


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _request(base, path, method="GET", token=None, payload=None, extra_headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    headers.update(extra_headers or {})
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        return error.code, json.loads(raw) if raw else {}


def test_memory_service_exposes_authenticated_workflow_api(tmp_path):
    port = _free_port()
    admin_token = "workflow-service-test-admin"
    viewer_token = "workflow-service-test-viewer"
    env = dict(
        os.environ,
        AGENT_OS_TOKEN=admin_token,
        AGENT_OS_TOKENS=f"{viewer_token}:viewer",
        MEMORY_PORT=str(port),
        AGENT_OS_DB=str(tmp_path / "service.db"),
        RATE_LIMIT_RPM="1000",
    )
    process = subprocess.Popen(
        [sys.executable, str(PYTHON_DIR / "memory_service.py")],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 10
        ready = False
        while time.time() < deadline:
            if process.poll() is not None:
                raise AssertionError(f"memory service exited early: {process.returncode}")
            try:
                code, _ = _request(base, "/health")
                if code == 200:
                    ready = True
                    break
            except OSError:
                time.sleep(0.05)
        assert ready, "memory service did not become ready"

        code, created = _request(
            base, "/v1/workflows", "POST", admin_token,
            {"run_id": "run-http-1", "goal": "Build and test", "model": "auto"},
            {"Idempotency-Key": "http-idem-1"},
        )
        assert code == 201 and created["created"] is True
        code, duplicate = _request(
            base, "/v1/workflows", "POST", admin_token,
            {"run_id": "ignored-second-id", "goal": "Build and test", "model": "auto"},
            {"Idempotency-Key": "http-idem-1"},
        )
        assert code == 200 and duplicate["run"]["run_id"] == "run-http-1"

        code, run = _request(
            base, "/v1/workflows/run-http-1", "PATCH", admin_token,
            {"status": "planning", "checkpoint": {"phase": "planning"}, "expected_version": 0},
        )
        assert code == 200 and run["run"]["version"] == 1

        # Regular operator tokens cannot mark an unverified run as verified.
        code, denied_verification = _request(
            base, "/v1/workflows/run-http-1", "PATCH", admin_token,
            {"status": "verified", "expected_version": 1},
        )
        assert code == 403 and denied_verification["code"] == "verification_required"

        code, step = _request(
            base, "/v1/workflows/run-http-1/steps", "POST", admin_token,
            {"step_key": "planner", "ordinal": 1, "status": "running", "input": {"goal_hash": "abc"}},
        )
        assert code == 200 and step["step"]["status"] == "running"

        code, read = _request(base, "/v1/workflows/run-http-1", token=viewer_token)
        assert code == 200 and read["run"]["checkpoint"]["phase"] == "planning"
        code, steps = _request(base, "/v1/workflows/run-http-1/steps", token=viewer_token)
        assert code == 200 and len(steps["steps"]) == 1
        code, forbidden = _request(base, "/v1/dead-letters", token=viewer_token)
        assert code == 403

        code, run = _request(
            base, "/v1/workflows/run-http-1", "PATCH", admin_token,
            {"status": "executing", "expected_version": 1},
        )
        assert code == 200
        code, letter = _request(
            base, "/v1/workflows/run-http-1/steps", "POST", admin_token,
            {"step_key": "worker", "ordinal": 2, "status": "running"},
        )
        assert code == 200

        # Dead-letter records are administrator-only and can be redriven once.
        from sys import path as import_path
        if str(PYTHON_DIR) not in import_path:
            import_path.insert(0, str(PYTHON_DIR))
        from workflow_store import dead_letter
        record = dead_letter("run-http-1", "retry_exhausted", {"stage": "worker"}, "worker", 3,
                             path=tmp_path / "service.db")
        code, letters = _request(base, "/v1/dead-letters", token=admin_token)
        assert code == 200 and letters["dead_letters"][0]["dead_letter_id"] == record["dead_letter_id"]
        code, redriven = _request(
            base, f"/v1/dead-letters/{record['dead_letter_id']}/redrive", "POST", admin_token, {}
        )
        assert code == 200 and redriven["run"]["status"] == "queued"
        code, replay = _request(
            base, f"/v1/dead-letters/{record['dead_letter_id']}/redrive", "POST", admin_token, {}
        )
        assert code == 409 and replay["code"] == "already_redriven"
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)