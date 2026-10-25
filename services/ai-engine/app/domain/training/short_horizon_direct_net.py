"""Research-only direct expected-net-return short-horizon challenger."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

DIRECT_NET_HORIZONS = (5, 20, 60)
MIN_CALIBRATION_ROWS = 200
MIN_CALIBRATION_DENSITY = 0.03
MAX_CALIBRATION_DENSITY = 0.20
MIN_SIDE_FRACTION = 0.05
MIN_CALIBRATION_PROFIT_FACTOR = 1.10
MIN_CALIBRATION_MEAN_BPS = 0.0

DirectNetCalibrationReason = Literal[
    "CALIBRATED",
    "INSUFFICIENT_CALIBRATION_ROWS",
    "NON_FINITE_CALIBRATION_INPUT",
    "INVALID_CALIBRATION_SHAPE",
    "NO_ECONOMIC_THRESHOLD",
]


@dataclass(frozen=True)
class DirectNetCalibration:
    passed: bool
    threshold_bps: float | None
    reason: DirectNetCalibrationReason
    rows: int
    density: float
    mean_realized_bps: float
    profit_factor: float | None
    long_fraction: float
    short_fraction: float
    candidate_count: int


def _raw_profit_factor(values_bps: np.ndarray) -> float | None:
    gains = float(values_bps[values_bps > 0].sum())
    losses = float(-values_bps[values_bps < 0].sum())
    if losses <= 0:
        return float("inf") if gains > 0 else None
    return gains / losses


def _failed(reason: DirectNetCalibrationReason) -> DirectNetCalibration:
    return DirectNetCalibration(
        passed=False,
        threshold_bps=None,
        reason=reason,
        rows=0,
        density=0.0,
        mean_realized_bps=0.0,
        profit_factor=None,
        long_fraction=0.0,
        short_fraction=0.0,
        candidate_count=0,
    )


def select_density_budgeted_threshold(
    predicted_best_bps: np.ndarray,
    predicted_long: np.ndarray,
    realized_selected_bps: np.ndarray,
) -> DirectNetCalibration:
    """Select an economic activation threshold from inner calibration data only."""

    predicted_best = np.asarray(predicted_best_bps, dtype=float)
    long_side = np.asarray(predicted_long, dtype=bool)
    realized = np.asarray(realized_selected_bps, dtype=float)

    if predicted_best.ndim != 1 or long_side.ndim != 1 or realized.ndim != 1:
        return _failed("INVALID_CALIBRATION_SHAPE")
    if not (len(predicted_best) == len(long_side) == len(realized)):
        return _failed("INVALID_CALIBRATION_SHAPE")
    if len(predicted_best) < MIN_CALIBRATION_ROWS:
        return _failed("INSUFFICIENT_CALIBRATION_ROWS")
    if not np.isfinite(predicted_best).all() or not np.isfinite(realized).all():
        return _failed("NON_FINITE_CALIBRATION_INPUT")

    quantiles = np.linspace(
        1.0 - MAX_CALIBRATION_DENSITY,
        1.0 - MIN_CALIBRATION_DENSITY,
        35,
    )
    thresholds = sorted(
        {float(np.quantile(predicted_best, quantile)) for quantile in quantiles}
    )
    eligible: list[DirectNetCalibration] = []

    for threshold in thresholds:
        active = predicted_best >= threshold
        active_rows = int(active.sum())
        if active_rows < MIN_CALIBRATION_ROWS:
            continue

        density = active_rows / len(predicted_best)
        if density < MIN_CALIBRATION_DENSITY or density > MAX_CALIBRATION_DENSITY:
            continue

        active_realized = realized[active]
        active_long = long_side[active]
        mean_realized = float(active_realized.mean())
        profit_factor = _raw_profit_factor(active_realized)
        long_fraction = float(active_long.mean())
        short_fraction = 1.0 - long_fraction

        if mean_realized <= MIN_CALIBRATION_MEAN_BPS:
            continue
        if profit_factor is None or profit_factor < MIN_CALIBRATION_PROFIT_FACTOR:
            continue
        if long_fraction < MIN_SIDE_FRACTION or short_fraction < MIN_SIDE_FRACTION:
            continue

        eligible.append(
            DirectNetCalibration(
                passed=True,
                threshold_bps=threshold,
                reason="CALIBRATED",
                rows=active_rows,
                density=float(density),
                mean_realized_bps=mean_realized,
                profit_factor=float(profit_factor),
                long_fraction=long_fraction,
                short_fraction=short_fraction,
                candidate_count=len(thresholds),
            )
        )

    if not eligible:
        return _failed("NO_ECONOMIC_THRESHOLD")

    return max(
        eligible,
        key=lambda decision: (
            decision.profit_factor if decision.profit_factor is not None else float("-inf"),
            decision.mean_realized_bps,
            decision.density,
        ),
    )
