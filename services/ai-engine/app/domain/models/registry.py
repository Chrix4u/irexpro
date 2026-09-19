"""
ModelRegistry — manages model versions, governance, and instrument/timeframe routing.

RULES:
- Every registered model requires matching governance metadata.
- Route-specific models are selected by exact (instrument, timeframe).
- Missing routes fall back to the default model, whose telemetry remains truthful.
- No model is approved for live trading by this registry.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from app.core.errors import ModelNotFoundError
from app.core.logging import get_logger
from app.domain.models.baseline_xgboost import BaselineXGBoostModel
from app.domain.models.governance import (
    create_baseline_governance,
    create_trained_model_governance,
)
from app.domain.models.schemas import ModelGovernanceMetadata

logger = get_logger(__name__)

MODEL_BUNDLE_PATH_ENV = "XGBOOST_MODEL_BUNDLE_PATH"


class ModelRegistry:
    """In-memory registry with default fallback plus exact market routes."""

    def __init__(self) -> None:
        self._models: dict[str, BaselineXGBoostModel] = {}
        self._governance: dict[str, ModelGovernanceMetadata] = {}
        self._active_version: str | None = None
        self._routes: dict[tuple[str, str], str] = {}

    def register_model(
        self,
        model: BaselineXGBoostModel,
        governance: ModelGovernanceMetadata,
    ) -> None:
        """Register a model with its governance metadata."""
        version = model.get_model_version()
        if governance.model_version != version:
            raise ValueError(
                f"Governance version {governance.model_version!r} does not match "
                f"model version {version!r}"
            )
        self._models[version] = model
        self._governance[version] = governance
        if self._active_version is None:
            self._active_version = version
        logger.info(
            "Model registered",
            version=version,
            approved_for_paper=governance.approved_for_paper,
            approved_for_live=governance.approved_for_live,
        )

    def register_route(
        self,
        instrument: str,
        timeframe: str,
        model: BaselineXGBoostModel,
        governance: ModelGovernanceMetadata,
    ) -> None:
        """Register and route one verified model to an exact market/timeframe pair."""
        key = self._route_key(instrument, timeframe)
        if key in self._routes:
            raise ValueError(f"Duplicate model route for {key[0]} {key[1]}")

        metadata = model.get_artifact_metadata()
        metadata_instrument = str(metadata.get("instrument", "")).upper()
        metadata_timeframe = str(metadata.get("timeframe", "")).upper()
        if metadata_instrument != key[0] or metadata_timeframe != key[1]:
            raise ValueError(
                "Model artifact route does not match metadata "
                f"({metadata_instrument} {metadata_timeframe} != {key[0]} {key[1]})"
            )

        self.register_model(model, governance)
        self._routes[key] = model.get_model_version()
        logger.info(
            "Model route registered",
            instrument=key[0],
            timeframe=key[1],
            version=model.get_model_version(),
        )

    def get_active_model(self) -> BaselineXGBoostModel:
        if self._active_version is None or self._active_version not in self._models:
            raise ModelNotFoundError("No active model registered")
        return self._models[self._active_version]

    def get_model_for(self, instrument: str, timeframe: str) -> BaselineXGBoostModel:
        version = self._routes.get(self._route_key(instrument, timeframe))
        if version is None:
            return self.get_active_model()
        return self.get_model_by_version(version)

    def get_model_by_version(self, version: str) -> BaselineXGBoostModel:
        if version not in self._models:
            raise ModelNotFoundError(f"Model version '{version}' not found")
        return self._models[version]

    def rollback_model(self, version: str) -> None:
        if version not in self._models:
            raise ModelNotFoundError(f"Cannot rollback to unknown version '{version}'")
        logger.warning("Model rollback", from_version=self._active_version, to_version=version)
        self._active_version = version

    def list_models(self) -> list[dict]:
        route_by_version = {
            version: {"instrument": key[0], "timeframe": key[1]}
            for key, version in self._routes.items()
        }
        return [
            {
                "version": version,
                "active": version == self._active_version,
                "approved_for_paper": self._governance[version].approved_for_paper,
                "approved_for_live": self._governance[version].approved_for_live,
                "validation_status": self._governance[version].validation_status,
                "mode": self._models[version].get_model_metadata().get("mode"),
                "route": route_by_version.get(version),
            }
            for version in self._models
        ]

    def get_governance(self, version: str) -> ModelGovernanceMetadata:
        if version not in self._governance:
            raise ModelNotFoundError(f"Governance record for '{version}' not found")
        return self._governance[version]

    @staticmethod
    def _route_key(instrument: str, timeframe: str) -> tuple[str, str]:
        return instrument.strip().upper(), timeframe.strip().upper()


def _resolve_bundle_path(bundle_path: Path, entry_path: str) -> Path:
    candidate = Path(entry_path)
    return candidate if candidate.is_absolute() else bundle_path.parent / candidate


def _load_bundle_routes(registry: ModelRegistry, bundle_path: Path) -> None:
    payload = json.loads(bundle_path.read_text(encoding="utf-8"))
    if payload.get("bundle_version") != 1:
        raise ValueError("Unsupported XGBoost model bundle version")

    entries = payload.get("models")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Model bundle must contain at least one model entry")

    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Invalid model bundle entry")

        instrument = str(entry.get("instrument", "")).strip().upper()
        timeframe = str(entry.get("timeframe", "")).strip().upper()
        artifact_path = str(entry.get("artifact_path", "")).strip()
        metadata_path = str(entry.get("metadata_path", "")).strip()
        if not instrument or not timeframe or not artifact_path or not metadata_path:
            raise ValueError("Model bundle entry is missing route or artifact paths")

        model = BaselineXGBoostModel(
            model_path=_resolve_bundle_path(bundle_path, artifact_path),
            metadata_path=_resolve_bundle_path(bundle_path, metadata_path),
        )
        if not model.load_model():
            raise ValueError(f"Unable to verify model route {instrument} {timeframe}")

        governance = create_trained_model_governance(model.get_artifact_metadata())
        registry.register_route(instrument, timeframe, model, governance)


def build_default_registry() -> ModelRegistry:
    """
    Build the runtime registry.

    A heuristic/default single-model path remains backwards compatible. When
    XGBOOST_MODEL_BUNDLE_PATH is configured, verified pair-specific models are
    added as exact routes. Invalid bundles are rejected and logged; the default
    model remains available and truthfully reports its own mode.
    """
    registry = ModelRegistry()

    default_model = BaselineXGBoostModel()
    trained_loaded = default_model.load_model()
    if trained_loaded:
        governance = create_trained_model_governance(default_model.get_artifact_metadata())
    else:
        governance = create_baseline_governance()
    registry.register_model(default_model, governance)

    raw_bundle_path = os.getenv(MODEL_BUNDLE_PATH_ENV, "").strip()
    if raw_bundle_path:
        bundle_path = Path(raw_bundle_path)
        try:
            if not bundle_path.is_file():
                raise ValueError("Configured XGBoost model bundle does not exist")
            _load_bundle_routes(registry, bundle_path)
        except Exception as exc:
            logger.error(
                "Failed to load XGBoost model bundle; default model retained",
                error=str(exc),
                bundle_path=str(bundle_path),
            )

    return registry
