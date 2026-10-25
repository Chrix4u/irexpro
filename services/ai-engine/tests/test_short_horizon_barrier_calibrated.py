from __future__ import annotations

import numpy as np

from app.domain.training.short_horizon_barrier_calibrated import (
    BarrierPairCalibration,
    select_barrier_pair_calibration,
)


def _balanced_side_probabilities(
    winning_probability: float,
    losing_probability: float,
    rows: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    choose_long = np.arange(rows) % 2 == 0
    long_probability = np.where(choose_long, winning_probability, losing_probability).astype(float)
    short_probability = np.where(choose_long, losing_probability, winning_probability).astype(float)
    return long_probability, short_probability, choose_long


def test_selects_profit_throughput_after_economic_floors_pass() -> None:
    rows = 1000
    long_probability = np.full(rows, 0.51, dtype=float)
    short_probability = np.full(rows, 0.49, dtype=float)
    realized_long = np.full(rows, -0.2, dtype=float)
    realized_short = np.full(rows, -0.2, dtype=float)

    high_long, high_short, high_side = _balanced_side_probabilities(0.82, 0.18, 200)
    medium_long, medium_short, medium_side = _balanced_side_probabilities(0.66, 0.24, 200)
    long_probability[:200] = high_long
    short_probability[:200] = high_short
    long_probability[200:400] = medium_long
    short_probability[200:400] = medium_short

    high_values = np.array([2.0] * 160 + [-1.0] * 40, dtype=float)
    medium_values = np.array([1.0] * 140 + [-1.0] * 60, dtype=float)
    for offset, (side_mask, values) in enumerate(
        ((high_side, high_values), (medium_side, medium_values))
    ):
        start = offset * 200
        stop = start + 200
        realized_long[start:stop] = np.where(side_mask, values, -0.5)
        realized_short[start:stop] = np.where(side_mask, -0.5, values)

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
        probability_thresholds=(0.60, 0.75),
        margin_thresholds=(0.20,),
        max_density=0.50,
    )

    assert isinstance(decision, BarrierPairCalibration)
    assert decision.passed is True
    assert decision.min_probability == 0.60
    assert decision.min_margin == 0.20
    assert decision.active_rows == 400
    assert decision.density == 0.40
    assert decision.mean_realized_bps > 0
    assert decision.profit_factor is not None
    assert decision.profit_factor >= 1.10
    assert decision.profit_throughput_bps > 0
    assert 0.05 <= decision.long_fraction <= 0.95
    assert 0.05 <= decision.short_fraction <= 0.95


def test_rejects_high_density_when_realized_economics_are_negative() -> None:
    rows = 1200
    long_probability, short_probability, _ = _balanced_side_probabilities(0.75, 0.20, rows)
    realized_long = np.full(rows, -0.5, dtype=float)
    realized_short = np.full(rows, -0.5, dtype=float)

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
    )

    assert decision.passed is False
    assert decision.reason == "NO_ECONOMIC_THRESHOLD"
    assert decision.min_probability is None
    assert decision.min_margin is None


def test_rejects_calibration_when_evidence_rows_are_insufficient() -> None:
    rows = 120
    long_probability, short_probability, _ = _balanced_side_probabilities(0.75, 0.20, rows)
    realized_long = np.full(rows, 1.0, dtype=float)
    realized_short = np.full(rows, 1.0, dtype=float)

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
    )

    assert decision.passed is False
    assert decision.reason == "INSUFFICIENT_CALIBRATION_ROWS"


def test_rejects_profitable_but_one_sided_activation() -> None:
    rows = 1200
    long_probability = np.full(rows, 0.78, dtype=float)
    short_probability = np.full(rows, 0.18, dtype=float)
    realized_long = np.full(rows, 1.2, dtype=float)
    realized_short = np.full(rows, -0.5, dtype=float)

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
    )

    assert decision.passed is False
    assert decision.reason == "NO_ECONOMIC_THRESHOLD"


def test_rejects_non_finite_probability_or_realized_input() -> None:
    rows = 1200
    long_probability, short_probability, _ = _balanced_side_probabilities(0.75, 0.20, rows)
    realized_long = np.ones(rows, dtype=float)
    realized_short = np.ones(rows, dtype=float)
    long_probability[10] = np.nan

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
    )

    assert decision.passed is False
    assert decision.reason == "NON_FINITE_CALIBRATION_INPUT"
