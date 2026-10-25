"""Research-only direct expected-net-return short-horizon challenger."""

from __future__ import annotations

import zlib
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score
from xgboost import XGBRegressor

from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
    TARGET_COLUMN,
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
)
from app.domain.training.validation import (
    compute_backtest_metrics,
    iter_purged_walk_forward_time_splits,
)

DIRECT_NET_HORIZONS = (5, 20, 60)
DIRECT_NET_INSTRUMENTS = (
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "AUDUSD",
    "USDCAD",
    "USDCHF",
)
PARTICIPATION_TARGETS_PER_DAY = {5: 24.0, 20: 12.0, 60: 6.0}
LOCKED_RESEARCH_GATE = {
    "balanced_accuracy": 0.52,
    "sharpe_ratio": 1.0,
    "profit_factor": 1.15,
    "max_drawdown": 0.12,
    "positive_fold_fraction": 0.60,
    "positive_instrument_fraction": 0.67,
}
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


def _with_realized_selected_returns(predictions: pd.DataFrame) -> pd.DataFrame:
    result = predictions.copy()
    long_returns = pd.to_numeric(result[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(
        dtype=float
    )
    short_returns = pd.to_numeric(
        result[SHORT_NET_RETURN_COLUMN], errors="raise"
    ).to_numpy(dtype=float)
    action = result["action"].astype(str).to_numpy()
    selected = np.where(action == "BUY", long_returns, np.where(action == "SELL", short_returns, 0.0))
    if not np.isfinite(selected).all():
        raise ValueError("direct-net validation produced non-finite selected returns")
    result["selected_net_return"] = selected
    return result


def _non_overlapping_direct_net_periods(
    predictions: pd.DataFrame,
    *,
    horizon_bars: int,
) -> pd.DataFrame:
    active = predictions.loc[predictions["active_trade"].astype(bool)].copy()
    if active.empty:
        return pd.DataFrame(
            columns=["decision_time", "portfolio_net_return", "signal_count"]
        )
    active["decision_time"] = pd.to_datetime(
        active["decision_time"], utc=True, errors="raise"
    )
    grouped = (
        active.groupby("decision_time", sort=True)["selected_net_return"]
        .agg(portfolio_net_return="mean", signal_count="size")
        .reset_index()
        .sort_values("decision_time")
        .reset_index(drop=True)
    )
    accepted: list[dict[str, Any]] = []
    next_available: pd.Timestamp | None = None
    holding_period = pd.Timedelta(minutes=horizon_bars)
    for row in grouped.itertuples(index=False):
        decision_time = pd.Timestamp(row.decision_time)
        if next_available is not None and decision_time < next_available:
            continue
        accepted.append(
            {
                "decision_time": decision_time,
                "portfolio_net_return": float(row.portfolio_net_return),
                "signal_count": int(row.signal_count),
            }
        )
        next_available = decision_time + holding_period
    return pd.DataFrame.from_records(accepted)


def _direct_net_summary(
    predictions: pd.DataFrame,
    *,
    horizon_bars: int,
) -> dict[str, Any]:
    predictions = _with_realized_selected_returns(predictions)
    active = predictions.loc[predictions["active_trade"].astype(bool)]
    periods = _non_overlapping_direct_net_periods(predictions, horizon_bars=horizon_bars)

    if active.empty:
        balanced_accuracy = 0.0
    else:
        true_direction = pd.to_numeric(active[TARGET_COLUMN], errors="raise").to_numpy(dtype=int)
        predicted_direction = (active["action"].astype(str).to_numpy() == "BUY").astype(int)
        balanced_accuracy = (
            float(balanced_accuracy_score(true_direction, predicted_direction))
            if len(np.unique(true_direction)) == 2
            else 0.0
        )

    if periods.empty:
        trading = {
            "trade_or_period_count": 0,
            "total_return": 0.0,
            "average_net_return": 0.0,
            "median_net_return": 0.0,
            "win_rate": 0.0,
            "profit_factor": None,
            "sharpe_ratio": None,
            "sortino_ratio": None,
            "max_drawdown": 0.0,
        }
        mean_interval = None
        median_interval = None
    else:
        returns = periods["portfolio_net_return"].to_numpy(dtype=float)
        start = pd.Timestamp(periods["decision_time"].min())
        end = pd.Timestamp(periods["decision_time"].max())
        span_years = max(
            (end - start).total_seconds() / (365.25 * 24 * 3600),
            1.0 / 365.25,
        )
        periods_per_year = max(float(len(periods)) / span_years, 1.0)
        trading = compute_backtest_metrics(
            returns,
            annualization_factor=periods_per_year,
        )
        interval_minutes = (
            periods["decision_time"].sort_values().diff().dropna().dt.total_seconds() / 60.0
        )
        mean_interval = float(interval_minutes.mean()) if len(interval_minutes) else None
        median_interval = float(interval_minutes.median()) if len(interval_minutes) else None

    decision_times = pd.to_datetime(predictions["decision_time"], utc=True, errors="raise")
    validation_days = max(int(pd.Series(decision_times.dt.normalize()).nunique()), 1)
    opportunities_per_day = float(len(periods)) / validation_days
    return {
        "classification": {
            "balanced_accuracy": balanced_accuracy,
            "active_sample_count": int(len(active)),
        },
        "trading": trading,
        "active_signals": int(predictions["active_trade"].astype(bool).sum()),
        "non_overlapping_opportunities": int(len(periods)),
        "validation_days": validation_days,
        "opportunities_per_validation_day": opportunities_per_day,
        "mean_minutes_between_entries": mean_interval,
        "median_minutes_between_entries": median_interval,
    }


def _direct_net_research_gate(
    *,
    overall: dict[str, Any],
    positive_fold_fraction: float,
    positive_instrument_fraction: float,
    participation_target: float,
) -> dict[str, Any]:
    classification = overall["classification"]
    trading = overall["trading"]
    profit_factor = trading.get("profit_factor")
    sharpe = trading.get("sharpe_ratio")
    checks = {
        "balanced_accuracy": float(classification["balanced_accuracy"])
        >= LOCKED_RESEARCH_GATE["balanced_accuracy"],
        "profit_factor": profit_factor is not None
        and float(profit_factor) >= LOCKED_RESEARCH_GATE["profit_factor"],
        "sharpe_ratio": sharpe is not None
        and float(sharpe) >= LOCKED_RESEARCH_GATE["sharpe_ratio"],
        "max_drawdown": float(trading["max_drawdown"])
        <= LOCKED_RESEARCH_GATE["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction
        >= LOCKED_RESEARCH_GATE["positive_fold_fraction"],
        "positive_instrument_fraction": positive_instrument_fraction
        >= LOCKED_RESEARCH_GATE["positive_instrument_fraction"],
        "participation": float(overall["opportunities_per_validation_day"])
        >= participation_target,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "locked_thresholds": dict(LOCKED_RESEARCH_GATE),
        "participation_target_per_day": participation_target,
    }


def evaluate_direct_net_frame(
    dataset: pd.DataFrame,
    *,
    horizon_bars: int,
    feature_columns: list[str],
    min_train_periods: int | None = None,
    validation_periods: int | None = None,
    max_splits: int | None = 5,
) -> dict[str, Any]:
    """Purged outer walk-forward evaluation for the research-only direct-net family."""

    if horizon_bars not in DIRECT_NET_HORIZONS:
        raise ValueError(f"unsupported direct-net horizon: {horizon_bars}")
    required_columns = {
        "decision_time",
        "instrument",
        TARGET_COLUMN,
        LONG_NET_RETURN_COLUMN,
        SHORT_NET_RETURN_COLUMN,
        *feature_columns,
    }
    missing = sorted(required_columns.difference(dataset.columns))
    if missing:
        raise ValueError(f"direct-net evaluation frame missing columns: {missing}")

    frame = dataset.copy()
    frame["decision_time"] = pd.to_datetime(frame["decision_time"], utc=True, errors="raise")
    instruments = set(frame["instrument"].astype(str).unique())
    if instruments != set(DIRECT_NET_INSTRUMENTS):
        raise ValueError("direct-net evaluation requires complete six-pair universe")

    unique_periods = int(frame["decision_time"].nunique())
    resolved_min_train = (
        min_train_periods
        if min_train_periods is not None
        else max(250, int(unique_periods * 0.60))
    )
    resolved_validation = (
        validation_periods
        if validation_periods is not None
        else max(100, int(unique_periods * 0.07))
    )

    folds: list[dict[str, Any]] = []
    fold_predictions: list[pd.DataFrame] = []
    for fold_index, (training_window, validation_window) in enumerate(
        iter_purged_walk_forward_time_splits(
            frame,
            time_column="decision_time",
            min_train_periods=resolved_min_train,
            validation_periods=resolved_validation,
            purge_periods=horizon_bars,
            embargo_periods=horizon_bars,
            max_splits=max_splits,
        ),
        start=1,
    ):
        models, calibrations, fit_metadata = fit_pair_direct_net_experts(
            training_window,
            horizon_bars=horizon_bars,
            feature_columns=feature_columns,
        )
        validation_window.attrs["outer_train_last"] = training_window["decision_time"].max()
        predictions = route_pair_direct_net_predictions(
            validation_window,
            models=models,
            calibrations=calibrations,
            feature_columns=feature_columns,
        )
        predictions = _with_realized_selected_returns(predictions)
        summary = _direct_net_summary(predictions, horizon_bars=horizon_bars)
        folds.append(
            {
                "fold": fold_index,
                "train_last": training_window["decision_time"].max().isoformat(),
                "validation_first": validation_window["decision_time"].min().isoformat(),
                "validation_last": validation_window["decision_time"].max().isoformat(),
                "fit": fit_metadata,
                "summary": summary,
            }
        )
        fold_predictions.append(predictions)

    combined = pd.concat(fold_predictions, ignore_index=True)
    overall = _direct_net_summary(combined, horizon_bars=horizon_bars)
    by_instrument = {
        instrument: _direct_net_summary(group, horizon_bars=horizon_bars)
        for instrument, group in combined.groupby("instrument", sort=True)
    }
    positive_fold_fraction = float(
        np.mean([float(fold["summary"]["trading"]["total_return"]) > 0.0 for fold in folds])
    )
    positive_instrument_fraction = float(
        np.mean(
            [
                float(summary["trading"]["total_return"]) > 0.0
                for summary in by_instrument.values()
            ]
        )
    )
    participation_target = PARTICIPATION_TARGETS_PER_DAY[horizon_bars]
    research_gate = _direct_net_research_gate(
        overall=overall,
        positive_fold_fraction=positive_fold_fraction,
        positive_instrument_fraction=positive_instrument_fraction,
        participation_target=participation_target,
    )
    return {
        "artifact": "short-horizon-direct-net-v4",
        "horizon_bars": horizon_bars,
        "fold_count": len(folds),
        "purge_periods": horizon_bars,
        "embargo_periods": horizon_bars,
        "min_train_periods": resolved_min_train,
        "validation_periods": resolved_validation,
        "participation_target_per_day": participation_target,
        "folds": folds,
        "overall": overall,
        "by_instrument": by_instrument,
        "positive_fold_fraction": positive_fold_fraction,
        "positive_instrument_fraction": positive_instrument_fraction,
        "research_gate": research_gate,
        "governance": {
            "approved_for_paper": False,
            "approved_for_demo": False,
            "approved_for_live": False,
            "research_only": True,
        },
    }
