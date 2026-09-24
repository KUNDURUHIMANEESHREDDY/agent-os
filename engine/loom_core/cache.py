"""
Cache module for Loom AI Engine.

Provides caching utilities for tool results and frequently accessed data.
"""

import time
from typing import Optional, Dict, Any


class ToolCache:
    """Simple in-memory cache for tool results."""
    
    def __init__(self, ttl_seconds: int = 300):
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._ttl_seconds = ttl_seconds
    
    def get(self, key: str) -> Optional[Any]:
        """Get a cached value if it exists and is not expired."""
        if key in self._cache:
            entry = self._cache[key]
            if time.time() - entry["timestamp"] < self._ttl_seconds:
                return entry["value"]
            else:
                # Expired, remove it
                del self._cache[key]
        return None
    
    def set(self, key: str, value: Any):
        """Set a cached value with current timestamp."""
        self._cache[key] = {
            "value": value,
            "timestamp": time.time()
        }
    
    def invalidate(self, key: str):
        """Invalidate a specific cache entry."""
        if key in self._cache:
            del self._cache[key]
    
    def clear(self):
        """Clear all cache entries."""
        self._cache.clear()
    
    def cleanup_expired(self):
        """Remove all expired entries from the cache."""
        now = time.time()
        expired_keys = [
            k for k, v in self._cache.items()
            if now - v["timestamp"] >= self._ttl_seconds
        ]
        for key in expired_keys:
            del self._cache[key]


# Global cache instance
global_tool_cache = ToolCache(ttl_seconds=300)
