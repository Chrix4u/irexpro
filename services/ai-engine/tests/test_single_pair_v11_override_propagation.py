"""Regression test for side-bundle XGBoost override propagation."""
from __future__ import annotations

from typing import Any

import pandas as pd

from app.domain.training import single_pair_v11_calibrated_gating as v11
from app.domain.training.model_qualification import ModelVariant


class _DummyRegressor:
    def fit(self, *args: Any, **kwargs: Any) -> _DummyRegressor:
        return self


def test_fit_models_propagates_parameter_overrides_to_all_submodels(monkeypatch) -> None:
    captured: list[tuple[tuple[str, float | int], ...]] = []

    monkeypatch.setattr(v11, "_ensure_event_dual_actionability_targets", lambda frame: frame)
    monkeypatch.setattr(v11, "_feature_columns", lambda policy: ["x"])

    def fake_fit_binary_variant(variant: ModelVariant, **kwargs: Any) -> object:
        captured.append(variant.parameter_overrides)
        return object()

    def fake_regression_model_for_variant(variant: ModelVariant) -> _DummyRegressor:
        captured.append(variant.parameter_overrides)
        return _DummyRegressor()

    monkeypatch.setattr(v11, "_fit_binary_variant", fake_fit_binary_variant)
    monkeypatch.setattr(v11, "_regression_model_for_variant", fake_regression_model_for_variant)

    frame = pd.DataFrame(
        {
            "x": [0.0, 1.0],
            v11.EVENT_ACTIONABLE_TARGET_COLUMN: [0, 1],
            v11.EVENT_LONG_ACTIONABLE_TARGET_COLUMN: [1, 0],
            v11.EVENT_SHORT_ACTIONABLE_TARGET_COLUMN: [0, 1],
            v11.EVENT_LONG_NET_RETURN_COLUMN: [0.001, -0.001],
            v11.EVENT_SHORT_NET_RETURN_COLUMN: [-0.001, 0.001],
        }
    )
    overrides = (
        ("max_depth", 3),
        ("min_child_weight", 5.0),
        ("reg_lambda", 2.0),
    )
    variant = ModelVariant(
        name="propagation_test",
        parameter_overrides=overrides,
    )

    v11._fit_models(frame, frame, variant=variant)

    assert len(captured) == 7
    assert all(item == overrides for item in captured)
