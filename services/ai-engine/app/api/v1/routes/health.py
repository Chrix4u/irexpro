"""Health check endpoint."""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import get_settings

router = APIRouter()


class HealthResponse(BaseModel):
    status: str
    service_name: str
    environment: str
    version: str
    timestamp: str
    signal_mode: str
    scheduler_enabled: bool
    scheduler_running: bool


@router.get("/health", response_model=HealthResponse, tags=["Health"])
async def health() -> HealthResponse:
    settings = get_settings()
    from app.main import app_state

    scheduler = app_state.get("scheduler")
    return HealthResponse(
        status="ok",
        service_name=settings.ai_engine_service_name,
        environment=settings.ai_engine_env,
        version=settings.ai_engine_version,
        timestamp=datetime.now(UTC).isoformat(),
        signal_mode=settings.ai_signal_mode,
        scheduler_enabled=settings.ai_scheduler_enabled,
        scheduler_running=bool(scheduler and scheduler.is_running),
    )
