"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOpenCodeModel } = require("./model-runtime");
test("preserves auto and exact OpenCode model identifiers", () => {
  assert.equal(normalizeOpenCodeModel("auto"), "auto");
  assert.equal(normalizeOpenCodeModel("opencode/free-model"), "opencode/free-model");
  assert.equal(normalizeOpenCodeModel("opencode-go/free-model"), "opencode-go/free-model");
});
test("legacy and external provider identifiers normalize to auto", () => {
  assert.equal(normalizeOpenCodeModel("gemini-1.5-flash"), "auto");
  assert.equal(normalizeOpenCodeModel("openai/gpt-paid"), "auto");
  assert.equal(normalizeOpenCodeModel("ollama/llama3"), "auto");
  assert.equal(normalizeOpenCodeModel(" "), "auto");
  assert.equal(normalizeOpenCodeModel(null), "auto");
});
