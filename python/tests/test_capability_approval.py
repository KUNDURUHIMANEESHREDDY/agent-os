import asyncio
import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[2] / "engine"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def test_tool_and_custom_registry_default_to_write_risk():
    from loom_core.engine import Tool, ToolRegistry

    async def noop():
        return "no-op"

    assert Tool("x", "x", noop).tier == Tool.WRITE
    assert Tool("x", "x", noop, tier="unknown").tier == Tool.WRITE

    registry = ToolRegistry()
    registry.register("custom", "custom capability")(noop)
    assert registry.get_tool("custom").tier == Tool.WRITE


def test_write_tool_denies_without_callback_even_if_legacy_auto_approve_is_set(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_OS_TEST_MODE", "1")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("AGENT_OS_AUTO_APPROVE", "1")
    monkeypatch.setenv("AGENT_OS_DB", str(tmp_path / "agent.db"))

    from loom_core import engine as engine_module
    engine_module.settings.environment = "development"
    instance = engine_module.LoomEngine(
        provider="mock",
        require_approval=False,  # legacy flag cannot disable write approval
        approval_callback=None,
    )
    result = asyncio.run(instance.process_query("write a document about solar sails"))

    assert "create_document" not in result.tools_used
    assert "create_document" in result.blocked_tools


def test_explicit_callback_is_required_for_write_tool(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_OS_TEST_MODE", "1")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("AGENT_OS_DB", str(tmp_path / "agent-approved.db"))

    from loom_core import engine as engine_module
    engine_module.settings.environment = "development"
    approved = engine_module.LoomEngine(
        provider="mock",
        approval_callback=lambda name, args: name == "create_document" and bool(args.get("topic")),
        require_approval=True,
    )
    result = asyncio.run(approved.process_query("write a document about solar sails"))
    assert "create_document" in result.tools_used
    assert approved.artifact_registry.list_artifacts()