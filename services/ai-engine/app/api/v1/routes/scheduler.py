"""Scheduler HTTP endpoints — internal use by NestJS only."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.config import get_settings
from app.core.security import validate_internal_api_key
from app.domain.scheduler.schemas import (
    SessionSchedulerJobStatus,
    SessionSchedulerResponse,
    SessionSchedulerStatusResponse,
    SessionStartRequest,
    SessionStopRequest,
)
from app.domain.scheduler.signal_scheduler import SignalScheduler

router = APIRouter()

INTERNAL_API_KEY_HEADER = "x-irexpro-internal-api-key"


def get_scheduler() -> SignalScheduler:
    from app.main import app_state

    scheduler: SignalScheduler = app_state["scheduler"]
    return scheduler


async def require_internal_api_key(request: Request) -> None:
    key = request.headers.get(INTERNAL_API_KEY_HEADER, "")
    if not key or not validate_internal_api_key(key):
        raise HTTPException(status_code=401, detail="Invalid or missing internal API key")


@router.post(
    "/scheduler/sessions/start",
    response_model=SessionSchedulerResponse,
    tags=["Scheduler (Internal)"],
    dependencies=[Depends(require_internal_api_key)],
)
async def start_session_scheduler(
    request: SessionStartRequest,
    scheduler: SignalScheduler = Depends(get_scheduler),
) -> SessionSchedulerResponse:
    """
    Register a paper-mode scheduled signal job for a trading session.
    Protected by x-irexpro-internal-api-key.
    """
    settings = get_settings()

    if request.source == "mock" and settings.is_production and not settings.ai_allow_mock_market_data:
        raise HTTPException(status_code=403, detail="Mock source is blocked in production")

    registered = scheduler.register_session(request)
    return SessionSchedulerResponse(
        registered=registered,
        trading_session_id=request.trading_session_id,
        message="Session scheduler registered" if registered else "Scheduler disabled or duplicate",
    )


@router.post(
    "/scheduler/sessions/stop",
    response_model=SessionSchedulerResponse,
    tags=["Scheduler (Internal)"],
    dependencies=[Depends(require_internal_api_key)],
)
async def stop_session_scheduler(
    request: SessionStopRequest,
    scheduler: SignalScheduler = Depends(get_scheduler),
) -> SessionSchedulerResponse:
    """Unregister scheduled signal job for a trading session."""
    removed = scheduler.unregister_session(request.trading_session_id)
    return SessionSchedulerResponse(
        registered=removed,
        trading_session_id=request.trading_session_id,
        message="Session scheduler stopped" if removed else "No active scheduler job found",
    )


@router.get(
    "/scheduler/sessions/{trading_session_id}",
    response_model=SessionSchedulerStatusResponse,
    tags=["Scheduler (Internal)"],
    dependencies=[Depends(require_internal_api_key)],
)
async def get_session_scheduler_status(
    trading_session_id: str,
    scheduler: SignalScheduler = Depends(get_scheduler),
) -> SessionSchedulerStatusResponse:
    """Return operational truth for one registered AI Trading session."""
    from app.main import app_state

    registry = app_state.get("registry")
    active_model_version: str | None = None
    approved_for_live: bool | None = None
    if registry is not None:
        active_model = registry.get_active_model()
        active_model_version = active_model.get_model_version()
        approved_for_live = registry.get_governance(active_model_version).approved_for_live

    job = scheduler.get_session_job(trading_session_id)
    job_status = None
    if job is not None:
        job_status = SessionSchedulerJobStatus(
            trading_session_id=job.trading_session_id,
            active=job.active,
            execution_mode=job.execution_mode,
            instruments=job.instruments,
            timeframes=job.timeframes,
            interval_seconds=job.interval_seconds,
            registered_at=job.registered_at,
            last_run_at=job.last_run_at,
            next_run_at=scheduler.next_run_at(trading_session_id),
            scan_count=job.scan_count,
            last_decision=job.last_decision,
            last_reason=job.last_reason,
            last_instrument=job.last_instrument,
            last_timeframe=job.last_timeframe,
            last_confidence_score=job.last_confidence_score,
            confidence_threshold=job.confidence_threshold,
            last_signal_id=job.last_signal_id,
        )

    return SessionSchedulerStatusResponse(
        scheduler_enabled=scheduler.is_enabled,
        scheduler_running=scheduler.is_running,
        registered=job is not None and job.active,
        active_model_version=active_model_version,
        approved_for_live=approved_for_live,
        job=job_status,
    )
