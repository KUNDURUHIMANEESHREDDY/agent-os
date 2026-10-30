# agent-os — OVERLORD autonomous agent system

One repository merging the OVERLORD supervisor, Loom dynamic-agent engine, DataOS kernel, hierarchical chunking/RAG, shared memory services, and visual pipeline studio.

## Layout

- **gateway/** — central OpenCode-only model gateway and CLI adapter.
- **supervisor/** — OVERLORD planner, dispatcher, specialist agents, SSE event stream, and console UI.
- **engine/** — LoomEngine, DynamicAgent, tool registry, and artifact registry. Model calls use the central gateway only.
- **data-kernel/** — DataOS objects, graph, SQL, Python execution, provenance, grounding, and tests.
- **python/** — memory service, chunking, embeddings, and kernel bridge.
- **studio/** — visual workflow builder. LLM nodes use the central gateway.
- **.opencode/agents/** — restricted text-only agent configuration.

## Model execution policy

All production model requests flow through one path:

OVERLORD supervisor / Loom engine / Studio → gateway → OpenCode CLI → tool-disabled text agent.

There is no Router, Ollama, direct provider SDK, or mock-success fallback in the production request path. When OpenCode is unavailable, the gateway returns an explicit error and the supervisor marks the run failed rather than inventing output.

The gateway admits only exact model IDs present in OPENCODE_FREE_MODELS, with provider IDs under the OpenCode or OpenCode Go namespace. The allowlist is intentionally empty by default. The operator must inspect the current OpenCode model catalogue and verify both input and output pricing are zero before adding an ID. This is a manual operator attestation, not a live automatic price-catalogue check. The gateway additionally rejects non-zero provider-reported spend, with a default maximum of zero.

## Quick start — local

1. Copy .env.example to .env.
2. Generate an application token with python python/make_token.py and set AGENT_OS_TOKEN.
3. Install the pinned CLI: npm install --global opencode-ai@1.19.5.
4. Authenticate: opencode auth login.
5. Inspect exact model IDs and prices: opencode models --verbose.
6. Only after verifying zero input and output pricing, add the exact provider/model IDs to OPENCODE_FREE_MODELS. Leave it empty if no model satisfies the policy.
7. Install and start services:

<pre><code>pip install -r python/requirements.txt
node gateway/llm-gateway.js
python python/memory_service.py
node supervisor/server.js</code></pre>

With an empty allowlist the expected model response is HTTP 503 with code <code>model_not_configured</code>. This is deliberate fail-closed behavior.

## Quick start — Docker Compose

The gateway image installs the pinned OpenCode CLI and persists its CLI data in a dedicated <code>opencode-data</code> volume. Authenticate interactively:

<pre><code>docker compose run --rm --entrypoint opencode gateway auth login
docker compose run --rm --entrypoint opencode gateway models --verbose</code></pre>

Then populate the verified free-model allowlist in the local, gitignored <code>.env</code> and start the stack:

<pre><code>docker compose up -d --build</code></pre>

The container image and authentication workflow have not yet been build-verified on the user's machine. No provider credential or OpenCode auth file is committed to this repository.

## Security

- All state-changing service routes require bearer authentication. Generate and rotate the token using <code>python python/make_token.py</code>.
- The supervisor may request model text only through the central gateway; UI configuration writes cannot add arbitrary model providers or model IDs.
- The OpenCode agent denies file, shell, network, MCP, and other tool permissions. Side-effecting capabilities must remain in independently governed workers.
- The current stack is localhost-oriented and documents a single trusted-operator model. Do not expose it to the public internet based only on the current shared-token and in-process sandbox protections.
- Studio's Node <code>vm</code> execution is not a security boundary. Untrusted code requires an OS/container/microVM boundary before production use.
- Secrets must not be committed, included in prompts, or written into ordinary task logs.

## Existing data and recovery capabilities

- Shared memory uses SQLite with WAL and a 30-second busy timeout.
- The memory service owns the shared database for the Node supervisor.
- Online snapshots use SQLite's backup API and are available through the authenticated backup endpoint.
- Artifacts persist in the shared database and can be reloaded after restart.
- Supervisor chat history and recent event replay persist across restarts.
- The supervisor, gateway, and memory service support graceful shutdown.
- Hybrid retrieval combines lexical and vector search. The default hashing embedder is not equivalent to a modern semantic embedding model; the evaluation reports the limitation instead of treating lexical recall as semantic success.

## OVERLORD 2.0 — production reliability status

The active engineering branch is <code>overlord/production-reliability</code>. The first implementation slice centralizes model execution and makes provider failures explicit. This branch is not yet a claim that the entire system is production-ready.

Implemented in the branch:
- OpenCode CLI process adapter, exact model allowlist, complexity-tier routing, timeouts, bounded output, usage parsing, zero-reported-cost guard, and tool-call rejection.
- Supervisor and Python engine route through the central gateway. Direct model-provider and Ollama fallback implementations are removed from the engine.
- Supervisor model configuration is read-only and controlled by the gateway environment allowlist.
- CI runs dedicated OpenCode gateway policy tests. The auth evaluation checks that a missing free-model allowlist fails closed.
- The gateway Dockerfile installs a pinned OpenCode CLI and the Compose file provides a dedicated auth-data volume.

Still required before production:
- durable run/step state, idempotency, checkpoints, classified retries, dead-letter queue, redrive, and restart recovery;
- capability schemas, least-privilege execution scopes, single-use action-bound approvals, secret-safe immutable audit records, and real OS/container/microVM isolation;
- independent verification tied to acceptance criteria, artifact digests, and raw test evidence;
- OpenTelemetry traces/metrics/log redaction, service-level objectives, and real operational alerts;
- a clean OpenCode catalogue/auth check on the target machine, Docker build verification, end-to-end runtime verification, and a reviewed/merged pull request.

The implementation plan and acceptance criteria live in the Linear project **OVERLORD 2.0 — Production Reliability**. See <code>docs/OVERLORD_PRODUCTION_RELIABILITY.md</code>.

## Verification

Run the current local checks:

<pre><code>node --test gateway/opencode-client.test.js
python -u evals/run_evals.py
python -m pytest data-kernel/tests -q</code></pre>
