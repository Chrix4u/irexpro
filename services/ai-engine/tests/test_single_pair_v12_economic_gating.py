from __future__ import annotations

import pandas as pd

from app.domain.training.single_pair_v12_economic_gating import select_economic_gate


def test_select_economic_gate_rejects_insufficient_evidence() -> None:
    scored = pd.DataFrame(
        {
            "event_actionable_target": [1, 0, 1, 0],
            "event_direction_target": [1, 0, 1, 0],
            "opportunity_probability": [0.2, 0.2, 0.2, 0.2],
            "direction_confidence": [0.7, 0.7, 0.7, 0.7],
            "action_probability_margin": [0.08, 0.08, 0.08, 0.08],
            "expected_selected_net_bps": [1.0, 1.0, 1.0, 1.0],
            "expected_payoff_ratio": [1.5, 1.5, 1.5, 1.5],
            "predicted_long": [True, False, True, False],
            "selected_net_return": [0.001, -0.0001, 0.001, -0.0001],
            "decision_time": pd.date_range(
                "2026-01-01", periods=4, freq="min", tz="UTC"
            ),
        }
    )
    result = select_economic_gate(scored)
    assert result["selected"] is None
    assert result["eligible_count"] == 0


def test_select_economic_gate_accepts_bounded_profitable_candidate() -> None:
    rows = 14
    scored = pd.DataFrame(
        {
            "event_actionable_target": [1, 0] * 7,
            "event_direction_target": [1, 0] * 7,
            "opportunity_probability": [0.2] * rows,
            "direction_confidence": [0.7] * rows,
            "action_probability_margin": [0.08] * rows,
            "expected_selected_net_bps": [1.0] * rows,
            "expected_payoff_ratio": [1.5] * rows,
            "predicted_long": [True, False] * 7,
            "selected_net_return": [
                0.001,
                0.001,
                0.001,
                -0.0001,
                0.001,
                0.001,
                0.001,
                -0.0001,
                0.001,
                0.001,
                0.001,
                -0.0001,
                0.001,
                0.001,
            ],
            "decision_time": pd.date_range(
                "2026-01-01", periods=rows, freq="min", tz="UTC"
            ),
        }
    )
    result = select_economic_gate(scored)
    assert result["selected"] is not None
    assert result["eligible_count"] > 0
    assert result["selected"]["trading"]["trade_count"] >= 10
