"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  configuredFreeModels,
  classifyComplexity,
  selectModel,
  serializeMessages,
  parseOpenCodeEvents,
  buildOpenCodeEnv,
  runOpenCode,
} = require("./opencode-client");

const baseEnv = {
  OPENCODE_FREE_MODELS: "opencode/free-fast,opencode-go/free-reasoning",
  OPENCODE_DEFAULT_MODEL: "opencode/free-fast",
  OPENCODE_REASONING_MODEL: "opencode-go/free-reasoning",
  OPENCODE_MAX_COST_USD: "0",
  OPENCODE_TIMEOUT_MS: "5000",
};

test("free-model allowlist accepts only explicit OpenCode provider IDs", () => {
  assert.deepEqual(configuredFreeModels(baseEnv), [
    "opencode/free-fast",
    "opencode-go/free-reasoning",
  ]);
  assert.throws(() => configuredFreeModels({
    OPENCODE_FREE_MODELS: "openai/paid-model",
  }), { code: "invalid_model_allowlist" });
});

test("unconfigured and non-allowlisted models fail closed", () => {
  assert.throws(() => selectModel("auto", [], {}), { code: "model_not_configured" });
  assert.throws(() => selectModel("openai/paid-model", [], baseEnv), {
    code: "model_not_allowlisted",
  });
});

test("complexity routing chooses only an allowlisted reasoning model", () => {
  const messages = [{
    role: "user",
    content: "Design a production system architecture, security audit, migration and recovery plan.",
  }];
  assert.equal(classifyComplexity(messages), "reasoning");
  assert.deepEqual(selectModel("auto", messages, baseEnv), {
    model: "opencode-go/free-reasoning",
    complexity: "reasoning",
  });
});

test("OpenCode child environment excludes application secrets", () => {
  const childEnv = buildOpenCodeEnv({
    PATH: "/usr/bin",
    HOME: "/home/test",
    OPENCODE_CONFIG: "/home/test/config.json",
    AGENT_OS_TOKEN: "do-not-forward",
    DATABASE_URL: "postgres://secret",
    SUPABASE_SERVICE_ROLE_KEY: "do-not-forward",
    OPENAI_API_KEY: "do-not-forward",
  });
  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.HOME, "/home/test");
  assert.equal(childEnv.OPENCODE_CONFIG, "/home/test/config.json");
  assert.equal("AGENT_OS_TOKEN" in childEnv, false);
  assert.equal("DATABASE_URL" in childEnv, false);
  assert.equal("SUPABASE_SERVICE_ROLE_KEY" in childEnv, false);
  assert.equal("OPENAI_API_KEY" in childEnv, false);
});

test("message serialization preserves roles and blocks tool-use authority", () => {
  const prompt = serializeMessages([
    { role: "system", content: "system instruction" },
    { role: "user", content: "user request" },
  ]);
  assert.match(prompt, /SYSTEM/);
  assert.match(prompt, /USER/);
  assert.match(prompt, /do not have permission to call tools/i);
  assert.throws(() => serializeMessages([{ role: "tool", content: "no" }]), {
    code: "invalid_messages",
  });
});

test("JSON event parser joins text parts and aggregates usage/cost", () => {
  const stdout = [
    JSON.stringify({ type: "text", part: { id: "t1", type: "text", text: "hello " } }),
    JSON.stringify({ type: "text", part: { id: "t2", type: "text", text: "world" } }),
    JSON.stringify({ type: "step_finish", part: { id: "s1", tokens: { input: 10, output: 2 }, cost: 0 } }),
  ].join("\n");
  const parsed = parseOpenCodeEvents(stdout);
  assert.equal(parsed.content, "hello world");
  assert.equal(parsed.usage.prompt_tokens, 10);
  assert.equal(parsed.usage.completion_tokens, 2);
  assert.equal(parsed.usage.cost_usd, 0);
  assert.equal(parsed.hasUsage, true);
  assert.equal(parsed.costKnown, true);
});

test("runner invokes OpenCode without a shell and returns metered text", async () => {
  let invocation;
  const fakeSpawn = (binary, args, options) => {
    invocation = { binary, args, options };
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from([
        JSON.stringify({ type: "text", part: { id: "t1", type: "text", text: "ok" } }),
        JSON.stringify({ type: "step_finish", part: { id: "s1", tokens: { input: 12, output: 3 }, cost: 0 } }),
      ].join("\n") + "\n"));
      child.emit("close", 0);
    });
    return child;
  };

  const result = await runOpenCode(
    [{ role: "user", content: "test" }],
    { model: "opencode/free-fast", env: baseEnv, spawnImpl: fakeSpawn }
  );
  assert.equal(result.content, "ok");
  assert.equal(result.via, "opencode");
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args.slice(0, 6), [
    "run", "--format", "json", "--model", "opencode/free-fast", "--agent",
  ]);
  assert.equal(invocation.args[6], "overlord-model");
  assert.equal(invocation.args[7], "--dir");
  assert.equal(invocation.options.shell, false);
});

test("runner rejects reported non-zero spend when the default cap is zero", async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from([
        JSON.stringify({ type: "text", part: { id: "t1", type: "text", text: "paid" } }),
        JSON.stringify({ type: "step_finish", part: { id: "s1", tokens: { input: 1, output: 1 }, cost: 0.01 } }),
      ].join("\n") + "\n"));
      child.emit("close", 0);
    });
    return child;
  };
  await assert.rejects(
    runOpenCode([{ role: "user", content: "test" }], {
      model: "opencode/free-fast",
      env: baseEnv,
      spawnImpl: fakeSpawn,
    }),
    { code: "model_cost_limit_exceeded" }
  );
});

test("runner rejects responses when cost telemetry is missing", async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from([
        JSON.stringify({ type: "text", part: { id: "t1", type: "text", text: "unknown cost" } }),
        JSON.stringify({ type: "step_finish", part: { id: "s1", tokens: { input: 1, output: 1 }, cost: null } }),
      ].join("\n") + "\n"));
      child.emit("close", 0);
    });
    return child;
  };
  await assert.rejects(
    runOpenCode([{ role: "user", content: "test" }], {
      model: "opencode/free-fast",
      env: baseEnv,
      spawnImpl: fakeSpawn,
    }),
    { code: "model_cost_unavailable" }
  );
});

test("runner rejects model tool-call events", async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "text",
        part: { id: "t1", type: "text", text: "not accepted" },
      }) + "\n" + JSON.stringify({
        type: "tool_use",
        part: { type: "tool", id: "exec" },
      }) + "\n"));
      child.emit("close", 0);
    });
    return child;
  };
  await assert.rejects(
    runOpenCode([{ role: "user", content: "test" }], {
      model: "opencode/free-fast",
      env: baseEnv,
      spawnImpl: fakeSpawn,
    }),
    { code: "opencode_tool_execution_blocked" }
  );
});