"""Show what memory recall actually retrieves, and which embedder is active.

Run this after changing embedding config, or when recall "feels wrong":
    python agent-os/python/memory_recall_report.py

It uses a throwaway DB, so it never touches your real memory. It reports
honestly: the zero-dependency hashed embedder matches lexical variants but
misses paraphrases, and the report says so rather than looking green.
"""
from __future__ import annotations
import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

os.environ["AGENT_OS_DB"] = os.path.join(tempfile.mkdtemp(), "recall-report.db")

import warnings
warnings.filterwarnings("ignore")

from loom_core.memory import PersistentMemory
from loom_core import embeddings as emb

FACTS = [
    "The user drives a 2019 Ford Focus.",
    "Braking distance increases when road is wet.",
    "The team standup happens at 9:30 every morning.",
    "User prefers dark mode in all editors.",
    "Deployment happens every Tuesday via the release pipeline.",
]
QUERIES = [
    ("car", "ford focus", "pure paraphrase: zero shared tokens"),
    ("stopping on wet roads", "braking", "partial overlap"),
    ("daily sync", "standup", "jargon/abbreviation"),
    ("dark editor theme", "dark mode", "near-paraphrase"),
    ("how do we ship to prod", "release pipeline", "pure paraphrase"),
]


def main() -> int:
    e = emb.get_embedder()
    m = PersistentMemory()
    for f in FACTS:
        asyncio.run(m.add_memory(f, "fact"))

    semantic = e.name != "hashing-word"
    print(f"embedder : {e.name}  (dim={e.dim})")
    if semantic:
        print("            real semantic model -> paraphrases work")
    else:
        print("            FALLBACK: lexical only. Paraphrases WILL miss.")
        print("            For real recall: pip install sentence-transformers")
    print()

    hits = 0
    for q, expect, kind in QUERIES:
        res = asyncio.run(m.search_memories(q, limit=1))
        got = res[0].content if res else None
        ok = bool(got) and expect in got.lower()
        hits += ok
        mark = "PASS" if ok else "MISS"
        print(f"[{mark}] {q!r}  ({kind})")
        print(f"        -> {got}")
    print()
    print(f"{hits}/{len(QUERIES)} recalled")
    if not semantic and hits < len(QUERIES):
        print("\nMisses above are expected without sentence-transformers.")
        print("This is the documented cost of the zero-dependency default.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
