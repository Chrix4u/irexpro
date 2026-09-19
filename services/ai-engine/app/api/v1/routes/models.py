"""Model registry endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.domain.models.registry import ModelRegistry

router = APIRouter()


def get_registry() -> ModelRegistry:
    from app.main import app_state
    return app_state["registry"]


@router.get("/models/active", tags=["Models"])
async def get_active_model(registry: ModelRegistry = Depends(get_registry)) -> dict:
    model = registry.get_active_model()
    return model.get_model_metadata()


@router.get("/models/resolve", tags=["Models"])
async def resolve_model(
    instrument: str = Query(min_length=1, max_length=32),
    timeframe: str = Query(min_length=1, max_length=8),
    registry: ModelRegistry = Depends(get_registry),
) -> dict:
    model = registry.get_model_for(instrument, timeframe)
    governance = registry.get_governance(model.get_model_version())
    return {
        **model.get_model_metadata(),
        "instrument": instrument.strip().upper(),
        "timeframe": timeframe.strip().upper(),
        "approved_for_paper": governance.approved_for_paper,
        "approved_for_live": governance.approved_for_live,
    }


@router.get("/models", tags=["Models"])
async def list_models(registry: ModelRegistry = Depends(get_registry)) -> list[dict]:
    return registry.list_models()
