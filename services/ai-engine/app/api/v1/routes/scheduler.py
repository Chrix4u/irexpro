"""Scheduler HTTP endpoints — internal use by NestJS only."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.config import get_settings
from app.core.security import validate_internal_api_key
from app.domain.scheduler.schemas import (
    SessionSchedulerResponse,
    SessionSchedulerStatusResponse,
    SessionStartRequest,
    SessionStatusRequest,
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

    if request.mode not in ("paper", "PAPER_ONLY"):
        return SessionSchedulerResponse(
            registered=False,
            trading_session_id=request.trading_session_id,
            message="Current AI model is not approved for live automation",
        )

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



@router.post(
    "/scheduler/sessions/status",
    response_model=SessionSchedulerStatusResponse,
    tags=["Scheduler (Internal)"],
    dependencies=[Depends(require_internal_api_key)],
)
async def session_scheduler_status(
    request: SessionStatusRequest,
    scheduler: SignalScheduler = Depends(get_scheduler),
) -> SessionSchedulerStatusResponse:
    """Return truthful runtime state for one registered trading-session job."""
    settings = get_settings()
    job = scheduler.get_session_job(request.trading_session_id)
    if job is None:
        return SessionSchedulerStatusResponse(
            enabled=scheduler.is_enabled,
            registered=False,
            trading_session_id=request.trading_session_id,
            active=False,
            instruments=[],
            confidence_threshold=settings.ai_min_confidence_score,
        )

    anchor = job.last_run_at or job.registered_at
    next_run_at = anchor + timedelta(seconds=job.interval_seconds)
    market_data_age_seconds = None
    if job.last_market_data_at is not None:
        market_data_at = job.last_market_data_at
        if market_data_at.tzinfo is None:
            market_data_at = market_data_at.replace(tzinfo=UTC)
        market_data_age_seconds = max(
            0.0,
            (datetime.now(UTC) - market_data_at).total_seconds(),
        )

    return SessionSchedulerStatusResponse(
        enabled=scheduler.is_enabled,
        registered=True,
        trading_session_id=job.trading_session_id,
        active=job.active,
        instruments=job.instruments,
        timeframe=job.timeframe,
        interval_seconds=job.interval_seconds,
        source=job.source,
        last_run_at=job.last_run_at.isoformat() if job.last_run_at else None,
        next_run_at=next_run_at.isoformat(),
        last_decision=job.last_decision,
        last_reason=job.last_reason,
        last_confidence_score=job.last_confidence_score,
        last_confidence_at=job.last_confidence_at.isoformat() if job.last_confidence_at else None,
        confidence_threshold=settings.ai_min_confidence_score,
        model_version=job.model_version,
        model_mode=job.model_mode,
        model_loaded=job.model_loaded,
        last_market_data_at=job.last_market_data_at.isoformat() if job.last_market_data_at else None,
        market_data_age_seconds=market_data_age_seconds,
        market_data_cache_bypassed=job.market_data_cache_bypassed,
        last_publish_failed=job.last_publish_failed,
    )
