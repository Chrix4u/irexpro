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
from hashlib import sha256
from uuid import uuid4

from app.core.config import get_settings
from app.core.errors import LiveModeNotSupportedError, SignalGenerationError
from app.core.logging import get_logger
from app.core.security import sanitize_metadata
from app.domain.agents.context_service import AgentContextService
from app.domain.market_data.ohlcv_service import MarketDataSource, OHLCVService
from app.domain.market_data.schemas import OHLCVCandle
from app.domain.models.feature_engineering import candles_to_dataframe, extract_latest_features
from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_RUNTIME_PROFILE,
    RUNTIME_TIMEFRAMES,
    build_multitimeframe_runtime_features,
)
from app.domain.models.registry import ModelRegistry
from app.domain.signals.confidence import get_threshold, is_above_threshold
from app.domain.signals.explainability import build_explainability_metadata
from app.domain.signals.schemas import (
    AiSignalCandidate,
    NoSignalResult,
    SignalEvaluationTelemetry,
    SignalGenerationResponse,
)

logger = get_logger(__name__)


class SignalGenerator:
    """
    Generates AiSignalCandidate objects from market data + model inference.
    Enforces the confidence threshold gate before producing any signal.
    """

    def __init__(
        self,
        ohlcv_service: OHLCVService,
        model_registry: ModelRegistry,
        agent_context_service: AgentContextService | None = None,
    ) -> None:
        self._ohlcv = ohlcv_service
        self._registry = model_registry
        self._agent_context_service = agent_context_service

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
    ) -> SignalGenerationResponse:
        """
        Full signal generation pipeline.
        Returns SignalGenerationResponse with either a candidate or a no-signal result.
        """
        settings = get_settings()

        if settings.ai_signal_mode == "live":
            # LIVE requires ALL gates open (fail-closed, each named truthfully):
            #   1. env feature gate AI_ENGINE_ALLOW_LIVE_MODEL
            #   2. a VALID out-of-band promotion record binding the active
            #      model_version + byte-exact verified artifact SHA-256
            if not settings.ai_engine_allow_live_model:
                raise LiveModeNotSupportedError(
                    "Live signal mode is disabled: AI_ENGINE_ALLOW_LIVE_MODEL "
                    "is not enabled for this engine. Live mode additionally "
                    "requires a valid operator promotion record."
                )

            live_activation = self._registry.get_live_activation()
            if not live_activation.get("activated", False):
                reason = live_activation.get("reason") or "NO_VALID_PROMOTION_RECORD"
                raise LiveModeNotSupportedError(
                    "Live signal mode is disabled: the active model has no valid "
                    "live promotion record (gate closed: "
                    f"{reason}). Live activation requires an out-of-band operator "
                    "promotion record matching the model_version and the verified "
                    "artifact SHA-256 byte-exactly."
                )

        # 1. Resolve active model/governance before deciding which market-data
        # feature profile is required.
        model = self._registry.get_active_model()
        raw_model_metadata = model.get_model_metadata()
        model_metadata = (
            raw_model_metadata if isinstance(raw_model_metadata, dict) else {}
        )
        governance = self._registry.get_governance(model.get_model_version())

        if not governance.approved_for_paper:
            raise SignalGenerationError(
                f"Model {model.get_model_version()} is not approved for paper mode"
            )

        runtime_profile = str(
            model_metadata.get("runtime_feature_profile", "single_timeframe_v1")
        )
        mtf_runtime = (
            bool(model_metadata.get("loaded", False))
            and runtime_profile == MULTITIMEFRAME_RUNTIME_PROFILE
        )

        signal_timeframe = timeframe.upper()
        latest_candle: OHLCVCandle
        revision_parts: list[str] = [instrument.upper()]

        if mtf_runtime:
            if source != "broker":
                raise SignalGenerationError(
                    "Trained multi-timeframe runtime requires broker market data"
                )
            if candles is not None:
                raise SignalGenerationError(
                    "Explicit single-timeframe candles cannot be used with the "
                    "trained multi-timeframe runtime"
                )

            candles_by_timeframe: dict[str, list[OHLCVCandle]] = {}
            for index, required_timeframe in enumerate(RUNTIME_TIMEFRAMES):
                candles_by_timeframe[required_timeframe] = await self._ohlcv.get_ohlcv(
                    source=source,
                    instrument=instrument,
                    timeframe=required_timeframe,
                    limit=100,
                    user_id=user_id,
                    broker_connection_id=broker_connection_id,
                    bypass_cache=True,
                    advance_simulation=(source == "broker" and index == 0),
                )

            try:
                bundle = build_multitimeframe_runtime_features(
                    candles_by_timeframe,
                    instrument=instrument,
                )
            except ValueError as exc:
                raise SignalGenerationError(
                    f"Unable to build trained MTF feature vector: {exc}"
                ) from exc

            features = bundle.features
            latest_candle = bundle.latest_m1
            signal_timeframe = "M1"
            for required_timeframe in RUNTIME_TIMEFRAMES:
                candle = bundle.latest_by_timeframe[required_timeframe]
                revision_parts.extend(
                    [
                        required_timeframe,
                        candle.timestamp.isoformat(),
                        str(candle.close),
                        str(candle.tick_volume),
                    ]
                )
            revision_parts.extend(
                [
                    str(latest_candle.spread_points),
                    str(latest_candle.price_digits),
                ]
            )
        else:
            if candles is None:
                candles = await self._ohlcv.get_ohlcv(
                    source=source,
                    instrument=instrument,
                    timeframe=timeframe,
                    limit=100,
                    user_id=user_id,
                    broker_connection_id=broker_connection_id,
                    bypass_cache=bypass_market_data_cache,
                    advance_simulation=(source == "broker"),
                )

            if len(candles) < 10:
                raise SignalGenerationError(
                    f"Insufficient candle data: {len(candles)} candles "
                    "(minimum 10 required)"
                )

            df = candles_to_dataframe(candles)
            features = extract_latest_features(df)
            latest_candle = candles[-1]
            revision_parts.extend(
                [
                    signal_timeframe,
                    latest_candle.timestamp.isoformat(),
                    str(latest_candle.open),
                    str(latest_candle.high),
                    str(latest_candle.low),
                    str(latest_candle.close),
                    str(latest_candle.volume),
                ]
            )

        # 2. Model inference against the matching runtime feature profile.
        prediction = model.predict_signal(features)

        revision_material = "|".join(revision_parts)
        telemetry = SignalEvaluationTelemetry(
            model_version=prediction.model_version,
            model_mode=str(model_metadata.get("mode", "unknown")),
            model_loaded=bool(model_metadata.get("loaded", False)),
            market_data_last_candle_at=latest_candle.timestamp,
            market_data_revision=sha256(revision_material.encode("utf-8")).hexdigest(),
            market_data_cache_bypassed=(
                True if mtf_runtime else bypass_market_data_cache
            ),
        )

        # 4. Confidence threshold gate
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
                telemetry=telemetry,
                mode=settings.ai_signal_mode,
            )

        # 5. Compute conservative paper-mode SL/TP from the latest closed M1
        # range for MTF models, or the legacy single-timeframe range otherwise.
        last_price = latest_candle.close
        range_value = (
            features.get("m1_range_pct", 0.001) * last_price
            if mtf_runtime
            else features.get("hl_range", last_price * 0.001)
        )
        atr_estimate = range_value * 1.5

        if prediction.direction == "BUY":
            sl = round(last_price - atr_estimate * 1.5, 5)
            tp = round(last_price + atr_estimate * 2.0, 5)
        else:
            sl = round(last_price + atr_estimate * 1.5, 5)
            tp = round(last_price - atr_estimate * 2.0, 5)

        # 6. Market regime estimation for explanatory telemetry only.
        volatility = features.get(
            "h1_volatility_10" if mtf_runtime else "volatility_10",
            0.0,
        )
        trend_distance = features.get(
            "h1_price_vs_ma20" if mtf_runtime else "price_vs_ma20",
            0.0,
        )
        if volatility > 0.003:
            market_regime = "volatile"
        elif abs(trend_distance) > 0.002:
            market_regime = "trending"
        else:
            market_regime = "ranging"

        # 7. Build explainability metadata
        explainability = build_explainability_metadata(
            prediction.explainability, features, instrument, signal_timeframe
        )

        # 8. Capture advisory Agent Council context. It is persisted for
        # Decision Explorer evidence only and does not alter this signal's
        # eligibility, confidence, SL/TP, volume, Risk Engine, or execution path.
        agent_context = None
        if self._agent_context_service is not None:
            try:
                agent_context = await self._agent_context_service.snapshot_for(
                    instrument=instrument,
                    quant_direction=prediction.direction,
                    quant_confidence=prediction.confidence_score,
                )
            except Exception as exc:  # advisory context must not become execution authority
                logger.warning(
                    "Agent context snapshot unavailable",
                    instrument=instrument,
                    error_type=type(exc).__name__,
                )

        # 9. Construct candidate
        metadata = sanitize_metadata({
            **explainability,
            "raw_scores": prediction.raw_scores,
            "signal_mode": settings.ai_signal_mode,
        })

        model_mode = model_metadata.get("mode")
        if model_mode == "trained_xgboost_mtf":
            strategy_family = "xgboost-mtf-trained"
        elif model_mode == "trained_xgboost":
            strategy_family = "xgboost-trained"
        else:
            strategy_family = "baseline"

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
            timeframe=signal_timeframe,
            strategy_code=f"{strategy_family}-{signal_timeframe.lower()}",
            market_regime=market_regime,
            volatility_score=min(volatility * 100, 1.0),
            generated_at=datetime.now(UTC),
            model_version=prediction.model_version,
            agent_context=agent_context,
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
            telemetry=telemetry,
            mode=settings.ai_signal_mode,
        )
