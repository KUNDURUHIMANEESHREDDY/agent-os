"""
Loom AI Engine - Dynamic Agent Orchestration Module

This module provides a fully dynamic LLM-driven agent that:
- Uses LLM reasoning for dynamic tool selection and workflow planning
- Maintains a registry of tools that can be extended at runtime
- Executes multi-step reasoning loops with reflection
- Supports arbitrary workflows without hardcoded pipelines
- Manages artifacts and transformations dynamically
"""

import asyncio
import time
import json
import re
from typing import Optional, List, Dict, Any, Callable
from dataclasses import dataclass, field
from pathlib import Path
from functools import wraps

from config import settings
from loom_core.memory import PersistentMemory, get_memory, MemoryEntry


@dataclass
class EngineResponse:
    """Response object from dynamic agent query processing."""
    query: str
    answer: str
    thoughts: List[str] = field(default_factory=list)
    sources: List[str] = field(default_factory=list)
    execution_time_ms: float = 0.0
    provider_used: str = ""
    model_used: str = ""
    tools_used: List[str] = field(default_factory=list)
    steps_taken: int = 0
    blocked_tools: List[str] = field(default_factory=list)


class Tool:
    """Represents a dynamically registered tool capability.

    tier "read":-only tools run freely. tier "write": tools create artifacts,
    files, or side effects and go through the approval gate in
    DynamicAgent.execute when the engine requires approval.
    """

    READ = "read"
    WRITE = "write"

    def __init__(
        self,
        name: str,
        description: str,
        func: Callable,
        parameters: Optional[Dict[str, Any]] = None,
        tier: str = READ,
    ):
        self.name = name
        self.description = description
        self.func = func
        self.parameters = parameters or {}
        self.tier = tier if tier in (self.READ, self.WRITE) else self.READ

    def to_schema(self) -> Dict[str, Any]:
        """Return tool schema for LLM consumption."""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "tier": self.tier,
        }


class ToolRegistry:
    """Dynamic registry for agent tools and capabilities."""
    
    def __init__(self):
        self._tools: Dict[str, Tool] = {}
    
    def register(self, name: str, description: str, parameters: Optional[Dict] = None, tier: str = Tool.READ):
        """Decorator to register a function as a tool (tier: "read" | "write")."""
        def decorator(func: Callable):
            tool = Tool(name=name, description=description, func=func, parameters=parameters, tier=tier)
            self._tools[name] = tool
            @wraps(func)
            async def wrapper(*args, **kwargs):
                return await func(*args, **kwargs)
            return wrapper
        return decorator
    
    def get_tool(self, name: str) -> Optional[Tool]:
        """Retrieve a tool by name."""
        return self._tools.get(name)
    
    def list_tools(self) -> List[Tool]:
        """List all registered tools."""
        return list(self._tools.values())
    
    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Get all tool schemas for LLM prompting."""
        return [tool.to_schema() for tool in self._tools.values()]
    
    def remove_tool(self, name: str) -> bool:
        """Remove a tool from the registry."""
        if name in self._tools:
            del self._tools[name]
            return True
        return False


class DynamicAgent:
    """LLM-driven dynamic agent for autonomous reasoning and tool use."""
    
    SYSTEM_PROMPT = """You are a dynamic AI agent with access to various tools. 
Your task is to help the user by reasoning through their request and using tools when appropriate.

You have access to these tools:
{tools}

When you need to use a tool, respond with this format:
THOUGHT: <your reasoning about what to do next>
ACTION: <tool_name>
ACTION_INPUT: <JSON input for the tool>

When you have enough information to answer, respond with:
THOUGHT: <final reasoning>
FINAL_ANSWER: <your complete response to the user>

