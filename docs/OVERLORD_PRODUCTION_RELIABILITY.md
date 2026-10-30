# OVERLORD 2.0 — Production Reliability

## Scope and source of truth

Repository: https://github.com/KUNDURUHIMANEESHREDDY/agent-os  
Implementation branch: <code>overlord/production-reliability</code>  
Primary supervisor: <code>supervisor/server.js</code>  
Model gateway: <code>gateway/llm-gateway.js</code>  
Python engine client: <code>engine/loom_core/engine.py</code>

This program hardens the existing system incrementally. It does not replace the current supervisor, memory store, or DataOS kernel wholesale.

## Architecture boundary

Production model requests follow one path:

1. Supervisor, engine, or Studio submits role-tagged messages to the gateway.
2. The gateway checks authentication, request shape, exact model allowlist, request limits, and complexity routing.
3. The OpenCode CLI runs the restricted <code>overlord-model</code> agent.
4. The adapter parses JSON events, enforces process and output limits, rejects tool-call events, records reported usage/cost, and returns an explicit provider error on failure.
5. The supervisor checks run-level token usage and marks failed model requests as failed. It must not emit a fabricated successful completion.

The OpenCode agent is a text-generation boundary, not an execution worker. File access, code execution, network access, MCP tools, and other side effects must be mediated by separate capability workers.

## Free-model policy

The current branch uses an operator-managed, exact-ID allowlist in <code>OPENCODE_FREE_MODELS</code>. Accepted model identifiers must be under an OpenCode provider namespace, but namespace membership alone does not prove the model is free: an OpenCode provider account can expose paid options too.

Before adding an ID:
- inspect the current catalogue using <code>opencode models --verbose</code>;
- verify the exact provider/model ID;
- verify both input and output pricing are zero;
- confirm the selected account/plan makes the model available without paid fallback;
- record the verification date and the operator who approved it.

The gateway has a default maximum reported cost of zero and rejects responses with non-zero reported spend. This check happens after the provider responds; it is not a pre-call billing guarantee or automated catalogue-price validator. The allowlist must remain empty when the price cannot be verified.

## Current implementation changes

### Model gateway
- One central OpenCode-only path; router, Ollama, direct provider, and mock-success fallbacks removed.
- Exact allowlist and complexity-tier preferences.
- Non-shell process execution with a restricted named agent.
- Timeouts, bounded stdout/stderr, request-size limit, explicit provider error mapping, and JSON event parsing.
- Empty output, provider error events, model tool calls, and non-zero reported costs are rejected.
- Token/cost usage is passed back to the supervisor and Python engine.

### Supervisor and configuration
- Supervisor model calls use the central gateway only.
- Gateway failures and token-budget exhaustion are visible run failures; no fabricated completion text.
- The supervisor configuration API normalizes model/provider settings to the environment allowlist. The console cannot add a provider or arbitrary model ID.
- Legacy provider test/sync endpoints return HTTP 410.
- The model screen is OpenCode-only and read-only.

### Durable workflow lifecycle
- The shared SQLite database contains `workflow_runs`, `workflow_steps`, and `workflow_dead_letters`.
- Run creation supports an `Idempotency-Key`; reusing it for the same request returns the original run, while reusing it for a different goal/model returns HTTP 409.
- Run updates use optimistic `expected_version` checks and explicit transition validation.
- Planner, dispatcher, and each specialist step are persisted with state, inputs, outputs, attempt counts, timestamps, and checkpoints.
- Supervisor process startup moves interrupted queued/active runs to `needs_review`, preserving the latest checkpoint and requiring review before manual redrive.
- Failed runs and step failures are recorded; dead-letter records support administrator-only, one-time redrive.
- Generated responses are persisted as `completed_unverified`. The existing supervisor currently generates text and specialist summaries; it does not yet independently execute or verify claimed side effects.

