"use strict";

const { spawn } = require("node:child_process");

const MODEL_ID = /^(opencode|opencode-go)\/[A-Za-z0-9._/-]+$/;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

class OpenCodeGatewayError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = "OpenCodeGatewayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function configuredFreeModels(env = process.env) {
  const raw = String(env.OPENCODE_FREE_MODELS || "");
  const models = raw.split(",").map((x) => x.trim()).filter(Boolean);
  const invalid = models.filter((model) => !MODEL_ID.test(model));
  if (invalid.length) {
    throw new OpenCodeGatewayError("invalid_model_allowlist",
      "OPENCODE_FREE_MODELS contains an invalid model identifier.", 500);
  }
  return [...new Set(models)];
}

function classifyComplexity(messages) {
  const userText = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === "user")
    .map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""))
    .join("\n");
  const length = userText.length;
  const signals = /\b(architecture|threat model|security audit|debug|refactor|root cause|benchmark|compare|evaluate|research|design a system|multi-step|migration|production)\b/i.test(userText);
  const highComplexity = /\b(architecture|threat model|security audit|root cause|benchmark|migration|design a system|formal proof|incident investigation|security review)\b/i.test(userText);
  if (highComplexity || length > 6000 || (length > 1800 && signals) || (signals && (userText.match(/\n/g) || []).length > 12)) {
    return "reasoning";
  }
  if (length < 700 && !signals) return "fast";
  return "standard";
}

function selectModel(requested, messages, env = process.env) {
  const allowed = configuredFreeModels(env);
  if (allowed.length === 0) {
    throw new OpenCodeGatewayError("model_not_configured",
      "No OpenCode free models are configured. Verify the current OpenCode model catalogue and set OPENCODE_FREE_MODELS.", 503);
  }

  let model = typeof requested === "string" ? requested.trim() : "";
  if (!model || model.toLowerCase() === "auto") {
    const complexity = classifyComplexity(messages);
    const preference = complexity === "reasoning"
      ? env.OPENCODE_REASONING_MODEL
      : complexity === "fast"
        ? env.OPENCODE_FAST_MODEL
        : env.OPENCODE_STANDARD_MODEL;
    model = preference || env.OPENCODE_DEFAULT_MODEL || (allowed.length === 1 ? allowed[0] : "");
  }

  if (!model) {
    throw new OpenCodeGatewayError("default_model_not_configured",
      "Set OPENCODE_DEFAULT_MODEL or configure a model for each complexity tier.", 503);
  }
  if (!allowed.includes(model)) {
    throw new OpenCodeGatewayError("model_not_allowlisted",
      "The requested model is not in the explicit OpenCode free-model allowlist.", 403);
  }
  return { model, complexity: classifyComplexity(messages) };
}

function serializeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new OpenCodeGatewayError("invalid_messages", "messages must be a non-empty array.", 400);
  }
  const serialized = messages.map((message, index) => {
    if (!message || !["system", "user", "assistant"].includes(message.role)) {
      throw new OpenCodeGatewayError("invalid_messages",
        "messages[" + index + "] has an unsupported role.", 400);
    }
    const content = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content ?? "");
    return "### " + message.role.toUpperCase() + "\n" + content;
  });
  return [
    "You are the text-generation component of OVERLORD.",
    "Return only the assistant response required by the conversation.",
    "You do not have permission to call tools, inspect files, execute commands, or perform side effects.",
    "",
    serialized.join("\n\n"),
  ].join("\n");
}

function parseOpenCodeEvents(stdout) {
  const textParts = new Map();
  const finishParts = new Map();
  let eventError = false;
  let toolAttempted = false;

  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }

    const part = event.part || event.properties?.part || {};
    if (event.type === "error" || part.type === "error") eventError = true;
    if (
      event.type === "tool_use" ||
      event.type === "tool" ||
      part.type === "tool" ||
      event.type === "session.tool.called"
    ) toolAttempted = true;

    if (
      (event.type === "text" || event.type === "message.part.updated" || event.type === "session.text.delta") &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      textParts.set(String(part.id || textParts.size), part.text);
    }

    if (event.type === "step_finish" || event.type === "step-finish") {
      const tokens = part.tokens || {};
      const reportedCost = Number(part.cost);
      finishParts.set(String(part.id || finishParts.size), {
        prompt_tokens: Math.max(0, Number(tokens.input) || 0),
        completion_tokens: Math.max(0, Number(tokens.output) || 0),
        cost_usd: Number.isFinite(reportedCost) ? Math.max(0, reportedCost) : null,
        cost_known: Number.isFinite(reportedCost),
      });
    }
  }

  const usage = [...finishParts.values()].reduce((total, item) => ({
    prompt_tokens: total.prompt_tokens + item.prompt_tokens,
    completion_tokens: total.completion_tokens + item.completion_tokens,
    cost_usd: total.cost_usd + (item.cost_usd == null ? 0 : item.cost_usd),
    cost_known: total.cost_known && item.cost_known,
  }), { prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, cost_known: true });

  return {
    content: [...textParts.values()].join(""),
    usage,
    hasUsage: finishParts.size > 0,
    costKnown: finishParts.size > 0 && usage.cost_known,
    eventError,
    toolAttempted,
  };
}

