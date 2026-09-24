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
from memory_store import log_event, get_logs, clear_logs, export_json, backup_to  # noqa: E402


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
# Roles: viewer < operator < admin. AGENT_OS_TOKEN is always admin; extra
# tokens come from AGENT_OS_TOKENS="tok:role,tok:role".
ROLE_RANK = {"viewer": 1, "operator": 2, "admin": 3}
TOKENS = {}
if os.getenv("AGENT_OS_TOKEN"):
    TOKENS[os.getenv("AGENT_OS_TOKEN")] = "admin"
for _part in (os.getenv("AGENT_OS_TOKENS") or "").split(","):
    if ":" in _part:
        _tok, _, _role = _part.partition(":")
        if _tok.strip() and _role.strip() in ROLE_RANK:
            TOKENS[_tok.strip()] = _role.strip()
if not TOKENS:
    raise SystemExit("FATAL: AGENT_OS_TOKEN is not set. Run: python agent-os/python/make_token.py")
RPM = max(1, int(os.getenv("RATE_LIMIT_RPM", "120")))
_RL = {}  # key -> [window_start, count]


def _rate_limited(key):
    import time
    now = time.time()
    start, count = _RL.get(key, (0, 0))
    if now - start >= 60:
        start, count = now, 0
    count += 1
    _RL[key] = (start, count)
    if len(_RL) > 10000:
        _RL.clear()
    if count > RPM:
        return int(60 - (now - start)) + 1
    return 0


class Handler(BaseHTTPRequestHandler):
    server_version = "agent-os-memory/1"

    def _send(self, code: int, obj: dict, headers: dict | None = None):
        """Write a JSON response. A client that hangs up mid-write is normal
        (timed-out fetch, closed tab) and must never raise or produce a
        traceback. Idempotent: a second call after a response is a no-op."""
        if getattr(self, "_responded", False):
            return
        self._responded = True
        data = json.dumps(obj).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            for k, v in (headers or {}).items():
                self.send_header(k, str(v))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            self.close_connection = True  # peer vanished; nothing to recover

    def _fail(self, code: int, message: str):
        """Error response that never masks an already-sent response."""
        if getattr(self, "_responded", False):
            return
        self._send(code, {"error": message})

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
        # CORS preflight: no body, own header set, peer may vanish.
        self._responded = True
        try:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True

    def _role(self):
        # /health stays open for probes (leaks nothing); everything else needs a token
        if urlparse(self.path).path == "/health":
            return "health"
        h = self.headers.get("Authorization") or ""
        if h.startswith("Bearer "):
            return TOKENS.get(h[7:], None)
        return None

    def _gate(self, need):
        """401 unknown token, 403 insufficient role, 429 too fast. None = pass."""
        role = self._role()
        if role is None:
            return self._send(401, {"error": "unauthorized: Bearer AGENT_OS_TOKEN required"})
        if role != "health" and ROLE_RANK[role] < ROLE_RANK[need]:
            return self._send(403, {"error": f"forbidden: {need} role required"})
        if role != "health":
            key = f"tok:{role}"
            retry = _rate_limited(key)
            if retry:
                self._send(429, {"error": "rate limited, retry later"}, {"Retry-After": retry})
                return True
        return None

    def do_GET(self):
        if (r := self._gate("viewer")) is not None:
            return r
        u = urlparse(self.path)
        if u.path == "/health":
            return self._send(200, {"ok": True, "service": "agent-os-memory"})
        try:
            if u.path == "/v1/logs":
                limit = int((parse_qs(u.query).get("limit") or ["300"])[0] or 300)
                return self._send(200, {"logs": get_logs(limit=limit)})
            if u.path == "/v1/export":
                return self._send(200, export_json())
            if u.path == "/v1/backup":
                # A backup exfiltrates the whole DB: require admin explicitly.
                if ROLE_RANK.get(self._role() or "", 0) < ROLE_RANK["admin"]:
                    return self._fail(403, "forbidden: admin role required")
                dest = backup_to()
                return self._send(200, {"ok": True, "file": dest.name, "bytes": dest.stat().st_size})
        except Exception as e:
            return self._fail(500, str(e))
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if (r := self._gate("operator")) is not None:
            return r
        if urlparse(self.path).path != "/v1/logs":
            return self._send(404, {"error": "not found"})
        b = self._body()
        if not b.get("dir") or not b.get("source") or not b.get("target") or not b.get("type"):
            return self._send(400, {"error": "dir, source, target, type required"})
        try:
            i = log_event(b)
            return self._send(201, {"ok": True, "id": i})
        except Exception as e:
            return self._fail(500, str(e))

    def do_DELETE(self):
        if (r := self._gate("admin")) is not None:
            return r
        if urlparse(self.path).path != "/v1/logs":
            return self._send(404, {"error": "not found"})
        try:
            clear_logs()
            return self._send(200, {"ok": True})
        except Exception as e:
            return self._fail(500, str(e))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    # TLS opt-in like the Node servers (TLS_CERT+TLS_KEY); default plain localhost HTTP.
    _cert, _key = os.getenv("TLS_CERT", ""), os.getenv("TLS_KEY", "")
    _scheme = "http"
    class _QuietHTTPServer(HTTPServer):
        """Clients disconnecting mid-response is normal HTTP, not a server fault.
        Suppress socketserver's traceback dump for connection teardown only;
        real bugs still print."""
        def handle_error(self, request, client_address):
            exc = sys.exc_info()[1]
            if isinstance(exc, (BrokenPipeError, ConnectionResetError,
                                ConnectionAbortedError, TimeoutError)):
                return
            super().handle_error(request, client_address)

    _httpd = _QuietHTTPServer(("127.0.0.1", PORT), Handler)
    if _cert and _key:
        import ssl
        _ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        _ctx.load_cert_chain(_cert, _key)
        _httpd.socket = _ctx.wrap_socket(_httpd.socket, server_side=True)
        _scheme = "https"
    print(f"agent-os memory-service on {_scheme}://localhost:{PORT}", flush=True)

    def _on_term(*_a):
        raise KeyboardInterrupt
    import signal as _signal
    for _sig in (_signal.SIGTERM, _signal.SIGINT):
        try:
            _signal.signal(_sig, _on_term)
        except (OSError, ValueError):
            pass
    try:
        _httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _httpd.server_close()