Think step-by-step. You can use multiple tools in sequence if needed.
Always explain your reasoning in the THOUGHT section."""

    def __init__(self, llm_client, max_iterations: int = 10, memory: Optional[PersistentMemory] = None,
                 approval_callback: Optional[Callable[[str, Dict[str, Any]], Any]] = None,
                 require_approval: bool = False):
        self.llm_client = llm_client
        self.max_iterations = max_iterations
        self._thought_history: List[str] = []
        self.memory = memory or get_memory()
        self._current_session_id: Optional[str] = None
        # Write-tier tools only run when approved. Callback gets
        # (tool_name, action_input) and returns truthy to allow.
        # None -> env AGENT_OS_AUTO_APPROVE ("1" allows, anything else denies).
        self.approval_callback = approval_callback
        self.require_approval = require_approval
        self._blocked_tools: List[str] = []

    async def _is_approved(self, tool_name: str, action_input: Dict[str, Any]) -> bool:
        if self.approval_callback is not None:
            try:
                res = self.approval_callback(tool_name, action_input)
                if asyncio.iscoroutine(res):
                    res = await res
                return bool(res)
            except Exception:
                return False
        import os
        return os.getenv("AGENT_OS_AUTO_APPROVE", "0") == "1"
    
    def _format_tools_prompt(self, tool_schemas: List[Dict]) -> str:
        """Format tool schemas into a prompt string."""
        if not tool_schemas:
            return "No tools available."
        
        formatted = []
        for tool in tool_schemas:
            desc = tool["description"]
            params = tool.get("parameters", {})
            param_str = ", ".join([f"{k}: {v}" for k, v in params.items()]) if params else "no parameters"
            formatted.append(f"- {tool['name']}: {desc} (Parameters: {param_str})")
        
        return "\n".join(formatted)
    
    def _parse_agent_response(self, response: str) -> Dict[str, Optional[str]]:
        """Parse agent response to extract thought, action, and answer."""
        result = {
            "thought": None,
            "action": None,
            "action_input": None,
            "final_answer": None
        }
        
        # Extract THOUGHT
        thought_match = re.search(r'THOUGHT:\s*(.+?)(?=ACTION:|FINAL_ANSWER:|$)', response, re.DOTALL | re.IGNORECASE)
        if thought_match:
            result["thought"] = thought_match.group(1).strip()
        
        # Extract ACTION
        action_match = re.search(r'ACTION:\s*(\w+)', response, re.IGNORECASE)
        if action_match:
            result["action"] = action_match.group(1).strip()
        
        # Extract ACTION_INPUT
        action_input_match = re.search(r'ACTION_INPUT:\s*(.+?)(?=THOUGHT:|FINAL_ANSWER:|$)', response, re.DOTALL | re.IGNORECASE)
        if action_input_match:
            result["action_input"] = action_input_match.group(1).strip()
        
        # Extract FINAL_ANSWER
        final_match = re.search(r'FINAL_ANSWER:\s*(.+?)$', response, re.DOTALL | re.IGNORECASE)
        if final_match:
            result["final_answer"] = final_match.group(1).strip()
        
        return result
    
    async def execute(self, query: str, tool_registry: ToolRegistry, session_id: Optional[str] = None) -> Dict[str, Any]:
        """Execute dynamic agent loop for query processing."""
        self._thought_history = []
        self._blocked_tools = []
        self._current_session_id = session_id
        
        # Initialize session if provided
        if session_id:
            await self.memory.start_conversation(session_id)
            # Add user query to conversation history
            await self.memory.add_message_to_conversation(session_id, "user", query)
        
        # Retrieve relevant memories and facts to provide context
        relevant_facts = await self.memory.get_relevant_facts(query, limit=3)
        context_prompt = ""
        if relevant_facts:
            context_prompt = "\n\nRelevant information from memory:\n" + "\n".join([f"- {fact}" for fact in relevant_facts])
        
        tool_schemas = tool_registry.get_tool_schemas()
        tools_prompt = self._format_tools_prompt(tool_schemas)
        
        conversation_history = [
            {
                "role": "system",
                "content": self.SYSTEM_PROMPT.format(tools=tools_prompt) + context_prompt
            },
            {
                "role": "user",
                "content": f"User request: {query}"
            }
        ]
        
        iteration = 0
        tools_used: List[str] = []
        while iteration < self.max_iterations:
            iteration += 1
            
            # Build prompt from conversation history
            prompt = "\n".join([
                f"{msg['role'].upper()}: {msg['content']}"
                for msg in conversation_history
            ])
            
            # Get LLM response
            response_text = await self.llm_client.generate(prompt)
            parsed = self._parse_agent_response(response_text)
            
            # Log thought
            if parsed["thought"]:
                self._thought_history.append(parsed["thought"])
            
            # Check for final answer
            if parsed["final_answer"]:
                # Store conversation and learn from interaction
                if self._current_session_id:
                    await self.memory.add_message_to_conversation(
                        self._current_session_id,
                        "assistant",
                        parsed["final_answer"],
                        metadata={"thoughts": self._thought_history.copy()}
                    )
                    
                    # Extract and store facts from the conversation
                    await self._extract_and_store_facts(query, parsed["final_answer"])
                
                return {
                    "answer": parsed["final_answer"],
                    "thoughts": self._thought_history.copy(),
                    "iterations": iteration,
                    "blocked": self._blocked_tools.copy(),
                    "tools_used": tools_used.copy(),
                }
            
            # Execute action if present
            if parsed["action"]:
                tool = tool_registry.get_tool(parsed["action"])
                if not tool:
                    error_msg = f"Tool '{parsed['action']}' not found. Available tools: {list(tool_registry._tools.keys())}"
                    conversation_history.append({
                        "role": "assistant",
                        "content": f"THOUGHT: {parsed['thought'] or 'Looking for tool'}\nACTION: {parsed['action']}"
                    })
                    conversation_history.append({
                        "role": "user",
                        "content": f"OBSERVATION: {error_msg}"
                    })
                    continue
                
                # Parse action input
                action_input = {}
                if parsed["action_input"]:
                    try:
                        action_input = json.loads(parsed["action_input"])
                        if not isinstance(action_input, dict):
                            action_input = {"input": action_input}
                    except json.JSONDecodeError:
                        action_input = {"input": parsed["action_input"]}
                
                # Approval gate for write-tier tools
                if tool.tier == Tool.WRITE and self.require_approval:
                    if not await self._is_approved(tool.name, action_input):
                        self._blocked_tools.append(tool.name)
                        observation = (
                            f"Tool '{tool.name}' blocked: approval denied. "
                            f"Answer from what you already know or use a read-only tool."
                        )
                        conversation_history.append({
                            "role": "assistant",
                            "content": f"THOUGHT: {parsed['thought'] or 'Executing tool'}\nACTION: {parsed['action']}\nACTION_INPUT: {parsed['action_input'] or '{}'}"
                        })
                        conversation_history.append({
                            "role": "user",
                            "content": f"OBSERVATION: {observation}"
                        })
                        continue

                # Execute tool
                try:
                    if asyncio.iscoroutinefunction(tool.func):
                        observation = await tool.func(**action_input)
                    else:
                        observation = tool.func(**action_input)
                    tools_used.append(tool.name)
                except Exception as e:
                    observation = f"Error executing tool: {str(e)}"
                
                # Add to conversation
                conversation_history.append({
                    "role": "assistant",
                    "content": f"THOUGHT: {parsed['thought'] or 'Executing tool'}\nACTION: {parsed['action']}\nACTION_INPUT: {parsed['action_input'] or '{}'}"
                })
                conversation_history.append({
                    "role": "user",
                    "content": f"OBSERVATION: {observation}"
                })
            else:
                # No action and no final answer - prompt for continuation
                conversation_history.append({
                    "role": "assistant",
                    "content": response_text
                })
                conversation_history.append({
                    "role": "user",
                    "content": "Please continue. Use an ACTION or provide a FINAL_ANSWER."
                })
        
        # Max iterations reached
        if self._current_session_id:
            await self.memory.add_message_to_conversation(
                self._current_session_id,
                "assistant",
                "I reached the maximum number of reasoning steps.",
                metadata={"thoughts": self._thought_history.copy()}
            )
        
        return {
            "answer": "I reached the maximum number of reasoning steps. Here's what I gathered so far: " + (self._thought_history[-1] if self._thought_history else ""),
            "thoughts": self._thought_history.copy(),
            "iterations": iteration,
            "blocked": self._blocked_tools.copy(),
            "tools_used": tools_used.copy(),
        }
    
    async def _extract_and_store_facts(self, query: str, answer: str):
        """Extract potential facts from conversation and store them in memory."""
        # Simple heuristic-based fact extraction
        # In production, this would use an LLM call to extract facts
        
        # Look for definitive statements that could be facts
        fact_patterns = [
            r"is a? (\w+)",  # "X is a Y"
            r"was (?:born|created|founded) in (\d{4})",  # dates
            r"located in ([\w\s,]+)",  # locations
            r"known for ([\w\s,]+)"  # attributes
        ]
        
        import re
        for pattern in fact_patterns:
            matches = re.findall(pattern, answer, re.IGNORECASE)
            for match in matches:
                if len(match) < 200:  # Avoid storing very long strings
                    fact = f"{query}: {match}"
                    await self.memory.learn_fact(fact, context=query)
                    break  # Store one fact per pattern
    
    async def get_memory_stats(self) -> Dict[str, Any]:
        """Get statistics about the agent's memory."""
        return await self.memory.get_stats()
    
    async def recall_memories(self, query: str, limit: int = 5) -> List[MemoryEntry]:
        """Recall relevant memories based on a query."""
        return await self.memory.search_memories(query, limit=limit)
    
    async def set_preference(self, key: str, value: Any):
        """Set a user preference."""
        await self.memory.add_preference(key, value)
    
    async def get_preference(self, key: str, default: Any = None) -> Any:
        """Get a user preference."""
        return await self.memory.get_preference(key, default)


