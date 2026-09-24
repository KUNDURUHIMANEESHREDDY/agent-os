"""Generate AGENT_OS_TOKEN and store it in agent-os/.env (created from .env.example).

All agent-os servers fail closed without this token. The token is a bearer
secret: every API call needs `Authorization: Bearer <token>`.
Never commit .env (gitignored). To rotate: run again (overwrites), restart servers.
"""
from __future__ import annotations
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / ".env"
EXAMPLE = ROOT / ".env.example"


def main() -> None:
    token = secrets.token_urlsafe(32)
    lines = []
    if ENV.exists():
        lines = ENV.read_text(encoding="utf-8").splitlines()
    elif EXAMPLE.exists():
        lines = ["# created by make_token.py from .env.example"] + EXAMPLE.read_text(encoding="utf-8").splitlines()
    out, seen = [], False
    for line in lines:
        if line.strip().startswith("AGENT_OS_TOKEN="):
            out.append(f"AGENT_OS_TOKEN={token}")
            seen = True
        else:
            out.append(line)
    if not seen:
        out.append(f"AGENT_OS_TOKEN={token}")
    ENV.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"wrote AGENT_OS_TOKEN to {ENV}")
    print("restart gateway, memory-service, supervisor, studio so they pick it up.")


if __name__ == "__main__":
    sys.exit(main())
