"""
SignalGenerator — produces AiSignalCandidate objects from OHLCV data.

IMPORTANT SAFETY RULES:
1. This class NEVER calls the broker directly.
2. This class NEVER calls the execution engine.
3. Output is always an AiSignalCandidate — a candidate for NestJS review.
4. All candidates must be forwarded via NestJsClient.publish_signal()
   which routes through AiSignalService → StrategyOrchestrator → Risk Engine → Execution.
5. If confidence is below threshold, NoSignalResult is returned — nothing is forwarded.
"""
from __future__ import annotations

from datetime import UTC, datetime
import hashlib
from uuid import uuid4

from app.core.config import get_settings
from app.core.errors import LiveModeNotSupportedError, SignalGenerationError
from app.core.logging import get_logger
from app.core.security import sanitize_metadata
from app.domain.market_data.ohlcv_service import MarketDataSource, OHLCVService
from app.domain.market_data.schemas import OHLCVCandle
from app.domain.models.feature_engineering import candles_to_dataframe, extract_latest_features
from app.domain.models.registry import ModelRegistry
from app.domain.signals.confidence import get_threshold, is_above_threshold
from app.domain.signals.explainability import build_explainability_metadata
from app.domain.signals.schemas import AiSignalCandidate, NoSignalResult, SignalGenerationResponse

logger = get_logger(__name__)


