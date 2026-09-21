"""
Signal generation and publishing endpoints.

These endpoints generate signal CANDIDATES only.
Signals are forwarded to NestJS for full Strategy/Risk/Execution pipeline processing.
No direct trade execution happens here.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.config import get_settings
from app.core.errors import LiveModeNotSupportedError, NestJsIntegrationError, SignalGenerationError
from app.domain.market_data.ohlcv_service import OHLCVService
from app.domain.market_data.redis_cache import OHLCVRedisCache
from app.domain.models.registry import ModelRegistry
from app.domain.signals.schemas import SignalGenerationRequest, SignalGenerationResponse
from app.domain.signals.signal_generator import SignalGenerator
from app.integrations.nestjs_client import NestJsClient

router = APIRouter()


def get_signal_generator(registry: ModelRegistry | None = None) -> SignalGenerator:
    from app.main import app_state
    reg = registry or app_state["registry"]
    cache = OHLCVRedisCache(redis_client=app_state.get("redis"))
    ohlcv_svc = OHLCVService(cache=cache)
    return SignalGenerator(ohlcv_service=ohlcv_svc, model_registry=reg)


@router.post("/signals/generate", response_model=SignalGenerationResponse, tags=["Signals"])
async def generate_signal(request: SignalGenerationRequest) -> SignalGenerationResponse:
    """
    Generate an AI signal candidate from mock market data.

    Paper mode only. Signal is NOT forwarded to NestJS automatically.
    Use /signals/publish-to-api to submit to the NestJS pipeline.
    """
    settings = get_settings()
    if settings.ai_signal_mode == "live" and not settings.ai_engine_allow_live_model:
        # Env feature gate closed — no live path is possible for this engine.
        # (When the gate is open, SignalGenerator enforces the promotion-record
        # gate and raises a truthful LiveModeNotSupportedError → 403 below.)
        raise HTTPException(
            status_code=403,
            detail="Live signal mode is disabled: AI_ENGINE_ALLOW_LIVE_MODEL is not enabled",
        )

    generator = get_signal_generator()
    try:
        return await generator.generate(
            user_id=request.user_id,
            trading_session_id=request.trading_session_id,
            broker_connection_id=request.broker_connection_id,
            instrument=request.instrument,
            timeframe=request.timeframe,
            candles=None,
        )
    except LiveModeNotSupportedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except SignalGenerationError as e:
        raise HTTPException(status_code=422, detail=str(e))


class PublishSignalRequest(SignalGenerationRequest):
    pass


class PublishSignalResponse(BaseModel):
    generated: bool
    published: bool
    nestjs_response: dict | None = None
    no_signal_reason: str | None = None


@router.post("/signals/publish-to-api", response_model=PublishSignalResponse, tags=["Signals"])
async def generate_and_publish_signal(request: PublishSignalRequest) -> PublishSignalResponse:
    """
    Generate a signal candidate AND forward it to NestJS for full pipeline processing.

    NestJS handles: StrategyOrchestrator → Risk Engine → Execution Engine → Broker Adapter.
    This endpoint does NOT execute trades directly.
    """
    settings = get_settings()
    if settings.ai_signal_mode == "live" and not settings.ai_engine_allow_live_model:
        raise HTTPException(
            status_code=403,
            detail="Live signal mode is disabled: AI_ENGINE_ALLOW_LIVE_MODEL is not enabled",
        )

    generator = get_signal_generator()
    try:
        result = await generator.generate(
            user_id=request.user_id,
            trading_session_id=request.trading_session_id,
            broker_connection_id=request.broker_connection_id,
            instrument=request.instrument,
            timeframe=request.timeframe,
        )
    except LiveModeNotSupportedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except SignalGenerationError as e:
        raise HTTPException(status_code=422, detail=str(e))

    if not result.generated or result.signal is None:
        return PublishSignalResponse(
            generated=False,
            published=False,
            no_signal_reason=result.no_signal.reason if result.no_signal else "unknown",
        )

    client = NestJsClient()
    try:
        nestjs_response = await client.publish_signal(result.signal)
        return PublishSignalResponse(
            generated=True,
            published=True,
            nestjs_response=nestjs_response,
        )
    except NestJsIntegrationError as e:
        raise HTTPException(status_code=502, detail=f"NestJS integration error: {e}")
