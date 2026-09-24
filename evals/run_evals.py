"""agent-os golden evals — offline gate (mock LLM, temp DBs). Exit 0 = all pass.

1. chunk_recall .... hierarchical parent linkage intact
2. dataos_search .... ingest -> hybrid search finds it
3. loom_multistep ... mock query uses create_document, artifact exists
4. approval_block ... denying callback stops the write tool, answer still produced
5. shared_memory ... loom write visible via shared store + export shape
6. import_hygiene .. no hard cloud/optional imports at data-kernel module level
7. auth_matrix .... gateway+memory: 401 without token, 200 with (live, localhost)
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
    try:
        detail = fn() or ""
        results.append((PASS, name, detail))
    except Exception as e:
        results.append((FAIL, name, f"{type(e).__name__}: {e}"))


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


import json  # noqa: E402  (kept late so t_dataos_search reads naturally above)

if __name__ == "__main__":
    check("chunk_recall", t_chunk_recall)
    check("dataos_search", t_dataos_search)
    check("loom_multistep", t_loom_multistep)
    check("approval_block", t_approval_block)
    check("shared_memory", t_shared_memory)
    check("import_hygiene", t_import_hygiene)
    check("auth_matrix", t_auth_matrix)
    width = max(len(n) for _, n, _ in results)
    failed = 0
    for st, name, detail in results:
        print(f"[{st}] {name:<{width}} {detail}")
        failed += st == FAIL
    print(f"{len(results) - failed}/{len(results)} evals passed")
    sys.exit(1 if failed else 0)