class SignalGenerator:
    """
    Generates AiSignalCandidate objects from market data + model inference.
    Enforces the confidence threshold gate before producing any signal.
    """

    def __init__(self, ohlcv_service: OHLCVService, model_registry: ModelRegistry) -> None:
        self._ohlcv = ohlcv_service
        self._registry = model_registry

    async def generate(
        self,
        user_id: str,
        trading_session_id: str,
        broker_connection_id: str,
        instrument: str,
        timeframe: str = "H1",
        candles: list[OHLCVCandle] | None = None,
        source: MarketDataSource = "mock",
        bypass_market_data_cache: bool = False,
        previous_market_data_fingerprint: str | None = None,
    ) -> SignalGenerationResponse:
        """
        Full signal generation pipeline.

        Scheduler-driven broker scans can bypass Redis and pass the previously
        evaluated market fingerprint. If the fresh broker observation is
        unchanged, model inference is deliberately skipped instead of reporting
        a duplicate decision as fresh AI analysis.
        """
        settings = get_settings()

        if settings.ai_signal_mode == "live":
            raise LiveModeNotSupportedError(
                "Live signal mode is not supported in this sprint. "
                "Use AI_SIGNAL_MODE=paper."
            )

        # 1. Fetch OHLCV data.
        market_data_fetched_at = datetime.now(UTC)
        market_data_cache_status = "provided"
        if candles is None:
            market_data_cache_status = "bypassed" if bypass_market_data_cache else "enabled"
            candles = await self._ohlcv.get_ohlcv(
                source=source,
                instrument=instrument,
                timeframe=timeframe,
                limit=100,
                user_id=user_id,
                broker_connection_id=broker_connection_id,
                bypass_cache=bypass_market_data_cache,
            )
            market_data_fetched_at = datetime.now(UTC)

        if len(candles) < 10:
            raise SignalGenerationError(
                f"Insufficient candle data: {len(candles)} candles (minimum 10 required)"
            )

        latest_candle = candles[-1]
        latest_market_data_at = latest_candle.timestamp
        if latest_market_data_at.tzinfo is None:
            latest_market_data_at = latest_market_data_at.replace(tzinfo=UTC)

        market_data_age_seconds = max(
            0.0,
            (market_data_fetched_at - latest_market_data_at).total_seconds(),
        )
        market_data_fingerprint = self._fingerprint_latest_candle(latest_candle)

        # 2. Resolve model identity/governance before deciding whether inference is needed.
        model = self._registry.get_active_model()
        model_version = model.get_model_version()
        model_metadata = model.get_model_metadata()
        model_mode = (
            str(model_metadata.get("mode", "unknown"))
            if isinstance(model_metadata, dict)
            else "unknown"
        )
        model_loaded = (
            bool(model_metadata.get("loaded", False))
            if isinstance(model_metadata, dict)
            else False
        )
        governance = self._registry.get_governance(model_version)

        if not governance.approved_for_paper:
            raise SignalGenerationError(
                f"Model {model_version} is not approved for paper mode"
            )

        common_telemetry = {
            "model_version": model_version,
            "model_mode": model_mode,
            "model_loaded": model_loaded,
            "market_data_source": source,
            "market_data_cache_status": market_data_cache_status,
            "market_data_cache_age_seconds": None,
            "market_data_fetched_at": market_data_fetched_at,
            "latest_market_data_at": latest_market_data_at,
            "market_data_age_seconds": market_data_age_seconds,
            "market_data_fingerprint": market_data_fingerprint,
        }

        if (
            previous_market_data_fingerprint
            and previous_market_data_fingerprint == market_data_fingerprint
        ):
            logger.debug(
                "Market observation unchanged — model inference skipped",
                instrument=instrument,
                timeframe=timeframe,
            )
            return SignalGenerationResponse(
                generated=False,
                no_signal=NoSignalResult(
                    reason="market_data_unchanged",
                    instrument=instrument,
                    confidence_score=None,
                    threshold=get_threshold(),
                ),
                mode=settings.ai_signal_mode,
                model_evaluated=False,
                **common_telemetry,
            )

        # 3. Feature engineering + model inference only for a changed observation.
        df = candles_to_dataframe(candles)
        features = extract_latest_features(df)
        prediction = model.predict_signal(features)

        # 4. Confidence threshold gate.
        if not is_above_threshold(prediction.confidence_score):
            logger.info(
                "Signal below confidence threshold — no signal generated",
                instrument=instrument,
                confidence=prediction.confidence_score,
                threshold=get_threshold(),
            )
            return SignalGenerationResponse(
                generated=False,
                no_signal=NoSignalResult(
                    reason="confidence_below_threshold",
                    instrument=instrument,
                    confidence_score=prediction.confidence_score,
                    threshold=get_threshold(),
                ),
                mode=settings.ai_signal_mode,
                model_evaluated=True,
                **common_telemetry,
            )

        # 5. Compute SL/TP from latest price (simple ATR-like placeholder).
        last_price = candles[-1].close
        atr_estimate = features.get("hl_range", last_price * 0.001) * 1.5

        if prediction.direction == "BUY":
            sl = round(last_price - atr_estimate * 1.5, 5)
            tp = round(last_price + atr_estimate * 2.0, 5)
        else:
            sl = round(last_price + atr_estimate * 1.5, 5)
            tp = round(last_price - atr_estimate * 2.0, 5)

        # 6. Market regime estimation (placeholder).
        volatility = features.get("volatility_10", 0.0)
        if volatility > 0.003:
            market_regime = "volatile"
        elif abs(features.get("price_vs_ma20", 0.0)) > 0.002:
            market_regime = "trending"
        else:
            market_regime = "ranging"

        # 7. Build explainability metadata.
        explainability = build_explainability_metadata(
            prediction.explainability, features, instrument, timeframe
        )

        # 8. Construct candidate.
        metadata = sanitize_metadata({
            **explainability,
            "raw_scores": prediction.raw_scores,
            "signal_mode": settings.ai_signal_mode,
        })

        candidate = AiSignalCandidate(
            signal_id=str(uuid4()),
            user_id=user_id,
            trading_session_id=trading_session_id,
            broker_connection_id=broker_connection_id,
            instrument=instrument.upper(),
            direction=prediction.direction,
            confidence_score=prediction.confidence_score,
            suggested_entry_price=last_price,
            suggested_stop_loss=sl,
            suggested_take_profit=tp,
            suggested_volume=0.01,  # Conservative minimum lot size for paper mode
            timeframe=timeframe,
            strategy_code=f"baseline-{timeframe.lower()}",
            market_regime=market_regime,
            volatility_score=min(volatility * 100, 1.0),
            generated_at=datetime.now(UTC),
            model_version=prediction.model_version,
            metadata=metadata,
        )

        logger.info(
            "Signal candidate generated",
            instrument=instrument,
            direction=candidate.direction,
            confidence=candidate.confidence_score,
            mode=settings.ai_signal_mode,
        )

        return SignalGenerationResponse(
            generated=True,
            signal=candidate,
            mode=settings.ai_signal_mode,
            model_evaluated=True,
            **common_telemetry,
        )

    @staticmethod
    def _fingerprint_latest_candle(candle: OHLCVCandle) -> str:
        """Stable identity for the latest market observation, excluding secrets."""
        payload = "|".join(
            [
                candle.timestamp.isoformat(),
                f"{candle.open:.10g}",
                f"{candle.high:.10g}",
                f"{candle.low:.10g}",
                f"{candle.close:.10g}",
                f"{candle.volume:.10g}",
                candle.instrument.upper(),
                candle.timeframe.upper(),
            ]
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()
