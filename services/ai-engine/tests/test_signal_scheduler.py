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
async def test_duplicate_session_job_rejected():
    settings = Settings(ai_scheduler_enabled=True, ai_signal_interval_seconds=3600)
    scheduler = SignalScheduler()
    scheduler._settings = settings

    assert scheduler.register_session(make_start_request()) is True
    assert scheduler.register_session(make_start_request()) is False
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
    assert job.last_decision == "SIGNAL_PUBLISHED"
    assert job.last_reason == "confidence_threshold_passed"
    assert job.last_confidence_score == 0.8


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
    job = scheduler._jobs["session-1"]
    assert job.last_decision == "NO_TRADE"
    assert job.last_reason == "confidence_below_threshold"
    assert job.last_confidence_score == 0.2


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
    timeframe = "H1"
    source = "mock"
    last_publish_failed = False
    last_decision = None
    last_reason = None
    last_confidence_score = None
    last_model_evaluated_at = None
    model_version = None
    model_mode = None
    model_loaded = False
    market_data_cache_status = None
    market_data_cache_age_seconds = None
    latest_market_data_at = None
    market_data_age_seconds = None
    last_market_data_fingerprints = {}


@pytest.mark.asyncio
async def test_broker_scheduler_bypasses_cache_and_skips_unchanged_inference():
    from datetime import UTC, datetime

    from app.domain.signals.schemas import NoSignalResult

    settings = Settings(ai_scheduler_enabled=True, ai_signal_mode="paper")
    scheduler = SignalScheduler(nestjs_client=AsyncMock())
    scheduler._settings = settings

    mock_generator = AsyncMock()
    mock_generator.generate.return_value = SignalGenerationResponse(
        generated=False,
        no_signal=NoSignalResult(
            reason="market_data_unchanged",
            instrument="EURUSD",
            confidence_score=None,
            threshold=0.6,
        ),
        mode="paper",
        model_version="baseline-xgboost-v0.1.0",
        model_mode="heuristic_placeholder",
        model_loaded=False,
        model_evaluated=False,
        market_data_source="broker",
        market_data_cache_status="bypassed",
        market_data_fetched_at=datetime.now(UTC),
        latest_market_data_at=datetime.now(UTC),
        market_data_age_seconds=0.0,
        market_data_fingerprint="same-market-observation",
    )
    scheduler._signal_generator = mock_generator

    job = ScheduledSessionJobStub()
    job.source = "broker"
    job.last_confidence_score = 0.0312
    job.last_market_data_fingerprints = {"EURUSD": "same-market-observation"}
    scheduler._jobs["session-1"] = job

    await scheduler._run_session_job("session-1")

    mock_generator.generate.assert_called_once_with(
        user_id="user-1",
        trading_session_id="session-1",
        broker_connection_id="conn-1",
        instrument="EURUSD",
        timeframe="H1",
        source="broker",
        bypass_market_data_cache=True,
        previous_market_data_fingerprint="same-market-observation",
    )
    assert job.last_decision == "NO_NEW_DATA"
    assert job.last_reason == "market_data_unchanged"
    assert job.last_confidence_score == 0.0312
    assert job.market_data_cache_status == "bypassed"
    assert job.model_mode == "heuristic_placeholder"