class LLMClient:
    """Unified LLM client supporting multiple providers."""
    
    class Provider:
        GOOGLE = "google"
        DEEPSEEK = "deepseek"
        GROQ = "groq"
        OLLAMA = "ollama"
        MOCK = "mock"
    
    def __init__(self, provider: str, model: Optional[str] = None):
        self.provider = provider
        self.model = model or self._get_default_model(provider)
        self._api_key = self._get_api_key(provider)
    
    def _get_default_model(self, provider: str) -> str:
        defaults = {
            "google": "gemini-pro",
            "deepseek": "deepseek-chat",
            "groq": "mixtral-8x7b-32768",
            "ollama": "llama2",
            "mock": "mock-model"
        }
        return defaults.get(provider, "default-model")
    
    def _get_api_key(self, provider: str) -> Optional[str]:
        keys = {
            "google": settings.google_api_key,
            "deepseek": settings.deepseek_api_key,
            "groq": settings.groq_api_key,
            "ollama": None,
            "mock": None
        }
        return keys.get(provider)
    
    async def generate(self, prompt: str) -> str:
        """Generate response from LLM based on provider."""
        # agent-os: single path first — gateway owns keys/fallbacks/mock.
        if settings.gateway_enabled:
            try:
                return await self._gateway_generate(prompt)
            except Exception:
                pass
        if self.provider == self.Provider.MOCK:
            return await self._mock_generate(prompt)
        elif self.provider == self.Provider.DEEPSEEK:
            return await self._deepseek_generate(prompt)
        elif self.provider == self.Provider.GOOGLE:
            return await self._google_generate(prompt)
        elif self.provider == self.Provider.GROQ:
            return await self._groq_generate(prompt)
        elif self.provider == self.Provider.OLLAMA:
            return await self._ollama_generate(prompt)
        else:
            return await self._mock_generate(prompt)
    
    async def _gateway_generate(self, prompt: str) -> str:
        """agent-os gateway: POST {gateway_url}/v1/chat. Raises if unreachable."""
        import httpx
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{settings.gateway_url.rstrip('/')}/v1/chat",
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=settings.gateway_timeout_s,
            )
            response.raise_for_status()
            data = response.json()
            content = data.get("content")
            if not content or not str(content).strip():
                raise ValueError("empty gateway reply")
            return content

    async def _mock_generate(self, prompt: str) -> str:
        """Mock generation that simulates dynamic agent behavior."""
        await asyncio.sleep(0.15)

        prompt_lower = prompt.lower()

        # Route on the latest USER request, not the whole prompt: the system
        # prompt names every tool (e.g. "PDF"), which used to hijack routing.
        user_q = prompt_lower
        user_blocks = re.findall(r'^user:\s*(.+?)(?=^(?:user|assistant|system):|\Z)', prompt_lower, re.DOTALL | re.MULTILINE)
        if user_blocks and "observation" not in prompt_lower:
            user_q = user_blocks[-1][:500]
        
        # Check if this is a follow-up after tool execution (contains OBSERVATION)
        if "observation" in prompt_lower:
            if "playlist" in prompt_lower or "created" in prompt_lower:
                return """THOUGHT: The playlist has been created successfully with all the requested content
FINAL_ANSWER: I've created a curated playlist for you with relevant content organized by topic. The playlist includes sections, items, and detailed descriptions."""
            
            if "document" in prompt_lower:
                return """THOUGHT: The document has been generated successfully
FINAL_ANSWER: Your document has been created and is ready. You can now export it to PDF if needed."""
            
            if "pdf" in prompt_lower or "export" in prompt_lower:
                return """THOUGHT: PDF export completed successfully
FINAL_ANSWER: Your document has been exported to PDF and saved to the output directory."""
            
            # Generic observation response
            return """THOUGHT: I have received the tool output and can now provide a complete answer
FINAL_ANSWER: I've completed the requested task using the available tools. Is there anything else you'd like me to help with?"""
        
        # Initial query handling - decide which tool to use based on keywords
        # in the USER request (not the system prompt). Priority order matters.
        if "pdf" in user_q or "export" in user_q:
            return """THOUGHT: The user wants to export content to PDF. I'll use the export_to_pdf tool.
ACTION: export_to_pdf
ACTION_INPUT: {}"""

        if "playlist" in user_q:
            return """THOUGHT: The user wants a playlist. I should use the create_playlist tool to generate curated content.
ACTION: create_playlist
ACTION_INPUT: {"topic": "user requested topic"}"""

        if "summarize" in user_q or "summary" in user_q:
            return """THOUGHT: The user wants a summary. I'll use the summarize_content tool.
ACTION: summarize_content
ACTION_INPUT: {"content": "user requested content"}"""

        if "search" in user_q or "information" in user_q or "research" in user_q or "news" in user_q:
            return """THOUGHT: The user is looking for information. I'll use the search_information tool.
ACTION: search_information
ACTION_INPUT: {"query": "user requested topic"}"""

        if "document" in user_q or "write" in user_q or "documentation" in user_q:
            return """THOUGHT: The user wants me to create a document. I'll use the create_document tool.
ACTION: create_document
ACTION_INPUT: {"topic": "user requested topic", "style": "informative"}"""
        
        # Default: provide a helpful response directly
        return f"""THOUGHT: Analyzing the user's request to determine the best approach. The query appears to be a general question.
FINAL_ANSWER: I've processed your request: "{prompt[:80]}...". I can help you with various tasks including content creation, research, summarization, playlist generation, and document export. What specific aspect would you like me to focus on?"""
    
    async def _deepseek_generate(self, prompt: str) -> str:
        """DeepSeek API generation."""
        if not self._api_key:
            return await self._mock_generate(prompt)
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    "https://api.deepseek.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": self.model,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": settings.temperature,
                        "max_tokens": settings.max_tokens
                    },
                    timeout=30.0
                )
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"]
        except Exception:
            return await self._mock_generate(prompt)
    
    async def _google_generate(self, prompt: str) -> str:
        """Google Gemini API generation."""
        if not self._api_key:
            return await self._mock_generate(prompt)
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent",
                    params={"key": self._api_key},
                    json={
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {
                            "temperature": settings.temperature,
                            "maxOutputTokens": settings.max_tokens
                        }
                    },
                    timeout=30.0
                )
                response.raise_for_status()
                data = response.json()
                return data["candidates"][0]["content"]["parts"][0]["text"]
        except Exception:
            return await self._mock_generate(prompt)
    
    async def _groq_generate(self, prompt: str) -> str:
        """Groq API generation."""
        if not self._api_key:
            return await self._mock_generate(prompt)
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": self.model,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": settings.temperature,
                        "max_tokens": settings.max_tokens
                    },
                    timeout=30.0
                )
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"]
        except Exception:
            return await self._mock_generate(prompt)
    
    async def _ollama_generate(self, prompt: str) -> str:
        """Ollama local generation."""
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{settings.ollama_base_url}/chat/completions",
                    json={
                        "model": self.model,
                        "messages": [{"role": "user", "content": prompt}],
                        "stream": False
                    },
                    timeout=30.0
                )
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"]
        except Exception:
            return await self._mock_generate(prompt)


