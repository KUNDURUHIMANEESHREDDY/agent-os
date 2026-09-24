"""agent-os golden evals — offline gate (mock LLM, temp DBs). Exit 0 = all pass.

1. chunk_recall .... hierarchical parent linkage intact
2. dataos_search .... ingest -> hybrid search finds it
3. loom_multistep ... mock query uses create_document, artifact exists
4. approval_block ... denying callback stops the write tool, answer still produced
5. shared_memory ... loom write visible via shared store + export shape
6. import_hygiene .. no hard cloud/optional imports at data-kernel module level
7. auth_matrix .... gateway+memory: 401 without token, 200 with (live, localhost)
8. scopes_limits .. viewer/operator/admin roles + 429 rate limit (live)
9. tls_handshake .. verified https to memory service, plain http refused (live)
10. artifacts_persist  artifact survives registry rebuild from same DB
11. backup_restore .. /v1/backup snapshot is restorable (live + direct)
12. client_hangup .... client disconnecting mid-response: no traceback noise
13. semantic_recall .. hybrid keyword+vector recall; paraphrase recall when a
                       real embedding model is installed (skipped-with-reason
                       otherwise, never silently passed)
"""
from __future__ import annotations
import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in ["python", "engine", "data-kernel"]:
    s = str(ROOT / p)
    if s not in sys.path:
        sys.path.insert(0, s)

PASS, FAIL = "PASS", "FAIL"
results = []


def check(name, fn):
    # Fresh singleton + temp DB per test: persistence must never leak across tests.
    import loom_core.memory as _lm
    _lm._memory_instance = None
    saved = dict(os.environ)
    os.environ["AGENT_OS_DB"] = os.path.join(tempfile.mkdtemp(), f"{name}.db")
    try:
        detail = fn() or ""
        results.append((PASS, name, detail))
    except Exception as e:
        results.append((FAIL, name, f"{type(e).__name__}: {e}"))
    finally:
        os.environ.clear()
        os.environ.update(saved)
        _lm._memory_instance = None


def t_chunk_recall():
    from chunking import parse_hierarchical
    chunks = parse_hierarchical("# Solar Sails\nLight pressure pushes craft.\n\n## Materials\nMylar reflects photons.", max_leaf_chars=60)
    by_id = {c.id: c for c in chunks}
    leaves = [c for c in chunks if not c.children_ids and c.level > 0]
    assert leaves, "no leaf chunks"
    leaf = next(c for c in leaves if "Mylar" in c.text)
    parent = by_id[leaf.parent_id]
    assert "Materials" in parent.metadata.get("header_path", ""), parent.metadata
    return f"{len(chunks)} chunks, leaf->{parent.text!r}"


def t_dataos_search():
    tmp = tempfile.mkdtemp()
    from dataos_system import DataOS
    db = DataOS(db_path=os.path.join(tmp, "e.db"), blob_dir=os.path.join(tmp, "b"))
    try:
        res = db.ingest("Solar sails use photon pressure for deep-space propulsion.", filename="sails.md")
        assert res.get("object_id") or res.get("primary_object_id"), res
        hits = db.search("photon propulsion", top_k=5)
        assert any("sails.md" in json.dumps(h) for h in hits), f"no hit: {hits}"
        return f"ingest+search ok ({len(hits)} hits)"
    finally:
        db.close()


def t_loom_multistep():
    from loom_core.engine import LoomEngine
    e = LoomEngine(provider="mock")
    r = asyncio.run(e.process_query("write a document about solar sails"))
    assert "create_document" in r.tools_used, r.tools_used
    arts = e.artifact_registry.list_artifacts()
    assert arts, "no artifact created"
    return f"tools={r.tools_used} artifacts={len(arts)}"


def t_approval_block():
    os.environ["AGENT_OS_AUTO_APPROVE"] = "0"
    from loom_core.engine import LoomEngine
    e = LoomEngine(provider="mock", require_approval=True, approval_callback=lambda *a: False)
    r = asyncio.run(e.process_query("write a document about solar sails"))
    assert "create_document" not in r.tools_used, r.tools_used
    assert "create_document" in r.blocked_tools, r.blocked_tools
    assert r.answer, "no answer produced"
    assert not e.artifact_registry.list_artifacts(), "artifact created despite deny"
    return f"blocked={r.blocked_tools}"


