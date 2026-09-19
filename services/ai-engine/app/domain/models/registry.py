"""
ModelRegistry — manages available model versions and governance state.

RULES:
- register_model() requires a governance record.
- No model is approved for live trading by default.
- get_active_model() returns the currently active model.
- rollback_model() switches the active model to a previous version.
"""
from __future__ import annotations

from app.core.errors import ModelNotFoundError
from app.core.logging import get_logger
from app.domain.models.baseline_xgboost import BaselineXGBoostModel
from app.domain.models.governance import (
    create_baseline_governance,
    create_trained_model_governance,
)
from app.domain.models.schemas import ModelGovernanceMetadata

logger = get_logger(__name__)


class ModelRegistry:
    """In-memory model registry with explicit governance metadata."""

    def __init__(self) -> None:
        self._models: dict[str, BaselineXGBoostModel] = {}
        self._governance: dict[str, ModelGovernanceMetadata] = {}
        self._active_version: str | None = None

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

    def get_active_model(self) -> BaselineXGBoostModel:
        if self._active_version is None or self._active_version not in self._models:
            raise ModelNotFoundError("No active model registered")
        return self._models[self._active_version]

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
        return [
            {
                "version": version,
                "active": version == self._active_version,
                "approved_for_paper": self._governance[version].approved_for_paper,
                "approved_for_live": self._governance[version].approved_for_live,
                "validation_status": self._governance[version].validation_status,
                "mode": self._models[version].get_model_metadata().get("mode"),
            }
            for version in self._models
        ]

    def get_governance(self, version: str) -> ModelGovernanceMetadata:
        if version not in self._governance:
            raise ModelNotFoundError(f"Governance record for '{version}' not found")
        return self._governance[version]


def build_default_registry() -> ModelRegistry:
    """
    Build the default registry.

    When a verified trained artifact is configured, it becomes the registered
    model and its paper approval comes from the verified sidecar. Otherwise the
    explicit heuristic scaffold is registered for development paper mode.
    """
    registry = ModelRegistry()
    model = BaselineXGBoostModel()
    trained_loaded = model.load_model()

    if trained_loaded:
        governance = create_trained_model_governance(model.get_artifact_metadata())
    else:
        governance = create_baseline_governance()

    registry.register_model(model, governance)
    return registry
