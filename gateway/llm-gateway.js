// agent-os LLM gateway — OpenCode-only, free-model allowlisted, fail-closed.
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  configuredFreeModels,
  selectModel,
  runOpenCode,
  OpenCodeGatewayError,
} = require("./opencode-client");

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
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
const TOKENS = new Map();
if (process.env.AGENT_OS_TOKEN) TOKENS.set(process.env.AGENT_OS_TOKEN, "admin");
for (const part of (process.env.AGENT_OS_TOKENS || "").split(",")) {
  const i = part.indexOf(":");
  if (i > 0 && ROLE_RANK[part.slice(i + 1).trim()]) {
    TOKENS.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
}
if (!TOKENS.size) {
  console.error("FATAL: AGENT_OS_TOKEN is not set. Run: python agent-os/python/make_token.py");
  process.exit(1);
}

function roleOf(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/);
  return (m && TOKENS.get(m[1])) || null;
}

const RPM = Math.max(1, +(process.env.RATE_LIMIT_RPM || 120));
const _rl = new Map();
function rateLimited(key) {
  const now = Date.now();
  let e = _rl.get(key);
  if (!e || now - e.start >= 60000) {
    e = { start: now, count: 0 };
    _rl.set(key, e);
    if (_rl.size > 10000) _rl.clear();
  }
  e.count++;
  return e.count > RPM ? Math.ceil((60000 - (now - e.start)) / 1000) : 0;
}
function rlKey(req, role) {
  if (role) return "tok:" + role + ":" + (req.headers.authorization || "").slice(-8);
  return "ip:" + (req.socket.remoteAddress || "?");
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > 1024 * 1024) {
        tooLarge = true;
        reject(new OpenCodeGatewayError("request_too_large", "Request body exceeds 1 MiB.", 413));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new OpenCodeGatewayError("bad_json", "Request body must be valid JSON.", 400)); }
    });
    req.on("error", () => reject(new OpenCodeGatewayError("request_read_failed", "Unable to read request body.", 400)));
  });
}

function json(res, code, value) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

async function generate(model, messages) {
  const selected = selectModel(model, messages);
  return runOpenCode(messages, { model: selected.model });
}

async function handler(req, res) {
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname === "/health" && req.method === "GET") {
      let models = [];
      let configurationError = null;
      try { models = configuredFreeModels(); }
      catch (error) { configurationError = error.code || "invalid_model_allowlist"; }
      return json(res, 200, {
        ok: true,
        provider: "opencode",
        configured: models.length > 0 && !configurationError,
        modelCount: models.length,
        configurationError,
      });
    }

    const role = roleOf(req);
    if (!role) return json(res, 401, { error: "unauthorized: Bearer AGENT_OS_TOKEN required", code: "unauthorized" });

    const retry = rateLimited(rlKey(req, role));
    if (retry) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": String(retry),
      });
      res.end(JSON.stringify({ error: "rate limited, retry later", code: "rate_limited" }));
      return;
    }

    if (ROLE_RANK[role] < ROLE_RANK.operator) {
      return json(res, 403, { error: "forbidden: operator role required", code: "forbidden" });
    }

    if (u.pathname === "/v1/models" && req.method === "GET") {
      let models;
      try { models = configuredFreeModels(); }
      catch (error) { return json(res, 500, { error: error.message, code: error.code }); }
      return json(res, 200, { data: models.map((id) => ({ id, object: "model", owned_by: "opencode" })) });
    }

    if ((u.pathname === "/v1/chat" || u.pathname === "/v1/chat/completions") && req.method === "POST") {
      const b = await body(req);
      if (!Array.isArray(b.messages) || b.messages.length === 0) {
        return json(res, 400, { error: "messages must be a non-empty array", code: "invalid_messages" });
      }

      const result = await generate(b.model || "auto", b.messages);
      if (u.pathname === "/v1/chat") {
        return json(res, 200, {
          content: result.content,
          reasoning: result.reasoning,
          via: result.via,
          model: result.model,
          usage: result.usage,
        });
      }
      return json(res, 200, {
        choices: [{ message: { role: "assistant", content: result.content, reasoning_content: null } }],
        usage: {
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
        },
        cost_usd: result.usage.cost_usd,
        via: result.via,
        model: result.model,
      });
    }

    return json(res, 404, { error: "not found", code: "not_found" });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
    const code = error.code || "gateway_error";
    return json(res, status, {
      error: error.message || "OpenCode request failed.",
      code,
      provider: "opencode",
    });
  }
}

const TLS_CERT = process.env.TLS_CERT || "";
const TLS_KEY = process.env.TLS_KEY || "";
let server;
if (TLS_CERT && TLS_KEY) {
  server = require("https").createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  }, handler);
} else {
  server = http.createServer(handler);
}
const SCHEME = (TLS_CERT && TLS_KEY) ? "https" : "http";
server.listen(PORT, () => {
  let count = 0;
  try { count = configuredFreeModels().length; } catch {}
  console.log("agent-os OpenCode gateway on " + SCHEME + "://localhost:" + PORT + " (allowlisted models=" + count + ")");
});

// Graceful shutdown: stop accepting, let in-flight upstream calls finish briefly, exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("received " + signal + ", draining...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
