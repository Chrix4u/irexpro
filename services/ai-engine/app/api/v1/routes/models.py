"""Model registry endpoints (read-only surface — no mutation endpoints)."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.config import get_settings
from app.domain.models.registry import ModelRegistry

router = APIRouter()


def get_registry() -> ModelRegistry:
    from app.main import app_state
    return app_state["registry"]


@router.get("/models/active", tags=["Models"])
async def get_active_model(registry: ModelRegistry = Depends(get_registry)) -> dict:
    model = registry.get_active_model()
    metadata = model.get_model_metadata()
    # Live-activation truth is derived per request (promotion records are
    # re-validated) and is exposed read-only alongside the model metadata.
    metadata["live_activation"] = registry.get_live_activation()
    # October UAT hardening (WS3): the engine-side environment/config LIVE
    # authorization, reported honestly. True ONLY when the engine is both
    # configured for live signal mode AND the AI_ENGINE_ALLOW_LIVE_MODEL env
    # gate is open. A closed gate means no live path exists for this engine,
    # regardless of promotion records — the NestJS LIVE model gate consumes
    # this flag fail-closed.
    settings = get_settings()
    metadata["live_signal_mode_enabled"] = (
        settings.ai_signal_mode == "live" and settings.ai_engine_allow_live_model
    )
    return metadata


@router.get("/models", tags=["Models"])
async def list_models(registry: ModelRegistry = Depends(get_registry)) -> list[dict]:
    return registry.list_models()
