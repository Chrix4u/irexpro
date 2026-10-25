"""Research-only direct expected-net-return short-horizon challenger."""

from __future__ import annotations

import zlib
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
)

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


class _RegressorLike(Protocol):
    def predict(self, frame: pd.DataFrame) -> np.ndarray: ...


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


def _make_direct_net_regressor(
    *,
    instrument: str,
    side: str,
    horizon_bars: int,
) -> XGBRegressor:
    """Return a deterministic pair/side/horizon expected-net-return regressor."""

    seed_material = f"{instrument}|{side}|{horizon_bars}".encode()
    random_state = zlib.crc32(seed_material) & 0x7FFFFFFF
    return XGBRegressor(
        objective="reg:squarederror",
        eval_metric="rmse",
        n_estimators=900,
        learning_rate=0.02,
        max_depth=5,
        min_child_weight=5.0,
        subsample=0.85,
        colsample_bytree=0.80,
        reg_alpha=0.10,
        reg_lambda=1.75,
        random_state=random_state,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=70,
    )


def fit_pair_direct_net_experts(
    training_window: pd.DataFrame,
    *,
    horizon_bars: int,
    feature_columns: list[str],
) -> tuple[dict[str, _RegressorLike], dict[str, DirectNetCalibration], dict[str, Any]]:
    """Fit exact-pair LONG/SHORT experts and calibrate from the inner tail only."""

    if horizon_bars not in DIRECT_NET_HORIZONS:
        raise ValueError(f"unsupported direct-net horizon: {horizon_bars}")
    required_columns = {
        "instrument",
        *feature_columns,
        LONG_NET_RETURN_COLUMN,
        SHORT_NET_RETURN_COLUMN,
    }
    missing = sorted(required_columns.difference(training_window.columns))
    if missing:
        raise ValueError(f"direct-net training frame missing columns: {missing}")
    if training_window.empty:
        raise ValueError("direct-net training frame is empty")

    fit_window, early_window = _split_internal_early_stopping_tail(
        training_window,
        horizon_bars=horizon_bars,
    )
    models: dict[str, _RegressorLike] = {}
    calibrations: dict[str, DirectNetCalibration] = {}
    pair_counts: dict[str, dict[str, Any]] = {}

    instruments = sorted(training_window["instrument"].astype(str).unique())
    for instrument in instruments:
        pair_fit = fit_window.loc[fit_window["instrument"].astype(str) == instrument]
        pair_early = early_window.loc[early_window["instrument"].astype(str) == instrument]
        if pair_fit.empty or pair_early.empty:
            raise ValueError(f"direct-net split lacks pair evidence for {instrument}")

        pair_models: dict[str, _RegressorLike] = {}
        for side, return_column in (
            ("long", LONG_NET_RETURN_COLUMN),
            ("short", SHORT_NET_RETURN_COLUMN),
        ):
            fit_target = (
                pd.to_numeric(pair_fit[return_column], errors="raise").to_numpy(dtype=float)
                * 10_000.0
            )
            early_target = (
                pd.to_numeric(pair_early[return_column], errors="raise").to_numpy(dtype=float)
                * 10_000.0
            )
            if not np.isfinite(fit_target).all() or not np.isfinite(early_target).all():
                raise ValueError(f"non-finite direct-net target for {instrument}::{side}")

            model = _make_direct_net_regressor(
                instrument=instrument,
                side=side,
                horizon_bars=horizon_bars,
            )
            model.fit(
                pair_fit[feature_columns],
                fit_target,
                eval_set=[(pair_early[feature_columns], early_target)],
                verbose=False,
            )
            key = f"{instrument}::{side}"
            models[key] = model
            pair_models[side] = model

        early_long = np.asarray(
            pair_models["long"].predict(pair_early[feature_columns]),
            dtype=float,
        )
        early_short = np.asarray(
            pair_models["short"].predict(pair_early[feature_columns]),
            dtype=float,
        )
        if not np.isfinite(early_long).all() or not np.isfinite(early_short).all():
            raise ValueError(f"non-finite direct-net calibration predictions for {instrument}")

        predicted_long = early_long >= early_short
        predicted_best = np.maximum(early_long, early_short)
        realized_long = (
            pd.to_numeric(pair_early[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(dtype=float)
            * 10_000.0
        )
        realized_short = (
            pd.to_numeric(pair_early[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(dtype=float)
            * 10_000.0
        )
        realized_selected = np.where(predicted_long, realized_long, realized_short)
        calibration = select_density_budgeted_threshold(
            predicted_best,
            predicted_long,
            realized_selected,
        )
        calibrations[instrument] = calibration
        pair_counts[instrument] = {
            "fit_rows": int(len(pair_fit)),
            "early_rows": int(len(pair_early)),
            "calibration_reason": calibration.reason,
            "calibration_passed": calibration.passed,
        }

    return models, calibrations, {
        "pair_count": len(instruments),
        "fit_rows": int(len(fit_window)),
        "early_rows": int(len(early_window)),
        "pairs": pair_counts,
    }


def route_pair_direct_net_predictions(
    frame: pd.DataFrame,
    *,
    models: dict[str, _RegressorLike],
    calibrations: dict[str, DirectNetCalibration],
    feature_columns: list[str],
) -> pd.DataFrame:
    """Route rows to exact pair experts and emit BUY, SELL or ABSTAIN."""

    if "instrument" not in frame.columns:
        raise ValueError("direct-net prediction frame requires instrument")
    missing_features = [column for column in feature_columns if column not in frame.columns]
    if missing_features:
        raise ValueError(f"direct-net prediction frame missing features: {missing_features}")

    count = len(frame)
    long_prediction = np.full(count, np.nan, dtype=float)
    short_prediction = np.full(count, np.nan, dtype=float)
    threshold = np.full(count, np.nan, dtype=float)
    active_trade = np.zeros(count, dtype=bool)
    action = np.full(count, "ABSTAIN", dtype=object)
    instruments = frame["instrument"].astype(str).to_numpy()

    for instrument in pd.unique(instruments):
        pair_positions = np.flatnonzero(instruments == instrument)
        pair_frame = frame.iloc[pair_positions]
        calibration = calibrations.get(instrument)
        if calibration is None:
            raise ValueError(f"missing direct-net calibration {instrument}")

        pair_predictions: dict[str, np.ndarray] = {}
        for side in ("long", "short"):
            key = f"{instrument}::{side}"
            model = models.get(key)
            if model is None:
                raise ValueError(f"missing direct-net expert {key}")
            values = np.asarray(model.predict(pair_frame[feature_columns]), dtype=float)
            if values.shape != (len(pair_frame),) or not np.isfinite(values).all():
                raise ValueError(f"invalid direct-net predictions from {key}")
            pair_predictions[side] = values

        pair_long = pair_predictions["long"]
        pair_short = pair_predictions["short"]
        long_prediction[pair_positions] = pair_long
        short_prediction[pair_positions] = pair_short

        if not calibration.passed or calibration.threshold_bps is None:
            continue

        pair_threshold = float(calibration.threshold_bps)
        threshold[pair_positions] = pair_threshold
        predicted_long = pair_long >= pair_short
        predicted_best = np.maximum(pair_long, pair_short)
        pair_active = predicted_best >= pair_threshold
        active_trade[pair_positions] = pair_active
        pair_action = np.where(predicted_long, "BUY", "SELL")
        action[pair_positions] = np.where(pair_active, pair_action, "ABSTAIN")

    result = frame.copy()
    result["predicted_long_net_bps"] = long_prediction
    result["predicted_short_net_bps"] = short_prediction
    result["predicted_best_net_bps"] = np.maximum(long_prediction, short_prediction)
    result["activation_threshold_bps"] = threshold
    result["active_trade"] = active_trade
    result["action"] = action
    return result
