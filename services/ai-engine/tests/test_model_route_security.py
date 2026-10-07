"""Security regressions for internal challenger scoring responses."""
from __future__ import annotations

import pytest

from app.api.v1.routes.models import (
    ChallengerBrokerScoreRequest,
    PostEntryBrokerScoreRequest,
    score_plan_b_v4_broker,
    score_plan_b_v85_broker_checkpoint,
)
from app.core.errors import MarketDataError


class _LoadedChallengerV4:
    loaded = True

    def status(self) -> dict:
        return {
            "artifact": "plan-b-v4",
            "loaded": True,
            "load_error": None,
            "manifest_path": "/srv/research/manifest.json",
        }


class _UnloadedChallengerV85:
    loaded = False
    checkpoint_minutes = (5, 10, 15)

    def status(self) -> dict:
        return {
            "artifact": "plan-b-v85",
            "loaded": False,
            "load_error": "CHALLENGER_LOAD_FAILED",
            "manifest_path": "/srv/research/v85.json",
        }


class _FailingBrokerMarketData:
    async def get_ohlcv(self, **_kwargs):
        raise MarketDataError("provider traceback / token=should-never-cross-api-boundary")


@pytest.mark.asyncio
async def test_v4_broker_score_maps_market_data_exception_to_stable_reason():
    result = await score_plan_b_v4_broker(
        ChallengerBrokerScoreRequest(
            user_id="user-1",
            broker_connection_id="broker-1",
            instrument="EURUSD",
        ),
        challenger=_LoadedChallengerV4(),
        ohlcv=_FailingBrokerMarketData(),
    )

    assert result["state"] == "WAITING_FOR_BROKER_DATA"
    assert result["reason"] == "BROKER_MARKET_DATA_UNAVAILABLE"
    assert "should-never-cross-api-boundary" not in repr(result)


@pytest.mark.asyncio
async def test_v85_not_loaded_uses_route_reason_not_internal_load_detail():
    result = await score_plan_b_v85_broker_checkpoint(
        PostEntryBrokerScoreRequest(
            user_id="user-1",
            broker_connection_id="broker-1",
            instrument="EURUSD",
            direction="BUY",
            entry_price=1.1,
            stop_loss=1.09,
            opened_at="2026-10-07T09:00:00Z",
            checkpoint_minutes=5,
            confidence=0.7,
            candidate_score=0.8,
            extension_atr=0.1,
            volatility_score=0.2,
            ema_separation=0.3,
            mtf_strength=0.4,
            rsi14=55.0,
        ),
        challenger=_UnloadedChallengerV85(),
        ohlcv=_FailingBrokerMarketData(),
    )

    assert result["state"] == "ERROR"
    assert result["reason"] == "POST_ENTRY_CHALLENGER_NOT_LOADED"
    assert "CHALLENGER_LOAD_FAILED" not in result["reason"]
