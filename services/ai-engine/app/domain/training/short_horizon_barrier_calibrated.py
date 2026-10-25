from __future__ import annotations

import argparse
import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score
from xgboost import XGBClassifier

from app.domain.models.multitimeframe_features import (
    INITIAL_FOREX_UNIVERSE,
    MULTITIMEFRAME_FEATURE_COLUMNS,
)
from app.domain.training.train_multitimeframe import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
    load_and_prepare_corpora,
)
from app.domain.training.validation import (
    compute_backtest_metrics,
    iter_purged_walk_forward_time_splits,
)

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


@dataclass(frozen=True)
class BarrierPairExperts:
    instrument: str
    long_model: Any
    short_model: Any
    feature_columns: tuple[str, ...]
    calibration: BarrierPairCalibration


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


def _with_side_targets(frame: pd.DataFrame) -> pd.DataFrame:
    required = {EVENT_ACTIONABLE_TARGET_COLUMN, EVENT_DIRECTION_TARGET_COLUMN}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"barrier experts require event labels: {missing}")
    result = frame.copy()
    actionable = pd.to_numeric(result[EVENT_ACTIONABLE_TARGET_COLUMN], errors="raise").astype(int)
    direction = pd.to_numeric(result[EVENT_DIRECTION_TARGET_COLUMN], errors="raise").astype(int)
    if not actionable.isin((0, 1)).all() or not direction.isin((0, 1)).all():
        raise ValueError("barrier experts require binary event labels")
    result["barrier_long_target"] = ((actionable == 1) & (direction == 1)).astype(int)
    result["barrier_short_target"] = ((actionable == 1) & (direction == 0)).astype(int)
    return result


def _binary_class_weights(labels: pd.Series) -> np.ndarray:
    values = pd.to_numeric(labels, errors="raise").to_numpy(dtype=int)
    if not np.isin(values, [0, 1]).all():
        raise ValueError("barrier expert targets must be binary")
    counts = np.bincount(values, minlength=2).astype(float)
    if (counts <= 0).any():
        raise ValueError("barrier expert fitting requires both classes")
    total = float(len(values))
    per_class = np.sqrt(total / (2.0 * counts))
    weights = np.clip(per_class[values], 0.5, 2.0)
    return (weights / float(weights.mean())).astype(float)


def _barrier_classifier(side: str) -> XGBClassifier:
    return XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        n_estimators=600,
        learning_rate=0.025,
        max_depth=4,
        min_child_weight=3.0,
        subsample=0.85,
        colsample_bytree=0.80,
        reg_alpha=0.05,
        reg_lambda=1.2,
        random_state=47 if side == "long" else 53,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=50,
    )


def _positive_probability(model: Any, features: pd.DataFrame) -> np.ndarray:
    probabilities = np.asarray(model.predict_proba(features), dtype=float)
    if probabilities.ndim != 2 or probabilities.shape != (len(features), 2):
        raise ValueError("barrier expert predict_proba must return Nx2 probabilities")
    positive = probabilities[:, 1]
    if not np.isfinite(positive).all() or ((positive < 0.0) | (positive > 1.0)).any():
        raise ValueError("barrier expert probabilities must be finite in [0, 1]")
    return positive


