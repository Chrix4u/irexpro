"""Tests for SignalScheduler."""
from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.v1.routes.scheduler import session_scheduler_status, start_session_scheduler
from app.core.config import Settings
from app.core.errors import MarketDataError
from app.domain.scheduler.schemas import SessionStartRequest, SessionStatusRequest
from app.domain.scheduler.signal_scheduler import ScheduledSessionJob, SignalScheduler
from app.domain.signals.schemas import (
    AiSignalCandidate,
    SignalEvaluationTelemetry,
    SignalGenerationResponse,
)


def make_start_request(session_id: str = "session-1") -> SessionStartRequest:
    return SessionStartRequest(
        userId="user-1",
        tradingSessionId=session_id,
        brokerConnectionId="conn-1",
        instruments=["EURUSD"],
        timeframe="H1",
        source="mock",
        accountType="DEMO",
        mode="paper",
    )


@pytest.mark.asyncio
async def test_scheduler_route_allows_full_auto_for_demo_provider_environment():
    scheduler = MagicMock()
    scheduler.register_session.return_value = True
    request = SessionStartRequest(
        userId="user-1",
        tradingSessionId="demo-session",
        brokerConnectionId="conn-demo",
        instruments=["EURUSD"],
        timeframe="H1",
        source="broker",
        accountType="DEMO",
        mode="FULL_AUTO",
    )

    response = await start_session_scheduler(request, scheduler)

    assert response.registered is True
    scheduler.register_session.assert_called_once_with(request)


def _live_request() -> SessionStartRequest:
    return SessionStartRequest(
        userId="user-1",
        tradingSessionId="live-session",
        brokerConnectionId="conn-live",
        instruments=["EURUSD"],
        timeframe="H1",
        source="broker",
        accountType="LIVE",
        mode="FULL_AUTO",
    )


def _settings_with(live_mode: bool, allow_live_model: bool) -> MagicMock:
    settings = MagicMock()
    settings.ai_signal_mode = "live" if live_mode else "paper"
    settings.ai_engine_allow_live_model = allow_live_model
    settings.is_production = False
    settings.ai_allow_mock_market_data = True
    return settings


@pytest.mark.asyncio
async def test_scheduler_route_blocks_live_when_engine_env_gate_is_closed(monkeypatch):
    """October UAT hardening (WS3): the default deployment (paper mode) refuses
    LIVE registration with the exact LIVE_MODEL_ENV_DISABLED reason."""
    scheduler = MagicMock()
    monkeypatch.setattr(
        "app.api.v1.routes.scheduler.get_settings",
        lambda: _settings_with(live_mode=False, allow_live_model=False),
    )

    response = await start_session_scheduler(_live_request(), scheduler)

    assert response.registered is False
    assert response.reason == "LIVE_MODEL_ENV_DISABLED"
    assert response.message == "Live signal mode is disabled for this AI engine"
    scheduler.register_session.assert_not_called()


@pytest.mark.asyncio
async def test_scheduler_route_blocks_live_when_env_open_but_model_not_live_approved(
    monkeypatch,
):
    """WS3: env gate open + no valid promotion record → the engine's exact
    typed refusal reason travels to the caller (never a blanket message)."""
    scheduler = MagicMock()
    monkeypatch.setattr(
        "app.api.v1.routes.scheduler.get_settings",
        lambda: _settings_with(live_mode=True, allow_live_model=True),
    )

    class _Registry:
        def get_live_activation(self):
            return {"activated": False, "reason": "NO_VALID_PROMOTION_RECORD"}

    from app.main import app_state

    original = app_state.get("registry")
    app_state["registry"] = _Registry()
    try:
        response = await start_session_scheduler(_live_request(), scheduler)
    finally:
        app_state["registry"] = original

    assert response.registered is False
    assert response.reason == "NO_VALID_PROMOTION_RECORD"
    assert response.message == "Current AI model is not approved for live automation"
    scheduler.register_session.assert_not_called()


