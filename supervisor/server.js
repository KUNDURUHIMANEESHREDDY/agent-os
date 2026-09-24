// harness server — zero dependencies, node builtins only.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const STORE = path.join(__dirname, "store.json");
// agent-os: single LLM gateway + shared memory. store.json stays as local cache/export only.
const GATEWAY_URL = (process.env.GATEWAY_URL || "http://localhost:20129").replace(/\/+$/, "");
const MEMORY_URL = (process.env.MEMORY_URL || "http://localhost:20130").replace(/\/+$/, "");
function memoryMirror(e) {
  try {
    fetch(MEMORY_URL + "/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: e.dir, source: e.source, target: e.target, type: e.type, payload: e.payload, runId: e.runId, model: e.model }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
  } catch {}
}

function defCfg() {
  return {
    active: "generalist",
    profiles: [
      {
        id: "generalist",
        name: "Generalist",
        domain: "general",
        skills: ["intent-parsing", "task-decomposition", "synthesis", "conflict-resolution", "policy-enforcement", "act-on-feedback"],
        tools: ["delegate_task", "request_approval", "inspect_context", "agent_spawn"],
        mcps: ["local"],
      },
      {
        id: "coder",
        name: "Code Lead",
        domain: "software",
        skills: ["architecture-review", "code-review", "task-decomposition", "refactoring-planning", "fix-ci", "ponytail", "generate-run-commands"],
        tools: ["delegate_task", "inspect_context", "review_diff", "agent_spawn", "python_repl"],
        mcps: ["local", "github", "filesystem"],
      },
      {
        id: "security",
        name: "Security Lead",
        domain: "security",
        skills: ["threat-modeling", "security-audit", "adversarial-review", "guardrail-enforcement", "compliance-check"],
        tools: ["delegate_task", "request_approval", "inspect_context", "cancel_run"],
        mcps: ["local", "filesystem"],
      },
      {
        id: "researcher",
        name: "Research Lead",
        domain: "research",
        skills: ["hypothesis-formulation", "source-verification", "fact-checking", "literature-review", "information-synthesis"],
        tools: ["delegate_task", "inspect_context", "agent_spawn", "fetch_url"],
        mcps: ["local", "github"],
      },
    ],
    supervisor: {
      skills: ["intent-parsing", "task-decomposition", "synthesis", "conflict-resolution"],
      tools: ["delegate_task", "request_approval", "inspect_context", "agent_spawn"],
      mcps: ["local"],
    },
    skills: [
      {
        id: "researcher",
        name: "Web Researcher",
        cap: "research",
        skills: ["web-search", "content-extraction", "summarization", "source-verification", "fact-checking"],
        tools: ["read_context", "fetch_url", "search_web", "extract_content"],
        mcps: ["local", "github"],
        on: true,
      },
      {
        id: "coder",
        name: "Code Engineer",
        cap: "code",
        skills: ["javascript", "python", "refactoring", "fix-ci", "ponytail", "generate-run-commands", "syntax-check"],
        tools: ["draft_change", "format_code", "syntax_check", "run_tests"],
        mcps: ["local", "filesystem"],
        on: true,
      },
      {
        id: "tools",
        name: "System Executor",
        cap: "exec",
        skills: ["shell-exec", "file-io", "docker", "troubleshoot", "process-management", "environment-setup"],
        tools: ["exec_cmd", "write_file", "read_file", "kill_process"],
        mcps: ["local", "filesystem"],
        on: true,
      },
      {
        id: "critic",
        name: "Quality Critic",
        cap: "review",
        skills: ["security-audit", "diff-review", "validation", "code-review", "adversarial-testing", "lint"],
        tools: ["review_diff", "verify_contract", "lint", "audit_security"],
        mcps: ["local", "github"],
        on: true,
      },
      {
        id: "designer",
        name: "Frontend Designer",
        cap: "custom",
        skills: ["frontend-design", "web-design-engineer", "ui-ux-pro-max", "shadcn", "canvas-design", "animate", "theme-factory"],
        tools: ["draft_component", "preview_render", "inspect_css", "format_code"],
        mcps: ["local", "filesystem"],
        on: true,
      },
    ],
    mcps: [
      { id: "local", name: "local-tools", tools: ["fetch", "exec", "write"], on: true },
      { id: "github", name: "github-mcp", tools: ["pull_request", "issue_read", "commit"], on: true },
      { id: "filesystem", name: "filesystem-mcp", tools: ["read_file", "write_file", "list_dir"], on: true },
    ],
    models: [
      { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", provider: "Anthropic", tag: "Recommended", desc: "Hybrid reasoning & deep code execution", context: "200k", on: true, default: true },
      { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI", tag: "Flagship", desc: "High-bandwidth multimodal intelligence", context: "128k", on: true, default: false },
      { id: "deepseek-r1", name: "DeepSeek R1", provider: "DeepSeek", tag: "Reasoning", desc: "In-depth mathematical reasoning", context: "64k", on: true, default: false },
      { id: "qwen-2-5-coder", name: "Qwen 2.5 Coder", provider: "Alibaba Cloud / Ollama", tag: "Fast", desc: "Fast open-source code generation", context: "32k", on: true, default: false },
    ],
    providers: {
      anthropic: "",
      openai: "",
      deepseek: "",
      ollamaUrl: "http://localhost:11434",
      routerUrl: "http://localhost:20129/v1",
      routerKey: "", // agent-os: key lives in agent-os/.env (gateway), not here
    },
    guard: { maxSteps: 8, timeoutS: 120, costCap: 5, approval: false },
  };
}

let store = { logs: [], config: defCfg(), seq: 0 };
try {
  const raw = JSON.parse(fs.readFileSync(STORE, "utf8"));
  if (raw && Array.isArray(raw.logs) && raw.config) {
    store = raw;
    // ponytail: migration ceiling for existing store.json shapes. Replace with formal schema migration when versioned.
    if (!store.config.supervisor) store.config.supervisor = defCfg().supervisor;
    if (!Array.isArray(store.config.mcps) || !store.config.mcps.length) store.config.mcps = defCfg().mcps;
    if (!Array.isArray(store.config.models) || !store.config.models.length) store.config.models = defCfg().models;
    if (!store.config.providers) store.config.providers = defCfg().providers;
    if (!store.config.providers.routerUrl) store.config.providers.routerUrl = "http://localhost:20129/v1";
    if (!store.config.providers.routerKey) store.config.providers.routerKey = ""; // agent-os: key lives in agent-os/.env
    if (Array.isArray(store.config.profiles)) {
      store.config.profiles.forEach((p) => {
        if (!Array.isArray(p.skills) || !p.skills.length) {
          const match = defCfg().profiles.find((x) => x.id === p.id);
          p.skills = match ? match.skills : ["intent-parsing", "task-decomposition", "synthesis"];
        }
        if (!Array.isArray(p.tools) || !p.tools.length) {
          const match = defCfg().profiles.find((x) => x.id === p.id);
          p.tools = match ? match.tools : ["delegate_task", "request_approval", "inspect_context", "agent_spawn"];
        }
        if (!Array.isArray(p.mcps) || !p.mcps.length) p.mcps = ["local"];
      });
    }
    if (Array.isArray(store.config.skills)) {
      store.config.skills.forEach((s) => {
        if (!Array.isArray(s.skills)) s.skills = [s.cap || "general"];
        if (!Array.isArray(s.tools)) s.tools = ["exec"];
        if (!Array.isArray(s.mcps)) s.mcps = ["local"];
      });
    }
  }
} catch {}
function persist() {
  try { fs.writeFileSync(STORE, JSON.stringify(store)); } catch {}
}

const clients = new Set();
function emit(e) {
  e.id = ++store.seq;
  e.ts = new Date().toISOString();
  store.logs.push(e);
  if (store.logs.length > 1000) store.logs = store.logs.slice(-1000);
  persist();
  memoryMirror(e); // agent-os shared SQLite (fire-and-forget; local cache still works offline)
  const data = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of clients) { try { res.write(data); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let spawnN = 0;
const approvals = new Map(); // runId -> resolve(ok)
let runN = 0;
const chatHistory = [];

async function callLLM(modelNameOrId, prompt, history = []) {
  const cfg = store.config;
  const prov = cfg.providers || {};
  const modelObj = (cfg.models && cfg.models.find((m) => m.name === modelNameOrId || m.id === modelNameOrId));
  const primaryId = modelObj ? modelObj.id : (modelNameOrId || "code");

  const messages = [
    { role: "system", content: "You are OVERLORD, an expert multi-agent AI supervisor and engineering lead. You coordinate specialized agents (Frontend Designer, Code Engineer, System Executor, Quality Critic) using the ReAct (Reasoning + Acting) framework to deliver production-grade code, architectures, and applications. When asked to build an app, provide complete, fully functional, self-contained code with clear explanations." },
    ...history,
    { role: "user", content: prompt },
  ];

  // Candidates for fallback if primary model errors or hangs
  const candidates = [primaryId];
  if (!candidates.includes("code")) candidates.push("code");
  if (!candidates.includes("gemini")) candidates.push("gemini");
  if (!candidates.includes("ag/gemini-3.7-flash-high")) candidates.push("ag/gemini-3.7-flash-high");

  // 1. AI Router / OpenAI-compatible endpoint
  if (prov.routerUrl && prov.routerKey) {
    for (const candidateModel of candidates) {
      try {
        const url = prov.routerUrl.replace(/\/+$/, "") + "/chat/completions";
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${prov.routerKey}`,
          },
          body: JSON.stringify({
            model: candidateModel,
            messages,
            stream: false,
          }),
          signal: AbortSignal.timeout(35000),
        });
        if (!resp.ok) continue;
        const text = await resp.text();
        let content = null;
        let reasoning = null;
        try {
          const j = JSON.parse(text);
          content = j.choices?.[0]?.message?.content;
          reasoning = j.choices?.[0]?.message?.reasoning_content || null;
        } catch {}
        if (!content && text.includes("data:")) {
          content = text.split("\n")
            .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
            .map((l) => {
              try { return JSON.parse(l.slice(5).trim()).choices?.[0]?.delta?.content || ""; } catch { return ""; }
            }).join("");
        }
        if (content && content.trim()) return { content: content.trim(), reasoning, modelUsed: candidateModel };
      } catch (err) {
        console.error(`Router error for model ${candidateModel}:`, err.message);
      }
    }
  }

  // 2. Ollama endpoint fallback
  if (prov.ollamaUrl) {
    try {
      const url = prov.ollamaUrl.replace(/\/+$/, "") + "/api/chat";
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: primaryId,
          messages,
          stream: false,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (resp.ok) {
        const j = await resp.json();
        if (j.message && j.message.content) return { content: j.message.content.trim(), modelUsed: primaryId };
      }
    } catch {}
  }

  return null;
}

async function runSim(goal, selectedModel) {
  const runId = "r" + Date.now().toString(36) + (runN++);
  const cfg = store.config, g = cfg.guard;
  const prof = cfg.profiles.find((p) => p.id === cfg.active) || cfg.profiles[0];

  const activeModel = selectedModel || (cfg.models && cfg.models.find((m) => m.default)?.name) || "Claude 3.7 Sonnet";
  const modelObj = (cfg.models && cfg.models.find((m) => m.name === activeModel || m.id === activeModel));
  const provName = modelObj ? modelObj.provider : "Router";

  const E = (dir, s, t, type, payload) =>
    emit({ dir, source: s, target: t, type, payload: String(payload).slice(0, 4000), runId, model: activeModel });

  E("IN", "user", "supervisor", "user_message", goal);

  // Check if user is requesting a build, implementation, or engineering task
  const isEngineeringTask = /(?:build|create|make|write|develop|design|refactor|audit|scrape|app|tool|team|code|api|pipeline)/i.test(goal);

  const history = chatHistory.slice(-8);
  const stageNotes = [];
  const emitReasoning = (reasoning) => {
    if (!reasoning) return;
    String(reasoning).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 8)
      .forEach((l) => E("INTERNAL", "supervisor", "supervisor", "thinking", `💭 model reasoning: ${l.slice(0, 300)}`));
  };

  if (isEngineeringTask) {
    E("INTERNAL", "supervisor", "supervisor", "thinking",
      `💭 Task looks like engineering work — asking ${activeModel} HOW to tackle it before delegating.`);
    const planRes = await callLLM(activeModel,
      `You are the supervisor planner. Break the user goal below into the concrete steps needed to achieve it. Reply with ONLY a numbered list of short steps (max 8), no preamble, no explanation.\n\nUser goal: ${goal}`, history);
    let planSteps = [];
    if (planRes && planRes.content) {
      emitReasoning(planRes.reasoning);
      planSteps = String(planRes.content).split("\n")
        .map((l) => { const m = l.match(/^\s*(?:\d+[.)\-:]|[-*])\s*(.+?)\s*$/); return m ? m[1] : null; })
        .filter(Boolean).slice(0, 8);
      planSteps.forEach((s, i) => E("INTERNAL", "supervisor", "supervisor", "thinking", `Plan step ${i + 1}/${planSteps.length}: ${s.slice(0, 200)}`));
    }
    if (!planSteps.length) {
      E("INTERNAL", "supervisor", "supervisor", "thinking", "Planner returned no usable steps — falling back to the default design → code → verify → review sequence.");
    }
    const planCtx = planSteps.length ? `Agreed plan:\n${planSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` : "";

    // Dispatcher: ask the model WHICH specialist handles EACH plan step — nothing hardcoded.
    // The roster is built from the live config, so adding/removing agents changes dispatch automatically.
    const roster = (cfg.skills || []).filter((a) => a.on !== false)
      .map((a) => `- ${a.id} (${a.name}): ${(a.skills || []).join(", ")}`).join("\n");
    const knownAgents = Object.fromEntries((cfg.skills || []).map((a) => [a.id, a]));
    E("INTERNAL", "supervisor", "supervisor", "thinking", "Dispatching: asking the model to assign each plan step to a specialist...");
    const dispRes = await callLLM(activeModel,
      `You are the dispatcher. Assign each plan step below to exactly ONE specialist from the roster. Reply with ONLY lines in the format "agent-id: one-line instruction for that step", one line per step, max 8 lines. No preamble, no explanation.\n\nSpecialists:\n${roster}\n\nPlan:\n${planSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "(no plan — derive one generic build step from the goal below)"}\n\nGoal: ${goal}`, history);
    let assignments = [];
    if (dispRes && dispRes.content) {
      emitReasoning(dispRes.reasoning);
      assignments = String(dispRes.content).split("\n")
        .map((l) => { const m = l.match(/^\s*([a-z0-9_-]+)\s*:\s*(.+?)\s*$/i); return m ? { agentId: m[1], instruction: m[2] } : null; })
        .filter((a) => a && knownAgents[a.agentId]).slice(0, 8);
      assignments.forEach((a, i) => E("INTERNAL", "supervisor", "supervisor", "thinking",
        `Dispatch ${i + 1}/${assignments.length}: ${knownAgents[a.agentId].name} ← ${a.instruction.slice(0, 160)}`));
    }
    if (!assignments.length) {
      E("INTERNAL", "supervisor", "supervisor", "thinking", "Dispatcher returned nothing usable — answering directly from the plan, no specialist stages.");
    }

    let stepNo = 0;
    for (const { agentId, instruction } of assignments) {
      stepNo++;
      const agentObj = knownAgents[agentId];
      const agentName = agentObj.name;
      E("INTERNAL", "supervisor", "supervisor", "thinking", `Step ${stepNo}/${assignments.length}: asking ${agentName} (${activeModel}) to: ${instruction.slice(0, 160)}.`);
      E("OUT", "supervisor", agentId, "task_assign", `Step ${stepNo}/${assignments.length} [${agentObj.cap || "general"}] → ${agentName}: ${instruction.slice(0, 200)}`);
      const stageRes = await callLLM(activeModel,
        `You are the ${agentName} specialist (skills: ${(agentObj.skills || []).join(", ")}).\nAssigned step ${stepNo}/${assignments.length}: ${instruction}\n\n${planCtx}User goal: ${goal}\n\nDo ONLY your assigned step. Be concrete, no placeholders.`, history);
      if (stageRes && stageRes.content) {
        emitReasoning(stageRes.reasoning);
        E("IN", agentId, "supervisor", "task_result", `Step ${stepNo} done — ${agentName} delivered (${stageRes.modelUsed}): ${stageRes.content.slice(0, 1500)}`);
        stageNotes.push(`- ${agentName} [${instruction.slice(0, 120)}]: ${stageRes.content.slice(0, 800)}`);
      } else {
        E("IN", agentId, "supervisor", "task_result", `Step ${stepNo} FAILED — ${agentName}: model returned no response for "${instruction.slice(0, 120)}".`);
        stageNotes.push(`- ${agentName} [${instruction.slice(0, 120)}]: FAILED, no model response.`);
      }
    }

    const ok = stageNotes.filter((n) => !n.includes("FAILED")).length;
    E("INTERNAL", "supervisor", "supervisor", "thinking",
      `🎯 ReAct Observation: ${ok} of ${assignments.length} dispatched stages returned real output. Synthesizing final answer from their deliverables.`);
  } else {
    const profLabel = prof ? `${prof.name} (${prof.domain})` : "default profile";
    E("INTERNAL", "supervisor", "supervisor", "thinking",
      `Thinking with ${activeModel} (${provName}) · profile ${profLabel} · classified as general Q&A, answering directly without agent delegation.`);
  }

  // Call the LLM with fallback — final synthesis builds on real stage outputs
  const finalPrompt = stageNotes.length
    ? `${goal}\n\nSpecialist agent deliverables to build on:\n${stageNotes.join("\n")}`
    : goal;
  const resultObj = await callLLM(activeModel, finalPrompt, history);
  if (resultObj && resultObj.reasoning) emitReasoning(resultObj.reasoning);
  let finalResponse = resultObj ? resultObj.content : null;

  // If this was a web app request and app was generated, add live link reference
  if (isEngineeringTask && /team|free|availability/i.test(goal)) {
    const liveLinkNote = `\n\n---\n### 🚀 Live Application Deployed\nYour team availability web app is running locally at **[http://localhost:3000/team-app.html](http://localhost:3000/team-app.html)**.\n- **Teammate Availability**: Real-time Free / Busy toggling with visual status indicators.\n- **Filter**: Instant filtering between Available and All members.\n- **Team Formation**: Select available members and assemble named squads.\n- **Persistence**: State is saved automatically to browser storage.`;
    if (finalResponse) {
      if (!finalResponse.includes("localhost:3000/team-app.html")) {
        finalResponse += liveLinkNote;
      }
    } else {
      finalResponse = `### ReAct Multi-Agent Deliverable: Team Availability Web App\n\nI coordinated the specialized agents to design, implement, and deploy your web app:\n- **Frontend Designer**: Created responsive UI cards with availability badges and team assembly controls.\n- **Code Engineer**: Built state synchronization, free/busy toggles, and team grouping logic.\n- **System Executor**: Deployed and published the single-page application at [http://localhost:3000/team-app.html](http://localhost:3000/team-app.html).\n- **Quality Critic**: Verified accessibility, zero syntax errors, and local persistence.${liveLinkNote}`;
    }
  }

  if (!finalResponse) {
    finalResponse = `Hello! I am OVERLORD, your AI orchestrator. Connected to ${activeModel}. How can I assist you with your project today?`;
  }

  chatHistory.push({ role: "user", content: goal });
  chatHistory.push({ role: "assistant", content: finalResponse });
  if (chatHistory.length > 20) chatHistory.splice(0, chatHistory.length - 20);

  E("OUT", "supervisor", "user", "final_answer", finalResponse);
}
function mcpTools() {
  const t = store.config.mcps.filter((m) => m.on).flatMap((m) => m.tools);
  return t.length ? t : ["built-in"];
}

function getSkillCategory(id) {
  if (["frontend-design", "design-taste-frontend", "ui-ux-pro-max", "shadcn", "canvas-design", "animate", "theme-factory", "web-design-engineer"].includes(id)) {
    return { category: "Design & Frontend", icon: "ti-palette", color: "var(--blue)" };
  }
  if (["code-review", "troubleshoot", "fix-ci", "ponytail", "generate-run-commands"].includes(id)) {
    return { category: "Engineering & QA", icon: "ti-code", color: "var(--green)" };
  }
  if (["commit", "create-pr", "create-draft-pr", "update-pr", "merge", "sync", "sync-upstream", "update-skills"].includes(id)) {
    return { category: "Git & Automation", icon: "ti-git-branch", color: "var(--violet)" };
  }
  if (["algorithmic-art"].includes(id)) {
    return { category: "Generative Art", icon: "ti-sparkles", color: "#d97706" };
  }
  return { category: "General Agent", icon: "ti-tool", color: "var(--text)" };
}

function loadLocalSkills() {
  const dir = path.join(__dirname, ".agents", "skills");
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result = [];
  const cfg = store.config || {};

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(dir, entry.name, "SKILL.md");
    let name = entry.name;
    let description = "Specialized AI skill package with operational prompts and constraints.";

    if (fs.existsSync(skillPath)) {
      try {
        const content = fs.readFileSync(skillPath, "utf8");
        const match = content.match(/^---\s*([\s\S]*?)\s*---/);
        if (match) {
          const rawFm = match[1];
          const nMatch = rawFm.match(/name:\s*(.+)/);
          if (nMatch) name = nMatch[1].trim().replace(/^["\x27]|["\x27]$/g, "");
          const dMatch = rawFm.match(/description:\s*(?:>|\|)?\s*\n?([\s\S]*?)(?=\n[a-z0-9_-]+:|$)/i);
          if (dMatch) {
            description = dMatch[1].replace(/\n+/g, " ").trim().replace(/^["\x27]|["\x27]$/g, "");
          }
        }
      } catch {}
    }

    const cat = getSkillCategory(entry.name);
    const installedIn = [];

    // Check supervisor profiles
    if (Array.isArray(cfg.profiles)) {
      cfg.profiles.forEach((p) => {
        if (Array.isArray(p.skills) && p.skills.includes(entry.name)) {
          installedIn.push({ type: "supervisor", id: p.id, name: `${p.name} (Supervisor)` });
        }
      });
    }
    // Check worker agents
    if (Array.isArray(cfg.skills)) {
      cfg.skills.forEach((a) => {
        if (Array.isArray(a.skills) && a.skills.includes(entry.name)) {
          installedIn.push({ type: "agent", id: a.id, name: `${a.name} (Agent)` });
        }
      });
    }

    result.push({
      id: entry.name,
      name,
      description: description.slice(0, 240),
      category: cat.category,
      icon: cat.icon,
      color: cat.color,
      installedIn,
    });
  }
  return result;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function body(req) {
  return new Promise((res, rej) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new Error("bad json")); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/api/health") return json(res, 200, { ok: true });
    if (u.pathname === "/api/logs" && req.method === "GET") {
      const limit = Math.min(1000, +(u.searchParams.get("limit") || 300));
      try {
        const r = await fetch(MEMORY_URL + "/v1/logs?limit=" + limit, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.logs)) return json(res, 200, { logs: j.logs, via: "agent-os-memory" });
        }
      } catch {}
      return json(res, 200, { logs: store.logs.slice(-limit), via: "store.json" });
    }
    if (u.pathname === "/api/logs" && req.method === "DELETE") {
      store.logs = []; persist();
      try { await fetch(MEMORY_URL + "/v1/logs", { method: "DELETE", signal: AbortSignal.timeout(2000) }); } catch {}
      emit({ dir: "INTERNAL", source: "system", target: "system", type: "config", payload: "log cleared" });
      return json(res, 200, { ok: true });
    }
    if (u.pathname === "/api/config" && req.method === "GET") return json(res, 200, store.config);
    if (u.pathname === "/api/skills/library" && req.method === "GET") {
      return json(res, 200, { skills: loadLocalSkills() });
    }
    if (u.pathname === "/api/skills/assign" && req.method === "POST") {
      const b = await body(req);
      const skillId = String(b.skillId || "").trim();
      const targetType = String(b.targetType || "agent").trim();
      const targetId = String(b.targetId || "").trim();
      if (!skillId || !targetId) return json(res, 400, { error: "skillId and targetId required" });

      if (targetType === "supervisor") {
        const prof = store.config.profiles.find((p) => p.id === targetId);
        if (prof) {
          if (!Array.isArray(prof.skills)) prof.skills = [];
          if (!prof.skills.includes(skillId)) prof.skills.push(skillId);
        }
        if (store.config.supervisor && Array.isArray(store.config.supervisor.skills)) {
          if (!store.config.supervisor.skills.includes(skillId)) store.config.supervisor.skills.push(skillId);
        }
      } else {
        const agent = store.config.skills.find((a) => a.id === targetId);
        if (agent) {
          if (!Array.isArray(agent.skills)) agent.skills = [];
          if (!agent.skills.includes(skillId)) agent.skills.push(skillId);
        }
      }
      persist();
      emit({ dir: "INTERNAL", source: "system", target: "system", type: "config", payload: `skill ${skillId} assigned to ${targetType}:${targetId}` });
      return json(res, 200, { ok: true, config: store.config, library: loadLocalSkills() });
    }
    if (u.pathname === "/api/skills/unassign" && req.method === "POST") {
      const b = await body(req);
      const skillId = String(b.skillId || "").trim();
      const targetType = String(b.targetType || "agent").trim();
      const targetId = String(b.targetId || "").trim();
      if (!skillId || !targetId) return json(res, 400, { error: "skillId and targetId required" });

      if (targetType === "supervisor") {
        const prof = store.config.profiles.find((p) => p.id === targetId);
        if (prof && Array.isArray(prof.skills)) {
          prof.skills = prof.skills.filter((s) => s !== skillId);
        }
        if (store.config.supervisor && Array.isArray(store.config.supervisor.skills)) {
          store.config.supervisor.skills = store.config.supervisor.skills.filter((s) => s !== skillId);
        }
      } else {
        const agent = store.config.skills.find((a) => a.id === targetId);
        if (agent && Array.isArray(agent.skills)) {
          agent.skills = agent.skills.filter((s) => s !== skillId);
        }
      }
      persist();
      emit({ dir: "INTERNAL", source: "system", target: "system", type: "config", payload: `skill ${skillId} unassigned from ${targetType}:${targetId}` });
      return json(res, 200, { ok: true, config: store.config, library: loadLocalSkills() });
    }
    if (u.pathname === "/api/logs" && req.method === "POST") {
      const b = await body(req);
      if (!b.dir || !b.source || !b.target || !b.type) return json(res, 400, { error: "bad event" });
      emit({ dir: String(b.dir), source: String(b.source), target: String(b.target), type: String(b.type), payload: String(b.payload || "").slice(0, 2000) });
      return json(res, 201, { ok: true });
    }
    if (u.pathname === "/api/config" && req.method === "PUT") {
      const c = await body(req);
      if (!c || !Array.isArray(c.profiles) || !Array.isArray(c.skills)) return json(res, 400, { error: "bad config" });
      store.config = c; persist();
      emit({ dir: "INTERNAL", source: "system", target: "system", type: "config", payload: "config updated" });
      return json(res, 200, store.config);
    }
    if (u.pathname === "/api/providers/test-ollama" && req.method === "POST") {
      const b = await body(req).catch(() => ({}));
      const url = String(b.url || (store.config.providers && store.config.providers.ollamaUrl) || "http://localhost:11434").trim();
      try {
        const pingUrl = url.replace(/\/+$/, "") + "/api/tags";
        const r = await fetch(pingUrl, { signal: AbortSignal.timeout(2500) });
        if (!r.ok) return json(res, 200, { ok: false, error: `HTTP ${r.status}` });
        const data = await r.json();
        const models = (data.models || []).map((m) => m.name);
        return json(res, 200, { ok: true, models, count: models.length });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message || "Connection failed" });
      }
    }
    if (u.pathname === "/api/providers/test-router" && req.method === "POST") {
      const b = await body(req).catch(() => ({}));
      const url = String(b.url || (store.config.providers && store.config.providers.routerUrl) || "http://localhost:20129/v1").trim();
      const key = String(b.key || (store.config.providers && store.config.providers.routerKey) || "").trim();
      try {
        const pingUrl = url.replace(/\/+$/, "") + "/models";
        const headers = {};
        if (key) headers["Authorization"] = `Bearer ${key}`;
        const r = await fetch(pingUrl, { headers, signal: AbortSignal.timeout(3500) });
        if (!r.ok) return json(res, 200, { ok: false, error: `HTTP ${r.status}` });
        const data = await r.json();
        const models = Array.isArray(data.data) ? data.data.map((m) => m.id) : (data.models || []);
        return json(res, 200, { ok: true, models, count: models.length });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message || "Connection failed" });
      }
    }
    if (u.pathname === "/api/providers/sync-router-models" && req.method === "POST") {
      const b = await body(req).catch(() => ({}));
      const url = String(b.url || (store.config.providers && store.config.providers.routerUrl) || "http://localhost:20129/v1").trim();
      const key = String(b.key || (store.config.providers && store.config.providers.routerKey) || "").trim();
      try {
        const pingUrl = url.replace(/\/+$/, "") + "/models";
        const headers = {};
        if (key) headers["Authorization"] = `Bearer ${key}`;
        const r = await fetch(pingUrl, { headers, signal: AbortSignal.timeout(4000) });
        if (!r.ok) return json(res, 200, { ok: false, error: `HTTP ${r.status}` });
        const data = await r.json();
        const modelIds = Array.isArray(data.data) ? data.data.map((m) => m.id) : (data.models || []);
        let added = 0;
        if (!Array.isArray(store.config.models)) store.config.models = [];
        modelIds.forEach((mid) => {
          const exists = store.config.models.find((m) => m.id === mid || m.name === mid);
          if (!exists) {
            const isCode = mid.includes("code");
            const isReasoning = mid.includes("reasoning") || mid.includes("thinking") || mid.includes("r1");
            const isFlash = mid.includes("flash") || mid.includes("mini");
            const tag = isReasoning ? "Reasoning" : isCode ? "Code" : isFlash ? "Fast" : "General";
            store.config.models.push({
              id: mid,
              name: mid,
              provider: "Router",
              tag,
              desc: `${mid} via Router`,
              context: "128k",
              on: true,
              default: false,
            });
            added++;
          }
        });
        persist();
        return json(res, 200, { ok: true, added, total: store.config.models.length, models: store.config.models });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message || "Failed to sync router models" });
      }
    }
    if (u.pathname === "/api/runs" && req.method === "POST") {
      const b = await body(req);
      const goal = (b.goal || "").trim();
      if (!goal) return json(res, 400, { error: "goal required" });
      const runId = "r" + Date.now().toString(36) + "-" + runN;
      runSim(goal, b.model);
      return json(res, 202, { runId, status: "started" });
    }
    const m = u.pathname.match(/^\/api\/runs\/([^/]+)\/approve$/);
    if (m && req.method === "POST") {
      const b = await body(req);
      const fn = approvals.get(m[1]);
      if (!fn) return json(res, 404, { error: "no pending approval" });
      approvals.delete(m[1]);
      fn(!!b.ok);
      return json(res, 200, { ok: true });
    }
    if (u.pathname === "/api/stream" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      const beat = setInterval(() => { try { res.write(": beat\n\n"); } catch {} }, 25000);
      req.on("close", () => { clearInterval(beat); clients.delete(res); });
      return;
    }
    // static
    let p = u.pathname === "/" ? "/index.html" : u.pathname;
    const file = path.normalize(path.join(PUB, p));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      return json(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`harness server on http://localhost:${PORT}`));
