"""agent-os golden evals — offline gate (mock LLM, temp DBs). Exit 0 = all pass.

1. chunk_recall .... hierarchical parent linkage intact
2. dataos_search .... ingest -> hybrid search finds it
3. loom_multistep ... mock query uses create_document, artifact exists
4. approval_block ... denying callback stops the write tool, answer still produced
5. shared_memory ... loom write visible via shared store + export shape
6. import_hygiene .. no hard cloud/optional imports at data-kernel module level
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


import json  # noqa: E402  (kept late so t_dataos_search reads naturally above)

if __name__ == "__main__":
    check("chunk_recall", t_chunk_recall)
    check("dataos_search", t_dataos_search)
    check("loom_multistep", t_loom_multistep)
    check("approval_block", t_approval_block)
    check("shared_memory", t_shared_memory)
    check("import_hygiene", t_import_hygiene)
    width = max(len(n) for _, n, _ in results)
    failed = 0
    for st, name, detail in results:
        print(f"[{st}] {name:<{width}} {detail}")
        failed += st == FAIL
    print(f"{len(results) - failed}/{len(results)} evals passed")
    sys.exit(1 if failed else 0)
