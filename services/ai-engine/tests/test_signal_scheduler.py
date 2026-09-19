"""Tests for SignalScheduler."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.core.config import Settings
from app.domain.scheduler.schemas import SessionStartRequest
from app.domain.scheduler.signal_scheduler import SignalScheduler
from app.domain.signals.schemas import AiSignalCandidate, SignalGenerationResponse


def make_start_request(session_id: str = "session-1") -> SessionStartRequest:
    return SessionStartRequest(
        userId="user-1",
        tradingSessionId=session_id,
        brokerConnectionId="conn-1",
        instruments=["EURUSD"],
        timeframe="H1",
        source="mock",
        mode="paper",
    )


def test_scheduler_disabled_by_default():
    settings = Settings(ai_scheduler_enabled=False)
    scheduler = SignalScheduler()
    scheduler._settings = settings
    assert scheduler.register_session(make_start_request()) is False


@pytest.mark.asyncio
async def test_register_and_unregister_job():
    settings = Settings(ai_scheduler_enabled=True, ai_signal_interval_seconds=3600)
    scheduler = SignalScheduler()
    scheduler._settings = settings

    assert scheduler.register_session(make_start_request()) is True
    assert scheduler.get_session_job("session-1") is not None
    assert scheduler.unregister_session("session-1") is True
    assert scheduler.get_session_job("session-1") is None
    scheduler.shutdown()


@pytest.mark.asyncio
async def test_duplicate_session_job_is_reconciled_idempotently():
    settings = Settings(ai_scheduler_enabled=True, ai_signal_interval_seconds=3600)
    scheduler = SignalScheduler()
    scheduler._settings = settings

    assert scheduler.register_session(make_start_request()) is True
    first_job = scheduler.get_session_job("session-1")
    assert first_job is not None

    replacement = make_start_request()
    replacement.instruments = ["GBPUSD", "USDJPY"]
    replacement.timeframes = ["M15", "H1"]
    assert scheduler.register_session(replacement) is True

    current = scheduler.get_session_job("session-1")
    assert current is not None
    assert current is not first_job
    assert current.instruments == ["GBPUSD", "USDJPY"]
    assert current.timeframes == ["M15", "H1"]
    scheduler.shutdown()


@pytest.mark.asyncio
async def test_job_calls_signal_generator_and_publishes_valid_signal():
    settings = Settings(ai_scheduler_enabled=True, ai_signal_mode="paper")
    scheduler = SignalScheduler(nestjs_client=AsyncMock())
    scheduler._settings = settings

    mock_generator = AsyncMock()
    candidate = AiSignalCandidate(
        user_id="user-1",
        trading_session_id="session-1",
        broker_connection_id="conn-1",
        instrument="EURUSD",
        direction="BUY",
        confidence_score=0.8,
        suggested_stop_loss=1.09,
        suggested_take_profit=1.12,
        suggested_volume=0.01,
        timeframe="H1",
        strategy_code="baseline-h1",
        model_version="baseline-xgboost-v0.1.0",
    )
    mock_generator.generate.return_value = SignalGenerationResponse(
        generated=True,
        signal=candidate,
        mode="paper",
    )
    scheduler._signal_generator = mock_generator

    job = ScheduledSessionJobStub()
    scheduler._jobs["session-1"] = job

    await scheduler._run_session_job("session-1")
    mock_generator.generate.assert_called_once()
    scheduler._nestjs_client.publish_signal.assert_called_once_with(candidate)


@pytest.mark.asyncio
async def test_low_confidence_not_published():
    settings = Settings(ai_scheduler_enabled=True, ai_signal_mode="paper")
    scheduler = SignalScheduler(nestjs_client=AsyncMock())
    scheduler._settings = settings

    mock_generator = AsyncMock()
    from app.domain.signals.schemas import NoSignalResult

    mock_generator.generate.return_value = SignalGenerationResponse(
        generated=False,
        no_signal=NoSignalResult(
            reason="confidence_below_threshold",
            instrument="EURUSD",
            confidence_score=0.2,
            threshold=0.6,
        ),
        mode="paper",
    )
    scheduler._signal_generator = mock_generator
    scheduler._jobs["session-1"] = ScheduledSessionJobStub()

    await scheduler._run_session_job("session-1")
    scheduler._nestjs_client.publish_signal.assert_not_called()


@pytest.mark.asyncio
async def test_full_auto_cycle_blocks_when_active_model_is_not_live_approved():
    from app.domain.models.registry import build_default_registry
    from app.main import app_state

    settings = Settings(ai_scheduler_enabled=True, ai_signal_mode="paper")
    scheduler = SignalScheduler(nestjs_client=AsyncMock())
    scheduler._settings = settings

    mock_generator = AsyncMock()
    scheduler._signal_generator = mock_generator
    job = ScheduledSessionJobStub()
    job.execution_mode = "FULL_AUTO"
    scheduler._jobs["session-1"] = job
    app_state["registry"] = build_default_registry()

    await scheduler._run_session_job("session-1")

    mock_generator.generate.assert_not_called()
    scheduler._nestjs_client.publish_signal.assert_not_called()
    assert job.last_decision == "LIVE_MODEL_BLOCKED"
    assert "not approved for live trading" in (job.last_reason or "")


@pytest.mark.asyncio
async def test_job_scans_each_configured_instrument_and_timeframe():
    settings = Settings(ai_scheduler_enabled=True, ai_signal_mode="paper")
    scheduler = SignalScheduler(nestjs_client=AsyncMock())
    scheduler._settings = settings

    mock_generator = AsyncMock()
    from app.domain.signals.schemas import NoSignalResult

    mock_generator.generate.return_value = SignalGenerationResponse(
        generated=False,
        no_signal=NoSignalResult(
            reason="confidence_below_threshold",
            instrument="EURUSD",
            confidence_score=0.4,
            threshold=0.6,
        ),
        mode="paper",
    )
    scheduler._signal_generator = mock_generator
    job = ScheduledSessionJobStub()
    job.instruments = ["EURUSD", "GBPUSD"]
    job.timeframes = ["M15", "H1"]
    scheduler._jobs["session-1"] = job

    await scheduler._run_session_job("session-1")

    assert mock_generator.generate.await_count == 4
    assert job.scan_count == 4
    assert job.last_decision == "NO_SIGNAL"


@pytest.mark.asyncio
async def test_shutdown_stops_scheduler_cleanly():
    settings = Settings(ai_scheduler_enabled=True, ai_signal_interval_seconds=3600)
    scheduler = SignalScheduler()
    scheduler._settings = settings
    scheduler.register_session(make_start_request())
    scheduler.shutdown()
    assert scheduler._started is False
    assert scheduler._jobs == {}


class ScheduledSessionJobStub:
    active = True
    instruments = ["EURUSD"]
    user_id = "user-1"
    trading_session_id = "session-1"
    broker_connection_id = "conn-1"
    timeframes = ["H1"]
    source = "mock"
    execution_mode = "PAPER_ONLY"
    last_publish_failed = False
    scan_count = 0
    last_decision = "WAITING_FOR_FIRST_SCAN"
    last_reason = None
    last_instrument = None
    last_timeframe = None
    last_confidence_score = None
    confidence_threshold = None
    last_signal_id = None
