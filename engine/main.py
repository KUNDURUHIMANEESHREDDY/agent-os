import argparse
import asyncio
import sys
from pathlib import Path

root_dir = Path(__file__).resolve().parent
if str(root_dir) not in sys.path:
    sys.path.insert(0, str(root_dir))

from config import settings
from loom_core.engine import LoomEngine

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.prompt import Prompt
    from rich.tree import Tree
    HAS_RICH = True
    console = Console()
except ImportError:
    HAS_RICH = False


def safe_print(text: str):
    try:
        print(text)
    except UnicodeEncodeError:
        safe_str = text.encode(sys.stdout.encoding, errors="replace").decode(sys.stdout.encoding)
        print(safe_str)


async def run_interactive(provider: str, model: str | None, verbose: bool = True):
    import uuid
    session_id = str(uuid.uuid4())[:8]

    def approve_tool(tool_name, action_input):
        preview = repr(action_input)
        if len(preview) > 600:
            preview = preview[:600] + "..."
        message = f"Approve write capability '{tool_name}' with arguments {preview}? [y/N] "
        if HAS_RICH:
            answer = Prompt.ask(message, default="n")
        else:
            answer = input(message).strip().lower()
        return str(answer).strip().lower() in {"y", "yes"}

    engine = LoomEngine(
        provider=provider,
        model=model,
        approval_callback=approve_tool,
        require_approval=True,
    )
    provider_name = engine.llm_client.provider.upper()
    model_name = engine.llm_client.model

    if HAS_RICH:
        console.print(
            Panel.fit(
                f"[bold cyan]Welcome to Loom Dynamic AI Agent[/bold cyan]\n"
                f"[yellow]Active Provider:[/yellow] {provider_name} | [yellow]Model:[/yellow] {model_name}\n"
                f"[green]Available Tools:[/green] {', '.join(engine.list_available_tools())}\n"
                f"[dim]Session ID: {session_id} (memory enabled)[/dim]\n"
                f"[dim]Type 'exit', 'quit', or 'q' to end. Type 'tools' to list available tools.[/dim]\n"
                f"[dim]Type 'memory' to view memory stats, 'recall <query>' to search memories.[/dim]"
            )
        )
    else:
        safe_print("--- Welcome to Loom Dynamic AI Agent ---")
        safe_print(f"Active Provider: {provider_name} | Model: {model_name}")
        safe_print(f"Available Tools: {', '.join(engine.list_available_tools())}\n")
        safe_print(f"Session ID: {session_id} (memory enabled)")

    while True:
        try:
            user_input = Prompt.ask("\n[bold green]You[/bold green]") if HAS_RICH else input("\nYou: ")
            cleaned_input = user_input.strip()
            if cleaned_input.lower() in ["exit", "quit", "q"]:
                safe_print("Exiting Loom Dynamic Agent. Goodbye!")
                break
            if not cleaned_input:
                continue

            if cleaned_input.lower() == "tools":
                safe_print(f"Available Tools: {', '.join(engine.list_available_tools())}")
                continue
            if cleaned_input.lower() == "memory":
                stats = await engine.get_memory_stats()
                safe_print(f"Memory Statistics: {stats}")
                continue
            if cleaned_input.lower().startswith("recall "):
                query = cleaned_input[7:].strip()
                memories = await engine.recall_memories(query)
                safe_print(f"Recalled memories for '{query}': {[m.content for m in memories]}")
                continue

            if HAS_RICH:
                with console.status("[cyan]Dynamic agent is reasoning and planning...[/cyan]"):
                    response = await engine.process_query(cleaned_input, session_id=session_id)
                if response.thoughts:
                    tree = Tree("[dim bold cyan]Agent Reasoning Steps[/dim bold cyan]")
                    for i, step in enumerate(response.thoughts, 1):
                        tree.add(f"[dim]Step {i}: {step}[/dim]")
                    console.print(tree)
                console.print(f"\n[bold magenta]Agent:[/bold magenta] {response.answer}")
                if response.tools_used:
                    console.print(f"[bold blue]Tools Used:[/bold blue] {', '.join(response.tools_used)}")
                if response.sources:
                    console.print(f"[bold yellow]Sources:[/bold yellow] {', '.join(response.sources)}")
                console.print(
                    f"[dim]Steps: {response.steps_taken} | Time: {response.execution_time_ms}ms | Provider: {response.provider_used}[/dim]"
                )
            else:
                safe_print("Agent is reasoning...")
                response = await engine.process_query(cleaned_input, session_id=session_id)
                safe_print(f"\nAgent: {response.answer}")
                if response.tools_used:
                    safe_print(f"Tools Used: {', '.join(response.tools_used)}")
                if response.sources:
                    safe_print(f"Sources: {', '.join(response.sources)}")
                safe_print(f"(Steps: {response.steps_taken} | Time: {response.execution_time_ms}ms)")

        except (KeyboardInterrupt, EOFError):
            safe_print("\nSession ended.")
            break


def main():
    parser = argparse.ArgumentParser(description="OVERLORD Loom engine — OpenCode-first execution")
    parser.add_argument(
        "--provider",
        choices=["opencode", "mock"],
        default=settings.llm_provider,
        help="Model runtime: opencode (default) or mock (requires AGENT_OS_TEST_MODE=1 outside production)",
    )
    parser.add_argument("--model", type=str, default=None, help="Exact allowlisted OpenCode model ID")
    args = parser.parse_args()
    asyncio.run(run_interactive(provider=args.provider, model=args.model))


if __name__ == "__main__":
    main()