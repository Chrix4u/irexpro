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
import math
import os
from pathlib import Path
from typing import Any, Literal

import pandas as pd

from app.core.logging import get_logger
from app.domain.models.feature_engineering import FEATURE_COLUMNS
from app.domain.models.multitimeframe_features import (
    INITIAL_FOREX_UNIVERSE,
    MULTITIMEFRAME_BACKTEST_POLICY,
    MULTITIMEFRAME_FEATURE_COLUMNS,
    MULTITIMEFRAME_LABEL_SELECTION_POLICY,
    MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
    MULTITIMEFRAME_RUNTIME_PROFILE,
)
from app.domain.models.schemas import ModelPrediction

logger = get_logger(__name__)

MODEL_VERSION = "baseline-xgboost-v0.1.0"
MODEL_PATH_ENV = "XGBOOST_MODEL_PATH"
MODEL_METADATA_PATH_ENV = "XGBOOST_MODEL_METADATA_PATH"

SINGLE_TIMEFRAME_MODEL_TYPE = "xgboost_binary_direction_classifier"
MULTITIMEFRAME_MODEL_TYPE = "xgboost_pooled_multitimeframe_direction_classifier"
EVENT_PAIR_BUNDLE_MODEL_TYPE = "xgboost_event_pair_bundle"
EVENT_LABEL_POLICY_RUNTIME = "first_net_return_barrier_atr1_spread2_timeout_v1"


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

    def __init__(self) -> None:
        self._model: Any = None
        self._model_loaded = False
        self._model_version = MODEL_VERSION
        self._feature_names = list(FEATURE_COLUMNS)
        self._artifact_metadata: dict[str, Any] = {}
        self._model_type = SINGLE_TIMEFRAME_MODEL_TYPE
        self._runtime_feature_profile = "single_timeframe_v1"
        self._bundle: dict[str, Any] = {}

    def load_model(self) -> bool:
        """
        Load a trained XGBoost classifier plus its integrity metadata.

        Returns False when no artifact is configured or verification fails.
        The caller can then truthfully report heuristic_placeholder mode.
        """
        raw_model_path = os.getenv(MODEL_PATH_ENV, "").strip()
        if not raw_model_path:
            logger.info("No XGBoost model configured — heuristic placeholder mode")
            return False

        model_path = Path(raw_model_path)
        if not model_path.is_file():
            logger.error("Configured XGBoost model file does not exist", path=str(model_path))
            return False

        raw_metadata_path = os.getenv(MODEL_METADATA_PATH_ENV, "").strip()
        metadata_path = (
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
            model_type = str(metadata.get("model_type", "")).strip()
            if model_type not in {
                SINGLE_TIMEFRAME_MODEL_TYPE,
                MULTITIMEFRAME_MODEL_TYPE,
                EVENT_PAIR_BUNDLE_MODEL_TYPE,
            }:
                raise ValueError("Unsupported model_type")

            expected_sha = str(metadata.get("artifact_sha256", "")).lower()
            actual_sha = _sha256_file(model_path)
            if not expected_sha or expected_sha != actual_sha:
                raise ValueError("Model artifact SHA-256 does not match metadata")

            runtime_feature_profile = str(
                metadata.get("runtime_feature_profile", "single_timeframe_v1")
            ).strip()
            mtf_model = model_type in {
                MULTITIMEFRAME_MODEL_TYPE,
                EVENT_PAIR_BUNDLE_MODEL_TYPE,
            }
            expected_features = (
                MULTITIMEFRAME_FEATURE_COLUMNS if mtf_model else FEATURE_COLUMNS
            )
            if mtf_model and runtime_feature_profile != MULTITIMEFRAME_RUNTIME_PROFILE:
                raise ValueError("MTF artifact runtime_feature_profile is unsupported")

            if (
                model_type == MULTITIMEFRAME_MODEL_TYPE
                and metadata.get("label_selection_policy")
                != MULTITIMEFRAME_LABEL_SELECTION_POLICY
            ):
                raise ValueError("MTF artifact label_selection_policy is unsupported")
            if (
                model_type == EVENT_PAIR_BUNDLE_MODEL_TYPE
                and metadata.get("event_label_policy") != EVENT_LABEL_POLICY_RUNTIME
            ):
                raise ValueError("Event-pair artifact event_label_policy is unsupported")

            if (
                mtf_model
                and metadata.get("backtest_evaluation_policy")
                != MULTITIMEFRAME_BACKTEST_POLICY
            ):
                raise ValueError("MTF artifact backtest_evaluation_policy is unsupported")

            if (
                mtf_model
                and metadata.get("research_validation_policy")
                != MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY
            ):
                raise ValueError("MTF artifact research_validation_policy is unsupported")

            feature_names = metadata.get("feature_columns")
            if feature_names != expected_features:
                raise ValueError("Model feature columns do not match runtime feature schema")

            expected_schema_hash = str(metadata.get("feature_schema_hash", "")).lower()
            if expected_schema_hash != _feature_schema_hash(expected_features):
                raise ValueError("Model feature schema hash does not match runtime schema")

            model_version = str(metadata.get("model_version", "")).strip()
            if not model_version:
                raise ValueError("Model metadata is missing model_version")

            if bool(metadata.get("approved_for_live", False)):
                raise ValueError("Live-approved artifacts are not accepted by this paper-mode loader")

            import xgboost as xgb

            if model_type == EVENT_PAIR_BUNDLE_MODEL_TYPE:
                manifest = json.loads(model_path.read_text(encoding="utf-8"))
                if manifest.get("model_type") != EVENT_PAIR_BUNDLE_MODEL_TYPE:
                    raise ValueError("Event-pair bundle manifest model_type mismatch")
                if manifest.get("event_label_policy") != EVENT_LABEL_POLICY_RUNTIME:
                    raise ValueError("Event-pair bundle label policy mismatch")

                root = model_path.parent.resolve()

                def component_path(item: dict[str, Any]) -> Path:
                    raw_path = str(item.get("path", "")).strip()
                    relative = Path(raw_path)
                    if (
                        not raw_path
                        or relative.is_absolute()
                        or ".." in relative.parts
                        or len(relative.parts) != 1
                    ):
                        raise ValueError("Unsafe event-pair component path")
                    resolved = (root / relative).resolve()
                    if resolved.parent != root or not resolved.is_file():
                        raise ValueError("Event-pair component file is missing")
                    expected = str(item.get("sha256", "")).lower()
                    if not expected or _sha256_file(resolved) != expected:
                        raise ValueError("Event-pair component SHA-256 mismatch")
                    return resolved

                opportunity_spec = manifest.get("opportunity")
                if not isinstance(opportunity_spec, dict):
                    raise ValueError("Event-pair bundle is missing opportunity model")
                opportunity = xgb.XGBClassifier()
                opportunity.load_model(str(component_path(opportunity_spec)))

                direction_specs = manifest.get("direction")
                if not isinstance(direction_specs, dict):
                    raise ValueError("Event-pair bundle is missing direction models")
                direction_models: dict[str, Any] = {}
                for instrument in INITIAL_FOREX_UNIVERSE:
                    item = direction_specs.get(instrument)
                    if not isinstance(item, dict):
                        raise ValueError(
                            f"Event-pair bundle missing direction model {instrument}"
                        )
                    kind = str(item.get("kind", ""))
                    child_path = component_path(item)
                    if kind == "xgboost_classifier":
                        child = xgb.XGBClassifier()
                    elif kind == "xgboost_return_margin_regressor":
                        calibration = item.get("calibration")
                        if not isinstance(calibration, dict):
                            raise ValueError(
                                f"Event-pair bundle missing calibrator {instrument}"
                            )
                        coefficient = float(calibration.get("coefficient"))
                        intercept = float(calibration.get("intercept"))
                        if not math.isfinite(coefficient) or not math.isfinite(intercept):
                            raise ValueError("Event-pair calibration is non-finite")
                        child = xgb.XGBRegressor()
                    else:
                        raise ValueError("Unsupported event-pair direction model kind")
                    child.load_model(str(child_path))
                    direction_models[instrument] = child

                self._bundle = {
                    "manifest": manifest,
                    "opportunity": opportunity,
                    "direction": direction_models,
                }
                model = opportunity
            else:
                model = xgb.XGBClassifier()
                model.load_model(str(model_path))
                self._bundle = {}

            self._model = model
            self._model_loaded = True
            self._model_version = model_version
            self._feature_names = list(feature_names)
            self._artifact_metadata = metadata
            self._model_type = model_type
            self._runtime_feature_profile = runtime_feature_profile

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
            self._bundle = {}
            self._model_type = SINGLE_TIMEFRAME_MODEL_TYPE
            self._runtime_feature_profile = "single_timeframe_v1"
            return False

    def predict_signal(self, features: dict[str, float]) -> ModelPrediction:
        """Predict a directional signal from runtime feature values."""
        if self._model_loaded and self._model is not None:
            return self._predict_with_xgboost(features)
        return self._predict_heuristic(features)

    def _predict_with_xgboost(self, features: dict[str, float]) -> ModelPrediction:
        """Run inference using the verified trained artifact."""
        if self._model_type == EVENT_PAIR_BUNDLE_MODEL_TYPE:
            return self._predict_with_event_pair_bundle(features)
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

    def _predict_with_event_pair_bundle(
        self,
        features: dict[str, float],
    ) -> ModelPrediction:
        missing = [name for name in self._feature_names if name not in features]
        if missing:
            raise ValueError(f"Missing model features: {missing}")

        active_instruments = [
            instrument
            for instrument in INITIAL_FOREX_UNIVERSE
            if float(features.get(f"instrument_{instrument}", 0.0)) >= 0.5
        ]
        if len(active_instruments) != 1:
            raise ValueError("Event-pair runtime requires exactly one active instrument")
        instrument = active_instruments[0]

        frame = pd.DataFrame(
            [[features[name] for name in self._feature_names]],
            columns=self._feature_names,
        )
        opportunity_model = self._bundle["opportunity"]
        opportunity_probability = float(
            opportunity_model.predict_proba(frame)[0][1]
        )
        manifest = self._bundle["manifest"]
        item = manifest["direction"][instrument]
        direction_model = self._bundle["direction"][instrument]
        kind = str(item.get("kind", ""))

        return_margin_bps: float | None = None
        if kind == "xgboost_classifier":
            positive_probability = float(direction_model.predict_proba(frame)[0][1])
            direction_method = "pair_xgboost_predict_proba"
        elif kind == "xgboost_return_margin_regressor":
            return_margin_bps = float(direction_model.predict(frame)[0])
            calibration = item["calibration"]
            coefficient = float(calibration["coefficient"])
            intercept = float(calibration["intercept"])
            logit = max(
                -60.0,
                min(60.0, coefficient * return_margin_bps + intercept),
            )
            positive_probability = 1.0 / (1.0 + math.exp(-logit))
            direction_method = "pair_return_margin_logistic_calibration"
        else:
            raise ValueError("Unsupported loaded event-pair direction model kind")

        if positive_probability >= 0.5:
            direction: Literal["BUY", "SELL"] = "BUY"
            direction_confidence = positive_probability
        else:
            direction = "SELL"
            direction_confidence = 1.0 - positive_probability
        joint_confidence = min(direction_confidence, opportunity_probability)

        raw_scores: dict[str, float] = {
            "opportunity_probability": opportunity_probability,
            "positive_class_probability": positive_probability,
            "direction_confidence": direction_confidence,
            "joint_confidence": joint_confidence,
        }
        if return_margin_bps is not None:
            raw_scores["predicted_return_margin_bps"] = return_margin_bps

        return ModelPrediction(
            direction=direction,
            confidence_score=round(joint_confidence, 4),
            model_version=self._model_version,
            features_used=list(self._feature_names),
            raw_scores=raw_scores,
            explainability={
                "method": direction_method,
                "instrument_expert": instrument,
                "opportunity_gate": "pooled_event_opportunity_xgboost",
                "research_experiment": self._artifact_metadata.get(
                    "research_experiment"
                ),
                "confidence_semantics": (
                    "Minimum of opportunity probability and pair-specific "
                    "direction confidence; not a probability of profit."
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
            mtf = self._model_type in {
                MULTITIMEFRAME_MODEL_TYPE,
                EVENT_PAIR_BUNDLE_MODEL_TYPE,
            }
            return {
                "version": self._model_version,
                "type": "xgboost_trained_mtf" if mtf else "xgboost_trained",
                "loaded": True,
                "mode": "trained_xgboost_mtf" if mtf else "trained_xgboost",
                "model_type": self._model_type,
                "runtime_feature_profile": self._runtime_feature_profile,
                "label_selection_policy": self._artifact_metadata.get(
                    "label_selection_policy"
                ),
                "event_label_policy": self._artifact_metadata.get(
                    "event_label_policy"
                ),
                "research_experiment": self._artifact_metadata.get(
                    "research_experiment"
                ),
                "backtest_evaluation_policy": self._artifact_metadata.get(
                    "backtest_evaluation_policy"
                ),
                "research_validation_policy": self._artifact_metadata.get(
                    "research_validation_policy"
                ),
                "feature_count": len(self._feature_names),
                "approved_for_live": False,
                "approved_for_paper": bool(
                    self._artifact_metadata.get("approved_for_paper", False)
                ),
                "validation_status": self._artifact_metadata.get(
                    "validation_status",
                    "unknown",
                ),
                "artifact_sha256": self._artifact_metadata.get("artifact_sha256"),
                "horizon_bars": self._artifact_metadata.get("horizon_bars"),
                "instruments": self._artifact_metadata.get("instruments", []),
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
