"""
Persistent Memory Module for Dynamic Agent

This module provides:
- Long-term memory storage for conversations and facts
- User preference persistence
- Session history management
- Vector-based semantic search for memory retrieval
- SQLite-based persistent storage
"""

import asyncio
import json
import os
import sqlite3
from datetime import datetime
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field
from pathlib import Path
import hashlib


@dataclass
class MemoryEntry:
    """Represents a single memory entry."""
    id: str
    content: str
    memory_type: str  # 'conversation', 'fact', 'preference', 'learning'
    timestamp: datetime
    metadata: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[List[float]] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "memory_type": self.memory_type,
            "timestamp": self.timestamp.isoformat(),
            "metadata": self.metadata,
            "embedding": self.embedding
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'MemoryEntry':
        return cls(
            id=data["id"],
            content=data["content"],
            memory_type=data["memory_type"],
            timestamp=datetime.fromisoformat(data["timestamp"]),
            metadata=data.get("metadata", {}),
            embedding=data.get("embedding")
        )


def _default_db() -> str:
    """agent-os: shared SQLite at agent-os/.data/agent-os.db (override AGENT_OS_DB/DATAOS_DB)."""
    for env in ("AGENT_OS_DB", "DATAOS_DB"):
        v = os.getenv(env)
        if v:
            return v
    shared = Path(__file__).resolve().parents[2] / ".data" / "agent-os.db"
    return str(shared)


