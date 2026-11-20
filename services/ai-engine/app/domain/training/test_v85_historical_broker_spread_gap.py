"""A missing historical spread is unobservable evidence, never a model error.

No network, database, broker credentials or broker order APIs are invoked.
"""
from datetime import UTC, datetime, timedelta
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

from app.api.v1.routes.models import (
    PostEntryBrokerScoreRequest, score_plan_b_v85_broker_checkpoint,
)
from app.domain.models.multitimeframe_features import MissingBrokerSpreadMetadata


class LoadedShadow:
    loaded = True
    checkpoint_minutes = (5, 10, 15, 30, 60, 120, 240)

    def status(self):
        return {"execution_authority": "NONE", "loaded": True}


class ProviderStub:
    async def get_ohlcv(self, **_kwargs):
        return []


class HistoricalBrokerSpreadGapTests(IsolatedAsyncioTestCase):
    async def _score(self, checkpoint_age_minutes: int):
        now = datetime.now(UTC)
        checkpoint_at = now - timedelta(minutes=checkpoint_age_minutes)
        request = PostEntryBrokerScoreRequest(
            user_id="user-test", broker_connection_id="demo-test",
            instrument="EURUSD", direction="BUY", entry_price=1.1,
            stop_loss=1.099, opened_at=checkpoint_at - timedelta(minutes=5),
            checkpoint_minutes=5, confidence=.7, candidate_score=.7,
            extension_atr=.2, volatility_score=.3,
            ema_separation=.4, mtf_strength=.6, rsi14=52,
        )
        with patch(
            "app.api.v1.routes.models.build_multitimeframe_runtime_features",
            side_effect=MissingBrokerSpreadMetadata(
                "M1 broker candle is missing spread_points/price_digits"),
        ):
            return await score_plan_b_v85_broker_checkpoint(
                request, challenger=LoadedShadow(), ohlcv=ProviderStub(),
            )

    async def test_old_missing_spread_does_not_raise_generic_model_error(self):
        result = await self._score(30)
        self.assertEqual(result["state"], "WAITING_FOR_BROKER_DATA")
        self.assertEqual(result["reason"], "HISTORICAL_SPREAD_UNOBSERVABLE")
        self.assertIsNone(result["score"])
        self.assertEqual(result["status"]["execution_authority"], "NONE")

    async def test_recent_missing_spread_can_be_retried(self):
        result = await self._score(2)
        self.assertEqual(result["state"], "WAITING_FOR_BROKER_DATA")
        self.assertEqual(result["reason"], "AWAITING_BROKER_SPREAD_EVIDENCE")
        self.assertIsNone(result["score"])
