"""
Observability module for Loom AI Engine.

Provides tracing, structured logging, and metrics collection.
"""

import time
import uuid
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, field


@dataclass
class Span:
    """Represents a single operation span in tracing."""
    name: str
    trace_id: str
    start_time: float = field(default_factory=time.time)
    end_time: Optional[float] = None
    duration_ms: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def finish(self):
        """Mark the span as finished and calculate duration."""
        self.end_time = time.time()
        self.duration_ms = (self.end_time - self.start_time) * 1000


class TraceContext:
    """Manages distributed tracing context."""
    
    def __init__(self, trace_id: Optional[str] = None):
        self.trace_id = trace_id or str(uuid.uuid4())
        self._spans: List[Span] = []
        self._events: List[Dict[str, Any]] = []
        self._current_span: Optional[Span] = None
    
    def start_span(self, name: str, metadata: Optional[Dict[str, Any]] = None) -> Span:
        """Start a new span within this trace context."""
        span = Span(
            name=name,
            trace_id=self.trace_id,
            metadata=metadata or {}
        )
        self._spans.append(span)
        self._current_span = span
        return span
    
    def log_event(self, event_name: str, data: Optional[Dict[str, Any]] = None):
        """Log an event within the trace context."""
        self._events.append({
            "event": event_name,
            "timestamp": time.time(),
            "trace_id": self.trace_id,
            "data": data or {}
        })
    
    def get_summary(self) -> Dict[str, Any]:
        """Get a summary of the trace."""
        return {
            "trace_id": self.trace_id,
            "span_count": len(self._spans),
            "event_count": len(self._events),
            "total_duration_ms": sum(s.duration_ms or 0 for s in self._spans)
        }


class StructuredLogger:
    """Structured logger for consistent log formatting."""
    
    def __init__(self, service_name: str = "loom-engine"):
        self.service_name = service_name
    
    def log(self, level: str, message: str, trace_id: Optional[str] = None, 
            extra: Optional[Dict[str, Any]] = None):
        """Log a structured message."""
        log_entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "level": level.upper(),
            "service": self.service_name,
            "message": message,
            "trace_id": trace_id,
            **(extra or {})
        }
        # In production, this would go to a logging backend
        print(f"[{log_entry['level']}] {log_entry['message']}")


class MetricsCollector:
    """Collects and aggregates operational metrics."""
    
    def __init__(self):
        self._request_count: int = 0
        self._success_count: int = 0
        self._error_count: int = 0
        self._total_latency_ms: float = 0.0
        self._latencies: List[float] = []
    
    def record_request(self, latency_ms: float, success: bool = True):
        """Record a request metric."""
        self._request_count += 1
        self._total_latency_ms += latency_ms
        self._latencies.append(latency_ms)
        
        if success:
            self._success_count += 1
        else:
            self._error_count += 1
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get current metrics summary."""
        avg_latency = (
            self._total_latency_ms / self._request_count 
            if self._request_count > 0 else 0.0
        )
        
        return {
            "request_count": self._request_count,
            "success_count": self._success_count,
            "error_count": self._error_count,
            "success_rate": (
                self._success_count / self._request_count 
                if self._request_count > 0 else 0.0
            ),
            "avg_latency_ms": round(avg_latency, 2),
            "p50_latency_ms": self._percentile(50),
            "p95_latency_ms": self._percentile(95),
            "p99_latency_ms": self._percentile(99)
        }
    
    def _percentile(self, p: int) -> float:
        """Calculate percentile of latencies."""
        if not self._latencies:
            return 0.0
        sorted_latencies = sorted(self._latencies)
        k = (len(sorted_latencies) - 1) * (p / 100)
        f = int(k)
        c = f + 1 if f + 1 < len(sorted_latencies) else f
        return sorted_latencies[f] + (sorted_latencies[c] - sorted_latencies[f]) * (k - f)


# Global instances
global_metrics = MetricsCollector()