function runOpenCode(messages, options = {}) {
  const env = options.env || process.env;
  const spawnImpl = options.spawnImpl || spawn;
  const model = options.model;
  const allowed = configuredFreeModels(env);
  if (!allowed.includes(model)) {
    return Promise.reject(new OpenCodeGatewayError(
      "model_not_allowlisted",
      "The requested model is not in the explicit OpenCode free-model allowlist.",
      403
    ));
  }

  let prompt;
  try { prompt = serializeMessages(messages); } catch (error) { return Promise.reject(error); }

  const binary = env.OPENCODE_CLI || "opencode";
  const agent = env.OPENCODE_AGENT || "overlord-model";
  const cwd = env.OPENCODE_WORKDIR || process.cwd();
  const timeoutMs = Math.max(1000, Math.min(300000, Number(env.OPENCODE_TIMEOUT_MS) || 90000));
  const maxCost = env.OPENCODE_MAX_COST_USD == null ? 0 : Number(env.OPENCODE_MAX_COST_USD);
  if (!Number.isFinite(maxCost) || maxCost < 0) {
    return Promise.reject(new OpenCodeGatewayError(
      "invalid_cost_limit", "OPENCODE_MAX_COST_USD must be a non-negative number.", 500));
  }

  const args = ["run", "--format", "json", "--model", model, "--agent", agent, "--dir", cwd];
  if (env.OPENCODE_VARIANT) args.push("--variant", env.OPENCODE_VARIANT);
  args.push(prompt);

  return new Promise((resolve, reject) => {
    let child;
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;

    const settle = (fn, value, kill = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (kill && child && !child.killed) {
        try { child.kill("SIGKILL"); } catch {}
      }
      fn(value);
    };

    try {
      child = spawnImpl(binary, args, {
        cwd,
        env: { ...env },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle(reject, new OpenCodeGatewayError(
        "opencode_spawn_failed",
        "Unable to start the OpenCode CLI. Check OPENCODE_CLI and the installed runtime.",
        503
      ));
      return;
    }

    timer = setTimeout(() => settle(reject, new OpenCodeGatewayError(
      "opencode_timeout",
      "OpenCode exceeded the " + timeoutMs + "ms request timeout.",
      504
    ), true), timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        settle(reject, new OpenCodeGatewayError(
          "opencode_output_too_large",
          "OpenCode output exceeded the configured response limit.",
          502
        ), true);
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) {
        settle(reject, new OpenCodeGatewayError(
          "opencode_stderr_too_large",
          "OpenCode emitted excessive diagnostic output.",
          502
        ), true);
      }
    });

    child.on("error", () => settle(reject, new OpenCodeGatewayError(
      "opencode_spawn_failed",
      "Unable to start the OpenCode CLI. Check OPENCODE_CLI and the installed runtime.",
      503
    )));

    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        settle(reject, new OpenCodeGatewayError(
          "opencode_failed",
          "OpenCode exited with status " + (code == null ? "unknown" : code) + ". No fallback provider was used.",
          502
        ));
        return;
      }

      const parsed = parseOpenCodeEvents(stdout);
      if (parsed.eventError) {
        settle(reject, new OpenCodeGatewayError(
          "opencode_event_error", "OpenCode reported an execution error.", 502));
        return;
      }
      if (parsed.toolAttempted) {
        settle(reject, new OpenCodeGatewayError(
          "opencode_tool_execution_blocked",
          "The OpenCode text agent attempted a tool call; the response was rejected.",
          502
        ));
        return;
      }
      if (!parsed.content.trim()) {
        settle(reject, new OpenCodeGatewayError(
          "opencode_empty_response", "OpenCode returned no text response.", 502));
        return;
      }
      if (!parsed.hasUsage || !parsed.costKnown) {
        settle(reject, new OpenCodeGatewayError(
          "model_cost_unavailable",
          "OpenCode did not report verifiable usage cost; the response was rejected.",
          502
        ));
        return;
      }
      if (parsed.usage.cost_usd > maxCost) {
        settle(reject, new OpenCodeGatewayError(
          "model_cost_limit_exceeded",
          "OpenCode reported a cost above OPENCODE_MAX_COST_USD; the response was rejected.",
          502
        ));
        return;
      }

      settle(resolve, {
        content: parsed.content.trim(),
        reasoning: null,
        via: "opencode",
        model,
        usage: {
          prompt_tokens: parsed.usage.prompt_tokens,
          completion_tokens: parsed.usage.completion_tokens,
          cost_usd: parsed.hasUsage ? parsed.usage.cost_usd : null,
        },
      });
    });
  });
}

module.exports = {
  OpenCodeGatewayError,
  configuredFreeModels,
  classifyComplexity,
  selectModel,
  serializeMessages,
  parseOpenCodeEvents,
  runOpenCode,
};