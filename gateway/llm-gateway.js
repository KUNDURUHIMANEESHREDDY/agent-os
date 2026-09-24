// agent-os LLM gateway — single LLM entry for saber + loom + prompt-chain.
// Replaces direct calls:
//  - saber/server.js callLLM() -> POST /v1/chat/completions (OpenAI-compatible)
//  - loom/core/engine.py LLMClient -> POST /v1/chat {model, messages}
//  - prompt-chain/server callGeminiAPI() -> POST /v1/chat {model, messages}
// Chain: upstream router (ROUTER_KEY) -> ollama -> mock. Never 500s on LLM path.
// Zero dependencies (node builtins only, same style as saber/server.js).
const http = require("http");
const fs = require("fs");
const path = require("path");

// Load agent-os/.env (gitignored) FIRST so it can provide URLs and tokens.
(function loadEnvFile() {
  try {
    const f = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  } catch {}
})();

const PORT = process.env.GATEWAY_PORT || 20129;
const ROUTER_URL = (process.env.ROUTER_URL || "http://localhost:20128/v1").replace(/\/+$/, "");
const ROUTER_KEY = process.env.ROUTER_KEY || "";
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
// Fail closed: no token, no server. Generate with python agent-os/python/make_token.py
const AUTH_TOKEN = process.env.AGENT_OS_TOKEN || "";
if (!AUTH_TOKEN) {
  console.error("FATAL: AGENT_OS_TOKEN is not set. Run: python agent-os/python/make_token.py");
  process.exit(1);
}
function authed(req) {
  const h = req.headers.authorization || "";
  return h === `Bearer ${AUTH_TOKEN}`;
}

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

async function tryRouter(model, messages) {
  if (!ROUTER_KEY) return null;
  try {
    const r = await fetch(ROUTER_URL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ROUTER_KEY },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(35000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content;
    const reasoning = j.choices?.[0]?.message?.reasoning_content || null;
    if (content?.trim()) return { content: content.trim(), reasoning, via: "router", model };
  } catch {}
  return null;
}

async function tryOllama(model, messages) {
  try {
    const r = await fetch(OLLAMA_URL + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.message?.content?.trim()) return { content: j.message.content.trim(), reasoning: null, via: "ollama", model };
  } catch {}
  return null;
}

function mockReply(model, messages) {
  const last = (messages[messages.length - 1]?.content || "").slice(0, 200);
  return { content: `[mock:${model}] no upstream configured. Set ROUTER_KEY in agent-os/.env or run ollama. Last input: ${last}`, reasoning: null, via: "mock", model };
}

async function resolve(model, messages) {
  return (await tryRouter(model, messages)) ||
    (await tryOllama(model, messages)) ||
    mockReply(model, messages);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/health") return json(res, 200, { ok: true, router: !!ROUTER_KEY, routerUrl: ROUTER_URL, ollama: OLLAMA_URL });
    // Authenticated from here on (/health stays open for probes, leaks nothing)
    if (!authed(req)) return json(res, 401, { error: "unauthorized: Bearer AGENT_OS_TOKEN required" });
    // Simple contract for loom + prompt-chain
    if (u.pathname === "/v1/chat" && req.method === "POST") {
      const b = await body(req);
      const model = b.model || "mock";
      const messages = b.messages || [];
      return json(res, 200, await resolve(model, messages));
    }
    // OpenAI-compatible contract for saber callLLM()
    if (u.pathname === "/v1/chat/completions" && req.method === "POST") {
      const b = await body(req);
      const model = b.model || "mock";
      const messages = b.messages || [];
      const r = await resolve(model, messages);
      return json(res, 200, {
        choices: [{ message: { role: "assistant", content: r.content, reasoning_content: r.reasoning } }],
        via: r.via,
        model: r.model,
      });
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`agent-os llm-gateway on http://localhost:${PORT} (router=${ROUTER_URL})`));
