from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training.six_pair_v79_gated_multihorizon_moe import (
    _apply,
    _balanced_accuracy,
    _metrics,
    _pair_status,
    _with_regime,
)


def _base_rows() -> pd.DataFrame:
    times = pd.date_range("2026-01-01T00:00:00Z", periods=8, freq="5min")
    return pd.DataFrame(
        {
            "decision_time": times,
            "spread_to_atr_ratio": [0.2] * 8,
            "m1_atr_pct_14": [0.001] * 8,
            "_horizon_agreement": [True] * 8,
            "_conservative_ev": np.array([0.30, 0.25, 0.20, 0.15, -0.10, -0.15, -0.20, -0.25]) / 10000,
            "_direction_margin": np.array([0.20] * 8) / 10000,
            "quote_coverage_60s": [0.9] * 8,
            "predicted_long": [True, False, True, False, True, False, True, False],
            "selected_net_return": np.array([0.40, 0.30, 0.20, 0.10, -0.20, -0.30, -0.10, -0.25]) / 10000,
            "_actionable_target": [True, True, True, True, False, False, False, False],
            "_regime": ["calm"] * 8,
        }
    )


def test_regime_router_uses_training_thresholds_and_spread_takes_precedence():
    frame = pd.DataFrame(
        {
            "spread_to_atr_ratio": [0.2, 0.2, 0.9],
            "m1_atr_pct_14": [0.001, 0.004, 0.004],
        }
    )
    routed = _with_regime(
        frame,
        {
            "spread_stressed_q75": 0.5,
            "volatility_active_q60": 0.002,
        },
    )
    assert routed["_regime"].tolist() == ["calm", "active_clean", "stressed"]


def test_horizon_disagreement_fails_closed():
    frame = _base_rows().iloc[:1].copy()
    frame["_horizon_agreement"] = False
    result = _apply(
        frame,
        {
            "ev_floor_bps": 0.05,
            "margin_floor_bps": 0.0,
            "coverage_floor": 0.35,
            "spread_atr_cap": 1.0,
        },
    )
    assert bool(result.iloc[0]["active_trade"]) is False


def test_two_horizon_positive_ev_can_activate():
    frame = _base_rows().iloc[:1].copy()
    result = _apply(
        frame,
        {
            "ev_floor_bps": 0.10,
            "margin_floor_bps": 0.05,
            "coverage_floor": 0.50,
            "spread_atr_cap": 0.75,
        },
    )
    assert bool(result.iloc[0]["active_trade"]) is True


def test_balanced_accuracy_is_symmetric_and_fail_closed_for_single_class():
    assert _balanced_accuracy(
        np.array([True, True, False, False]),
        np.array([True, False, False, False]),
    ) == 0.75
    assert _balanced_accuracy(
        np.array([True, True]),
        np.array([True, False]),
    ) is None


def test_metrics_use_only_active_realized_h5_returns():
    frame = _apply(
        _base_rows(),
        {
            "ev_floor_bps": 0.05,
            "margin_floor_bps": 0.0,
            "coverage_floor": 0.35,
            "spread_atr_cap": 1.0,
        },
    )
    metrics = _metrics(frame)
    assert metrics["trades"] == 4
    assert metrics["profit_factor"] is None
    assert metrics["total_return"] > 0
    assert metrics["balanced_accuracy"] == 1.0
    assert metrics["median_gap_minutes"] == 5.0


def test_pair_status_requires_two_of_three_positive_and_calibration_folds():
    frame = _apply(
        _base_rows(),
        {
            "ev_floor_bps": 0.05,
            "margin_floor_bps": 0.0,
            "coverage_floor": 0.35,
            "spread_atr_cap": 1.0,
        },
    )
    folds = [
        {"calibration_passed": True, "metrics": {"total_return": 0.01}},
        {"calibration_passed": True, "metrics": {"total_return": 0.01}},
        {"calibration_passed": False, "metrics": {"total_return": -0.01}},
    ]
    status = _pair_status(folds, pd.concat([frame] * 10, ignore_index=True))
    assert status["calibration_pass_fraction"] == 2 / 3
    assert status["positive_fold_fraction"] == 2 / 3
    # Other formal gates still decide final challenger status.
    assert "calibration_stability" in status["checks"]
    assert "positive_fold_fraction" in status["checks"]
