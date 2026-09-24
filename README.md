# agent-os — standalone AI agent system
One repo merging `saber` + `loom` + `dataos` + `hierarchical-chunking` + `prompt-chain`.
No cross-repo imports: `core` belongs to data-kernel only, loom's package is `loom_core`.

## Layout
```
agent-os/
  gateway/llm-gateway.js    single LLM entry (:20129). Upstream router key (ROUTER_KEY)
                            -> ollama -> mock. OpenAI-compatible /v1/chat/completions
                            (supervisor) + simple /v1/chat (engine, studio).
  supervisor/server.js      OVERLORD harness (from saber): planner->dispatcher->
                            specialists, SSE stream, skills library. Logs mirror to
                            shared SQLite; store.json is local cache/export only.
  supervisor/public/        console UI.  supervisor/.agents/  32 skill packs.
  engine/                   LoomEngine/DynamicAgent/ToolRegistry (from loom).
                            LLM routes via gateway first; provider calls are fallback.
                            Memory defaults to shared .data/agent-os.db.
  data-kernel/              DataOS kernel (from dataos): objects/graph/SQL/python-
                            sandbox/provenance/grounding/time-travel + tests/.
  python/chunking/          hierarchical RAG chunker (from hierarchical-chunking).
  python/kernel_bridge.py   in-process demo: chunk -> store -> reason.
  python/memory_store.py    shared SQLite schema (logs/memories/prefs/conversations).
  python/memory_service.py  sidecar owning the DB over HTTP (:20130) for zero-dep Node.
  studio/                   visual pipeline builder (from prompt-chain): server/ +
                            client/. LLM nodes call the gateway first.
```

## Quick start
```powershell
Copy-Item agent-os/.env.example agent-os/.env   # then set ROUTER_KEY
pip install -r agent-os/python/requirements.txt
python agent-os/python/kernel_bridge.py --demo  # chunk + dataos + loom(mock), no keys

node agent-os/gateway/llm-gateway.js            # :20129
python agent-os/python/memory_service.py        # :20130
node agent-os/supervisor/server.js              # :3000
```

## Fixes folded in (were separate-repo bugs)
- `data-kernel/core/permissions/policy.py`: missing `Union` import (NameError).
- `chunking/Structure.py`: missing `Chunk` import; parent_id stored a header
  level int — now stores the section id and links children.
- `chunking/Embedding.py`: missing `Chunk` import.
- Fresh-install router defaults point at the gateway; router key moved to
  `agent-os/.env` (gitignored). Rotate the old key committed in saber history.
```

## Security (top priority)
- Bearer auth everywhere: `AGENT_OS_TOKEN` in `agent-os/.env` (gitignored).
  Generate: `python agent-os/python/make_token.py`. Rotate: re-run + restart.
  All servers fail closed without it. `/health` stays open (leaks nothing).
  UIs: supervisor reads token from `localStorage` (prompted once),
  studio client from `sessionStorage`.
- Studio `js_transform` runs in Node `vm` (frozen context, 2s timeout, no
  require/process) — up from `new Function`, still not a true boundary.
- Supervisor dispatcher: roster allowlist + 300-char cap + untrusted-plan
  rule + raw output logged for audit.
- `evals/run_evals.py` enforces auth live (`auth_matrix`: 401/200 on both
  services; `scopes_limits`: viewer/operator/admin + 429; `tls_handshake`:
  verified https, plain http refused).
- TLS opt-in on all servers (`TLS_CERT`+`TLS_KEY`); `security/gen-local-ca.py`
  mints a localhost-only CA + cert for dev.

## Reliability
- SQLite: WAL + 30s busy timeout on every connection; `meta.schema_version`
  gate (`memory_store.SCHEMA_VERSION`); online snapshots via sqlite backup API
  (`GET /v1/backup`, admin) into `.data/backups/`.
- Artifacts persist in the shared DB (`artifacts` table) — registries reload
  after restarts; ids are collision-safe (timestamp + random suffix).
- Supervisor chat history persists in `store.json` (capped at 20, restored on
  boot); `/api/stream` replays the last 50 shared events to reconnecting UIs.
- Graceful shutdown (SIGTERM/SIGINT) on gateway, supervisor (ends SSE with
  retry hint, flushes cache), and memory service.
- Gateway retries upstream once on 429/5xx with backoff; usage flows through
  (`usage` on both contracts) and `runSim` enforces `guard.maxTokensPerRun`
  (default 400k, migrated into old configs), reporting run totals in the log.
- Compose: `unless-stopped` restarts, `service_healthy` ordering, per-service
  healthchecks against the open `/health` endpoints.
- Gate is 11/11: `python agent-os/evals/run_evals.py`.

## Next
- Tools + approvals: DONE — read/write tool tiers, approval gate in
  `DynamicAgent` (`require_approval` + callback, `AGENT_OS_AUTO_APPROVE`
  fallback), blocked tools reported, supervisor `guard.maxSteps` cap +
  approval wait with timeout (`POST /api/runs/:id/approve`).
- Evals: DONE — `evals/run_evals.py`, 6 offline golden checks (chunk recall,
  grounded search, multi-step tool, approval block, shared memory, import
  hygiene). Gate: `python agent-os/evals/run_evals.py`.
- DataOS lazy imports: DONE — verified boto3/GCS/Azure/sentence-transformers/
  psycopg are function-level with pip hints; none installed yet import+boot
  works. `import_hygiene` eval locks this in; optionals listed in
  `python/requirements.txt`.
