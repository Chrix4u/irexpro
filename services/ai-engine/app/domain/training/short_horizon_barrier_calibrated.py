from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import numpy as np

MIN_CALIBRATION_ROWS = 200
MIN_CALIBRATION_DENSITY = 0.05
MAX_CALIBRATION_DENSITY = 0.25
MIN_SIDE_FRACTION = 0.05
CALIBRATION_MIN_PROFIT_FACTOR = 1.10
CALIBRATION_MIN_MEAN_BPS = 0.0
DEFAULT_PROBABILITY_THRESHOLDS = (0.55, 0.60, 0.65, 0.70, 0.75, 0.80)
DEFAULT_MARGIN_THRESHOLDS = (0.05, 0.10, 0.15, 0.20, 0.25)


@dataclass(frozen=True)
class BarrierPairCalibration:
    passed: bool
    reason: str
    min_probability: float | None
    min_margin: float | None
    active_rows: int
    density: float
    mean_realized_bps: float
    profit_factor: float | None
    profit_throughput_bps: float
    long_fraction: float
    short_fraction: float


def _failed(reason: str) -> BarrierPairCalibration:
    return BarrierPairCalibration(
        passed=False,
        reason=reason,
        min_probability=None,
        min_margin=None,
        active_rows=0,
        density=0.0,
        mean_realized_bps=0.0,
        profit_factor=None,
        profit_throughput_bps=0.0,
        long_fraction=0.0,
        short_fraction=0.0,
    )


def _as_vector(values: np.ndarray | Iterable[float]) -> np.ndarray:
    vector = np.asarray(values, dtype=float)
    if vector.ndim != 1:
        raise ValueError("barrier calibration inputs must be one-dimensional")
    return vector


def _profit_factor(values_bps: np.ndarray) -> float | None:
    gains = float(values_bps[values_bps > 0].sum())
    losses = float(-values_bps[values_bps < 0].sum())
    if losses <= 0:
        return None if gains <= 0 else float("inf")
    return gains / losses


def select_barrier_pair_calibration(
    long_probability: np.ndarray | Iterable[float],
    short_probability: np.ndarray | Iterable[float],
    realized_long_bps: np.ndarray | Iterable[float],
    realized_short_bps: np.ndarray | Iterable[float],
    *,
    probability_thresholds: tuple[float, ...] = DEFAULT_PROBABILITY_THRESHOLDS,
    margin_thresholds: tuple[float, ...] = DEFAULT_MARGIN_THRESHOLDS,
    min_rows: int = MIN_CALIBRATION_ROWS,
    min_density: float = MIN_CALIBRATION_DENSITY,
    max_density: float = MAX_CALIBRATION_DENSITY,
    min_side_fraction: float = MIN_SIDE_FRACTION,
    min_profit_factor: float = CALIBRATION_MIN_PROFIT_FACTOR,
    min_mean_bps: float = CALIBRATION_MIN_MEAN_BPS,
) -> BarrierPairCalibration:
    """Select train-only pair activation thresholds from realised economics.

    Inputs must already be aligned to the calibration tail and realised returns
    must be expressed in net basis points. Validation/future rows must never be
    passed to this policy.
    """

    long_p = _as_vector(long_probability)
    short_p = _as_vector(short_probability)
    realized_long = _as_vector(realized_long_bps)
    realized_short = _as_vector(realized_short_bps)
    lengths = {len(long_p), len(short_p), len(realized_long), len(realized_short)}
    if len(lengths) != 1:
        raise ValueError("barrier calibration inputs must have equal lengths")
    rows = len(long_p)
    if rows < min_rows:
        return _failed("INSUFFICIENT_CALIBRATION_ROWS")
    if not all(
        np.isfinite(values).all()
        for values in (long_p, short_p, realized_long, realized_short)
    ):
        return _failed("NON_FINITE_CALIBRATION_INPUT")
    if (
        not probability_thresholds
        or not margin_thresholds
        or min_rows <= 0
        or not (0.0 <= min_density <= max_density <= 1.0)
        or not (0.0 <= min_side_fraction <= 0.5)
    ):
        raise ValueError("invalid barrier calibration policy")

    candidates: list[BarrierPairCalibration] = []
    winning_long = long_p > short_p
    winning_probability = np.maximum(long_p, short_p)
    separation = np.abs(long_p - short_p)

    for min_probability in sorted(set(float(value) for value in probability_thresholds)):
        for min_margin in sorted(set(float(value) for value in margin_thresholds)):
            active = (winning_probability >= min_probability) & (separation >= min_margin)
            active_rows = int(active.sum())
            if active_rows < min_rows:
                continue
            density = active_rows / rows
            if density < min_density or density > max_density:
                continue

            active_long = winning_long[active]
            long_fraction = float(active_long.mean())
            short_fraction = 1.0 - long_fraction
            if long_fraction < min_side_fraction or short_fraction < min_side_fraction:
                continue

            selected = np.where(active_long, realized_long[active], realized_short[active])
            mean_realized_bps = float(selected.mean())
            profit_factor = _profit_factor(selected)
            if mean_realized_bps <= min_mean_bps:
                continue
            if profit_factor is None or not np.isfinite(profit_factor):
                continue
            if profit_factor < min_profit_factor:
                continue

            candidates.append(
                BarrierPairCalibration(
                    passed=True,
                    reason="CALIBRATED",
                    min_probability=min_probability,
                    min_margin=min_margin,
                    active_rows=active_rows,
                    density=density,
                    mean_realized_bps=mean_realized_bps,
                    profit_factor=float(profit_factor),
                    profit_throughput_bps=mean_realized_bps * density,
                    long_fraction=long_fraction,
                    short_fraction=short_fraction,
                )
            )

    if not candidates:
        return _failed("NO_ECONOMIC_THRESHOLD")

    return max(
        candidates,
        key=lambda candidate: (
            candidate.profit_throughput_bps,
            candidate.profit_factor or 0.0,
            candidate.density,
            -(candidate.min_probability or 0.0),
            -(candidate.min_margin or 0.0),
        ),
    )
