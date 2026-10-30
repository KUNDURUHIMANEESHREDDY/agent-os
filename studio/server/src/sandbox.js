"use strict";

// Arbitrary JavaScript supplied by a saved pipeline must never execute inside
// the long-lived Studio server process. Node's vm module is not a security
// boundary, even with frozen globals and a timeout. This module deliberately
// fails closed until a separately supervised OS/container/microVM executor is
// implemented with scoped filesystem/network permissions and resource limits.

function runTransform() {
  const error = new Error(
    "js_transform is disabled until an isolated OS/container worker is configured."
  );
  error.code = "isolated_executor_unavailable";
  throw error;
}

module.exports = { runTransform };
