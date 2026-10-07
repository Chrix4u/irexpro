"""Frozen Plan-B v4 three-expert high-conviction challenger.

This component is shadow-only. It verifies the exported artifact manifest and
reproduces the exact frozen OOF consensus rule without publishing signals or
executing trades.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.models.multitimeframe_features import (
    INITIAL_FOREX_UNIVERSE,
    MULTITIMEFRAME_FEATURE_COLUMNS,
)

EXPECTED_ARTIFACT = "plan-b-v4-oof-three-expert-consensus-challenger"
EXPECTED_MODE = "PROSPECTIVE_SHADOW_ONLY"
EXPECTED_LABEL_POLICY = "first_net_return_barrier_atr1_spread2_timeout_v1"
EXPECTED_FEATURE_COUNT = 128


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class PlanBV4HighConvictionChallenger:
    """Integrity-checked three-expert model bundle for prospective shadow scoring."""

    def __init__(
        self,
        manifest_path: str | Path | None = None,
        expected_manifest_sha256: str | None = None,
    ) -> None:
        self._manifest_path = Path(manifest_path).expanduser() if manifest_path else None
        self._expected_manifest_sha256 = (
            str(expected_manifest_sha256).strip().lower()
            if expected_manifest_sha256
            else None
        )
        self._manifest_sha256_verified = False
        self._manifest: dict[str, Any] = {}
        self._features: list[str] = []
        self._models: dict[str, Any] = {}
        self._routers: dict[str, dict[str, float]] = {}
        self._loaded = False
        self._load_error: str | None = None
        if self._manifest_path:
            self.load()

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def status(self) -> dict[str, Any]:
        historical = self._manifest.get("historical_validation_metrics", {})
        return {
            "artifact": self._manifest.get("artifact", EXPECTED_ARTIFACT),
            "mode": EXPECTED_MODE,
            "configured": self._manifest_path is not None,
            "loaded": self._loaded,
            "load_error": "CHALLENGER_LOAD_FAILED" if self._load_error else None,
            "manifest_path": str(self._manifest_path) if self._manifest_path else None,
            "manifest_sha256_pinned": self._expected_manifest_sha256 is not None,
            "manifest_sha256_verified": self._manifest_sha256_verified,
            "feature_count": len(self._features),
            "frozen_consensus": self._manifest.get("frozen_consensus"),
            "qualification_cutoff": self._manifest.get("qualification_cutoff"),
            "sealed_future_holdout_touched": self._manifest.get(
                "sealed_future_holdout_touched"
            ),
            "historical_validation": {
                "n": historical.get("n"),
                "profit_factor": historical.get("pf"),
                "sharpe": historical.get("sharpe"),
                "balanced_accuracy": historical.get("ba"),
                "max_drawdown": historical.get("dd"),
                "positive_fold_fraction": historical.get("positive_fold_fraction"),
                "positive_instrument_fraction": historical.get(
                    "positive_instrument_fraction"
                ),
                "median_gap_minutes": historical.get("median_gap_minutes"),
            },
            "execution_authority": "NONE",
            "paper_promotion_eligible": False,
        }

    def load(self) -> bool:
        try:
            if self._manifest_path is None or not self._manifest_path.is_file():
                raise ValueError("challenger manifest is not configured or missing")
            if not self._expected_manifest_sha256:
                raise ValueError("challenger manifest SHA-256 pin is required")
            if not re.fullmatch(r"[0-9a-f]{64}", self._expected_manifest_sha256):
                raise ValueError("challenger manifest SHA-256 pin is malformed")
            actual_manifest_sha256 = _sha256(self._manifest_path)
            if actual_manifest_sha256 != self._expected_manifest_sha256:
                raise ValueError("challenger manifest SHA-256 mismatch")
            self._manifest_sha256_verified = True
            manifest = json.loads(self._manifest_path.read_text(encoding="utf-8"))
            if manifest.get("artifact") != EXPECTED_ARTIFACT:
                raise ValueError("unexpected challenger artifact")
            if manifest.get("mode") != EXPECTED_MODE:
                raise ValueError("challenger must remain prospective shadow only")
            if manifest.get("event_label_policy") != EXPECTED_LABEL_POLICY:
                raise ValueError("event label policy mismatch")
            if manifest.get("sealed_future_holdout_touched") is not False:
                raise ValueError("sealed future holdout flag is not clean")

            root = self._manifest_path.parent.resolve()
            feature_spec = manifest.get("feature_columns")
            if not isinstance(feature_spec, dict):
                raise ValueError("feature contract missing")
            feature_path = self._verified_path(root, feature_spec)
            features = json.loads(feature_path.read_text(encoding="utf-8"))
            if (
                not isinstance(features, list)
                or len(features) != EXPECTED_FEATURE_COUNT
                or features != MULTITIMEFRAME_FEATURE_COLUMNS
            ):
                raise ValueError("challenger feature schema does not match runtime")

            import xgboost as xgb

            artifacts = manifest.get("artifacts")
            if not isinstance(artifacts, dict):
                raise ValueError("challenger artifact components missing")

            two_stage = artifacts["event_barrier_two_stage"]
            pair = artifacts["event_barrier_pair_experts"]
            regime = artifacts["event_barrier_pair_regime_experts"]

            models: dict[str, Any] = {}
            models["two_direction"] = self._load_classifier(
                xgb, self._verified_path(root, two_stage["direction"])
            )
            models["two_opportunity"] = self._load_classifier(
                xgb, self._verified_path(root, two_stage["opportunity"])
            )
            models["pair_opportunity"] = self._load_classifier(
                xgb, self._verified_path(root, pair["opportunity"])
            )
            models["regime_opportunity"] = self._load_classifier(
                xgb, self._verified_path(root, regime["opportunity"])
            )

            pair_models: dict[str, Any] = {}
            for instrument in INITIAL_FOREX_UNIVERSE:
                spec = pair["direction_by_pair"].get(instrument)
                if not isinstance(spec, dict):
                    raise ValueError(f"missing pair expert for {instrument}")
                pair_models[instrument] = self._load_classifier(
                    xgb, self._verified_path(root, spec)
                )
            models["pair_direction"] = pair_models

            regime_models: dict[str, Any] = {}
            for key, spec in regime["direction_models"].items():
                regime_models[str(key)] = self._load_classifier(
                    xgb, self._verified_path(root, spec)
                )
            models["regime_direction"] = regime_models

            router_path = self._verified_path(root, regime["regime_routers"])
            routers = json.loads(router_path.read_text(encoding="utf-8"))
            if set(routers) != set(INITIAL_FOREX_UNIVERSE):
                raise ValueError("regime router universe mismatch")

            frozen = manifest.get("frozen_consensus")
            if frozen != {
                "opp_floor": 0.55,
                "margin_floor": 0.0,
                "votes_required": 3,
            }:
                raise ValueError("frozen consensus policy mismatch")

            self._manifest = manifest
            self._features = list(features)
            self._models = models
            self._routers = routers
            self._loaded = True
            self._load_error = None
            return True
        except Exception as exc:
            self._loaded = False
            self._manifest_sha256_verified = False
            self._load_error = str(exc)
            return False

    def score(self, *, instrument: str, features: dict[str, float]) -> dict[str, Any]:
        if not self._loaded:
            raise RuntimeError(self._load_error or "challenger is not loaded")
        symbol = instrument.strip().upper()
        if symbol not in INITIAL_FOREX_UNIVERSE:
            raise ValueError(f"unsupported instrument: {symbol}")
        if list(features) != self._features:
            raise ValueError("feature order diverged from frozen challenger schema")

        values = np.asarray([features[name] for name in self._features], dtype=float)
        if not np.isfinite(values).all():
            raise ValueError("challenger received non-finite feature values")
        frame = pd.DataFrame([values], columns=self._features)

        experts = [
            self._expert(
                "event_barrier_two_stage",
                self._models["two_direction"],
                self._models["two_opportunity"],
                frame,
            ),
            self._expert(
                "event_barrier_pair_experts",
                self._models["pair_direction"][symbol],
                self._models["pair_opportunity"],
                frame,
            ),
        ]

        regime_name = self._route_regime(symbol, features)
        regime_models: dict[str, Any] = self._models["regime_direction"]
        regime_key = f"{symbol}::{regime_name}"
        fallback_key = f"{symbol}::fallback"
        direction_model = regime_models.get(regime_key) or regime_models.get(fallback_key)
        if direction_model is None:
            raise ValueError(f"missing regime and fallback model for {symbol}")
        experts.append(
            self._expert(
                "event_barrier_pair_regime_experts",
                direction_model,
                self._models["regime_opportunity"],
                frame,
                regime=regime_name,
                used_fallback=regime_key not in regime_models,
            )
        )

        long_votes = sum(1 for expert in experts if expert["predicted_long"])
        short_votes = len(experts) - long_votes
        consensus_long = long_votes >= short_votes
        agreement = max(long_votes, short_votes) / len(experts)
        mean_direction_confidence = float(
            np.mean([expert["direction_confidence"] for expert in experts])
        )
        mean_opportunity = float(
            np.mean([expert["opportunity_probability"] for expert in experts])
        )
        vote_margin = abs(long_votes - short_votes) / len(experts)
        ensemble_confidence = (
            0.5 * agreement
            + 0.3 * mean_direction_confidence
            + 0.2 * mean_opportunity
        )

        frozen = self._manifest["frozen_consensus"]
        admitted = bool(
            max(long_votes, short_votes) >= int(frozen["votes_required"])
            and mean_opportunity >= float(frozen["opp_floor"])
            and vote_margin >= float(frozen["margin_floor"])
        )

        return {
            "artifact": EXPECTED_ARTIFACT,
            "mode": EXPECTED_MODE,
            "modifies_execution": False,
            "instrument": symbol,
            "direction": "BUY" if consensus_long else "SELL",
            "admitted": admitted,
            "ensemble_confidence": ensemble_confidence,
            "mean_opportunity_probability": mean_opportunity,
            "mean_direction_confidence": mean_direction_confidence,
            "long_votes": long_votes,
            "short_votes": short_votes,
            "vote_margin": vote_margin,
            "votes_required": int(frozen["votes_required"]),
            "opportunity_floor": float(frozen["opp_floor"]),
            "regime": regime_name,
            "experts": experts,
            "paper_promotion_eligible": False,
        }

    def _expert(
        self,
        name: str,
        direction_model: Any,
        opportunity_model: Any,
        frame: pd.DataFrame,
        **extra: Any,
    ) -> dict[str, Any]:
        direction_probability = float(direction_model.predict_proba(frame)[0][1])
        opportunity_probability = float(opportunity_model.predict_proba(frame)[0][1])
        predicted_long = direction_probability >= 0.5
        return {
            "name": name,
            "predicted_long": predicted_long,
            "direction_probability_long": direction_probability,
            "direction_confidence": max(
                direction_probability, 1.0 - direction_probability
            ),
            "opportunity_probability": opportunity_probability,
            **extra,
        }

    def _route_regime(self, instrument: str, features: dict[str, float]) -> str:
        thresholds = self._routers[instrument]
        spread = float(features["m1_spread_bps"])
        volatility = float(features["m1_volatility_20"])
        if spread > float(thresholds["m1_spread_bps_median"]):
            return "stressed"
        if volatility > float(thresholds["m1_volatility_20_median"]):
            return "active_clean"
        return "calm"

    def _verified_path(self, root: Path, spec: dict[str, Any]) -> Path:
        raw = str(spec.get("path", "")).strip()
        expected_sha = str(spec.get("sha256", "")).strip().lower()
        if not raw or not expected_sha:
            raise ValueError("artifact path/hash missing")
        path = Path(raw).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"artifact file missing: {path}")
        if root not in path.parents and path != root:
            raise ValueError("artifact path escapes challenger root")
        if _sha256(path) != expected_sha:
            raise ValueError(f"artifact SHA-256 mismatch: {path.name}")
        return path

    @staticmethod
    def _load_classifier(xgb: Any, path: Path) -> Any:
        model = xgb.XGBClassifier()
        model.load_model(str(path))
        return model
