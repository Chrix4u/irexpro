from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.training.short_horizon_direct_net import (
    DIRECT_NET_HORIZONS,
    MAX_CALIBRATION_DENSITY,
    MIN_CALIBRATION_DENSITY,
    DirectNetCalibration,
    route_pair_direct_net_predictions,
    select_density_budgeted_threshold,
)


def _two_sided_predictions(rows: int) -> tuple[np.ndarray, np.ndarray]:
    predicted_best = np.linspace(-0.2, 1.8, rows, dtype=float)
    predicted_long = np.arange(rows) % 2 == 0
    return predicted_best, predicted_long


def _passed_calibration(threshold: float = 1.0) -> DirectNetCalibration:
    return DirectNetCalibration(
        passed=True,
        threshold_bps=threshold,
        reason="CALIBRATED",
        rows=250,
        density=0.10,
        mean_realized_bps=0.4,
        profit_factor=1.4,
        long_fraction=0.5,
        short_fraction=0.5,
        candidate_count=20,
    )


class _ConstantModel:
    def __init__(self, value: float) -> None:
        self.value = value

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        return np.full(len(frame), self.value, dtype=float)


def test_direct_net_horizons_are_locked() -> None:
    assert DIRECT_NET_HORIZONS == (5, 20, 60)


def test_selects_train_only_threshold_inside_density_budget() -> None:
    rows = 1000
    predicted_best, predicted_long = _two_sided_predictions(rows)
    realized = np.where(predicted_best >= 1.2, 1.8, -0.7).astype(float)

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is True
    assert decision.threshold_bps is not None
    assert MIN_CALIBRATION_DENSITY <= decision.density <= MAX_CALIBRATION_DENSITY
    assert decision.rows >= 200
    assert decision.mean_realized_bps > 0
    assert decision.profit_factor is not None
    assert decision.profit_factor >= 1.10
    assert decision.long_fraction > 0
    assert decision.short_fraction > 0


def test_rejects_high_density_threshold_when_economics_are_negative() -> None:
    rows = 1000
    predicted_best, predicted_long = _two_sided_predictions(rows)
    realized = np.full(rows, -0.5, dtype=float)

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is False
    assert decision.threshold_bps is None
    assert decision.reason == "NO_ECONOMIC_THRESHOLD"


def test_rejects_profitable_but_one_sided_calibration() -> None:
    rows = 1000
    predicted_best = np.linspace(0.0, 2.0, rows, dtype=float)
    predicted_long = np.ones(rows, dtype=bool)
    realized = np.where(predicted_best >= 1.2, 1.5, -0.2).astype(float)

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is False
    assert decision.threshold_bps is None
    assert decision.reason == "NO_ECONOMIC_THRESHOLD"


def test_rejects_insufficient_calibration_rows() -> None:
    predicted_best, predicted_long = _two_sided_predictions(120)
    realized = np.full(120, 1.0, dtype=float)

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is False
    assert decision.threshold_bps is None
    assert decision.reason == "INSUFFICIENT_CALIBRATION_ROWS"


def test_rejects_non_finite_inputs() -> None:
    predicted_best, predicted_long = _two_sided_predictions(1000)
    realized = np.ones(1000, dtype=float)
    predicted_best[5] = np.nan

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is False
    assert decision.reason == "NON_FINITE_CALIBRATION_INPUT"


def test_routes_each_row_to_its_exact_pair_long_and_short_experts() -> None:
    frame = pd.DataFrame(
        {
            "instrument": ["EURUSD", "USDJPY"],
            "feature_x": [1.0, 2.0],
        }
    )
    models = {
        "EURUSD::long": _ConstantModel(2.0),
        "EURUSD::short": _ConstantModel(0.2),
        "USDJPY::long": _ConstantModel(0.1),
        "USDJPY::short": _ConstantModel(3.0),
    }
    calibrations = {
        "EURUSD": _passed_calibration(1.0),
        "USDJPY": _passed_calibration(1.0),
    }

    result = route_pair_direct_net_predictions(
        frame,
        models=models,
        calibrations=calibrations,
        feature_columns=["feature_x"],
    )

    assert result["predicted_long_net_bps"].tolist() == [2.0, 0.1]
    assert result["predicted_short_net_bps"].tolist() == [0.2, 3.0]
    assert result["action"].tolist() == ["BUY", "SELL"]
    assert result["active_trade"].tolist() == [True, True]


def test_missing_pair_expert_fails_closed_without_cross_pair_fallback() -> None:
    frame = pd.DataFrame({"instrument": ["USDJPY"], "feature_x": [2.0]})
    models = {
        "EURUSD::long": _ConstantModel(2.0),
        "EURUSD::short": _ConstantModel(0.2),
        "USDJPY::long": _ConstantModel(0.1),
    }

    with pytest.raises(ValueError, match=r"missing direct-net expert USDJPY::short"):
        route_pair_direct_net_predictions(
            frame,
            models=models,
            calibrations={"USDJPY": _passed_calibration(1.0)},
            feature_columns=["feature_x"],
        )


def test_failed_pair_calibration_abstains_instead_of_borrowing_threshold() -> None:
    frame = pd.DataFrame({"instrument": ["EURUSD", "USDJPY"], "feature_x": [1.0, 2.0]})
    models = {
        "EURUSD::long": _ConstantModel(2.0),
        "EURUSD::short": _ConstantModel(0.2),
        "USDJPY::long": _ConstantModel(0.1),
        "USDJPY::short": _ConstantModel(3.0),
    }
    failed = DirectNetCalibration(
        passed=False,
        threshold_bps=None,
        reason="NO_ECONOMIC_THRESHOLD",
        rows=0,
        density=0.0,
        mean_realized_bps=0.0,
        profit_factor=None,
        long_fraction=0.0,
        short_fraction=0.0,
        candidate_count=0,
    )

    result = route_pair_direct_net_predictions(
        frame,
        models=models,
        calibrations={"EURUSD": _passed_calibration(1.0), "USDJPY": failed},
        feature_columns=["feature_x"],
    )

    assert result["action"].tolist() == ["BUY", "ABSTAIN"]
    assert result["active_trade"].tolist() == [True, False]
