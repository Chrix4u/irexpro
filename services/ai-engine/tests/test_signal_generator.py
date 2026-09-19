"""Tests for SignalGenerator."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.domain.market_data.ohlcv_service import OHLCVService
from app.domain.market_data.providers.mock_provider import MockMarketDataProvider
from app.domain.market_data.redis_cache import OHLCVRedisCache
from app.domain.models.registry import build_default_registry
from app.domain.models.schemas import ModelPrediction
from app.domain.signals.signal_generator import SignalGenerator


def make_generator() -> SignalGenerator:
    provider = MockMarketDataProvider()
    cache = OHLCVRedisCache(redis_client=None)
    ohlcv_svc = OHLCVService(mock_provider=provider, cache=cache)
    registry = build_default_registry()
    return SignalGenerator(ohlcv_service=ohlcv_svc, model_registry=registry)


@pytest.mark.asyncio
async def test_signal_generator_returns_response_type():
    gen = make_generator()
    result = await gen.generate(
        user_id="u1",
        trading_session_id="s1",
        broker_connection_id="c1",
        instrument="EURUSD",
        timeframe="H1",
    )
    assert hasattr(result, "generated")
    assert hasattr(result, "mode")
    assert result.mode == "paper"


@pytest.mark.asyncio
async def test_signal_generator_no_signal_for_low_confidence():
    """When model returns confidence below threshold, no signal should be generated."""
    gen = make_generator()

    # Override model to return very low confidence
    mock_model = MagicMock()
    mock_model.get_model_version.return_value = "baseline-xgboost-v0.1.0"
    mock_model.predict_signal.return_value = ModelPrediction(
        direction="BUY",
        confidence_score=0.10,  # Far below 0.60 threshold
        model_version="baseline-xgboost-v0.1.0",
        features_used=[],
        explainability={"method": "mock"},
    )

    mock_registry = MagicMock()
    mock_registry.get_model_for.return_value = mock_model
    governance = MagicMock()
    governance.approved_for_paper = True
    mock_registry.get_governance.return_value = governance

    gen._registry = mock_registry

    result = await gen.generate(
        user_id="u1",
        trading_session_id="s1",
        broker_connection_id="c1",
        instrument="EURUSD",
        timeframe="H1",
    )
    assert result.generated is False
    assert result.signal is None
    assert result.no_signal is not None
    assert result.no_signal.reason == "confidence_below_threshold"


@pytest.mark.asyncio
async def test_signal_generator_creates_valid_candidate_for_high_confidence():
    """When model returns high confidence, a valid AiSignalCandidate should be created."""
    gen = make_generator()

    mock_model = MagicMock()
    mock_model.get_model_version.return_value = "baseline-xgboost-v0.1.0"
    mock_model.predict_signal.return_value = ModelPrediction(
        direction="BUY",
        confidence_score=0.80,  # Above 0.60 threshold
        model_version="baseline-xgboost-v0.1.0",
        features_used=["price_vs_ma20"],
        raw_scores={"price_vs_ma20": 0.005},
        explainability={"method": "mock"},
    )

    mock_registry = MagicMock()
    mock_registry.get_model_for.return_value = mock_model
    governance = MagicMock()
    governance.approved_for_paper = True
    mock_registry.get_governance.return_value = governance

    gen._registry = mock_registry

    result = await gen.generate(
        user_id="user-abc",
        trading_session_id="sess-xyz",
        broker_connection_id="conn-999",
        instrument="EURUSD",
        timeframe="H1",
    )
    mock_registry.get_model_for.assert_called_with("EURUSD", "H1")
    assert result.generated is True
    assert result.signal is not None
    assert result.signal.direction == "BUY"
    assert result.signal.confidence_score == 0.80
    assert result.signal.model_version == "baseline-xgboost-v0.1.0"
    assert result.signal.user_id == "user-abc"
    assert result.signal.suggested_stop_loss > 0
    assert result.signal.suggested_take_profit > 0
    assert result.signal.generated_at.tzinfo is not None


@pytest.mark.asyncio
async def test_signal_candidate_never_calls_execution_directly():
    """
    Safety test: SignalGenerator must never call ExecutionService, BrokerAdapter,
    or any trade-execution method directly.
    """
    gen = make_generator()
    # Confirm no execution-related attributes exist
    assert not hasattr(gen, "execution_service")
    assert not hasattr(gen, "broker_adapter")
    assert not hasattr(gen, "place_order")
    assert not hasattr(gen, "execute_trade")


@pytest.mark.asyncio
async def test_signal_generator_reports_truthful_model_and_market_telemetry():
    gen = make_generator()
    result = await gen.generate(
        user_id="u1",
        trading_session_id="s1",
        broker_connection_id="c1",
        instrument="EURUSD",
        timeframe="H1",
        bypass_market_data_cache=True,
    )

    assert result.telemetry is not None
    assert result.telemetry.model_version == "baseline-xgboost-v0.1.0"
    assert result.telemetry.model_mode == "heuristic_placeholder"
    assert result.telemetry.model_loaded is False
    assert result.telemetry.market_data_revision
    assert result.telemetry.market_data_cache_bypassed is True
