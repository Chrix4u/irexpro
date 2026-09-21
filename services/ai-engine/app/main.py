"""
iRexPro AI Signal Engine — FastAPI application entry point.

This service produces AI signal candidates only.
It never executes trades directly.
All signals flow through NestJS: AiSignalService → Strategy → Risk → Execution → Broker.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.routes import backtests, health, market_data, models, scheduler, signals
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.domain.agents.context_service import AgentContextService
from app.domain.models.registry import build_default_registry
from app.domain.scheduler.signal_scheduler import SignalScheduler
from app.integrations.redis_client import close_redis_client, get_redis_client

# Shared application state (registry, redis) — avoids circular imports in route deps
app_state: dict[str, Any] = {}

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.ai_engine_env)

    logger.info(
        "iRexPro AI Engine starting",
        env=settings.ai_engine_env,
        version=settings.ai_engine_version,
        signal_mode=settings.ai_signal_mode,
    )

    # Initialise model registry
    app_state["registry"] = build_default_registry()

    # Attempt Redis connection (non-fatal)
    app_state["redis"] = await get_redis_client()

    # Initialise advisory Agent Council context service.
    app_state["agent_context_service"] = AgentContextService()

    # Initialise scheduler (disabled by default)
    app_state["scheduler"] = SignalScheduler()

    yield

    # Cleanup
    scheduler = app_state.get("scheduler")
    if isinstance(scheduler, SignalScheduler):
        scheduler.shutdown()
    await close_redis_client()
    logger.info("iRexPro AI Engine stopped")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="iRexPro AI Signal Engine",
        description=(
            "Baseline AI signal engine for iRexPro. "
            "Produces signal candidates only — never executes trades directly. "
            "All signals route through the NestJS Risk Engine."
        ),
        version=settings.ai_engine_version,
        docs_url="/docs" if not settings.is_production else None,
        redoc_url="/redoc" if not settings.is_production else None,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Accept"],
    )

    prefix = "/api/v1"
    app.include_router(health.router, prefix=prefix)
    app.include_router(signals.router, prefix=prefix)
    app.include_router(market_data.router, prefix=prefix)
    app.include_router(models.router, prefix=prefix)
    app.include_router(scheduler.router, prefix=prefix)
    app.include_router(backtests.router, prefix=prefix)

    return app


app = create_app()