@pytest.mark.asyncio
async def test_scheduler_route_blocks_live_on_artifact_sha_mismatch(monkeypatch):
    """WS3: an integrity failure surfaces the engine's exact reason."""
    scheduler = MagicMock()
    monkeypatch.setattr(
        "app.api.v1.routes.scheduler.get_settings",
        lambda: _settings_with(live_mode=True, allow_live_model=True),
    )

    class _Registry:
        def get_live_activation(self):
            return {"activated": False, "reason": "ARTIFACT_SHA_MISMATCH"}

    from app.main import app_state

    original = app_state.get("registry")
    app_state["registry"] = _Registry()
    try:
        response = await start_session_scheduler(_live_request(), scheduler)
    finally:
        app_state["registry"] = original

    assert response.registered is False
    assert response.reason == "ARTIFACT_SHA_MISMATCH"


@pytest.mark.asyncio
async def test_scheduler_route_registers_live_when_exact_model_is_live_approved(
    monkeypatch,
):
    """WS3: env gate open + the EXACT active model holds a valid promotion
    record → the session registers (broker certification / risk gates remain
    independent NestJS-side gates)."""
    scheduler = MagicMock()
    scheduler.register_session.return_value = True
    monkeypatch.setattr(
        "app.api.v1.routes.scheduler.get_settings",
        lambda: _settings_with(live_mode=True, allow_live_model=True),
    )

    class _Registry:
        def get_live_activation(self):
            return {"activated": True, "reason": None}

    from app.main import app_state

    original = app_state.get("registry")
    app_state["registry"] = _Registry()
    try:
        request = _live_request()
        response = await start_session_scheduler(request, scheduler)
    finally:
        app_state["registry"] = original

    assert response.registered is True
    assert response.reason is None
    scheduler.register_session.assert_called_once_with(request)


@pytest.mark.asyncio
async def test_scheduler_status_reports_the_trained_multitimeframe_runtime_stack():
    scheduler = MagicMock()
    scheduler.is_enabled = True
    job = ScheduledSessionJob(
        trading_session_id="session-mtf",
        user_id="user-1",
        broker_connection_id="conn-demo",
        instruments=["EURUSD"],
        timeframe="H1",
        source="broker",
        interval_seconds=60,
        last_run_at=datetime.now(UTC),
    )
    job.model_loaded = True
    job.model_mode = "trained_xgboost_mtf"
    scheduler.get_session_job.return_value = job

    response = await session_scheduler_status(
        SessionStatusRequest(tradingSessionId="session-mtf"),
        scheduler,
    )

    assert response.timeframe == "M1 · M5 · M15 · H1 · H4"


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
    last_confidence_at = None
    market_data_revisions = {}
    last_market_data_at = None
    model_version = None
    model_mode = None
    model_loaded = None
    market_data_cache_bypassed = False


@pytest.mark.asyncio
async def test_unchanged_market_revision_suppresses_duplicate_signal_publish():
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
    telemetry = SignalEvaluationTelemetry(
        model_version="baseline-xgboost-v0.1.0",
        model_mode="heuristic_placeholder",
        model_loaded=False,
        market_data_last_candle_at="2026-09-19T15:00:00Z",
        market_data_revision="same-market-revision",
        market_data_cache_bypassed=True,
    )
    mock_generator.generate.return_value = SignalGenerationResponse(
        generated=True,
        signal=candidate,
        telemetry=telemetry,
        mode="paper",
    )
    scheduler._signal_generator = mock_generator
    job = ScheduledSessionJobStub()
    job.market_data_revisions["EURUSD"] = "same-market-revision"
    job.last_confidence_score = 0.0285
    job.last_confidence_at = object()
    scheduler._jobs["session-1"] = job

    await scheduler._run_session_job("session-1")

    scheduler._nestjs_client.publish_signal.assert_not_called()
    assert job.last_decision == "NO_NEW_MARKET_DATA"
    assert job.last_reason == "market_data_unchanged"
    assert job.last_confidence_score is None
    assert job.last_confidence_at is None
    assert job.model_mode == "heuristic_placeholder"
    assert job.market_data_cache_bypassed is True


