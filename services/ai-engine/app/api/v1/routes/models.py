"""Model registry and internal challenger endpoints."""
from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.errors import MarketDataError
from app.core.security import validate_internal_api_key
from app.domain.market_data.ohlcv_service import OHLCVService
from app.domain.market_data.redis_cache import OHLCVRedisCache
from app.domain.models.high_conviction_challenger import PlanBV4HighConvictionChallenger
from app.domain.models.multitimeframe_features import (
    RUNTIME_TIMEFRAMES,
    build_multitimeframe_runtime_features,
)
from app.domain.models.post_entry_protection_challenger import (
    PlanBV85PostEntryProtectionChallenger,
)
from app.domain.models.registry import ModelRegistry

router = APIRouter()
INTERNAL_API_KEY_HEADER = "x-irexpro-internal-api-key"


class ChallengerBrokerScoreRequest(BaseModel):
    user_id: str = Field(min_length=1)
    broker_connection_id: str = Field(min_length=1)
    instrument: str = Field(min_length=6, max_length=7)


class PostEntryBrokerScoreRequest(BaseModel):
    user_id: str = Field(min_length=1)
    broker_connection_id: str = Field(min_length=1)
    instrument: str = Field(min_length=6, max_length=7)
    direction: str = Field(min_length=3, max_length=4)
    entry_price: float
    stop_loss: float
    opened_at: datetime
    checkpoint_minutes: int
    confidence: float
    candidate_score: float
    extension_atr: float
    volatility_score: float
    ema_separation: float
    mtf_strength: float
    rsi14: float


def get_registry() -> ModelRegistry:
    from app.main import app_state
    return app_state["registry"]


def get_challenger() -> PlanBV4HighConvictionChallenger:
    from app.main import app_state
    return app_state["plan_b_v4_challenger"]


def get_post_entry_challenger() -> PlanBV85PostEntryProtectionChallenger:
    from app.main import app_state
    return app_state["plan_b_v85_post_entry"]


def get_ohlcv_service() -> OHLCVService:
    from app.main import app_state
    cache = OHLCVRedisCache(redis_client=app_state.get("redis"))
    return OHLCVService(cache=cache)


async def require_internal_api_key(request: Request) -> None:
    key = request.headers.get(INTERNAL_API_KEY_HEADER, "")
    if not key or not validate_internal_api_key(key):
        raise HTTPException(status_code=401, detail="Invalid or missing internal API key")


@router.get("/models/active", tags=["Models"])
async def get_active_model(registry: ModelRegistry = Depends(get_registry)) -> dict:
    model = registry.get_active_model()
    return model.get_model_metadata()


@router.get("/models", tags=["Models"])
async def list_models(registry: ModelRegistry = Depends(get_registry)) -> list[dict]:
    return registry.list_models()


@router.get(
    "/models/challengers/plan-b-v4/status",
    tags=["Models (Internal Shadow)"],
    dependencies=[Depends(require_internal_api_key)],
)
async def get_plan_b_v4_status(
    challenger: PlanBV4HighConvictionChallenger = Depends(get_challenger),
) -> dict:
    return challenger.status()


@router.post(
    "/models/challengers/plan-b-v4/score-broker",
    tags=["Models (Internal Shadow)"],
    dependencies=[Depends(require_internal_api_key)],
)
async def score_plan_b_v4_broker(
    request: ChallengerBrokerScoreRequest,
    challenger: PlanBV4HighConvictionChallenger = Depends(get_challenger),
    ohlcv: OHLCVService = Depends(get_ohlcv_service),
) -> dict:
    status = challenger.status()
    if not challenger.loaded:
        return {
            "state": "ERROR",
            "reason": status.get("load_error") or "CHALLENGER_NOT_LOADED",
            "status": status,
            "score": None,
        }

    instrument = request.instrument.replace("/", "").upper()
    candles_by_timeframe = {}
    try:
        for timeframe in RUNTIME_TIMEFRAMES:
            candles_by_timeframe[timeframe] = await ohlcv.get_ohlcv(
                source="broker",
                instrument=instrument,
                timeframe=timeframe,
                limit=100,
                user_id=request.user_id,
                broker_connection_id=request.broker_connection_id,
                bypass_cache=False,
                advance_simulation=False,
            )

        bundle = build_multitimeframe_runtime_features(
            candles_by_timeframe,
            instrument=instrument,
        )
        latest_sources = {
            timeframe: str(candle.source)
            for timeframe, candle in bundle.latest_by_timeframe.items()
        }
        if any(source == "paper-broker" for source in latest_sources.values()):
            return {
                "state": "WAITING_FOR_BROKER_DATA",
                "reason": "BROKER_NATIVE_REQUIRED",
                "status": status,
                "decision_time": bundle.decision_time.isoformat(),
                "market_data_sources": latest_sources,
                "score": None,
            }

        score = challenger.score(
            instrument=instrument,
            features=bundle.features,
        )
        return {
            "state": "READY",
            "reason": None,
            "status": status,
            "decision_time": bundle.decision_time.isoformat(),
            "market_data_sources": latest_sources,
            "score": score,
        }
    except MarketDataError as exc:
        return {
            "state": "WAITING_FOR_BROKER_DATA",
            "reason": str(exc),
            "status": status,
            "score": None,
        }
    except (ValueError, RuntimeError) as exc:
        return {
            "state": "ERROR",
            "reason": str(exc),
            "status": status,
            "score": None,
        }

