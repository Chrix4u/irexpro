"""Model registry and internal challenger endpoints."""
from __future__ import annotations

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
from app.domain.models.registry import ModelRegistry

router = APIRouter()
INTERNAL_API_KEY_HEADER = "x-irexpro-internal-api-key"


class ChallengerBrokerScoreRequest(BaseModel):
    user_id: str = Field(min_length=1)
    broker_connection_id: str = Field(min_length=1)
    instrument: str = Field(min_length=6, max_length=7)


def get_registry() -> ModelRegistry:
    from app.main import app_state
    return app_state["registry"]


def get_challenger() -> PlanBV4HighConvictionChallenger:
    from app.main import app_state
    return app_state["plan_b_v4_challenger"]


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
                bypass_cache=True,
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
