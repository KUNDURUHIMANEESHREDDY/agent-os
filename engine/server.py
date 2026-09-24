import time
from typing import Dict, Any, Optional, List
from fastapi import FastAPI, HTTPException, Header, Response
from pydantic import BaseModel, Field
from loom_core.engine import LoomEngine
from loom_core.observability import TraceContext, StructuredLogger, global_metrics
from loom_core.cache import global_tool_cache

app = FastAPI(
    title="Loom Execution Framework API",
    description="Production REST API for Loom AI Engineering Framework",
    version="2.0.0",
)

from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/dashboard", response_class=HTMLResponse)
async def get_dashboard():
    html_file = static_dir / "dashboard.html"
    if html_file.exists():
        return HTMLResponse(content=html_file.read_text(encoding="utf-8"))
import os
from config import settings

engine = LoomEngine(provider="mock" if os.getenv("TESTING") == "true" or settings.llm_provider == "mock" else None)
logger = StructuredLogger(service_name="loom-api")


class ChatRequest(BaseModel):
    query: str = Field(..., example="create a playlist about AI agents")
    session_id: Optional[str] = Field(default="default_session", example="session_123")


class ExportRequest(BaseModel):
    artifact_id: Optional[str] = Field(default=None, example="playlist_1784697063")
    theme: Optional[str] = Field(default="modern", example="modern")


class ChatResponse(BaseModel):
    query: str
    answer: str
    thoughts: List[str]
    trace_id: str
    execution_time_ms: float
    provider_used: str
    model_used: str
    metrics: Dict[str, Any]


@app.get("/api/v1/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "loom-engine",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "registered_pipelines": engine.artifact_pipeline_registry.list_types(),
    }


@app.get("/api/v1/metrics")
async def get_metrics():
    return global_metrics.get_metrics()


@app.post("/api/v1/chat", response_model=ChatResponse)
async def chat(request: ChatRequest, x_trace_id: Optional[str] = Header(default=None)):
    ctx = TraceContext(trace_id=x_trace_id)
    span = ctx.start_span("process_query", metadata={"query": request.query})

    try:
        response = await engine.process_query(request.query)
        span.finish()
        ctx.log_event("query_success", {"execution_time_ms": response.execution_time_ms})
        global_metrics.record_request(latency_ms=response.execution_time_ms, success=True)

        logger.log(
            level="info",
            message="Query processed successfully",
            trace_id=ctx.trace_id,
            extra={"latency_ms": response.execution_time_ms, "provider": response.provider_used}
        )

        return ChatResponse(
            query=response.query,
            answer=response.answer,
            thoughts=response.thoughts,
            trace_id=ctx.trace_id,
            execution_time_ms=response.execution_time_ms,
            provider_used=response.provider_used,
            model_used=response.model_used,
            metrics=ctx.get_summary(),
        )
    except Exception as e:
        span.finish()
        global_metrics.record_request(latency_ms=span.duration_ms or 0.0, success=False)
        logger.log(level="error", message=f"Query failed: {str(e)}", trace_id=ctx.trace_id)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/export")
async def export_pdf(request: ExportRequest):
    try:
        art = None
        if request.artifact_id:
            art = engine.artifact_registry.get_artifact(request.artifact_id)
        if not art:
            art = engine.artifact_registry.get_latest_artifact()

        if not art:
            raise HTTPException(status_code=404, detail="No artifact found to export")

        res_transform = engine.transform_engine.transform_to_pdf(art, theme=request.theme or "modern")
        return {
            "status": "success",
            "artifact_id": art.artifact_id,
            "title": art.title,
            "pdf_path": res_transform["pdf_path"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
