"""agent-os memory service — owns agent-os/.data/agent-os.db over HTTP.

Why a sidecar: saber/server.js is zero-dep Node (no sqlite driver), so it
talks to this stdlib-only python service. Loom (python) can use
memory_store.py directly AND read rows written here — same SQLite file.

Endpoints (port 20130, MEMORY_PORT override):
  GET  /health
  GET  /v1/logs?limit=300   -> {logs: [...]}
  POST /v1/logs {dir,source,target,type,payload?,runId?,model?} -> {ok, id}
  DELETE /v1/logs           -> {ok}
  GET  /v1/export           -> {logs, seq} (store.json-compatible snapshot)
"""
from __future__ import annotations
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent))
from memory_store import log_event, get_logs, clear_logs, export_json  # noqa: E402


def _load_env_file():
    """Load agent-os/.env (gitignored) so the token works without shell exports."""
    try:
        f = Path(__file__).resolve().parents[1] / ".env"
        if not f.exists():
            return
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and os.getenv(k) is None:
                os.environ[k] = v
    except OSError:
        pass


_load_env_file()
PORT = int(os.getenv("MEMORY_PORT", "20130"))
# Fail closed: no token, no server. Generate with python agent-os/python/make_token.py
AUTH_TOKEN = os.getenv("AGENT_OS_TOKEN", "")
if not AUTH_TOKEN:
    raise SystemExit("FATAL: AGENT_OS_TOKEN is not set. Run: python agent-os/python/make_token.py")


class Handler(BaseHTTPRequestHandler):
    server_version = "agent-os-memory/1"

    def _send(self, code: int, obj: dict):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, OSError):
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def _authed(self) -> bool:
        # /health stays open for probes (leaks nothing); everything else needs the token
        if urlparse(self.path).path == "/health":
            return True
        return (self.headers.get("Authorization") or "") == f"Bearer {AUTH_TOKEN}"

    def do_GET(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized: Bearer AGENT_OS_TOKEN required"})
        u = urlparse(self.path)
        if u.path == "/health":
            return self._send(200, {"ok": True, "service": "agent-os-memory"})
        if u.path == "/v1/logs":
            limit = int((parse_qs(u.query).get("limit") or ["300"])[0] or 300)
            try:
                return self._send(200, {"logs": get_logs(limit=limit)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
        if u.path == "/v1/export":
            try:
                return self._send(200, export_json())
            except Exception as e:
                return self._send(500, {"error": str(e)})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized: Bearer AGENT_OS_TOKEN required"})
        if urlparse(self.path).path != "/v1/logs":
            return self._send(404, {"error": "not found"})
        b = self._body()
        if not b.get("dir") or not b.get("source") or not b.get("target") or not b.get("type"):
            return self._send(400, {"error": "dir, source, target, type required"})
        try:
            i = log_event(b)
            return self._send(201, {"ok": True, "id": i})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def do_DELETE(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized: Bearer AGENT_OS_TOKEN required"})
        if urlparse(self.path).path != "/v1/logs":
            return self._send(404, {"error": "not found"})
        try:
            clear_logs()
            return self._send(200, {"ok": True})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"agent-os memory-service on http://localhost:{PORT}", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
