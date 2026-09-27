from __future__ import annotations

import pandas as pd

from app.domain.training.single_pair_v11_calibrated_gating import (
    select_margin_floor,
    select_opportunity_threshold,
)


def test_select_opportunity_threshold_uses_calibrated_classification_quality() -> None:
    scored = pd.DataFrame(
        {
            "event_actionable_target": [0, 0, 1, 1, 1, 0],
            "opportunity_probability": [0.05, 0.09, 0.11, 0.18, 0.24, 0.31],
        }
    )
    selected = select_opportunity_threshold(scored)
    assert selected["threshold"] == 0.10
    assert selected["recall"] == 1.0


def test_select_margin_floor_balances_direction_accuracy_and_coverage() -> None:
    scored = pd.DataFrame(
        {
            "event_actionable_target": [1, 1, 1, 0],
            "event_direction_target": [0, 1, 1, 0],
            "opportunity_probability": [0.2, 0.2, 0.2, 0.2],
            "predicted_long": [False, True, False, False],
            "direction_confidence": [0.7, 0.7, 0.7, 0.7],
            "action_probability_margin": [0.06, 0.08, 0.03, 0.2],
        }
    )
    selected = select_margin_floor(scored, opportunity_threshold=0.10)
    assert selected["margin_floor"] == 0.05
    assert selected["direction_accuracy"] == 1.0
    assert selected["eligible_rows"] == 2.0