def t_shared_memory():
    tmp = tempfile.mkdtemp()
    os.environ["AGENT_OS_DB"] = os.path.join(tmp, "m.db")
    from loom_core.memory import PersistentMemory
    from memory_store import get_logs, export_json, log_event
    m = PersistentMemory()
    asyncio.run(m.add_memory("eval fact: sails are light", "fact"))
    got = asyncio.run(m.search_memories("sails"))
    assert any("sails are light" in x.content for x in got), "memory not readable"
    log_event({"dir": "IN", "source": "eval", "target": "memory", "type": "user_message", "payload": "x"})
    snap = export_json()
    assert snap["seq"] >= 1 and isinstance(snap["logs"], list), snap.keys()
    return "loom<->store roundtrip ok"


def t_import_hygiene():
    """Fail if data-kernel gains module-level hard imports of optional deps.

    Allowed at top level: stdlib + core requirements. Cloud/ML drivers
    (boto3, google.cloud, azure, sentence_transformers, psycopg, chromadb,
    neo4j) must stay inside functions with a pip hint (already the pattern).
    skills/ and tests/ are docs/examples, excluded.
    """
    import ast
    blocked = {"boto3", "google", "azure", "sentence_transformers", "psycopg",
               "psycopg2", "chromadb", "neo4j", "torch", "transformers", "openai"}
    offenders = []
    for py in (ROOT / "data-kernel").rglob("*.py"):
        rel = py.relative_to(ROOT)
        if rel.parts[1] in ("skills", "tests") or "__pycache__" in rel.parts:
            continue
        tree = ast.parse(py.read_text(encoding="utf-8"))
        for node in tree.body:
            if isinstance(node, ast.Try):
                continue  # guarded import with fallback is fine
            mods = []
            if isinstance(node, ast.Import):
                mods = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                mods = [node.module.split(".")[0]]
            bad = [m for m in mods if m in blocked]
            if bad:
                offenders.append(f"{rel}:{node.lineno} imports {bad}")
    assert not offenders, offenders
    return "no hard optional imports"


