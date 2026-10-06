from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training.six_pair_v80_tail_ranking_moe import (
    _apply,
    _diagnostics,
    _tail_thresholds,
    _with_labels,
)


def test_tail_thresholds_are_fit_only_and_never_below_net_profit_floor():
    fit = pd.DataFrame(
        {
            "long_h5": np.array([-2, -1, 0, 1, 2]) / 10000,
            "short_h5": np.array([-2, -1, 0, 1, 2]) / 10000,
            "long_h10": np.array([-2, -1, 0, 2, 4]) / 10000,
            "short_h10": np.array([-2, -1, 0, 2, 4]) / 10000,
        }
    )
    thresholds = _tail_thresholds(fit)

    assert thresholds["long_h5"] >= 0.50 / 10000
    assert thresholds["short_h5"] >= 0.50 / 10000
    assert thresholds["long_h10"] >= 1.00 / 10000
    assert thresholds["short_h10"] >= 1.00 / 10000


def test_tail_labels_require_profitable_tail_and_side_dominance():
    frame = pd.DataFrame(
        {
            "long_h5": [2.0, 2.0, -1.0],
            "short_h5": [1.0, 3.0, 2.0],
            "long_h10": [4.0, 2.0, -1.0],
            "short_h10": [1.0, 5.0, 3.0],
        }
    )
    thresholds = {target: 1.5 for target in ("long_h5", "short_h5", "long_h10", "short_h10")}
    labeled = _with_labels(frame, thresholds)

    assert labeled["_tail_long_h5"].tolist() == [1, 0, 0]
    assert labeled["_tail_short_h5"].tolist() == [0, 1, 1]
    assert labeled["_tail_long_h10"].tolist() == [1, 0, 0]
    assert labeled["_tail_short_h10"].tolist() == [0, 1, 1]


def _scored_row(*, agree: bool = True, probability: float = 0.70, margin: float = 0.20):
    return pd.DataFrame(
        {
            "_horizon_agreement": [agree],
            "_conservative_tail_p": [probability],
            "_probability_margin": [margin],
            "quote_coverage_60s": [0.90],
            "spread_to_atr_ratio": [0.30],
            "selected_net_return": [0.0002],
            "predicted_long": [True],
            "_actionable_target": [True],
            "_regime": ["calm"],
            "decision_time": pd.to_datetime(["2026-10-05T12:00:00Z"], utc=True),
            "long_h5": [0.0002],
            "short_h5": [-0.0002],
            "long_h10": [0.0004],
            "short_h10": [-0.0004],
            "_best_p_h5": [probability],
            "_best_p_h10": [probability],
        }
    )


def test_horizon_disagreement_fails_closed():
    out = _apply(
        _scored_row(agree=False),
        {
            "probability_floor": 0.55,
            "margin_floor": 0.10,
            "coverage_floor": 0.50,
            "spread_atr_cap": 0.75,
        },
    )
    assert bool(out.iloc[0]["active_trade"]) is False


def test_high_tail_probability_and_margin_can_activate():
    out = _apply(
        _scored_row(),
        {
            "probability_floor": 0.55,
            "margin_floor": 0.10,
            "coverage_floor": 0.50,
            "spread_atr_cap": 0.75,
        },
    )
    assert bool(out.iloc[0]["active_trade"]) is True


def test_probability_diagnostics_are_bounded():
    frame = _scored_row(probability=0.66, margin=0.12)
    diagnostics = _diagnostics(frame)

    assert diagnostics["horizon_agreement_fraction"] == 1.0
    assert diagnostics["conservative_tail_probability"]["p50"] == 0.66
    assert diagnostics["probability_margin"]["p50"] == 0.12
    assert diagnostics["actual_tail_fraction"] == 1.0
