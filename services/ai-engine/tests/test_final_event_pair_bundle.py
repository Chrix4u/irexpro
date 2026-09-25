"""Focused tests for final event-pair bundle packaging."""
from __future__ import annotations

import hashlib

import pandas as pd
from xgboost import XGBClassifier

from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS
from app.domain.training.model_qualification import (
    DUAL_ACTION_MARGIN_FLOOR,
    EVENT_DUAL_ACTIONABILITY_EXPERIMENT_NAME,
)
from app.domain.training.train_final_event_pair_bundle import (
    EVENT_PAIR_BUNDLE_MODEL_TYPE,
    SUPPORTED_EXPERIMENTS,
    _component_manifest,
)


def _fit_classifier() -> XGBClassifier:
    feature_columns = list(MULTITIMEFRAME_FEATURE_COLUMNS)
    rows = [
        {
            column: float((index + position) % 7) / 10.0
            for position, column in enumerate(feature_columns)
        }
        for index in range(12)
    ]
    frame = pd.DataFrame(rows, columns=feature_columns)
    target = [0, 1] * 6
    model = XGBClassifier(
        n_estimators=2,
        max_depth=1,
        learning_rate=0.1,
        n_jobs=1,
        tree_method="hist",
        random_state=42,
    )
    model.fit(frame, target)
    return model


def _sha256(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_v7_dual_actionability_is_supported_for_final_packaging(tmp_path):
    assert EVENT_DUAL_ACTIONABILITY_EXPERIMENT_NAME in SUPPORTED_EXPERIMENTS

    output = tmp_path / "bundle.json"
    manifest = _component_manifest(
        output,
        experiment=EVENT_DUAL_ACTIONABILITY_EXPERIMENT_NAME,
        direction_models={
            "long": _fit_classifier(),
            "short": _fit_classifier(),
        },
        direction_calibrators=None,
        regime_routers=None,
        opportunity_model=None,
    )

    assert manifest["model_type"] == EVENT_PAIR_BUNDLE_MODEL_TYPE
    assert manifest["experiment"] == EVENT_DUAL_ACTIONABILITY_EXPERIMENT_NAME
    assert "opportunity" not in manifest
    assert "direction" not in manifest

    dual = manifest["dual_actionability"]
    assert dual["kind"] == "xgboost_dual_actionability"
    assert dual["action_margin_floor"] == DUAL_ACTION_MARGIN_FLOOR

    for side in ("long", "short"):
        spec = dual[side]
        child = tmp_path / spec["path"]
        assert spec["kind"] == "xgboost_classifier"
        assert child.is_file()
        assert spec["sha256"] == _sha256(child)