def fit_pair_barrier_experts(
    training_frame: pd.DataFrame,
    calibration_frame: pd.DataFrame,
    *,
    instrument: str,
    horizon_bars: int,
    feature_columns: tuple[str, ...] = tuple(MULTITIMEFRAME_FEATURE_COLUMNS),
    model_factory: Callable[[str], Any] | None = None,
) -> BarrierPairExperts:
    """Fit exact-pair LONG/SHORT actionability experts and train-only calibration."""
    pair = instrument.strip().upper()
    if not pair:
        raise ValueError("instrument is required")
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")
    if "instrument" not in training_frame or "instrument" not in calibration_frame:
        raise ValueError("barrier expert frames require instrument identity")

    train = training_frame.loc[
        training_frame["instrument"].astype(str).str.upper() == pair
    ].copy()
    calibration = calibration_frame.loc[
        calibration_frame["instrument"].astype(str).str.upper() == pair
    ].copy()
    if train.empty or calibration.empty:
        raise ValueError(f"missing exact-pair train/calibration rows for {pair}")
    missing_features = [column for column in feature_columns if column not in train.columns]
    missing_features += [
        column for column in feature_columns if column not in calibration.columns and column not in missing_features
    ]
    if missing_features:
        raise ValueError(f"barrier expert frame missing features: {missing_features}")
    for column in (EVENT_LONG_NET_RETURN_COLUMN, EVENT_SHORT_NET_RETURN_COLUMN):
        if column not in calibration.columns:
            raise ValueError(f"barrier calibration frame missing {column}")

    labeled = _with_side_targets(train)
    fit, early = _split_internal_early_stopping_tail(labeled, horizon_bars=horizon_bars)
    models: dict[str, Any] = {}
    factory = model_factory or _barrier_classifier
    for side, target_column in (
        ("long", "barrier_long_target"),
        ("short", "barrier_short_target"),
    ):
        if fit[target_column].nunique() < 2 or early[target_column].nunique() < 2:
            raise ValueError(f"{pair} {side} barrier expert requires both classes")
        model = factory(side)
        model.fit(
            fit[list(feature_columns)],
            fit[target_column].astype(int),
            sample_weight=_binary_class_weights(fit[target_column]),
            eval_set=[(early[list(feature_columns)], early[target_column].astype(int))],
            sample_weight_eval_set=[_binary_class_weights(early[target_column])],
            verbose=False,
        )
        models[side] = model

    long_probability = _positive_probability(models["long"], calibration[list(feature_columns)])
    short_probability = _positive_probability(models["short"], calibration[list(feature_columns)])
    pair_calibration = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        pd.to_numeric(calibration[EVENT_LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
        * 10_000.0,
        pd.to_numeric(calibration[EVENT_SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
        * 10_000.0,
    )
    return BarrierPairExperts(
        instrument=pair,
        long_model=models["long"],
        short_model=models["short"],
        feature_columns=feature_columns,
        calibration=pair_calibration,
    )


def route_pair_barrier_predictions(
    frame: pd.DataFrame,
    experts_by_instrument: Mapping[str, BarrierPairExperts],
) -> pd.DataFrame:
    """Route every row only through its exact pair expert/calibration or ABSTAIN."""
    if "instrument" not in frame.columns:
        raise ValueError("barrier routing requires instrument identity")
    result = frame.copy()
    result["long_probability"] = np.nan
    result["short_probability"] = np.nan
    result["winning_probability"] = np.nan
    result["probability_margin"] = np.nan
    result["predicted_long"] = False
    result["active_trade"] = False
    result["action"] = "ABSTAIN"
    result["route_reason"] = "MISSING_PAIR_EXPERT"

    canonical_experts = {key.upper(): value for key, value in experts_by_instrument.items()}
    canonical_instrument = result["instrument"].astype(str).str.upper()
    for instrument in canonical_instrument.unique():
        index = result.index[canonical_instrument == instrument]
        expert = canonical_experts.get(instrument)
        if expert is None or expert.instrument.upper() != instrument:
            continue
        calibration = expert.calibration
        if (
            not calibration.passed
            or calibration.min_probability is None
            or calibration.min_margin is None
        ):
            result.loc[index, "route_reason"] = "PAIR_CALIBRATION_FAILED"
            continue
        missing = [column for column in expert.feature_columns if column not in result.columns]
        if missing:
            result.loc[index, "route_reason"] = "MISSING_PAIR_FEATURES"
            continue

        features = result.loc[index, list(expert.feature_columns)]
        long_probability = _positive_probability(expert.long_model, features)
        short_probability = _positive_probability(expert.short_model, features)
        predicted_long = long_probability > short_probability
        winning_probability = np.maximum(long_probability, short_probability)
        margin = np.round(np.abs(long_probability - short_probability), 12)
        probability_pass = winning_probability >= calibration.min_probability
        margin_pass = margin >= calibration.min_margin
        active = probability_pass & margin_pass

        result.loc[index, "long_probability"] = long_probability
        result.loc[index, "short_probability"] = short_probability
        result.loc[index, "winning_probability"] = winning_probability
        result.loc[index, "probability_margin"] = margin
        result.loc[index, "predicted_long"] = predicted_long
        result.loc[index, "active_trade"] = active
        result.loc[index, "action"] = np.where(
            active,
            np.where(predicted_long, "BUY", "SELL"),
            "ABSTAIN",
        )
        reason = np.where(
            ~probability_pass,
            "CALIBRATED_PROBABILITY_NOT_MET",
            np.where(~margin_pass, "CALIBRATED_MARGIN_NOT_MET", "CALIBRATED_PAIR_SIGNAL"),
        )
        result.loc[index, "route_reason"] = reason

    return result


PARTICIPATION_TARGETS_PER_DAY = {5: 24.0, 20: 12.0, 60: 6.0}


def _split_barrier_train_calibration(
    training_window: pd.DataFrame,
    *,
    horizon_bars: int,
    calibration_fraction: float = 0.20,
    minimum_calibration_periods: int = 200,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split outer-train rows into model-training and train-only calibration tails.

    A full horizon-sized gap separates the two sets, so labels used by the fit
    portion cannot cross into the calibration window.
    """
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")
    if not 0.0 < calibration_fraction < 0.5:
        raise ValueError("calibration_fraction must be in (0, 0.5)")
    if minimum_calibration_periods < 1:
        raise ValueError("minimum_calibration_periods must be positive")
    if "decision_time" not in training_window.columns:
        raise ValueError("barrier calibration split requires decision_time")

    times = pd.Series(
        pd.to_datetime(training_window["decision_time"], utc=True, errors="coerce")
    )
    if times.isna().any():
        raise ValueError("barrier calibration split contains invalid decision_time")
    unique_times = pd.Index(times.drop_duplicates().sort_values())
    requested = max(minimum_calibration_periods, int(len(unique_times) * calibration_fraction))
    max_calibration = len(unique_times) - horizon_bars - 50
    calibration_periods = min(requested, max_calibration)
    if calibration_periods < 50:
        raise ValueError("outer training window is too small for barrier calibration")

    calibration_start = len(unique_times) - calibration_periods
    fit_end = calibration_start - horizon_bars
    if fit_end < 50:
        raise ValueError("outer training window is too small after barrier purge")

    fit_last = unique_times[fit_end - 1]
    calibration_first = unique_times[calibration_start]
    fit = training_window.loc[times <= fit_last].copy()
    calibration = training_window.loc[times >= calibration_first].copy()
    if fit.empty or calibration.empty:
        raise ValueError("barrier train/calibration split produced an empty frame")
    return fit, calibration


def collapse_non_overlapping_barrier_signals(
    signals: pd.DataFrame,
    *,
    horizon_bars: int,
) -> pd.DataFrame:
    """Collapse simultaneous pair signals and overlapping holding windows."""
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")
    required = {"decision_time", "active_trade", "selected_net_return"}
    missing = sorted(required.difference(signals.columns))
    if missing:
        raise ValueError(f"barrier signal collapse requires columns: {missing}")
    active = signals.loc[signals["active_trade"].astype(bool)].copy()
    if active.empty:
        return pd.DataFrame(
            columns=["decision_time", "portfolio_net_return", "signal_count"]
        )
    active["decision_time"] = pd.to_datetime(
        active["decision_time"], utc=True, errors="raise"
    )
    active["selected_net_return"] = pd.to_numeric(
        active["selected_net_return"], errors="raise"
    )
    grouped = (
        active.groupby("decision_time", sort=True)["selected_net_return"]
        .agg(portfolio_net_return="mean", signal_count="size")
        .reset_index()
        .sort_values("decision_time")
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


def _attach_selected_barrier_return(routed: pd.DataFrame) -> pd.DataFrame:
    result = routed.copy()
    required = {EVENT_LONG_NET_RETURN_COLUMN, EVENT_SHORT_NET_RETURN_COLUMN}
    missing = sorted(required.difference(result.columns))
    if missing:
        raise ValueError(f"barrier routed frame missing realised returns: {missing}")
    long_return = pd.to_numeric(result[EVENT_LONG_NET_RETURN_COLUMN], errors="raise")
    short_return = pd.to_numeric(result[EVENT_SHORT_NET_RETURN_COLUMN], errors="raise")
    action = result["action"].astype(str)
    result["selected_net_return"] = np.where(
        action == "BUY",
        long_return,
        np.where(action == "SELL", short_return, 0.0),
    )
    return result


def _barrier_metrics(periods: pd.DataFrame, *, horizon_bars: int) -> dict[str, Any]:
    if periods.empty:
        return {
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
    returns = periods["portfolio_net_return"].to_numpy(dtype=float)
    periods_per_year = (365.25 * 24.0 * 60.0) / float(horizon_bars)
    return compute_backtest_metrics(returns, annualization_factor=periods_per_year)


def _active_balanced_accuracy(predictions: pd.DataFrame) -> float | None:
    active = predictions.loc[predictions["active_trade"].astype(bool)].copy()
    if active.empty or EVENT_DIRECTION_TARGET_COLUMN not in active.columns:
        return None
    truth = pd.to_numeric(active[EVENT_DIRECTION_TARGET_COLUMN], errors="raise").to_numpy(int)
    predicted = active["predicted_long"].astype(bool).to_numpy(dtype=int)
    if len(np.unique(truth)) < 2:
        return None
    return float(balanced_accuracy_score(truth, predicted))


def evaluate_barrier_calibrated_frame(
    frame: pd.DataFrame,
    *,
    horizon_bars: int,
    min_train_periods: int,
    validation_periods: int,
    max_splits: int = 3,
    expert_fitter: Callable[..., BarrierPairExperts] = fit_pair_barrier_experts,
    router: Callable[[pd.DataFrame, Mapping[str, BarrierPairExperts]], pd.DataFrame] = (
        route_pair_barrier_predictions
    ),
) -> dict[str, Any]:
    """Evaluate v5 with expanding horizon-purged walk-forward validation."""
    if horizon_bars not in PARTICIPATION_TARGETS_PER_DAY:
        raise ValueError("barrier evaluator horizon must be one of 5/20/60 minutes")
    required = {
        "decision_time",
        "instrument",
        EVENT_ACTIONABLE_TARGET_COLUMN,
        EVENT_DIRECTION_TARGET_COLUMN,
        EVENT_LONG_NET_RETURN_COLUMN,
        EVENT_SHORT_NET_RETURN_COLUMN,
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"barrier evaluator missing columns: {missing}")
    dataset = frame.copy()
    dataset["decision_time"] = pd.to_datetime(
        dataset["decision_time"], utc=True, errors="raise"
    )
    observed_pairs = set(dataset["instrument"].astype(str).str.upper().unique())
    expected_pairs = set(INITIAL_FOREX_UNIVERSE)
    if observed_pairs != expected_pairs:
        raise ValueError(
            f"barrier evaluator requires exact six-pair universe; got {sorted(observed_pairs)}"
        )
    dataset = dataset.sort_values(["decision_time", "instrument"]).reset_index(drop=True)

    folds: list[dict[str, Any]] = []
    predictions: list[pd.DataFrame] = []
    for fold_index, (outer_train, validation) in enumerate(
        iter_purged_walk_forward_time_splits(
            dataset,
            time_column="decision_time",
            min_train_periods=min_train_periods,
            validation_periods=validation_periods,
            purge_periods=horizon_bars,
            embargo_periods=horizon_bars,
            max_splits=max_splits,
        ),
        start=1,
    ):
        model_train, calibration = _split_barrier_train_calibration(
            outer_train,
            horizon_bars=horizon_bars,
        )
        experts: dict[str, BarrierPairExperts] = {}
        for instrument in INITIAL_FOREX_UNIVERSE:
            experts[instrument] = expert_fitter(
                model_train,
                calibration,
                instrument=instrument,
                horizon_bars=horizon_bars,
            )
        routed = router(validation.copy(), experts)
        if "active_trade" not in routed or "predicted_long" not in routed or "action" not in routed:
            raise ValueError("barrier router omitted required execution columns")
        routed = _attach_selected_barrier_return(routed)
        routed["fold"] = fold_index
        fold_periods = collapse_non_overlapping_barrier_signals(
            routed,
            horizon_bars=horizon_bars,
        )
        fold_metrics = _barrier_metrics(fold_periods, horizon_bars=horizon_bars)
        folds.append(
            {
                "fold": fold_index,
                "train_start": pd.Timestamp(outer_train["decision_time"].min()).isoformat(),
                "train_end": pd.Timestamp(outer_train["decision_time"].max()).isoformat(),
                "calibration_start": pd.Timestamp(calibration["decision_time"].min()).isoformat(),
                "calibration_end": pd.Timestamp(calibration["decision_time"].max()).isoformat(),
                "validation_start": pd.Timestamp(validation["decision_time"].min()).isoformat(),
                "validation_end": pd.Timestamp(validation["decision_time"].max()).isoformat(),
                "active_signals": int(routed["active_trade"].sum()),
                "non_overlapping_opportunities": int(len(fold_periods)),
                "total_return": float(fold_metrics["total_return"]),
            }
        )
        predictions.append(routed)

    all_predictions = pd.concat(predictions, ignore_index=True)
    periods = collapse_non_overlapping_barrier_signals(
        all_predictions,
        horizon_bars=horizon_bars,
    )
    metrics = _barrier_metrics(periods, horizon_bars=horizon_bars)
    validation_days = int(
        all_predictions["decision_time"].dt.normalize().drop_duplicates().shape[0]
    )
    opportunities_per_day = float(len(periods) / max(validation_days, 1))
    target_per_day = PARTICIPATION_TARGETS_PER_DAY[horizon_bars]
    balanced_accuracy = _active_balanced_accuracy(all_predictions)

    instrument_positive: dict[str, bool] = {}
    for instrument, group in all_predictions.groupby("instrument", sort=True):
        selected = group.loc[group["active_trade"].astype(bool), "selected_net_return"]
        instrument_positive[str(instrument)] = bool(len(selected) and float(selected.sum()) > 0.0)
    positive_instrument_fraction = float(
        sum(instrument_positive.values()) / len(INITIAL_FOREX_UNIVERSE)
    )
    positive_fold_fraction = float(
        sum(float(fold["total_return"]) > 0.0 for fold in folds) / len(folds)
    )

    profit_factor = metrics["profit_factor"]
    sharpe = metrics["sharpe_ratio"]
    max_drawdown = float(metrics["max_drawdown"])
    gates = {
        "participation": opportunities_per_day >= target_per_day,
        "balanced_accuracy": balanced_accuracy is not None and balanced_accuracy >= 0.52,
        "profit_factor": profit_factor is not None and float(profit_factor) >= 1.15,
        "sharpe": sharpe is not None and float(sharpe) >= 1.0,
        "max_drawdown": max_drawdown <= 0.12,
        "positive_fold_fraction": positive_fold_fraction >= 0.60,
        "positive_instrument_fraction": positive_instrument_fraction >= 0.67,
    }
    return {
        "candidate": "short-horizon-barrier-calibrated-v5",
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_demo": False,
        "approved_for_live": False,
        "horizon_minutes": horizon_bars,
        "protocol": {
            "purge_periods": horizon_bars,
            "embargo_periods": horizon_bars,
            "inner_calibration_train_only": True,
            "pair_specific_experts": True,
            "cross_pair_fallback": False,
            "non_overlapping_portfolio_counting": True,
        },
        "folds": folds,
        "classification": {"balanced_accuracy": balanced_accuracy},
        "trading": metrics,
        "participation": {
            "raw_active_signals": int(all_predictions["active_trade"].sum()),
            "non_overlapping_opportunities": int(len(periods)),
            "validation_days": validation_days,
            "opportunities_per_validation_day": opportunities_per_day,
            "target_per_validation_day": target_per_day,
        },
        "robustness": {
            "positive_fold_fraction": positive_fold_fraction,
            "positive_instrument_fraction": positive_instrument_fraction,
            "instrument_positive": instrument_positive,
        },
        "gates": gates,
        "research_gate_passed": all(gates.values()),
    }


def evaluate_barrier_calibrated_corpora(
    datasets: Mapping[str, str | Path],
    *,
    horizon_bars: int,
    report_path: str | Path,
    min_train_periods: int | None = None,
    validation_periods: int = 7200,
    max_splits: int = 1,
    decision_time_before: str | pd.Timestamp | None = None,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
) -> dict[str, Any]:
    """Load the exact six-pair corpus, evaluate v5, and atomically persist JSON."""
    normalized = {str(key).upper(): value for key, value in datasets.items()}
    expected = set(INITIAL_FOREX_UNIVERSE)
    if set(normalized) != expected:
        raise ValueError(
            f"barrier corpus evaluation requires exact six-pair universe; got {sorted(normalized)}"
        )
    pooled, hashes = load_and_prepare_corpora(
        normalized,
        horizon_bars=horizon_bars,
        commission_bps=commission_bps,
        slippage_bps=slippage_bps,
        decision_time_before=decision_time_before,
    )
    unique_periods = int(pooled["decision_time"].nunique())
    train_periods = min_train_periods or max(1000, int(unique_periods * 0.70))
    if train_periods + horizon_bars + validation_periods > unique_periods:
        validation_periods = max(200, unique_periods - train_periods - horizon_bars)
    report = evaluate_barrier_calibrated_frame(
        pooled,
        horizon_bars=horizon_bars,
        min_train_periods=train_periods,
        validation_periods=validation_periods,
        max_splits=max_splits,
    )
    report["dataset_sha256"] = hashes
    report["decision_time_before"] = (
        pd.Timestamp(decision_time_before).isoformat()
        if decision_time_before is not None
        else None
    )
    report["cost_model"] = {
        "commission_bps_round_trip": float(commission_bps),
        "slippage_bps_round_trip": float(slippage_bps),
        "historical_spread": "half spread at entry + half spread at exit",
    }
    output = Path(report_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
    temporary.replace(output)
    return {**report, "report_path": str(output)}


def _parse_dataset_args(values: list[str]) -> dict[str, str]:
    datasets: dict[str, str] = {}
    for value in values:
        instrument, separator, raw_path = value.partition("=")
        instrument = instrument.strip().upper()
        if not separator or not instrument or not raw_path.strip():
            raise ValueError("--dataset must use INSTRUMENT=/path/to/corpus.csv")
        if instrument in datasets:
            raise ValueError(f"duplicate dataset for {instrument}")
        datasets[instrument] = raw_path.strip()
    return datasets


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate pair-specific short-horizon barrier-calibrated v5 research"
    )
    parser.add_argument("--dataset", action="append", required=True)
    parser.add_argument("--horizon-bars", type=int, choices=(5, 20, 60), required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--min-train-periods", type=int)
    parser.add_argument("--validation-periods", type=int, default=7200)
    parser.add_argument("--max-splits", type=int, default=1)
    parser.add_argument("--decision-time-before")
    parser.add_argument("--commission-bps", type=float, default=0.0)
    parser.add_argument("--slippage-bps", type=float, default=0.0)
    args = parser.parse_args()

    report = evaluate_barrier_calibrated_corpora(
        _parse_dataset_args(args.dataset),
        horizon_bars=args.horizon_bars,
        report_path=args.report,
        min_train_periods=args.min_train_periods,
        validation_periods=args.validation_periods,
        max_splits=args.max_splits,
        decision_time_before=args.decision_time_before,
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
    )
    print(json.dumps(report, indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