class ArtifactRegistry:
    """Manages generated artifacts (documents, playlists, etc.)."""
    
    def __init__(self):
        self._artifacts: Dict[str, Dict[str, Any]] = {}
        self._latest_id: Optional[str] = None
    
    def create_artifact(self, title: str, content: str, artifact_type: str = "document") -> str:
        """Create and store a new artifact."""
        artifact_id = f"{artifact_type}_{int(time.time())}"
        self._artifacts[artifact_id] = {
            "artifact_id": artifact_id,
            "title": title,
            "content": content,
            "type": artifact_type,
            "created_at": time.time(),
            "sources": []
        }
        self._latest_id = artifact_id
        return artifact_id
    
    def get_artifact(self, artifact_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve an artifact by ID."""
        return self._artifacts.get(artifact_id)
    
    def get_latest_artifact(self) -> Optional[Dict[str, Any]]:
        """Get the most recently created artifact."""
        if self._latest_id:
            return self._artifacts.get(self._latest_id)
        return None
    
    def update_artifact(self, artifact_id: str, **updates) -> bool:
        """Update an existing artifact."""
        if artifact_id in self._artifacts:
            self._artifacts[artifact_id].update(updates)
            return True
        return False
    
    def list_artifacts(self) -> List[Dict[str, Any]]:
        """List all artifacts."""
        return list(self._artifacts.values())


class TransformEngine:
    """Handles transformations like PDF export."""
    
    def __init__(self):
        self.data_dir = settings.data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
    
    def transform_to_pdf(self, artifact: Dict[str, Any], theme: str = "modern") -> Dict[str, Any]:
        """Transform artifact content to PDF format."""
        try:
            from tools.pdf import PDFMaker
            pdf_maker = PDFMaker()
            output_filename = f"{artifact['artifact_id']}_export.pdf"
            
            pdf_path = pdf_maker.create_pdf(
                title=artifact["title"],
                content=artifact["content"],
                output_filename=output_filename,
                sources=artifact.get("sources", [])
            )
            
            return {"pdf_path": str(pdf_path), "success": True}
        except ImportError:
            # Fallback without PDF tools
            pdf_path = self.data_dir / f"{artifact['artifact_id']}_export.pdf"
            pdf_path.touch()  # Create empty file as placeholder
            return {"pdf_path": str(pdf_path), "success": True, "note": "Placeholder PDF"}


class LoomEngine:
    """
    Dynamic AI Agent Engine with LLM-driven reasoning and tool selection.
    
    This engine uses a ReAct-style (Reason + Act) loop where the LLM:
    1. Reasons about the user's request
    2. Decides which tool to use (if any)
    3. Observes the tool output
    4. Continues reasoning until it can provide a final answer
    
    Tools are dynamically registered and can be added/removed at runtime.
    No hardcoded pipelines or intent classifiers.
    """
    
    def __init__(self, provider: Optional[str] = None, model: Optional[str] = None,
                 require_approval: bool = False,
                 approval_callback: Optional[Callable[[str, Dict[str, Any]], Any]] = None):
        self.provider = provider or settings.llm_provider
        self.llm_client = LLMClient(provider=self.provider, model=model)
        self.artifact_registry = ArtifactRegistry()
        self.transform_engine = TransformEngine()
        self.tool_registry = ToolRegistry()
        self.agent = DynamicAgent(self.llm_client, require_approval=require_approval,
                                  approval_callback=approval_callback)
        
        # Register built-in tools dynamically
        self._register_builtin_tools()
    
    def _register_builtin_tools(self):
        """Register built-in tools that the dynamic agent can use."""
        
        @self.tool_registry.register(
            name="create_playlist",
            description="Create a curated playlist about a given topic",
            parameters={"topic": "string - the topic for the playlist"},
            tier="write",
        )
        async def create_playlist(topic: str) -> str:
            prompt = f"Create a detailed curated playlist about: {topic}. Include sections, items, and descriptions."
            content = await self.llm_client.generate(prompt)
            artifact_id = self.artifact_registry.create_artifact(
                title=f"Playlist: {topic}",
                content=content,
                artifact_type="playlist"
            )
            return f"Playlist created (ID: {artifact_id}). Content:\n{content}"
        
        @self.tool_registry.register(
            name="create_document",
            description="Generate a document or article on a given topic",
            parameters={"topic": "string - the topic for the document", "style": "string - writing style (optional)"},
            tier="write",
        )
        async def create_document(topic: str, style: str = "informative") -> str:
            prompt = f"Write a {style} document about: {topic}. Provide comprehensive coverage of the topic."
            content = await self.llm_client.generate(prompt)
            artifact_id = self.artifact_registry.create_artifact(
                title=f"Document: {topic[:50]}",
                content=content,
                artifact_type="document"
            )
            return f"Document created (ID: {artifact_id}). Content:\n{content}"
        
        @self.tool_registry.register(
            name="search_information",
            description="Search for information on a given topic",
            parameters={"query": "string - the search query"}
        )
        async def search_information(query: str) -> str:
            prompt = f"Provide comprehensive information about: {query}. Include key facts, context, and relevant details."
            content = await self.llm_client.generate(prompt)
            return content
        
        @self.tool_registry.register(
            name="summarize_content",
            description="Summarize given content or topic",
            parameters={"content": "string - the content or topic to summarize"}
        )
        async def summarize_content(content: str) -> str:
            prompt = f"Provide a concise summary of: {content}. Highlight key points and main ideas."
            summary = await self.llm_client.generate(prompt)
            return summary
        
        @self.tool_registry.register(
            name="export_to_pdf",
            description="Export the most recent artifact to PDF format",
            parameters={},
            tier="write",
        )
        async def export_to_pdf() -> str:
            artifact = self.artifact_registry.get_latest_artifact()
            if not artifact:
                return "No artifact found to export. Create content first."
            
            result = self.transform_engine.transform_to_pdf(artifact)
            return f"PDF exported successfully to: {result['pdf_path']}"
        
        @self.tool_registry.register(
            name="get_artifact",
            description="Retrieve a specific artifact by ID",
            parameters={"artifact_id": "string - the artifact ID to retrieve"}
        )
        async def get_artifact(artifact_id: str) -> str:
            artifact = self.artifact_registry.get_artifact(artifact_id)
            if not artifact:
                return f"Artifact with ID '{artifact_id}' not found."
            return f"Title: {artifact['title']}\nType: {artifact['type']}\nContent:\n{artifact['content']}"
        
        @self.tool_registry.register(
            name="list_artifacts",
            description="List all created artifacts",
            parameters={}
        )
        async def list_artifacts() -> str:
            artifacts = self.artifact_registry.list_artifacts()
            if not artifacts:
                return "No artifacts have been created yet."
            
            result = ["Created artifacts:"]
            for art in artifacts:
                result.append(f"- {art['artifact_id']}: {art['title']} ({art['type']})")
            return "\n".join(result)
    
    async def process_query(self, query: str, session_id: Optional[str] = None) -> EngineResponse:
        """
        Process a user query using dynamic agent reasoning.
        
        The agent will:
        1. Reason about the query
        2. Select and execute tools as needed
        3. Iterate until it can provide a complete answer
        
        Args:
            query: User's query or request
            session_id: Optional session ID for memory persistence
        """
        start_time = time.time()
        
        # Execute dynamic agent loop with optional session ID for memory
        result = await self.agent.execute(query, self.tool_registry, session_id=session_id)
        
        execution_time = (time.time() - start_time) * 1000

        # Tools recorded at execution time (blocked tools never ran)
        tools_used = list(result.get("tools_used") or [])
        if not tools_used:
            # Fallback: parse ACTION lines out of thought history
            for thought in result["thoughts"]:
                if "ACTION:" in thought.upper():
                    match = re.search(r'ACTION:\s*(\w+)', thought, re.IGNORECASE)
                    if match:
                        tools_used.append(match.group(1))
        
        return EngineResponse(
            query=query,
            answer=result["answer"],
            thoughts=result["thoughts"],
            sources=[],
            execution_time_ms=round(execution_time, 2),
            provider_used=self.llm_client.provider,
            model_used=self.llm_client.model,
            tools_used=tools_used,
            steps_taken=result["iterations"],
            blocked_tools=result.get("blocked", []),
        )
    
    async def get_memory_stats(self) -> Dict[str, Any]:
        """Get statistics about the agent's persistent memory."""
        return await self.agent.get_memory_stats()
    
    async def recall_memories(self, query: str, limit: int = 5) -> List[MemoryEntry]:
        """Recall relevant memories based on a query."""
        return await self.agent.recall_memories(query, limit)
    
    async def set_preference(self, key: str, value: Any):
        """Set a user preference in persistent memory."""
        await self.agent.set_preference(key, value)
    
    async def get_preference(self, key: str, default: Any = None) -> Any:
        """Get a user preference from persistent memory."""
        return await self.agent.get_preference(key, default)
    
    def register_custom_tool(self, name: str, description: str, func: Callable, parameters: Optional[Dict] = None, tier: str = Tool.READ):
        """
        Register a custom tool at runtime.

        This allows extending agent capabilities without code changes.
        """
        tool = Tool(name=name, description=description, func=func, parameters=parameters, tier=tier)
        self.tool_registry._tools[name] = tool
    
    def unregister_tool(self, name: str) -> bool:
        """Remove a tool from the registry."""
        return self.tool_registry.remove_tool(name)
    
    def list_available_tools(self) -> List[str]:
        """List names of all available tools."""
        return [tool.name for tool in self.tool_registry.list_tools()]
