// Optional, privacy-minimal PostHog telemetry for runtime lifecycle events.
const ALLOWED_EVENTS = new Set([
  "overlord_run_started",
  "overlord_run_failed",
  "overlord_run_completed_unverified",
]);
const ALLOWED_PROPERTIES = new Set([
  "model_provider",
  "verification_status",
  "failure_code",
]);

function captureRuntimeEvent(event, properties = {}) {
  const apiKey = process.env.POSTHOG_API_KEY || "";
  const host = (process.env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/+$/, "");
  if (!apiKey || !ALLOWED_EVENTS.has(event)) return false;

  const safe = {
    service: "overlord-supervisor",
    environment: process.env.NODE_ENV || "development",
  };
  for (const [key, value] of Object.entries(properties || {})) {
    if (ALLOWED_PROPERTIES.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      safe[key] = typeof value === "string" ? value.slice(0, 80) : value;
    }
  }
  const payload = {
    api_key: apiKey,
    event,
    distinct_id: "overlord-runtime",
    properties: safe,
  };
  // Never block task execution on analytics. No prompts, outputs, run IDs,
  // user identifiers, secrets, or raw error messages are sent.
  try {
    fetch(host + "/capture/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
  } catch {}
  return true;
}

module.exports = { captureRuntimeEvent };
