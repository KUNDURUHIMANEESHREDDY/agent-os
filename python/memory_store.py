"""agent-os shared memory store — single SQLite DB for saber logs + loom memories.

DB: agent-os/.data/agent-os.db (override with AGENT_OS_DB or DATAOS_DB env).
Tables are a superset of loom/core/memory.py schema plus saber's run-log events.
stdlib only (sqlite3/json/hashlib). JSON files (saber store.json) are export/cache only.
"""
from __future__ import annotations
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def db_path() -> Path:
    raw = os.getenv("AGENT_OS_DB") or os.getenv("DATAOS_DB") or str(ROOT / ".data" / "agent-os.db")
    p = Path(raw)
    if not p.is_absolute():
        # resolve relative to repo base (parent of agent-os/) like kernel_bridge does
        p = (ROOT.parent / p).resolve() if not str(p).startswith(".data") else (ROOT / p).resolve()
    return p


SCHEMA = """
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    dir TEXT NOT NULL,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '',
    runId TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(runId);
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    metadata TEXT,
    embedding TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_mem_ts ON memories(timestamp);
CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
    session_id TEXT PRIMARY KEY,
    user_id TEXT,
    started_at TEXT NOT NULL,
    last_active TEXT NOT NULL,
    messages TEXT
);
"""


def connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log_event(event: dict, path: Path | None = None) -> int:
    conn = connect(path)
    try:
        cur = conn.execute(
            "INSERT INTO logs (ts, dir, source, target, type, payload, runId, model)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (event.get("ts") or now_iso(), event.get("dir", ""), event.get("source", ""),
             event.get("target", ""), event.get("type", ""), str(event.get("payload", ""))[:4000],
             str(event.get("runId", "")), str(event.get("model", ""))),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_logs(limit: int = 300, path: Path | None = None) -> list[dict]:
    conn = connect(path)
    try:
        rows = conn.execute(
            "SELECT id, ts, dir, source, target, type, payload, runId, model"
            " FROM logs ORDER BY id DESC LIMIT ?", (max(1, min(limit, 1000)),)).fetchall()
        return [dict(zip(["id", "ts", "dir", "source", "target", "type", "payload", "runId", "model"], r))
                for r in reversed(rows)]
    finally:
        conn.close()


def clear_logs(path: Path | None = None) -> None:
    conn = connect(path)
    try:
        conn.execute("DELETE FROM logs")
        conn.commit()
    finally:
        conn.close()


def add_memory(content: str, memory_type: str = "conversation",
               metadata: dict | None = None, path: Path | None = None) -> str:
    mid = hashlib.sha256(f"{content}{now_iso()}".encode()).hexdigest()[:16]
    conn = connect(path)
    try:
        conn.execute(
            "INSERT INTO memories (id, content, memory_type, timestamp, metadata, embedding)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (mid, content, memory_type, now_iso(), json.dumps(metadata or {}), None))
        conn.commit()
        return mid
    finally:
        conn.close()


def export_json(path: Path | None = None) -> dict:
    """store.json-compatible snapshot: {logs, seq} for export/backup."""
    logs = get_logs(limit=1000, path=path)
    return {"logs": logs, "seq": logs[-1]["id"] if logs else 0}


if __name__ == "__main__":
    import tempfile
    tmp = Path(tempfile.mkdtemp()) / "test-agent-os.db"
    i = log_event({"dir": "IN", "source": "selftest", "target": "memory",
                   "type": "user_message", "payload": "hello", "runId": "r1", "model": "mock"}, path=tmp)
    assert i == 1, i
    logs = get_logs(path=tmp)
    assert len(logs) == 1 and logs[0]["payload"] == "hello", logs
    mid = add_memory("prefers dark mode", "fact", {"k": 1}, path=tmp)
    assert len(mid) == 16, mid
    snap = export_json(path=tmp)
    assert snap["seq"] == 1 and len(snap["logs"]) == 1, snap
    clear_logs(path=tmp)
    assert get_logs(path=tmp) == [], "clear failed"
    print(f"memory_store selftest ok ({tmp.parent})")
