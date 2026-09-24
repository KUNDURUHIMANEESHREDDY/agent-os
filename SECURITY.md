# agent-os security policy

Threat model: all servers bind localhost and assume a single trusted operator.
Nothing here is safe to expose to a network yet (no TLS, no multi-user, no
per-principal scopes — one shared bearer token).

## Authentication

- `AGENT_OS_TOKEN` (in `agent-os/.env`, gitignored, file 0600) is required as
  `Authorization: Bearer` on every API route of every server:
  gateway `:20129`, memory `:20130`, supervisor `:3000`, studio `:5000`.
- Every server **fails closed**: it exits at boot without the token. Generate:
  `python agent-os/python/make_token.py`. Health endpoints (`/health`,
  `/api/health`) stay open for probes and leak nothing.
- Browser UIs prompt once and keep the token in `localStorage` (supervisor)
  or `sessionStorage` (studio), re-prompting on 401. Exception: supervisor
  `/api/stream` also accepts `?token=` because `EventSource` cannot send
  headers — localhost only, never log that URL.
- Roles: `AGENT_OS_TOKEN` is admin; `AGENT_OS_TOKENS="tok:role,..."` adds
  `viewer` (GET), `operator` (POST/PUT), `admin` (DELETE, config writes,
  run approvals). Unknown token → 401, insufficient role → 403.
- Rate limiting: fixed 60s window per token (`RATE_LIMIT_RPM`, default 120),
  `429 + Retry-After` past it. `/health` is exempt (probes).
- TLS is opt-in per server (`TLS_CERT`+`TLS_KEY`): `security/gen-local-ca.py`
  mints a localhost-only CA + server cert; clients verify with the CA file.
  Default stays plain localhost HTTP; terminate real TLS at a reverse proxy
  for any network exposure.
- Service-to-service calls (supervisor→memory, engine/studio→gateway) send the
  same token from env. No anonymous path exists between services.

## Code execution

- Studio `js_transform` is **disabled by default** (`STUDIO_ALLOW_JS=0`). When
  enabled it runs in Node `vm` with frozen context, no require/process, JSON-
  only inputs, 2s timeout, 20KB output cap. `vm` is NOT a true boundary:
  treat enabled hosts as semi-trusted and isolate them (container/VM).
- Engine write-tier tools (`create_*`, `export_to_pdf`) require approval when
  `require_approval` is set; denials are recorded in `blocked_tools`, never
  silently executed. Supervisor runs gate on `guard.approval` + `maxSteps`.

## Prompt-injection surface

- Supervisor dispatcher output is untrusted: agent-ids are allowlisted against
  the live roster (unknown ids dropped), instructions truncated to 300 chars,
  raw dispatcher output logged for audit, stages capped to `guard.maxSteps`.
- Treat plan text and tool observations as data, never as instructions.

## Secrets

- Never commit `.env`, `*.db`, or provider keys. Staging audit before every
  commit: `git status --short` must show no `.env`/`.db`; grep staged diff for
  `sk-`, `nvapi-`, `Bearer`.
- Rotate by regenerating the token + provider keys and restarting all four
  servers (old bearer stops working on restart — there is no grace period).
- Disclosure: `sk-9afc…` and `nvapi-…` keys were committed in the pre-merge
  `saber`/`loom` repos. If either was live, revoke it at the provider —
  deleting it from this repo does not un-publish history.

## Out of scope (do before any network exposure)

Per-user auth/scopes beyond shared role tokens, container image builds
(`compose.yaml` + Dockerfiles ship but were never built here — no daemon),
sandboxing engine Python (`python_sandbox` is best-effort), audit-log tamper
evidence, dependency pinning audit. TLS past localhost also still means a
real CA + reverse proxy, not `gen-local-ca.py` output.
