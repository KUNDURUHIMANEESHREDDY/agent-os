"""DataOS kernel bridge: hierarchical chunking -> DataOS storage -> Loom reasoning.

The production model path is OpenCode through the central gateway. Mock generation
is available only for explicit non-production tests; the --demo action opts into
that mode only when the engine is not configured as production.
"""
from __future__ import annotations
import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for relative in ["python", "engine", "data-kernel"]:
    path = str(ROOT / relative)
    if path not in sys.path:
        sys.path.insert(0, path)


def _load_env_file():
    """Load non-secret service settings from the repository's ignored .env."""
    try:
        env_file = ROOT / ".env"
        if not env_file.exists():
            return
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and os.getenv(key) is None:
                os.environ[key] = value
    except OSError:
        pass


_load_env_file()


def chunk_text(text: str, max_leaf_chars: int = 500):
    from chunking import parse_hierarchical
    return parse_hierarchical(text, max_leaf_chars=max_leaf_chars)


def get_loom(provider: str = "opencode", model=None):
    from loom_core.engine import LoomEngine
    return LoomEngine(provider=provider, model=model)


async def run_query(query: str, provider: str = "opencode"):
    return await get_loom(provider=provider).process_query(query)


def demo():
    from config import settings
    if settings.environment.lower() == "production":
        print("Mock demo disabled in production. Use the OpenCode gateway for live execution.")
        return

    # --demo is an explicit operator action. It opts into deterministic test-only mock mode.
    os.environ["AGENT_OS_TEST_MODE"] = "1"
    print("== agent-os demo: chunk -> store -> test-only mock reasoning ==")
    sample = "# Agents\nSupervisor plans work.\n\n## Memory\nAgents recall facts.\n\n## Tools\nAgents call tools with approval."
    chunks = chunk_text(sample, max_leaf_chars=60)
    print(f"chunks: {len(chunks)}")
    for chunk in chunks:
        print(f"  L{chunk.level} parent={bool(chunk.parent_id)} children={len(chunk.children_ids)} :: {chunk.text[:60]!r}")

    try:
        import dataos_system
        print(f"dataos import ok: {hasattr(dataos_system, 'DataOS')}")
    except Exception as error:
        print(f"dataos skipped: {type(error).__name__}: {error}")

    try:
        response = asyncio.run(run_query("list available tools", provider="mock"))
        print(f"loom mock test ok: tools={response.tools_used} steps={response.steps_taken}")
        print(f"answer: {(response.answer or '')[:160]}")
    except Exception as error:
        print(f"loom skipped: {type(error).__name__}: {error}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--query", default="hello")
    parser.add_argument("--provider", choices=["opencode", "mock"], default=os.getenv("LLM_PROVIDER", "opencode"))
    args = parser.parse_args()
    if args.demo:
        demo()
    else:
        if args.provider == "mock" and os.getenv("AGENT_OS_TEST_MODE") != "1":
            parser.error("mock requires AGENT_OS_TEST_MODE=1 and a non-production environment")
        print(asyncio.run(run_query(args.query, provider=args.provider)).answer)
