// Sandboxed JS transform runner for prompt-chain nodes.
//
// The old code used `new Function(inputs)` — full process access. This runs
// untrusted snippets in Node's `vm` with a frozen, minimal context and a hard
// timeout. It is a big step up from `new Function` but NOT a security
// boundary: determined code can still escape vm. Treat js_transform nodes as
// semi-trusted; full isolation needs worker processes or containers.
const vm = require("vm");

const MAX_OUTPUT = 20000; // chars
const TIMEOUT_MS = 2000;

function runTransform(code, inputs) {
  if (typeof code !== "string" || code.length > 20000) {
    throw new Error("transform code missing or too large (max 20000 chars)");
  }
  let safeInputs;
  try {
    safeInputs = JSON.parse(JSON.stringify(inputs || {}));
  } catch {
    throw new Error("transform inputs are not JSON-serializable");
  }
  if (JSON.stringify(safeInputs).length > 100000) {
    throw new Error("transform inputs too large (max 100KB JSON)");
  }
  const sandbox = Object.freeze({
    inputs: Object.freeze(safeInputs),
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Date,
  });
  const ctx = vm.createContext(sandbox);
  // Two snippet styles: legacy `return <expr>;` (wrapped in a function) and
  // `result = <expr>;` (reads the trailing value). No require/process/console.
  const wrapped = /\breturn\b/.test(code)
    ? `"use strict";\nlet result;\nresult = (function(){\n${code}\n})();\nresult;`
    : `"use strict";\nlet result;\n${code}\nresult;`;
  let out;
  try {
    out = vm.runInContext(wrapped, ctx, { timeout: TIMEOUT_MS });
  } catch (err) {
    throw new Error("Sandbox error: " + (err && err.message ? err.message : err));
  }
  const text = out === undefined ? "" : (typeof out === "object" ? JSON.stringify(out, null, 2) : String(out));
  return text.slice(0, MAX_OUTPUT);
}

module.exports = { runTransform, MAX_OUTPUT, TIMEOUT_MS };
