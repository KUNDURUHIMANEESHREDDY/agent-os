const test = require("node:test");
const assert = require("node:assert/strict");
const { captureRuntimeEvent } = require("./telemetry");

test("telemetry is disabled without an explicit project token", () => {
  const previous = process.env.POSTHOG_API_KEY;
  delete process.env.POSTHOG_API_KEY;
  assert.equal(captureRuntimeEvent("overlord_run_started"), false);
  if (previous === undefined) delete process.env.POSTHOG_API_KEY;
  else process.env.POSTHOG_API_KEY = previous;
});

test("only allowlisted event names and metadata are sent", async () => {
  const previousKey = process.env.POSTHOG_API_KEY;
  const previousHost = process.env.POSTHOG_HOST;
  const previousFetch = global.fetch;
  let sent;
  process.env.POSTHOG_API_KEY = "test-project-token";
  process.env.POSTHOG_HOST = "https://posthog.example";
  global.fetch = async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return { ok: true };
  };
  try {
    assert.equal(captureRuntimeEvent("overlord_run_started", {
      model_provider: "opencode",
      prompt: "must never be sent",
      run_id: "must never be sent",
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.url, "https://posthog.example/capture/");
    assert.equal(sent.body.event, "overlord_run_started");
    assert.deepEqual(sent.body.properties.model_provider, "opencode");
    assert.equal("prompt" in sent.body.properties, false);
    assert.equal("run_id" in sent.body.properties, false);
    assert.equal(captureRuntimeEvent("some_unapproved_event"), false);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.POSTHOG_API_KEY;
    else process.env.POSTHOG_API_KEY = previousKey;
    if (previousHost === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = previousHost;
  }
});
