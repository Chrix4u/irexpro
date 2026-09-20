"""
Model governance utilities.

The runtime distinguishes the heuristic scaffold from verified trained
artifacts. No helper in this module can grant live-trading approval.
"""
from __future__ import annotations

from typing import Any

from app.domain.models.baseline_xgboost import MODEL_VERSION as BASELINE_VERSION
from app.domain.models.feature_engineering import FEATURE_COLUMNS
from app.domain.models.schemas import ModelGovernanceMetadata


def create_baseline_governance() -> ModelGovernanceMetadata:
    """Return the governance record for the heuristic baseline scaffold."""
    return ModelGovernanceMetadata(
        model_version=BASELINE_VERSION,
        training_data_source="none_synthetic_placeholder",
        validation_status="scaffold_only_not_validated",
        approved_for_paper=True,
        approved_for_sandbox=False,
        approved_for_live=False,
        notes=(
            "Baseline heuristic scaffold. No fitted model weights are loaded. "
            "Paper-mode development only."
        ),
        feature_list=list(FEATURE_COLUMNS),
    )


def create_trained_model_governance(
    metadata: dict[str, Any],
) -> ModelGovernanceMetadata:
    """
    Build governance state from a verified model sidecar.

    Integrity verification happens before this function is called. Live
    approval is deliberately forced to False regardless of sidecar contents.
    """
    model_version = str(metadata.get("model_version", "")).strip()
    if not model_version:
        raise ValueError("Trained model metadata is missing model_version")

    return ModelGovernanceMetadata(
        model_version=model_version,
        training_data_source=str(
            metadata.get("training_data_source", "unknown_historical_ohlcv")
        ),
        validation_status=str(
            metadata.get("validation_status", "offline_validation_unknown")
        ),
        approved_for_paper=bool(metadata.get("approved_for_paper", False)),
        approved_for_sandbox=bool(metadata.get("approved_for_sandbox", False)),
        approved_for_live=False,
        notes=(
            "Verified trained XGBoost artifact. Paper approval is read from the "
            "signed-off sidecar; live approval remains unavailable in this runtime."
        ),
        feature_list=list(metadata.get("feature_columns", FEATURE_COLUMNS)),
        extra_metadata={
            "artifact_sha256": metadata.get("artifact_sha256"),
            "dataset_sha256": metadata.get("dataset_sha256"),
            "instrument": metadata.get("instrument"),
            "timeframe": metadata.get("timeframe"),
            "validation_metrics": metadata.get("validation_metrics", {}),
            "confidence_semantics": metadata.get("confidence_semantics"),
            "label_selection_policy": metadata.get("label_selection_policy"),
            "backtest_evaluation_policy": metadata.get(
                "backtest_evaluation_policy"
            ),
        },
    )
