"use strict";
const OPENCODE_MODEL_ID = /^(?:opencode|opencode-go)\/[A-Za-z0-9._/-]+$/;
function normalizeOpenCodeModel(requested) {
  if (typeof requested !== "string") return "auto";
  const model = requested.trim();
  if (model.toLowerCase() === "auto") return "auto";
  return OPENCODE_MODEL_ID.test(model) ? model : "auto";
}
module.exports = { normalizeOpenCodeModel };
