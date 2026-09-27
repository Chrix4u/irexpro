from __future__ import annotations

import pandas as pd

from app.domain.training.v11_calibrated_opportunity import (
    apply_v11_execution_policy,
    select_execution_thresholds,
)


def _frame() -> pd.DataFrame:
    rows = []
    for i in range(80):
        long_side = i % 2 == 0
        rows.append(
            {
                "predicted_long": long_side,
                "direction_confidence": 0.66,
                "opportunity_probability": 0.50 if i < 60 else 0.61,
                "action_probability_margin": 0.06 if i < 60 else 0.11,
                "expected_selected_net_bps": 1.5,
                "expected_payoff_ratio": 1.30,
                "selected_net_return": 0.0004 if i % 5 != 0 else -0.0001,
            }
        )
    return pd.DataFrame(rows)


def test_apply_policy_uses_locked_direction_and_payoff_floors() -> None:
    frame = _frame()
    evaluated = apply_v11_execution_policy(
        frame,
        opportunity_threshold=0.50,
        action_margin_floor=0.05,
    )
    assert int(evaluated["active_trade"].sum()) == 80

    frame.loc[0, "direction_confidence"] = 0.59
    frame.loc[1, "expected_payoff_ratio"] = 1.14
    evaluated = apply_v11_execution_policy(
        frame,
        opportunity_threshold=0.50,
        action_margin_floor=0.05,
    )
    assert evaluated.loc[0, "active_trade"] is False or not bool(
        evaluated.loc[0, "active_trade"]
    )
    assert evaluated.loc[1, "active_trade"] is False or not bool(
        evaluated.loc[1, "active_trade"]
    )


def test_selector_can_choose_inner_threshold_without_outer_data() -> None:
    choice = select_execution_thresholds(
        _frame(),
        minimum_trades=30,
        minimum_side_trades=3,
    )
    assert choice.eligible is True
    assert choice.opportunity_threshold in {0.35, 0.40, 0.45, 0.50}
    assert choice.action_margin_floor in {0.03, 0.05}


def test_selector_falls_back_when_two_sided_evidence_missing() -> None:
    frame = _frame()
    frame["predicted_long"] = True
    choice = select_execution_thresholds(
        frame,
        minimum_trades=30,
        minimum_side_trades=3,
    )
    assert choice.eligible is False
    assert choice.opportunity_threshold == 0.60
    assert choice.action_margin_floor == 0.10
    assert "conservative v10 thresholds retained" in choice.reason


def test_selector_rejects_negative_economics() -> None:
    frame = _frame()
    frame["selected_net_return"] = -0.0002
    choice = select_execution_thresholds(
        frame,
        minimum_trades=30,
        minimum_side_trades=3,
    )
    assert choice.eligible is False
