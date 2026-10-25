from __future__ import annotations

import numpy as np

from app.domain.training.short_horizon_direct_net import (
    DIRECT_NET_HORIZONS,
    MAX_CALIBRATION_DENSITY,
    MIN_CALIBRATION_DENSITY,
    select_density_budgeted_threshold,
)


def _two_sided_predictions(rows: int) -> tuple[np.ndarray, np.ndarray]:
    predicted_best = np.linspace(-0.2, 1.8, rows, dtype=float)
    predicted_long = np.arange(rows) % 2 == 0
    return predicted_best, predicted_long


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