def _connect(db_path) -> sqlite3.Connection:
    """Shared-DB connection: WAL + busy timeout so concurrent writers wait
    instead of raising 'database is locked'. Mirrors memory_store.connect."""
    conn = sqlite3.connect(str(db_path), timeout=30.0, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


class PersistentMemory:
    """
    Persistent memory system for the dynamic agent.
    
    Features:
    - SQLite storage for durability
    - Semantic search capabilities (when embeddings available)
    - Conversation history tracking
    - User preference storage
    - Fact accumulation and retrieval
    """
    
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = Path(db_path or _default_db())
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_database()
        self._conversation_cache: Dict[str, List[Dict]] = {}
    
    def _init_database(self):
        """Initialize SQLite database with required tables."""
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            
            # Main memory table
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    memory_type TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    metadata TEXT,
                    embedding TEXT
                )
            ''')
            
            # User preferences table
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS preferences (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            ''')
            
            # Conversation sessions table
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS conversations (
                    session_id TEXT PRIMARY KEY,
                    user_id TEXT,
                    started_at TEXT NOT NULL,
                    last_active TEXT NOT NULL,
                    messages TEXT
                )
            ''')
            
            # Create indexes for faster queries
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_memory_type ON memories(memory_type)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_timestamp ON memories(timestamp)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_content ON memories(content)')

            # agent-os shared table: saber run-log events live in the same DB
            cursor.execute('''
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
                )
            ''')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(runId)')

            # agent-os shared table: artifacts survive restarts (same DDL as memory_store)
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '',
                    type TEXT NOT NULL DEFAULT 'document',
                    content TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL DEFAULT 0,
                    updated_at REAL NOT NULL DEFAULT 0
                )
            ''')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type)')

            conn.commit()
    
    def _generate_id(self, content: str) -> str:
        """Generate unique ID for memory entry."""
        timestamp = datetime.now().isoformat()
        return hashlib.sha256(f"{content}{timestamp}".encode()).hexdigest()[:16]
    
    async def add_memory(
        self,
        content: str,
        memory_type: str = "conversation",
        metadata: Optional[Dict[str, Any]] = None
    ) -> MemoryEntry:
        """Add a new memory entry."""
        entry = MemoryEntry(
            id=self._generate_id(content),
            content=content,
            memory_type=memory_type,
            timestamp=datetime.now(),
            metadata=metadata or {},
            embedding=None  # Can be populated later with embedding model
        )
        
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO memories (id, content, memory_type, timestamp, metadata, embedding)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (
                entry.id,
                entry.content,
                entry.memory_type,
                entry.timestamp.isoformat(),
                json.dumps(entry.metadata),
                json.dumps(entry.embedding) if entry.embedding else None
            ))
            conn.commit()
        
        return entry
    
    async def get_memories(
        self,
        memory_type: Optional[str] = None,
        limit: int = 10,
        query: Optional[str] = None
    ) -> List[MemoryEntry]:
        """Retrieve memories with optional filtering and search."""
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            
            if query:
                # Simple keyword search (can be enhanced with full-text search)
                cursor.execute('''
                    SELECT id, content, memory_type, timestamp, metadata, embedding
                    FROM memories
                    WHERE content LIKE ?
                    ORDER BY timestamp DESC
                    LIMIT ?
                ''', (f"%{query}%", limit))
            elif memory_type:
                cursor.execute('''
                    SELECT id, content, memory_type, timestamp, metadata, embedding
                    FROM memories
                    WHERE memory_type = ?
                    ORDER BY timestamp DESC
                    LIMIT ?
                ''', (memory_type, limit))
            else:
                cursor.execute('''
                    SELECT id, content, memory_type, timestamp, metadata, embedding
                    FROM memories
                    ORDER BY timestamp DESC
                    LIMIT ?
                ''', (limit,))
            
            rows = cursor.fetchall()
        
        entries = []
        for row in rows:
            entry = MemoryEntry(
                id=row[0],
                content=row[1],
                memory_type=row[2],
                timestamp=datetime.fromisoformat(row[3]),
                metadata=json.loads(row[4]) if row[4] else {},
                embedding=json.loads(row[5]) if row[5] else None
            )
            entries.append(entry)
        
        return entries
    
    async def search_memories(self, query: str, limit: int = 5) -> List[MemoryEntry]:
        """Search memories by content (keyword-based for now)."""
        return await self.get_memories(query=query, limit=limit)
    
    async def add_preference(self, key: str, value: Any):
        """Store a user preference."""
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT OR REPLACE INTO preferences (key, value, updated_at)
                VALUES (?, ?, ?)
            ''', (key, json.dumps(value), datetime.now().isoformat()))
            conn.commit()
    
    async def get_preference(self, key: str, default: Any = None) -> Any:
        """Retrieve a user preference."""
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT value FROM preferences WHERE key = ?', (key,))
            row = cursor.fetchone()
            if row:
                return json.loads(row[0])
            return default
    
    async def get_all_preferences(self) -> Dict[str, Any]:
        """Get all user preferences."""
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT key, value FROM preferences')
            rows = cursor.fetchall()
            return {row[0]: json.loads(row[1]) for row in rows}
    
    async def start_conversation(self, session_id: str, user_id: Optional[str] = None):
        """Start a new conversation session."""
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            # Check if session already exists
            cursor.execute('SELECT session_id FROM conversations WHERE session_id = ?', (session_id,))
            if not cursor.fetchone():
                cursor.execute('''
                    INSERT INTO conversations (session_id, user_id, started_at, last_active, messages)
                    VALUES (?, ?, ?, ?, ?)
                ''', (session_id, user_id, datetime.now().isoformat(), datetime.now().isoformat(), json.dumps([])))
                conn.commit()
            else:
                # Update last_active for existing session
                cursor.execute('''
                    UPDATE conversations SET last_active = ? WHERE session_id = ?
                ''', (datetime.now().isoformat(), session_id))
                conn.commit()
        
        if session_id not in self._conversation_cache:
            self._conversation_cache[session_id] = []
    
    async def add_message_to_conversation(
        self,
        session_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict] = None
    ):
        """Add a message to an ongoing conversation."""
        message = {
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
            "metadata": metadata or {}
        }
        
        # Update cache
        if session_id not in self._conversation_cache:
            self._conversation_cache[session_id] = []
        self._conversation_cache[session_id].append(message)
        
        # Persist to database
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT messages FROM conversations WHERE session_id = ?', (session_id,))
            row = cursor.fetchone()
            messages = json.loads(row[0]) if row and row[0] else []
            messages.append(message)
            
            cursor.execute('''
                UPDATE conversations
                SET messages = ?, last_active = ?
                WHERE session_id = ?
            ''', (json.dumps(messages), datetime.now().isoformat(), session_id))
            conn.commit()
    
    async def get_conversation_history(self, session_id: str, limit: int = 50) -> List[Dict]:
        """Get conversation history for a session."""
        if session_id in self._conversation_cache:
            return self._conversation_cache[session_id][-limit:]
        
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT messages FROM conversations WHERE session_id = ?', (session_id,))
            row = cursor.fetchone()
            if row and row[0]:
                messages = json.loads(row[0])
                self._conversation_cache[session_id] = messages
                return messages[-limit:]
            return []
    
    async def learn_fact(self, fact: str, context: Optional[str] = None):
        """Store a learned fact for future reference."""
        metadata = {"context": context} if context else {}
        await self.add_memory(
            content=fact,
            memory_type="fact",
            metadata=metadata
        )
    
    async def get_relevant_facts(self, query: str, limit: int = 3) -> List[str]:
        """Retrieve relevant facts based on a query."""
        memories = await self.search_memories(query, limit=limit)
        return [m.content for m in memories if m.memory_type == "fact"]
    
    async def clear_conversation_cache(self, session_id: Optional[str] = None):
        """Clear conversation cache."""
        if session_id:
            self._conversation_cache.pop(session_id, None)
        else:
            self._conversation_cache.clear()
    
    async def get_stats(self) -> Dict[str, Any]:
        """Get memory system statistics."""
        with _connect(self.db_path) as conn:
            cursor = conn.cursor()
            
            cursor.execute('SELECT COUNT(*) FROM memories')
            total_memories = cursor.fetchone()[0]
            
            cursor.execute('SELECT memory_type, COUNT(*) FROM memories GROUP BY memory_type')
            by_type = dict(cursor.fetchall())
            
            cursor.execute('SELECT COUNT(*) FROM preferences')
            total_preferences = cursor.fetchone()[0]
            
            cursor.execute('SELECT COUNT(*) FROM conversations')
            total_conversations = cursor.fetchone()[0]
        
        return {
            "total_memories": total_memories,
            "memories_by_type": by_type,
            "total_preferences": total_preferences,
            "total_conversations": total_conversations,
            "cached_sessions": len(self._conversation_cache)
        }

    def save_artifact(self, artifact: Dict[str, Any]) -> None:
        """Upsert an artifact row (crash-safe: artifacts live in SQLite, not RAM)."""
        import time as _time
        with _connect(self.db_path) as conn:
            conn.execute('''
                INSERT INTO artifacts (artifact_id, title, type, content, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(artifact_id) DO UPDATE SET
                    title=excluded.title, type=excluded.type, content=excluded.content,
                    updated_at=excluded.updated_at
            ''', (artifact["artifact_id"], artifact.get("title", ""),
                  artifact.get("type", "document"), artifact.get("content", ""),
                  artifact.get("created_at", _time.time()), _time.time()))
            conn.commit()

    def load_artifacts(self) -> List[Dict[str, Any]]:
        """Load all artifact rows, oldest first."""
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT artifact_id, title, type, content, created_at FROM artifacts ORDER BY created_at ASC"
            ).fetchall()
        return [{"artifact_id": r[0], "title": r[1], "type": r[2], "content": r[3],
                 "created_at": r[4], "sources": []} for r in rows]


# Global memory instance (singleton pattern)
_memory_instance: Optional[PersistentMemory] = None


def get_memory(db_path: Optional[str] = None) -> PersistentMemory:
    """Get or create the global memory instance (agent-os shared DB by default)."""
    global _memory_instance
    if _memory_instance is None:
        _memory_instance = PersistentMemory(db_path or _default_db())
    return _memory_instance
