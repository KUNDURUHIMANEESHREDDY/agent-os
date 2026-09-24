"""agent-os kernel bridge: chunking -> DataOS storage -> Loom reasoning, in-process.

Merged standalone layout (no cross-repo sys.path hacks — `core` now uniquely
belongs to data-kernel, loom's package is `loom_core`):
  python/chunking  -> hierarchical chunking (RAG ingest)
  data-kernel/     -> DataOS kernel (storage/graph/grounding)
  engine/          -> LoomEngine (multi-provider reasoning, gateway-first)
Runs `--demo` with mock LLM, no API keys.
"""
from __future__ import annotations
import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # agent-os/
for p in ["python", "engine", "data-kernel"]:
    s = str(ROOT / p)
    if s not in sys.path:
        sys.path.insert(0, s)


def chunk_text(text: str, max_leaf_chars: int = 500):
    from chunking import parse_hierarchical
    return parse_hierarchical(text, max_leaf_chars=max_leaf_chars)


def get_loom(provider: str = "mock", model=None):
    from loom_core.engine import LoomEngine
    return LoomEngine(provider=provider, model=model)


async def run_query(query: str, provider: str = "mock"):
    return await get_loom(provider=provider).process_query(query)


def demo():
    print("== agent-os demo: chunk -> store -> reason ==")
    sample = "# Agents\nSupervisor plans work.\n\n## Memory\nAgents recall facts.\n\n## Tools\nAgents call tools with approval."
    chunks = chunk_text(sample, max_leaf_chars=60)
    print(f"chunks: {len(chunks)}")
    for c in chunks:
        print(f"  L{c.level} parent={bool(c.parent_id)} children={len(c.children_ids)} :: {c.text[:60]!r}")

    try:
        import dataos_system
        print(f"dataos import ok: {hasattr(dataos_system, 'DataOS')}")
    except Exception as e:
        print(f"dataos skipped: {type(e).__name__}: {e}")

    try:
        resp = asyncio.run(run_query("list available tools", provider="mock"))
        print(f"loom mock ok: tools={resp.tools_used} steps={resp.steps_taken}")
        print(f"answer: {(resp.answer or '')[:160]}")
    except Exception as e:
        print(f"loom skipped: {type(e).__name__}: {e}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--query", default="hello")
    ap.add_argument("--provider", default=os.getenv("LLM_PROVIDER", "mock"))
    a = ap.parse_args()
    if a.demo:
        demo()
    else:
        print(asyncio.run(run_query(a.query, provider=a.provider)).answer)
