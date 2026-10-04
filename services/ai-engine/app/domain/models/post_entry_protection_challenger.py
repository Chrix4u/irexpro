"""Frozen v85 profitable-state giveback classifier.

Shadow-only post-entry protection challenger. The artifact may recommend a
counterfactual PROTECT_SHADOW action, but this component has no execution path.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

EXPECTED_ARTIFACT = "plan-b-v85-profitable-state-giveback-classifier-v1"
EXPECTED_MODE = "PROSPECTIVE_SHADOW_ONLY"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class PlanBV85PostEntryProtectionChallenger:
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
        self._manifest: dict[str, Any] = {}
        self._features: list[str] = []
        self._model: Any = None
        self._loaded = False
        self._load_error: str | None = None
        self._manifest_sha256_verified = False
        if self._manifest_path:
            self.load()

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def load_error(self) -> str | None:
        return self._load_error

    @property
    def features(self) -> list[str]:
        return list(self._features)

    @property
    def checkpoint_minutes(self) -> tuple[int, ...]:
        values = (
            self._manifest.get("training_contract", {}).get("snapshot_minutes")
            if self._manifest
            else None
        )
        if not isinstance(values, list):
            return (5, 10, 15, 30, 60, 120, 240)
        return tuple(int(value) for value in values)

    def status(self) -> dict[str, Any]:
        contract = self._manifest.get("training_contract", {})
        evidence = self._manifest.get("development_evidence", {})
        combined = evidence.get("combined", {}) if isinstance(evidence, dict) else {}
        delta = combined.get("delta", {}) if isinstance(combined, dict) else {}
        return {
            "artifact": self._manifest.get("artifact", EXPECTED_ARTIFACT),
            "mode": EXPECTED_MODE,
            "configured": self._manifest_path is not None,
            "loaded": self._loaded,
            "load_error": self._load_error,
            "manifest_path": str(self._manifest_path) if self._manifest_path else None,
            "manifest_sha256_pinned": self._expected_manifest_sha256 is not None,
            "manifest_sha256_verified": self._manifest_sha256_verified,
            "feature_count": len(self._features),
            "checkpoint_minutes": list(self.checkpoint_minutes),
            "minimum_current_profit_r": contract.get("minimum_current_profit_r"),
            "giveback_label_r": contract.get("giveback_label_r"),
            "probability_threshold": contract.get("probability_threshold"),
            "development_delta": {
                "n": delta.get("n"),
                "net_r": delta.get("net_r"),
                "profit_factor": delta.get("profit_factor"),
                "sharpe": delta.get("sharpe"),
                "max_drawdown": delta.get("max_drawdown"),
            },
            "sealed_future_holdout_touched": self._manifest.get(
                "sealed_future_holdout_touched"
            ),
            "execution_authority": "NONE",
            "modifies_execution": False,
            "paper_promotion_eligible": False,
        }

    def load(self) -> bool:
        try:
            if self._manifest_path is None or not self._manifest_path.is_file():
                raise ValueError("v85 manifest is not configured or missing")
            if not self._expected_manifest_sha256:
                raise ValueError("v85 manifest SHA-256 pin is required")
            if not re.fullmatch(r"[0-9a-f]{64}", self._expected_manifest_sha256):
                raise ValueError("v85 manifest SHA-256 pin is malformed")
            if _sha256(self._manifest_path) != self._expected_manifest_sha256:
                raise ValueError("v85 manifest SHA-256 mismatch")
            self._manifest_sha256_verified = True

            manifest = json.loads(self._manifest_path.read_text(encoding="utf-8"))
            if manifest.get("artifact") != EXPECTED_ARTIFACT:
                raise ValueError("unexpected v85 artifact")
            if manifest.get("mode") != EXPECTED_MODE:
                raise ValueError("v85 must remain prospective shadow only")
            if manifest.get("sealed_future_holdout_touched") is not False:
                raise ValueError("v85 sealed future holdout flag is not clean")
            if manifest.get("execution_authority") != "NONE":
                raise ValueError("v85 execution authority must remain NONE")
            if manifest.get("modifies_execution") is not False:
                raise ValueError("v85 must not modify execution")

            artifacts = manifest.get("artifacts")
            if not isinstance(artifacts, dict):
                raise ValueError("v85 artifact map missing")
            root = self._manifest_path.parent.resolve()
            feature_path = self._verified_path(root, artifacts["feature_columns"])
            model_path = self._verified_path(root, artifacts["model"])
            self._verified_path(root, artifacts["development_report"])
            self._verified_path(root, artifacts["training_script"])
            self._verified_path(root, artifacts["snapshot_corpus"])

            features = json.loads(feature_path.read_text(encoding="utf-8"))
            if not isinstance(features, list) or not features:
                raise ValueError("v85 feature schema missing")
            if len(features) != int(manifest["training_contract"]["feature_count"]):
                raise ValueError("v85 feature count mismatch")

            import xgboost as xgb

            model = xgb.XGBClassifier()
            model.load_model(str(model_path))

            self._manifest = manifest
            self._features = [str(value) for value in features]
            self._model = model
            self._loaded = True
            self._load_error = None
            return True
        except Exception as exc:
            self._loaded = False
            self._manifest_sha256_verified = False
            self._load_error = str(exc)
            return False

    def score(self, features: dict[str, float]) -> dict[str, Any]:
        if not self._loaded or self._model is None:
            raise RuntimeError(self._load_error or "v85 challenger is not loaded")
        if list(features) != self._features:
            raise ValueError("v85 feature order diverged from frozen schema")
        values = np.asarray([features[name] for name in self._features], dtype=float)
        if not np.isfinite(values).all():
            raise ValueError("v85 received non-finite feature values")

        frame = pd.DataFrame([values], columns=self._features)
        probability = float(self._model.predict_proba(frame)[0][1])
        contract = self._manifest["training_contract"]
        threshold = float(contract["probability_threshold"])
        current_r = float(features["current_r"])
        minimum_profit = float(contract["minimum_current_profit_r"])
        protect = bool(current_r >= minimum_profit and probability >= threshold)
        return {
            "artifact": EXPECTED_ARTIFACT,
            "mode": EXPECTED_MODE,
            "probability": probability,
            "threshold": threshold,
            "current_r": current_r,
            "eligible_profit_state": current_r >= minimum_profit,
            "action": "PROTECT_SHADOW" if protect else "OBSERVE",
            "modifies_execution": False,
            "execution_authority": "NONE",
            "paper_promotion_eligible": False,
        }

    def _verified_path(self, root: Path, spec: dict[str, Any]) -> Path:
        if not isinstance(spec, dict):
            raise ValueError("v85 artifact spec missing")
        raw = str(spec.get("path", "")).strip()
        expected = str(spec.get("sha256", "")).strip().lower()
        if not raw or not expected:
            raise ValueError("v85 artifact path/hash missing")
        path = Path(raw).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"v85 artifact file missing: {path}")
        # Snapshot corpus is intentionally in sibling v84 research directory;
        # all other artifact files must remain under the v85 root.
        if path.name != "v84-snapshots.csv" and root not in path.parents and path != root:
            raise ValueError("v85 artifact path escapes frozen root")
        if _sha256(path) != expected:
            raise ValueError(f"v85 artifact SHA-256 mismatch: {path.name}")
        return path