### Studio runtime boundary
- Studio LLM prompt nodes use the central OpenCode gateway; legacy provider IDs are normalized to `auto`, and gateway failures terminate the pipeline without direct Gemini or other-provider fallback.
- Direct Gemini API helper and client-supplied `geminiApiKey` fallback path have been removed from the Studio runner.
- Arbitrary `js_transform` pipeline code is disabled even when the legacy `STUDIO_ALLOW_JS=1` flag is set. The previous Node `vm` implementation is not treated as isolation; a separate OS/container/microVM executor must be built before re-enabling this capability.
- Dedicated tests assert OpenCode model normalization and that untrusted JavaScript cannot execute in the Studio process.

### Python engine
- Engine calls require the central gateway.
- Direct DeepSeek, Google, Groq, and Ollama implementation paths are removed.
- Mock generation is available only when <code>AGENT_OS_TEST_MODE=1</code> and the environment is not production. It is for deterministic tests, not a provider fallback.

### Build and test
- Gateway container installs a pinned OpenCode CLI.
- OpenCode auth data is persisted in a dedicated named Docker volume, separate from repository files.
- Node policy tests are included in CI.
- The auth evaluation asserts that an empty model allowlist returns <code>503 model_not_configured</code> after authentication.

## Known blockers and limitations

- The OpenCode CLI on the currently inspected Windows host reported a local database/session-table error when listing models. No auth store or CLI database was changed. Until the catalogue command works or an independently clean runtime is configured, keep the allowlist empty.
- The container image and the OpenCode auth-volume workflow still require a clean Docker build and runtime test.
- Manual model-price attestation is required; the current implementation does not query a live model-pricing catalogue.
- Automatic replay from checkpoints, worker leases, side-effect idempotency, classified retry/backoff policies, and a safe operator resume workflow remain outstanding. The current supervisor preserves state and isolates interrupted runs into `needs_review`; it does not auto-resume side effects.
- Supabase has no configured project, Vercel has no configured project/team, and Datadog has no registered OVERLORD service/dashboard in the connected accounts inspected for this work. No infrastructure was provisioned and no synthetic telemetry was inserted.
- PostHog could not be safely queried for project selection during this work; no project-level analytics claims are made.

## Remaining delivery gates

| Priority | Workstream | Gate |
|---|---|---|
| P0 | OpenCode routing and model efficiency | Live CLI/catalogue/auth check, free-model attestation, token budgets and end-to-end tests |
| P0 | Durable recovery | Automatic checkpoint replay, worker leases, idempotent side effects, retry/backoff policy, and operator-controlled resume; checkpoint persistence and one-time dead-letter redrive are implemented in the current branch |
| P0 | Capability security | Typed capability contracts, scope checks at execution, action-bound one-time approvals, real isolation, secret-safe audit |
| P0 | Independent verification | Verifier independent of worker, artifact digest, raw test evidence, mandatory checks, failed verifier blocks completion |
| P1 | Observability | OpenTelemetry trace hierarchy, metrics, redaction, SLOs, PostHog/Datadog wiring after live projects/services exist |
| P2 | Infrastructure | Choose single Postgres source, Redis ownership, object storage, workflow runtime and deployment topology; approve cost before provisioning |

## Operational KPIs

The first dashboard should use real events and compute:
- verified task completion rate = tasks passing independent verification / tasks submitted;
- false-completion rate = tasks marked complete without valid verifier evidence / tasks marked complete;
- recovery success rate = interrupted tasks resumed and verified / eligible interrupted tasks;
- model cost leakage = total provider-reported cost for runs configured as free;
- model efficiency = verified tasks completed per 1,000 model tokens;
- capability policy violation rate = denied unauthorized capability attempts / total capability attempts;
- p95 task latency and p95 model-call latency.

Do not emit synthetic production events to make dashboards look populated. Define event schemas and wire telemetry only after a real service/project is configured.

## Linear programme

- HIM-5 — central OpenCode-only execution and free-model policy.
- HIM-6 — durable task state, idempotency, checkpoints, dead-letter recovery.
- HIM-7 — capability scopes, approvals and execution isolation.
- HIM-8 — independent verification and evidence-backed completion.
- HIM-9 — OpenTelemetry, SLOs and analytics.
- HIM-10 — decision-gated infrastructure provisioning.