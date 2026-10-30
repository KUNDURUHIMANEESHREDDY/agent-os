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


def _port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _call(base, path, method="GET", token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        return error.code, json.loads(raw) if raw else {}


def test_worker_api_uses_separate_identity_and_fenced_leases(tmp_path):
    port = _port()
    admin, operator, worker = "test-admin", "test-operator", "test-worker"
    env = dict(
        os.environ,
        AGENT_OS_TOKEN=admin,
        AGENT_OS_WORKER_TOKEN=worker,
        AGENT_OS_TOKENS=f"{operator}:operator",
        MEMORY_PORT=str(port),
        AGENT_OS_DB=str(tmp_path / "service.db"),
        RATE_LIMIT_RPM="1000",
    )
    process = subprocess.Popen(
        [sys.executable, str(PYTHON_DIR / "memory_service.py")],
        cwd=str(REPO_ROOT), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 10
        while time.time() < deadline:
            if process.poll() is not None:
                raise AssertionError(f"memory service exited early: {process.returncode}")
            try:
                if _call(base, "/health")[0] == 200:
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("memory service did not become ready")

        code, _ = _call(base, "/v1/workflows", "POST", admin,
                        {"run_id": "worker-http-run", "goal": "Run a leased step"})
        assert code == 201
        for status in ("planning", "executing"):
            code, _ = _call(base, "/v1/workflows/worker-http-run", "PATCH", admin,
                            {"status": status})
            assert code == 200
        code, _ = _call(base, "/v1/workflows/worker-http-run/steps", "POST", admin,
                        {"step_key": "compile", "ordinal": 1, "status": "pending",
                         "input": {"task": "compile"}})
        assert code == 200

        payload = {"run_id": "worker-http-run", "step_key": "compile",
                   "worker_id": "build-worker", "lease_seconds": 30}
        assert _call(base, "/v1/workers/claim", "POST", operator, payload)[0] == 403
        assert _call(base, "/v1/workflows", "POST", worker,
                     {"run_id": "blocked", "goal": "not allowed"})[0] == 403
        assert _call(base, "/v1/logs", token=worker)[0] == 403
        assert _call(base, "/v1/workflows", token=worker)[0] == 403

        code, claimed = _call(base, "/v1/workers/claim", "POST", worker, payload)
        assert code == 201, claimed
        lease = claimed["lease"]
        code, _ = _call(base, "/v1/workers/heartbeat", "POST", worker,
                        {**payload, "lease_token": lease["lease_token"]})
        assert code == 200
        code, completed = _call(base, "/v1/workers/complete", "POST", worker,
                                {**payload, "lease_token": lease["lease_token"],
                                 "output": {"exit_code": 0}})
        assert code == 200 and completed["step"]["status"] == "completed"

        code, audit = _call(base, "/v1/workflows/worker-http-run/audit/verify", token=admin)
        assert code == 200 and audit["audit"]["valid"] is True
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