@pytest.mark.asyncio
async def test_scan_error_clears_previous_confidence_instead_of_reusing_it():
    settings = Settings(ai_scheduler_enabled=True, ai_signal_mode="paper")
    scheduler = SignalScheduler(nestjs_client=AsyncMock())
    scheduler._settings = settings

    mock_generator = AsyncMock()
    mock_generator.generate.side_effect = MarketDataError("Broker market data is stale")
    scheduler._signal_generator = mock_generator

    job = ScheduledSessionJobStub()
    job.source = "broker"
    job.last_confidence_score = 0.0285
    job.last_confidence_at = object()
    scheduler._jobs["session-1"] = job

    await scheduler._run_session_job("session-1")

    assert job.last_decision == "ERROR"
    assert job.last_reason == "MarketDataError"
    assert job.last_confidence_score is None
    assert job.last_confidence_at is None
    assert job.last_run_at is not None
    assert job.last_publish_failed is True


# ─── October UAT hardening (WS3): /models/active live env truth ─────────────


@pytest.mark.asyncio
async def test_models_active_reports_live_signal_mode_env_gate(monkeypatch):
    """WS3: /models/active exposes the engine-side environment/config LIVE
    authorization honestly (true ONLY when live mode + env gate are BOTH on)."""
    from app.api.v1.routes import models as models_route

    class _Model:
        def get_model_metadata(self):
            return {
                "version": "xgb-mtf-1",
                "mode": "trained_xgboost_mtf",
                "loaded": True,
                "artifact_sha256": "a" * 64,
                "approved_for_paper": True,
                "approved_for_live": False,
            }

    class _Registry:
        def get_active_model(self):
            return _Model()

        def get_live_activation(self):
            return {"activated": False, "reason": "NO_VALID_PROMOTION_RECORD"}

    monkeypatch.setattr(models_route, "get_registry", lambda: _Registry())
    monkeypatch.setattr(
        models_route,
        "get_settings",
        lambda: _settings_with(live_mode=False, allow_live_model=False),
    )

    payload = await models_route.get_active_model(_Registry())

    assert payload["live_activation"]["activated"] is False
    assert payload["live_signal_mode_enabled"] is False


@pytest.mark.asyncio
async def test_models_active_reports_env_gate_open(monkeypatch):
    from app.api.v1.routes import models as models_route

    class _Model:
        def get_model_metadata(self):
            return {"version": "xgb-mtf-1", "loaded": True}

    class _Registry:
        def get_active_model(self):
            return _Model()

        def get_live_activation(self):
            return {"activated": True, "reason": None}

    monkeypatch.setattr(models_route, "get_registry", lambda: _Registry())
    monkeypatch.setattr(
        models_route,
        "get_settings",
        lambda: _settings_with(live_mode=True, allow_live_model=True),
    )

    payload = await models_route.get_active_model(_Registry())

    assert payload["live_activation"]["activated"] is True
    assert payload["live_signal_mode_enabled"] is True


@pytest.mark.asyncio
async def test_models_active_env_gate_open_requires_both_mode_and_env(monkeypatch):
    """Live MODE alone (env gate closed) is NOT an enabled live path."""
    from app.api.v1.routes import models as models_route

    class _Model:
        def get_model_metadata(self):
            return {"version": "xgb-mtf-1", "loaded": True}

    class _Registry:
        def get_active_model(self):
            return _Model()

        def get_live_activation(self):
            return {"activated": True, "reason": None}

    monkeypatch.setattr(models_route, "get_registry", lambda: _Registry())
    # ai_signal_mode = 'live' BUT AI_ENGINE_ALLOW_LIVE_MODEL closed.
    monkeypatch.setattr(
        models_route,
        "get_settings",
        lambda: _settings_with(live_mode=True, allow_live_model=False),
    )

    payload = await models_route.get_active_model(_Registry())

    assert payload["live_signal_mode_enabled"] is False
