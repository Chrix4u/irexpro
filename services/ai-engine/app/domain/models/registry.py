"""
ModelRegistry — manages available model versions and governance state.

RULES:
- register_model() requires a governance record.
- No model is approved for live trading by default.
- get_active_model() returns the currently active model.
- rollback_model() switches the active model to a previous version.
- LIVE activation is SEPARATE from artifact governance: a model is
  live-activatable only when a VALID out-of-band promotion record (see
  app/domain/models/promotion.py) matches the model_version AND the
  byte-exact SHA-256 of its VERIFIED artifact. The promotion files are
  re-read and the artifact bytes re-hashed on EVERY activation check —
  nothing is cached blindly, so removing or invalidating a record
  deactivates live mode on the next check.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app.core.errors import ModelNotFoundError
from app.core.logging import get_logger
from app.domain.models.baseline_xgboost import BaselineXGBoostModel
from app.domain.models.governance import (
    create_baseline_governance,
    create_trained_model_governance,
)
from app.domain.models.promotion import (
    ModelPromotionRecord,
    find_promotion_for_model,
    load_promotion_records,
    promotion_record_to_activation,
    resolve_promotion_dir,
)
from app.domain.models.schemas import ModelGovernanceMetadata

logger = get_logger(__name__)


def _not_activated(reason: str) -> dict[str, Any]:
    """Truthful not-activated structure (same shape as the activated one)."""
    return {
        "activated": False,
        "record_id": None,
        "model_version": None,
        "artifact_sha256": None,
        "promoted_by": None,
        "approved_by": None,
        "activated_at": None,
        "reason": reason,
    }


class ModelRegistry:
    """In-memory model registry with explicit governance metadata."""

    def __init__(self, promotion_dir: Path | None = None) -> None:
        self._models: dict[str, BaselineXGBoostModel] = {}
        self._governance: dict[str, ModelGovernanceMetadata] = {}
        self._active_version: str | None = None
        # Promotion-record directory: explicit override → env → engine default.
        self._promotion_dir: Path | None = promotion_dir
        # Only the previously OBSERVED activation state is remembered (for
        # audit logging). The promotion records themselves are never cached —
        # every check re-reads them from disk.
        self._last_live_activation: dict[str, Any] | None = None

    # ─── Live activation (fail-closed, re-validated per check) ────────────

    def _effective_promotion_dir(self) -> Path:
        if self._promotion_dir is not None:
            return self._promotion_dir
        return resolve_promotion_dir()

    def evaluate_live_activation(self, version: str) -> dict[str, Any]:
        """
        Evaluate live activation for a registered model version.

        Fail-closed chain (each step re-validated on every call):
        1. MODEL_NOT_REGISTERED — version not registered.
        2. Artifact integrity (recomputed file SHA-256):
           NO_VERIFIED_ARTIFACT / ARTIFACT_FILE_MISSING / ARTIFACT_SHA_MISMATCH.
        3. NO_VALID_PROMOTION_RECORD — no valid record binds this exact
           model_version + artifact_sha256 (missing file, tampered binding
           fields, malformed JSON, duplicate record_id, unknown fields…).
        """
        if version not in self._models:
            return _not_activated("MODEL_NOT_REGISTERED")

        model = self._models[version]
        integrity = model.verify_artifact_integrity()
        if not integrity.get("verified", False):
            return _not_activated(str(integrity.get("reason") or "NO_VERIFIED_ARTIFACT"))

        artifact_sha256 = str(integrity["artifact_sha256"])
        state = load_promotion_records(self._effective_promotion_dir())
        record: ModelPromotionRecord | None = find_promotion_for_model(
            state, version, artifact_sha256
        )
        if record is None:
            return _not_activated("NO_VALID_PROMOTION_RECORD")

        activation = promotion_record_to_activation(record)
        activation["activated"] = True
        activation["reason"] = None
        return activation

    def get_live_activation(self) -> dict[str, Any]:
        """
        Live-activation truth for the ACTIVE model (re-validated per call).

        Returns {activated, record_id, model_version, artifact_sha256,
        promoted_by, approved_by, activated_at, reason} — a truthful
        not-activated structure with reason when live is not active.
        Auditable log lines are emitted whenever the observed activation
        state changes (activation or deactivation).
        """
        if self._active_version is None or self._active_version not in self._models:
            activation = _not_activated("NO_ACTIVE_MODEL")
        else:
            activation = self.evaluate_live_activation(self._active_version)

        self._log_activation_change(activation)
        return activation

    def _log_activation_change(self, activation: dict[str, Any]) -> None:
        """Emit one auditable line per activation state change."""
        previous = self._last_live_activation
        self._last_live_activation = dict(activation)

        if previous is None:
            # First observation is baseline state, not a state change.
            return

        was_active = bool(previous.get("activated"))
        is_active = bool(activation.get("activated"))
        if was_active == is_active and previous.get("record_id") == activation.get(
            "record_id"
        ):
            return

        if is_active:
            logger.info(
                "Live model activation state changed",
                change="ACTIVATED",
                model_version=activation.get("model_version"),
                artifact_sha256=activation.get("artifact_sha256"),
                record_id=activation.get("record_id"),
                promoted_by=activation.get("promoted_by"),
                approved_by=activation.get("approved_by"),
            )
        else:
            logger.warning(
                "Live model activation state changed",
                change="DEACTIVATED",
                previous_record_id=previous.get("record_id"),
                previous_model_version=previous.get("model_version"),
                reason=activation.get("reason"),
            )

    # ─── Registry core ────────────────────────────────────────────────────

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
                "live_activation": self.evaluate_live_activation(version),
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
