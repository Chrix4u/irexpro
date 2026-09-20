"""Tests for SignalGenerator."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.domain.market_data.ohlcv_service import OHLCVService
from app.domain.market_data.schemas import OHLCVCandle
from app.domain.market_data.providers.mock_provider import MockMarketDataProvider
from app.domain.market_data.redis_cache import OHLCVRedisCache
from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_FEATURE_COLUMNS,
    MULTITIMEFRAME_RUNTIME_PROFILE,
    RUNTIME_TIMEFRAMES,
    TIMEFRAME_MINUTES,
)
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
    mock_registry.get_active_model.return_value = mock_model
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
    mock_registry.get_active_model.return_value = mock_model
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



def _closed_broker_candles(timeframe: str) -> list[OHLCVCandle]:
    duration = timedelta(minutes=TIMEFRAME_MINUTES[timeframe])
    now = datetime.now(UTC)
    end_open = now - duration * 2
    first = end_open - duration * 29
    candles = []
    for index in range(30):
        timestamp = first + duration * index
        close = 1.10 + index * 0.00001
        candles.append(
            OHLCVCandle(
                timestamp=timestamp,
                open=close - 0.00002,
                high=close + 0.00005,
                low=close - 0.00005,
                close=close,
                volume=100 + index,
                tick_volume=100 + index,
                spread_points=2.0,
                price_digits=5,
                instrument="EURUSD",
                timeframe=timeframe,
                source="broker",
            )
        )
    return candles


@pytest.mark.asyncio
async def test_trained_mtf_runtime_fetches_all_timeframes_and_uses_m1_signal_timing():
    ohlcv = MagicMock()
    ohlcv.get_ohlcv = AsyncMock(
        side_effect=lambda **kwargs: _closed_broker_candles(kwargs["timeframe"])
    )

    model = MagicMock()
    model.get_model_version.return_value = "mtf-xgboost-sixpair-h5-test"
    model.get_model_metadata.return_value = {
        "version": "mtf-xgboost-sixpair-h5-test",
        "loaded": True,
        "mode": "trained_xgboost_mtf",
        "runtime_feature_profile": MULTITIMEFRAME_RUNTIME_PROFILE,
        "approved_for_paper": True,
    }
    model.predict_signal.return_value = ModelPrediction(
        direction="BUY",
        confidence_score=0.80,
        model_version="mtf-xgboost-sixpair-h5-test",
        features_used=list(MULTITIMEFRAME_FEATURE_COLUMNS),
        raw_scores={"positive_class_probability": 0.80},
        explainability={"method": "xgboost_predict_proba"},
    )

    registry = MagicMock()
    registry.get_active_model.return_value = model
    governance = MagicMock()
    governance.approved_for_paper = True
    registry.get_governance.return_value = governance

    generator = SignalGenerator(ohlcv_service=ohlcv, model_registry=registry)
    result = await generator.generate(
        user_id="u1",
        trading_session_id="s1",
        broker_connection_id="c1",
        instrument="EURUSD",
        timeframe="H1",
        source="broker",
    )

    requested = [call.kwargs["timeframe"] for call in ohlcv.get_ohlcv.await_args_list]
    assert requested == list(RUNTIME_TIMEFRAMES)
    assert result.generated is True
    assert result.signal is not None
    assert result.signal.timeframe == "M1"
    assert result.signal.strategy_code == "xgboost-mtf-trained-m1"
    assert result.telemetry is not None
    assert result.telemetry.model_mode == "trained_xgboost_mtf"
    assert result.telemetry.model_loaded is True
    assert result.telemetry.market_data_cache_bypassed is True

    feature_arg = model.predict_signal.call_args.args[0]
    assert list(feature_arg) == MULTITIMEFRAME_FEATURE_COLUMNS
