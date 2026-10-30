"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runTransform } = require("./sandbox");
test("JS transforms remain disabled even when the legacy flag is set", () => {
  const previous = process.env.STUDIO_ALLOW_JS;
  process.env.STUDIO_ALLOW_JS = "1";
  try {
    assert.throws(() => runTransform("result = process.env", {}), {
      code: "isolated_executor_unavailable",
      message: /isolated OS\/container worker/i,
    });
  } finally {
    if (previous === undefined) delete process.env.STUDIO_ALLOW_JS;
    else process.env.STUDIO_ALLOW_JS = previous;
  }
});
test("untrusted JavaScript cannot execute in the Studio process", () => {
  globalThis.__overlordSandboxProbe = 0;
  try {
    assert.throws(() => runTransform("globalThis.__overlordSandboxProbe = 1", {}), {
      code: "isolated_executor_unavailable",
    });
    assert.equal(globalThis.__overlordSandboxProbe, 0);
  } finally {
    delete globalThis.__overlordSandboxProbe;
  }
});
