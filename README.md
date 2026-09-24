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

## Next
- Tools + approvals: gate engine tools as DataOS capabilities, enforce supervisor guard.
- Evals: golden-query gate script.
- DataOS lazy imports for optional cloud deps (boto3/GCS/Azure/sentence-transformers).
