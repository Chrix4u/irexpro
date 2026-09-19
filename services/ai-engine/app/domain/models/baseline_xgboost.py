"""
XGBoost signal model with a conservative heuristic fallback.

A trained artifact is loaded only when XGBOOST_MODEL_PATH points to a model
file with a valid sidecar metadata document and matching SHA-256 checksum.
Without a verified artifact, the existing heuristic scaffold remains visible
as such and is never presented as a trained model.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Literal

import pandas as pd

from app.core.logging import get_logger
from app.domain.models.feature_engineering import FEATURE_COLUMNS
from app.domain.models.schemas import ModelPrediction

logger = get_logger(__name__)

MODEL_VERSION = "baseline-xgboost-v0.1.0"
MODEL_PATH_ENV = "XGBOOST_MODEL_PATH"
MODEL_METADATA_PATH_ENV = "XGBOOST_MODEL_METADATA_PATH"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _feature_schema_hash(feature_names: list[str]) -> str:
    payload = json.dumps(feature_names, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class BaselineXGBoostModel:
    """
    XGBoost model wrapper.

    If a verified trained artifact is configured, inference uses the fitted
    XGBoost classifier. Otherwise it falls back to the explicitly identified
    heuristic scaffold used by existing paper-mode development.
    """

    def __init__(
        self,
        model_path: str | Path | None = None,
        metadata_path: str | Path | None = None,
    ) -> None:
        self._model: Any = None
        self._model_loaded = False
        self._model_version = MODEL_VERSION
        self._feature_names = list(FEATURE_COLUMNS)
        self._artifact_metadata: dict[str, Any] = {}
        self._configured_model_path = Path(model_path) if model_path else None
        self._configured_metadata_path = Path(metadata_path) if metadata_path else None

    def load_model(self) -> bool:
        """
        Load a trained XGBoost classifier plus its integrity metadata.

        Returns False when no artifact is configured or verification fails.
        The caller can then truthfully report heuristic_placeholder mode.
        """
        raw_model_path = os.getenv(MODEL_PATH_ENV, "").strip()
        model_path = self._configured_model_path or (Path(raw_model_path) if raw_model_path else None)
        if model_path is None:
            logger.info("No XGBoost model configured — heuristic placeholder mode")
            return False

        if not model_path.is_file():
            logger.error("Configured XGBoost model file does not exist", path=str(model_path))
            return False

        raw_metadata_path = os.getenv(MODEL_METADATA_PATH_ENV, "").strip()
        metadata_path = self._configured_metadata_path or (
            Path(raw_metadata_path)
            if raw_metadata_path
            else model_path.with_suffix(".metadata.json")
        )
        if not metadata_path.is_file():
            logger.error(
                "XGBoost metadata sidecar missing; refusing unverified artifact",
                path=str(metadata_path),
            )
            return False

        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if metadata.get("model_type") != "xgboost_binary_direction_classifier":
                raise ValueError("Unsupported model_type")

            expected_sha = str(metadata.get("artifact_sha256", "")).lower()
            actual_sha = _sha256_file(model_path)
            if not expected_sha or expected_sha != actual_sha:
                raise ValueError("Model artifact SHA-256 does not match metadata")

            feature_names = metadata.get("feature_columns")
            if feature_names != FEATURE_COLUMNS:
                raise ValueError("Model feature columns do not match runtime feature schema")

            expected_schema_hash = str(metadata.get("feature_schema_hash", "")).lower()
            if expected_schema_hash != _feature_schema_hash(FEATURE_COLUMNS):
                raise ValueError("Model feature schema hash does not match runtime schema")

            model_version = str(metadata.get("model_version", "")).strip()
            if not model_version:
                raise ValueError("Model metadata is missing model_version")

            if bool(metadata.get("approved_for_live", False)):
                raise ValueError("Live-approved artifacts are not accepted by this paper-mode loader")

            import xgboost as xgb

            model = xgb.XGBClassifier()
            model.load_model(str(model_path))

            self._model = model
            self._model_loaded = True
            self._model_version = model_version
            self._feature_names = list(feature_names)
            self._artifact_metadata = metadata

            logger.info(
                "Verified trained XGBoost model loaded",
                path=str(model_path),
                metadata_path=str(metadata_path),
                version=self._model_version,
                approved_for_paper=bool(metadata.get("approved_for_paper", False)),
            )
            return True
        except Exception as exc:
            logger.error(
                "Failed to verify/load XGBoost model; heuristic fallback retained",
                error=str(exc),
            )
            self._model = None
            self._model_loaded = False
            self._model_version = MODEL_VERSION
            self._feature_names = list(FEATURE_COLUMNS)
            self._artifact_metadata = {}
            return False

    def predict_signal(self, features: dict[str, float]) -> ModelPrediction:
        """Predict a directional signal from runtime feature values."""
        if self._model_loaded and self._model is not None:
            return self._predict_with_xgboost(features)
        return self._predict_heuristic(features)

    def _predict_with_xgboost(self, features: dict[str, float]) -> ModelPrediction:
        """Run inference using the verified trained classifier."""
        missing = [name for name in self._feature_names if name not in features]
        if missing:
            raise ValueError(f"Missing model features: {missing}")

        frame = pd.DataFrame(
            [[features[name] for name in self._feature_names]],
            columns=self._feature_names,
        )
        positive_probability = float(self._model.predict_proba(frame)[0][1])

        direction: Literal["BUY", "SELL"]
        if positive_probability >= 0.5:
            direction = "BUY"
            confidence = positive_probability
        else:
            direction = "SELL"
            confidence = 1.0 - positive_probability

        return ModelPrediction(
            direction=direction,
            confidence_score=round(confidence, 4),
            model_version=self._model_version,
            features_used=list(self._feature_names),
            raw_scores={
                "positive_class_probability": positive_probability,
                "class_confidence": confidence,
            },
            explainability={
                "method": "xgboost_predict_proba",
                "confidence_semantics": (
                    "Directional class probability estimate from the fitted classifier; "
                    "not a probability of profit."
                ),
                "approved_for_live": False,
            },
        )

    def _predict_heuristic(self, features: dict[str, float]) -> ModelPrediction:
        """
        Conservative heuristic placeholder when no verified model is loaded.

        This remains a development fallback only and is clearly surfaced in
        telemetry as heuristic_placeholder.
        """
        price_vs_ma20 = features.get("price_vs_ma20", 0.0)
        volatility = features.get("volatility_10", 0.5)

        direction: Literal["BUY", "SELL"] = "BUY" if price_vs_ma20 > 0 else "SELL"
        raw_confidence = min(abs(price_vs_ma20) * 10.0, 0.65)
        volatility_penalty = min(volatility * 0.5, 0.15)
        confidence = max(0.0, raw_confidence - volatility_penalty)

        return ModelPrediction(
            direction=direction,
            confidence_score=round(confidence, 4),
            model_version=MODEL_VERSION,
            features_used=list(features.keys()),
            raw_scores={
                "price_vs_ma20": price_vs_ma20,
                "volatility_10": volatility,
            },
            explainability={
                "method": "heuristic_placeholder",
                "note": "No verified trained model loaded. This is a scaffold prediction only.",
                "approved_for_live": False,
            },
        )

    def get_model_version(self) -> str:
        return self._model_version

    def is_trained_model_loaded(self) -> bool:
        return self._model_loaded

    def get_artifact_metadata(self) -> dict[str, Any]:
        return dict(self._artifact_metadata)

    def get_model_metadata(self) -> dict[str, Any]:
        if self._model_loaded:
            return {
                "version": self._model_version,
                "type": "xgboost_trained",
                "loaded": True,
                "mode": "trained_xgboost",
                "approved_for_live": False,
                "approved_for_paper": bool(
                    self._artifact_metadata.get("approved_for_paper", False)
                ),
                "validation_status": self._artifact_metadata.get(
                    "validation_status",
                    "unknown",
                ),
                "artifact_sha256": self._artifact_metadata.get("artifact_sha256"),
            }

        return {
            "version": MODEL_VERSION,
            "type": "xgboost_scaffold",
            "loaded": False,
            "mode": "heuristic_placeholder",
            "approved_for_live": False,
            "approved_for_paper": True,
            "validation_status": "scaffold_only_not_validated",
        }
