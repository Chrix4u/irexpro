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


class _SensitiveStatusChallengerV4:
    loaded = True

    def status(self) -> dict:
        return {
            "artifact": "plan-b-v4",
            "loaded": True,
            "load_error": "Traceback: secret filesystem detail",
            "manifest_path": "/srv/private/research/manifest.json",
        }


class _SensitiveStatusChallengerV85:
    loaded = False
    checkpoint_minutes = (5, 10, 15)

    def status(self) -> dict:
        return {
            "artifact": "plan-b-v85",
            "loaded": False,
            "load_error": "Traceback: private model loading detail",
            "manifest_path": "/srv/private/research/v85.json",
        }


class _FailingBrokerMarketData:
    async def get_ohlcv(self, **_kwargs):
        raise MarketDataError("provider traceback / token=should-never-cross-api-boundary")


@pytest.mark.asyncio
async def test_v4_broker_score_hides_exception_and_sensitive_status_details():
    result = await score_plan_b_v4_broker(
        ChallengerBrokerScoreRequest(
            user_id="user-1",
            broker_connection_id="broker-1",
            instrument="EURUSD",
        ),
        challenger=_SensitiveStatusChallengerV4(),
        ohlcv=_FailingBrokerMarketData(),
    )

    assert result["state"] == "WAITING_FOR_BROKER_DATA"
    assert result["reason"] == "BROKER_MARKET_DATA_UNAVAILABLE"
    assert "load_error" not in result["status"]
    assert "manifest_path" not in result["status"]
    assert "should-never-cross-api-boundary" not in repr(result)


@pytest.mark.asyncio
async def test_v85_not_loaded_uses_stable_reason_and_hides_sensitive_status_details():
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
        challenger=_SensitiveStatusChallengerV85(),
        ohlcv=_FailingBrokerMarketData(),
    )

    assert result["state"] == "ERROR"
    assert result["reason"] == "POST_ENTRY_CHALLENGER_NOT_LOADED"
    assert "load_error" not in result["status"]
    assert "manifest_path" not in result["status"]
    assert "private model loading detail" not in repr(result)