@router.get(
    "/models/challengers/plan-b-v85/status",
    tags=["Models (Internal Shadow)"],
    dependencies=[Depends(require_internal_api_key)],
)
async def get_plan_b_v85_status(
    challenger: PlanBV85PostEntryProtectionChallenger = Depends(
        get_post_entry_challenger
    ),
) -> dict:
    return challenger.status()


@router.post(
    "/models/challengers/plan-b-v85/score-broker-checkpoint",
    tags=["Models (Internal Shadow)"],
    dependencies=[Depends(require_internal_api_key)],
)
async def score_plan_b_v85_broker_checkpoint(
    request: PostEntryBrokerScoreRequest,
    challenger: PlanBV85PostEntryProtectionChallenger = Depends(
        get_post_entry_challenger
    ),
    ohlcv: OHLCVService = Depends(get_ohlcv_service),
) -> dict:
    status = challenger.status()
    if not challenger.loaded:
        return {
            "state": "ERROR",
            "reason": status.get("load_error") or "POST_ENTRY_CHALLENGER_NOT_LOADED",
            "status": status,
            "score": None,
        }

    instrument = request.instrument.replace("/", "").upper()
    direction = request.direction.upper()
    if direction not in {"BUY", "SELL"}:
        return {
            "state": "ERROR",
            "reason": "INVALID_DIRECTION",
            "status": status,
            "score": None,
        }
    if request.checkpoint_minutes not in challenger.checkpoint_minutes:
        return {
            "state": "ERROR",
            "reason": "UNTRAINED_CHECKPOINT",
            "status": status,
            "score": None,
        }

    opened_at = request.opened_at
    if opened_at.tzinfo is None:
        opened_at = opened_at.replace(tzinfo=UTC)
    else:
        opened_at = opened_at.astimezone(UTC)
    checkpoint_at = opened_at + timedelta(minutes=request.checkpoint_minutes)
    if checkpoint_at > datetime.now(UTC) + timedelta(seconds=5):
        return {
            "state": "NOT_YET_ELIGIBLE",
            "reason": "CHECKPOINT_NOT_REACHED",
            "status": status,
            "checkpoint_at": checkpoint_at.isoformat(),
            "score": None,
        }

    risk = abs(float(request.entry_price) - float(request.stop_loss))
    if risk <= 0 or request.entry_price <= 0:
        return {
            "state": "ERROR",
            "reason": "INVALID_TRADE_GEOMETRY",
            "status": status,
            "score": None,
        }

    candles_by_timeframe = {}
    try:
        for timeframe in RUNTIME_TIMEFRAMES:
            limit = 500 if timeframe == "M1" else 150
            candles_by_timeframe[timeframe] = await ohlcv.get_ohlcv(
                source="broker",
                instrument=instrument,
                timeframe=timeframe,
                limit=limit,
                user_id=request.user_id,
                broker_connection_id=request.broker_connection_id,
                bypass_cache=True,
                advance_simulation=False,
            )

        bundle = build_multitimeframe_runtime_features(
            candles_by_timeframe,
            instrument=instrument,
            now=checkpoint_at,
        )
        latest_sources = {
            timeframe: str(candle.source)
            for timeframe, candle in bundle.latest_by_timeframe.items()
        }
        if any(source == "paper-broker" for source in latest_sources.values()):
            return {
                "state": "WAITING_FOR_BROKER_DATA",
                "reason": "BROKER_NATIVE_REQUIRED",
                "status": status,
                "checkpoint_at": checkpoint_at.isoformat(),
                "market_data_sources": latest_sources,
                "score": None,
            }

        alignment_seconds = abs(
            (bundle.decision_time - checkpoint_at).total_seconds()
        )
        if alignment_seconds > 60:
            return {
                "state": "WAITING_FOR_BROKER_DATA",
                "reason": "CHECKPOINT_DATA_UNAVAILABLE",
                "status": status,
                "checkpoint_at": checkpoint_at.isoformat(),
                "decision_time": bundle.decision_time.isoformat(),
                "market_data_sources": latest_sources,
                "score": None,
            }

        m1_path = []
        for candle in candles_by_timeframe["M1"]:
            candle_time = candle.timestamp
            if candle_time.tzinfo is None:
                candle_time = candle_time.replace(tzinfo=UTC)
            else:
                candle_time = candle_time.astimezone(UTC)
            close_time = candle_time + timedelta(minutes=1)
            if close_time > opened_at and close_time <= checkpoint_at:
                m1_path.append(candle)
        if not m1_path:
            return {
                "state": "WAITING_FOR_BROKER_DATA",
                "reason": "POST_ENTRY_M1_PATH_UNAVAILABLE",
                "status": status,
                "checkpoint_at": checkpoint_at.isoformat(),
                "score": None,
            }

        sign = 1.0 if direction == "BUY" else -1.0
        entry = float(request.entry_price)
        current_r = sign * (float(bundle.latest_m1.close) - entry) / risk
        if sign > 0:
            favorable = max((float(c.high) - entry) / risk for c in m1_path)
            adverse = min((float(c.low) - entry) / risk for c in m1_path)
            close_rs = [(float(c.close) - entry) / risk for c in m1_path]
        else:
            favorable = max((entry - float(c.low)) / risk for c in m1_path)
            adverse = min((entry - float(c.high)) / risk for c in m1_path)
            close_rs = [(entry - float(c.close)) / risk for c in m1_path]

        peak_close_r = max(close_rs)
        risk_bps = risk / abs(entry) * 10_000.0
        hour = bundle.decision_time.hour + bundle.decision_time.minute / 60.0
        values = {
            "confidence": float(request.confidence),
            "score": float(request.candidate_score),
            "extension_atr": float(request.extension_atr),
            "volatility_score": float(request.volatility_score),
            "ema_separation": float(request.ema_separation),
            "mtf_strength": float(request.mtf_strength),
            "entry_rsi14": float(request.rsi14) / 100.0,
            "risk_bps": risk_bps,
            "elapsed_minutes": float(request.checkpoint_minutes),
            "elapsed_log1p": math.log1p(request.checkpoint_minutes),
            "current_r": current_r,
            "max_favorable_r": favorable,
            "max_adverse_r": adverse,
            "peak_close_r": peak_close_r,
            "close_giveback_r": peak_close_r - current_r,
            "directional_m1_return": sign * bundle.features["m1_simple_return"],
            "directional_m1_momentum_3": sign * bundle.features["m1_momentum_3"],
            "directional_m1_momentum_5": sign * bundle.features["m1_momentum_5"],
            "directional_m1_momentum_10": sign * bundle.features["m1_momentum_10"],
            "directional_m5_momentum_3": sign * bundle.features["m5_momentum_3"],
            "directional_m5_momentum_5": sign * bundle.features["m5_momentum_5"],
            "directional_m5_momentum_10": sign * bundle.features["m5_momentum_10"],
            "directional_m15_momentum_3": sign * bundle.features["m15_momentum_3"],
            "directional_m15_momentum_5": sign * bundle.features["m15_momentum_5"],
            "directional_h1_momentum_3": sign * bundle.features["h1_momentum_3"],
            "m1_volatility_20": bundle.features["m1_volatility_20"],
            "m1_atr_pct_14": bundle.features["m1_atr_pct_14"],
            "m1_spread_bps": bundle.features["m1_spread_bps"],
            "spread_to_risk": (
                bundle.features["m1_spread_bps"] / risk_bps
                if risk_bps > 0
                else float("nan")
            ),
            "directional_rsi_centered": sign
            * (bundle.features["m1_rsi_14"] - 0.5),
            "directional_m1_close_position_20": sign
            * bundle.features["m1_close_position_20"],
            "directional_m5_close_position_20": sign
            * bundle.features["m5_close_position_20"],
            "directional_m15_close_position_20": sign
            * bundle.features["m15_close_position_20"],
            "hour_sin": math.sin(2.0 * math.pi * hour / 24.0),
            "hour_cos": math.cos(2.0 * math.pi * hour / 24.0),
        }
        for pair in ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY"):
            values[f"pair_{pair}"] = 1.0 if pair == instrument else 0.0

        ordered = {name: float(values[name]) for name in challenger.features}
        score = challenger.score(ordered)
        return {
            "state": "READY",
            "reason": None,
            "status": status,
            "checkpoint_at": checkpoint_at.isoformat(),
            "decision_time": bundle.decision_time.isoformat(),
            "market_data_sources": latest_sources,
            "score": score,
        }
    except MarketDataError as exc:
        return {
            "state": "WAITING_FOR_BROKER_DATA",
            "reason": str(exc),
            "status": status,
            "checkpoint_at": checkpoint_at.isoformat(),
            "score": None,
        }
    except (KeyError, ValueError, RuntimeError) as exc:
        return {
            "state": "ERROR",
            "reason": str(exc),
            "status": status,
            "checkpoint_at": checkpoint_at.isoformat(),
            "score": None,
        }