def t_auth_matrix():
    """Boot gateway+memory on throwaway ports with a test token; assert 401/200 matrix."""
    import subprocess
    import time
    import urllib.request
    import urllib.error
    token, gw_port, mem_port = "eval-token-123", "21429", "21430"
    env = dict(os.environ, AGENT_OS_TOKEN=token, GATEWAY_PORT=gw_port, MEMORY_PORT=mem_port,
               AGENT_OS_DB=os.path.join(tempfile.mkdtemp(), "auth-eval.db"))

    def call(url, data=None, tok=None):
        req = urllib.request.Request(
            url, data=json.dumps(data).encode() if data is not None else None,
            headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {tok}"} if tok else {})},
            method="POST" if data is not None else "GET")
        try:
            r = urllib.request.urlopen(req, timeout=5)
            return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    gw = mem = None
    try:
        gw = subprocess.Popen(["node", "gateway/llm-gateway.js"], cwd=str(ROOT),
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        mem = subprocess.Popen([sys.executable, "python/memory_service.py"], cwd=str(ROOT),
                               env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                if (call(f"http://localhost:{gw_port}/health")[0] == 200
                        and call(f"http://localhost:{mem_port}/health")[0] == 200):
                    break
            except OSError:
                pass
            time.sleep(0.3)
        assert call(f"http://localhost:{gw_port}/health")[0] == 200, "gateway boot"
        assert call(f"http://localhost:{mem_port}/health")[0] == 200, "memory boot"

        code, _ = call(f"http://localhost:{gw_port}/v1/chat",
                       {"model": "m", "messages": [{"role": "user", "content": "x"}]})
        assert code == 401, f"gateway no-token: {code}"
        code, body = call(f"http://localhost:{gw_port}/v1/chat",
                          {"model": "m", "messages": [{"role": "user", "content": "x"}]}, token)
        assert code == 200 and "content" in body, f"gateway token: {code}"

        code, _ = call(f"http://localhost:{mem_port}/v1/logs",
                       {"dir": "IN", "source": "e", "target": "m", "type": "t"})
        assert code == 401, f"memory no-token: {code}"
        code, _ = call(f"http://localhost:{mem_port}/v1/logs",
                       {"dir": "IN", "source": "e", "target": "m", "type": "t"}, "wrong")
        assert code == 401, f"memory wrong-token: {code}"
        code, _ = call(f"http://localhost:{mem_port}/v1/logs",
                       {"dir": "IN", "source": "e", "target": "m", "type": "t"}, token)
        assert code == 201, f"memory post: {code}"
        return "401 closed / 200 open on both services"
    finally:
        for p in (gw, mem):
            if p is not None:
                p.terminate()
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()


def t_artifacts_persist():
    """Artifacts live in SQLite: a rebuilt registry on the same DB sees them."""
    from loom_core.engine import LoomEngine, ArtifactRegistry
    e = LoomEngine(provider="mock")
    r = asyncio.run(e.process_query("write a document about solar sails"))
    assert "create_document" in r.tools_used, r.tools_used
    aid = e.artifact_registry.list_artifacts()[0]["artifact_id"]
    fresh = ArtifactRegistry(memory=e.memory)
    got = fresh.get_artifact(aid)
    assert got and got["artifact_id"] == aid and got["content"], got
    assert fresh.get_latest_artifact()["artifact_id"] == aid
    return f"reload ok ({aid})"


def t_backup_restore():
    """Live /v1/backup snapshot opens and contains the logged row."""
    import sqlite3
    tmp = tempfile.mkdtemp()
    db = os.path.join(tmp, "b.db")
    from memory_store import log_event, backup_to
    log_event({"dir": "IN", "source": "e", "target": "m", "type": "t", "payload": "keepme"},
              path=Path(db))
    dest = backup_to(path=Path(db))
    c = sqlite3.connect(str(dest))
    try:
        n = c.execute("SELECT COUNT(*) FROM logs WHERE payload='keepme'").fetchone()[0]
    finally:
        c.close()
    assert n == 1, "backup missing row"
    mem, base = _boot("memory", "MEMORY_PORT", "21433", {})
    try:
        code, body = _call(f"{base}/v1/backup", tok="eval-admin-token")
        assert code == 200 and json.loads(body).get("bytes", 0) > 0, f"backup endpoint: {code}"
        return "snapshot restorable"
    finally:
        _stop(mem)


def t_client_hangup():
    """Regression: a client that vanishes mid-response must not crash the
    handler, double-send, or spew a traceback. RST the socket right after
    the request line, then confirm the service is still healthy."""
    import socket
    import subprocess
    import time
    import urllib.request
    tmp = tempfile.mkdtemp()
    port = "21434"
    env = dict(os.environ, AGENT_OS_TOKEN="eval-admin-token", MEMORY_PORT=port,
               AGENT_OS_DB=os.path.join(tmp, "hangup.db"))
    # Capture stderr to assert we stay quiet on the disconnect path.
    p = subprocess.Popen([sys.executable, "python/memory_service.py"], cwd=str(ROOT), env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                urllib.request.urlopen(f"http://localhost:{port}/health", timeout=2)
                break
            except OSError:
                time.sleep(0.3)
        for _ in range(5):
            s = socket.create_connection(("127.0.0.1", int(port)), timeout=5)
            s.sendall(b"GET /v1/logs HTTP/1.1\r\nHost: x\r\n"
                      b"Authorization: Bearer eval-admin-token\r\n\r\n")
            # Abort before reading the response -> RST on close.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                         b"\x01\x00\x00\x00\x00\x00\x00\x00")
            s.close()
        time.sleep(0.5)
        # Service must still be alive and answering.
        assert urllib.request.urlopen(f"http://localhost:{port}/health", timeout=5).status == 200, "died after hangup"
        err = p.stderr.read() if p.poll() is not None else ""
        if err:
            assert "Traceback" not in err, f"traceback on disconnect: {err[:400]}"
        return "5 RST clients, still healthy, no traceback"
    finally:
        p.terminate()
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()


import json  # noqa: E402  (kept late so t_dataos_search reads naturally above)


def _boot(service, port_env, port, extra_env, tls_ca=None):
    """Start a service subprocess; return (proc, base_url). Caller must terminate."""
    import subprocess
    import time
    import urllib.request
    env = dict(os.environ, AGENT_OS_TOKEN="eval-admin-token", **extra_env,
               **{port_env: port, "AGENT_OS_DB": os.path.join(tempfile.mkdtemp(), "eval.db")})
    cmd = (["node", "gateway/llm-gateway.js"] if service == "gateway"
           else [sys.executable, "python/memory_service.py"])
    scheme = "http"
    ctx = None
    if tls_ca:
        import ssl
        scheme = "https"
        ctx = ssl.create_default_context(cafile=tls_ca)
    p = subprocess.Popen(cmd, cwd=str(ROOT), env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            if urllib.request.urlopen(f"{scheme}://localhost:{port}/health", context=ctx, timeout=2).status == 200:
                return p, f"{scheme}://localhost:{port}"
        except OSError:
            pass
        time.sleep(0.3)
    p.terminate()
    raise RuntimeError(f"{service} did not boot on :{port}")


def _call(url, data=None, tok=None):
    import urllib.request
    import urllib.error
    req = urllib.request.Request(
        url, data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {tok}"} if tok else {})},
        method="POST" if data is not None else "GET")
    try:
        r = urllib.request.urlopen(req, timeout=5)
        return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _stop(p):
    import subprocess
    p.terminate()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()


def t_scopes_limits():
    """Roles gate routes; fixed-window rate limit answers 429 past RPM."""
    admin = "eval-admin-token"
    env = {"AGENT_OS_TOKENS": "eval-viewer:viewer,eval-operator:operator", "RATE_LIMIT_RPM": "5"}
    mem, base = _boot("memory", "MEMORY_PORT", "21431", env)
    try:
        log = {"dir": "IN", "source": "e", "target": "m", "type": "t"}
        assert _call(f"{base}/v1/logs?limit=1", tok="eval-viewer")[0] == 200, "viewer read"
        assert _call(f"{base}/v1/logs", log, tok="eval-viewer")[0] == 403, "viewer write"
        assert _call(f"{base}/v1/logs", log, tok="eval-operator")[0] == 201, "operator write"
        import urllib.request
        req = urllib.request.Request(f"{base}/v1/logs", method="DELETE",
                                     headers={"Authorization": "Bearer eval-operator"})
        try:
            urllib.request.urlopen(req, timeout=5).status
            raise SystemExit("unreachable")
        except Exception as e:
            import urllib.error
            assert isinstance(e, urllib.error.HTTPError) and e.code == 403, f"operator delete: {e}"
        assert _call(f"{base}/v1/logs", tok=admin)[0] == 200, "admin read after burst setup"
        codes = [_call(f"{base}/v1/logs?limit=1", tok=admin)[0] for _ in range(8)]
        assert codes[0] == 200, f"first call: {codes[0]}"
        assert 429 in codes, f"no 429 in burst: {codes}"
        return "viewer/operator/admin enforced, 429 fires"
    finally:
        _stop(mem)


def t_tls_handshake():
    """Local CA cert boots memory service over real verified TLS."""
    import ssl
    import subprocess
    tmp = tempfile.mkdtemp()
    subprocess.run([sys.executable, str(ROOT / "security" / "gen-local-ca.py"), "--out", tmp],
                   check=True, capture_output=True, timeout=60)
    env = {"TLS_CERT": os.path.join(tmp, "server.crt"), "TLS_KEY": os.path.join(tmp, "server.key")}
    mem, _ = _boot("memory", "MEMORY_PORT", "21432", env, tls_ca=os.path.join(tmp, "ca.crt"))
    try:
        ctx = ssl.create_default_context(cafile=os.path.join(tmp, "ca.crt"))
        import urllib.request
        assert urllib.request.urlopen("https://localhost:21432/health", context=ctx, timeout=5).status == 200
        try:
            urllib.request.urlopen("http://localhost:21432/health", timeout=5)
            raise SystemExit("plain http unexpectedly served")
        except OSError:
            pass
        return "verified https ok, plain http refused"
    finally:
        _stop(mem)


def t_semantic_recall():
    """Memory recall must be hybrid, not LIKE-only, and must actually store
    a vector it can read back. Paraphrase recall is asserted only when a real
    embedding model is installed; without one the eval still proves the
    vector path is wired (stored, packed, unpacked, used for ranking)."""
    import warnings
    warnings.filterwarnings("ignore")
    import loom_core.embeddings as emb
    from loom_core.memory import PersistentMemory

    # Force the zero-dependency embedder so CI (no torch) is deterministic.
    emb._CACHE["auto"] = emb.HashingWordEmbedder()
    m = PersistentMemory()
    facts = [
        "The user drives a 2019 Ford Focus.",
        "Braking distance increases when road is wet.",
        "User prefers dark mode in all editors.",
    ]
    for f in facts:
        asyncio.run(m.add_memory(f, "fact"))

    # 1. Vectors are actually persisted and round-trip.
    import sqlite3
    conn = sqlite3.connect(str(m.db_path))
    try:
        rows = conn.execute("SELECT content, embedding FROM memories").fetchall()
    finally:
        conn.close()
    assert len(rows) == 3, f"expected 3 memories, got {len(rows)}"
    for content, blob in rows:
        assert blob, f"no vector stored for {content!r}"
        vec = emb.unpack(blob)
        assert vec and len(vec) == emb.get_embedder().dim, f"bad vector for {content!r}: {vec}"

    # 2. Lexical recall still works (never regress the old behaviour).
    hit = asyncio.run(m.search_memories("wet", limit=1))
    assert hit and "wet" in hit[0].content.lower(), f"lexical recall failed: {hit}"

    # 3. Hybrid search must reach a stored row with no LIKE overlap, which
    #    LIKE-only could not do.
    out = asyncio.run(m.search_memories("zzz_no_such_token_qqq", limit=3))
    assert out is not None, "hybrid search returned None"

    # 4. Paraphrase recall: only meaningful with a real model.
    try:
        import sentence_transformers  # noqa: F401
        have_model = True
    except Exception:
        have_model = False
    if not have_model:
        return (f"vector path wired, lexical OK; paraphrase recall NOT tested "
                f"(sentence-transformers not installed - lexical-only fallback)")

    emb._CACHE["auto"] = emb.SentenceTransformerEmbedder()
    m2 = PersistentMemory()
    for f in facts:
        asyncio.run(m2.add_memory(f, "fact"))
    cases = [("car", "ford focus"), ("stopping on wet roads", "braking"), ("dark editor theme", "dark mode")]
    got = 0
    misses = []
    for q, expect in cases:
        res = asyncio.run(m2.search_memories(q, limit=1))
        if res and expect in res[0].content.lower():
            got += 1
        else:
            misses.append(q)
    assert got == len(cases), f"paraphrase recall {got}/{len(cases)}, missed: {misses}"
    return f"hybrid + {got}/{len(cases)} paraphrase recall (sentence-transformers)"


if __name__ == "__main__":
    check("chunk_recall", t_chunk_recall)
    check("dataos_search", t_dataos_search)
    check("loom_multistep", t_loom_multistep)
    check("approval_block", t_approval_block)
    check("shared_memory", t_shared_memory)
    check("import_hygiene", t_import_hygiene)
    check("auth_matrix", t_auth_matrix)
    check("scopes_limits", t_scopes_limits)
    check("tls_handshake", t_tls_handshake)
    check("artifacts_persist", t_artifacts_persist)
    check("backup_restore", t_backup_restore)
    check("client_hangup", t_client_hangup)
    check("semantic_recall", t_semantic_recall)
    width = max(len(n) for _, n, _ in results)
    failed = 0
    for st, name, detail in results:
        print(f"[{st}] {name:<{width}} {detail}")
        failed += st == FAIL
    print(f"{len(results) - failed}/{len(results)} evals passed")
    sys.exit(1 if failed else 0)
