"""
BaselineXGBoostModel — Scaffold only.

╔══════════════════════════════════════════════════════════════════════════════╗
║  IMPORTANT:                                                                ║
║  This is a BASELINE SCAFFOLD, NOT a trained production model.              ║
║  It does NOT use real market data weights.                                 ║
║  It does NOT imply any trading edge or profitability.                      ║
║  It is approved for PAPER MODE ONLY.                                       ║
║  Do NOT enable for live trading without a full governance review.          ║
╚══════════════════════════════════════════════════════════════════════════════╝

When a trained model file is available, set MODEL_PATH to its location and
call load_model() before calling predict_signal().
"""
from __future__ import annotations

import os
from typing import Any, Literal

from app.core.logging import get_logger
from app.domain.models.schemas import ModelPrediction

logger = get_logger(__name__)

MODEL_VERSION = "baseline-xgboost-v0.1.0"
MODEL_PATH_ENV = "XGBOOST_MODEL_PATH"


class BaselineXGBoostModel:
    """
    XGBoost baseline scaffold.

    In this sprint, no real model weights exist.
    predict_signal() uses a simple heuristic on features as a placeholder.
    The class is structured so a real trained model can be loaded in the future.
    """

    def __init__(self) -> None:
        self._model: Any = None
        self._model_loaded = False
        self._model_path_configured = False
        self._model_load_status = "not_configured"

    def load_model(self) -> bool:
        """
        Attempt to load a trained XGBoost model from disk.
        Returns True if loaded, False if no model file found (placeholder mode).
        """
        model_path = os.getenv(MODEL_PATH_ENV)
        self._model_loaded = False
        self._model = None
        self._model_path_configured = bool(model_path)

        if not model_path:
            self._model_load_status = "not_configured"
            logger.info("No XGBoost model path configured — heuristic scaffold is active")
            return False

        if not os.path.exists(model_path):
            self._model_load_status = "artifact_missing"
            logger.error(
                "Configured XGBoost model artifact is missing — heuristic fallback is active"
            )
            return False

        try:
            import xgboost as xgb  # noqa: F401 — lazy import
            self._model = xgb.Booster()
            self._model.load_model(model_path)
            self._model_loaded = True
            self._model_load_status = "loaded"
            logger.info("XGBoost model loaded", path=model_path, version=MODEL_VERSION)
            return True
        except Exception as e:
            self._model_load_status = "load_failed"
            logger.error("Failed to load XGBoost model", error=str(e))
            return False

    def predict_signal(self, features: dict[str, float]) -> ModelPrediction:
        """
        Predict a trading signal from extracted features.

        If a real model is loaded, uses XGBoost inference.
        Otherwise, uses a conservative heuristic placeholder.

        IMPORTANT: Confidence scores from the placeholder are intentionally
        conservative (≤ 0.65) to avoid accidental live trading signals.
        """
        if self._model_loaded and self._model is not None:
            return self._predict_with_xgboost(features)
        return self._predict_heuristic(features)

    def _predict_with_xgboost(self, features: dict[str, float]) -> ModelPrediction:
        """XGBoost model inference — only called when a real model is loaded."""
        import numpy as np
        import xgboost as xgb

        feature_names = list(features.keys())
        feature_matrix = np.array([[features[k] for k in feature_names]])
        dmatrix = xgb.DMatrix(feature_matrix, feature_names=feature_names)
        raw_prob = float(self._model.predict(dmatrix)[0])

        direction: Literal["BUY", "SELL"] = "BUY" if raw_prob > 0.5 else "SELL"
        confidence = abs(raw_prob - 0.5) * 2  # Map [0.5, 1.0] → [0.0, 1.0]

        return ModelPrediction(
            direction=direction,
            confidence_score=round(confidence, 4),
            model_version=MODEL_VERSION,
            features_used=feature_names,
            raw_scores={"raw_prob": raw_prob},
            explainability={"method": "xgboost_predict_proba"},
        )

    def _predict_heuristic(self, features: dict[str, float]) -> ModelPrediction:
        """
        Conservative heuristic placeholder when no model is loaded.

        Uses simple price-vs-MA20 momentum as a directional proxy.
        Intentionally capped at 0.65 confidence — should rarely trigger real signals.

        THIS IS NOT A REAL TRADING STRATEGY. Do not use for live trading.
        """
        price_vs_ma20 = features.get("price_vs_ma20", 0.0)
        volatility = features.get("volatility_10", 0.5)

        direction: Literal["BUY", "SELL"] = "BUY" if price_vs_ma20 > 0 else "SELL"

        # Conservative confidence — capped below 0.70 to be safely below threshold
        # in volatile regimes
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
                "note": "No trained model loaded. This is a scaffold prediction only.",
                "approved_for_live": False,
            },
        )

    def get_model_version(self) -> str:
        return MODEL_VERSION

    def get_model_metadata(self) -> dict:
        if self._model_loaded:
            mode = "trained_xgboost"
        elif self._model_path_configured:
            mode = "heuristic_fallback"
        else:
            mode = "heuristic_placeholder"

        return {
            "version": MODEL_VERSION,
            "type": "xgboost_scaffold",
            "loaded": self._model_loaded,
            "trained_model_active": self._model_loaded,
            "model_path_configured": self._model_path_configured,
            "load_status": self._model_load_status,
            "mode": mode,
            "approved_for_live": False,
            "approved_for_paper": True,
        }
