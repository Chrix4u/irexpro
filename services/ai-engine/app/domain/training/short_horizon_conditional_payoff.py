from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.models.multitimeframe_features import (
    INITIAL_FOREX_UNIVERSE,
    MULTITIMEFRAME_FEATURE_COLUMNS,
)
from app.domain.training.model_qualification import ModelVariant, _regression_model_for_variant
from app.domain.training.short_horizon_barrier_calibrated import (
    _active_balanced_accuracy,
    _attach_selected_barrier_return,
    _barrier_classifier,
    _barrier_metrics,
    _binary_class_weights,
    _positive_probability,
    _profit_factor,
    _split_barrier_train_calibration,
    _with_side_targets,
    collapse_non_overlapping_barrier_signals,
)
from app.domain.training.train_multitimeframe import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_BARRIER_RETURN_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    _split_internal_early_stopping_tail,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits


class InsufficientConditionalEvidenceError(ValueError):
    """Expected pair-level evidence shortage that must fail closed to ABSTAIN."""


@dataclass(frozen=True)
class ConditionalSeverityTarget:
    row_index: np.ndarray
    values: np.ndarray


@dataclass(frozen=True)
class ConditionalSeverityModels:
    long_favorable: Any
    long_adverse: Any
    short_favorable: Any
    short_adverse: Any


@dataclass(frozen=True)
class ConditionalPayoffCalibration:
    passed: bool
    reason: str
    min_expected_net: float | None
    active_rows: int
    density: float
    mean_realized_bps: float
    profit_factor: float | None
    profit_throughput_bps: float
    long_fraction: float
    short_fraction: float


@dataclass(frozen=True)
class ConditionalPayoffPairExpert:
    instrument: str
    long_model: Any
    short_model: Any
    severity_models: ConditionalSeverityModels
    feature_columns: tuple[str, ...]
    calibration: ConditionalPayoffCalibration | None = None
    evidence_failure: str | None = None


@dataclass(frozen=True)
class ConditionalPayoffScore:
    long_expected_favorable: np.ndarray
    long_expected_adverse: np.ndarray
    short_expected_favorable: np.ndarray
    short_expected_adverse: np.ndarray
    long_expected_net: np.ndarray
    short_expected_net: np.ndarray
    predicted_long: np.ndarray
    selected_expected_favorable: np.ndarray
    selected_expected_adverse: np.ndarray
    selected_expected_net: np.ndarray
    selected_payoff_ratio: np.ndarray


def _as_vector(values: np.ndarray | Iterable[float]) -> np.ndarray:
    array = np.asarray(values, dtype=float)
    if array.ndim != 1:
        raise ValueError("conditional payoff inputs must be one-dimensional")
    return array


def _barrier_units(frame: pd.DataFrame, return_column: str) -> np.ndarray:
    missing = [
        column
        for column in (return_column, EVENT_BARRIER_RETURN_COLUMN)
        if column not in frame.columns
    ]
    if missing:
        raise ValueError(f"conditional payoff frame missing columns: {missing}")
    returns = pd.to_numeric(frame[return_column], errors="raise").to_numpy(dtype=float)
    barriers = (
        pd.to_numeric(frame[EVENT_BARRIER_RETURN_COLUMN], errors="raise").to_numpy(dtype=float)
        * 10_000.0
    )
    returns_bps = returns * 10_000.0
    if (
        not np.isfinite(returns_bps).all()
        or not np.isfinite(barriers).all()
        or np.any(barriers <= 0.0)
    ):
        raise ValueError("conditional payoff targets require finite positive barriers")
    return returns_bps / barriers


def _conditional_severity_targets(
    frame: pd.DataFrame,
) -> dict[str, ConditionalSeverityTarget]:
    required = {
        EVENT_ACTIONABLE_TARGET_COLUMN,
        EVENT_DIRECTION_TARGET_COLUMN,
        EVENT_BARRIER_RETURN_COLUMN,
        EVENT_LONG_NET_RETURN_COLUMN,
        EVENT_SHORT_NET_RETURN_COLUMN,
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"conditional payoff frame missing columns: {missing}")

    actionable = pd.to_numeric(frame[EVENT_ACTIONABLE_TARGET_COLUMN], errors="raise").astype(int)
    direction = pd.to_numeric(frame[EVENT_DIRECTION_TARGET_COLUMN], errors="raise").astype(int)
    if not actionable.isin((0, 1)).all() or not direction.isin((0, 1)).all():
        raise ValueError("conditional payoff event labels must be binary")

    long_mask = (actionable == 1) & (direction == 1)
    short_mask = (actionable == 1) & (direction == 0)
    long_rows = frame.loc[long_mask]
    short_rows = frame.loc[short_mask]

    return {
        "long_favorable": ConditionalSeverityTarget(
            row_index=long_rows.index.to_numpy(copy=True),
            values=np.maximum(_barrier_units(long_rows, EVENT_LONG_NET_RETURN_COLUMN), 0.0),
        ),
        "long_adverse": ConditionalSeverityTarget(
            row_index=short_rows.index.to_numpy(copy=True),
            values=np.maximum(-_barrier_units(short_rows, EVENT_LONG_NET_RETURN_COLUMN), 0.0),
        ),
        "short_favorable": ConditionalSeverityTarget(
            row_index=short_rows.index.to_numpy(copy=True),
            values=np.maximum(_barrier_units(short_rows, EVENT_SHORT_NET_RETURN_COLUMN), 0.0),
        ),
        "short_adverse": ConditionalSeverityTarget(
            row_index=long_rows.index.to_numpy(copy=True),
            values=np.maximum(-_barrier_units(long_rows, EVENT_SHORT_NET_RETURN_COLUMN), 0.0),
        ),
    }


def _severity_regressor(name: str) -> Any:
    return _regression_model_for_variant(
        ModelVariant(name=f"conditional_payoff_v6_{name}")
    )


def fit_pair_conditional_payoff_expert(
    training_frame: pd.DataFrame,
    *,
    instrument: str,
    horizon_bars: int,
    feature_columns: tuple[str, ...] = tuple(MULTITIMEFRAME_FEATURE_COLUMNS),
    classifier_factory: Callable[[str], Any] | None = None,
    regressor_factory: Callable[[str], Any] | None = None,
    min_conditional_fit_rows: int = 500,
    min_conditional_early_rows: int = 100,
) -> ConditionalPayoffPairExpert:
    pair = instrument.strip().upper()
    if not pair:
        raise ValueError("instrument is required")
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")
    if min_conditional_fit_rows < 1 or min_conditional_early_rows < 1:
        raise ValueError("conditional evidence floors must be positive")
    if "instrument" not in training_frame.columns:
        raise ValueError("conditional payoff training frame requires instrument identity")

    pair_frame = training_frame.loc[
        training_frame["instrument"].astype(str).str.upper() == pair
    ].copy()
    if pair_frame.empty:
        raise ValueError(f"missing exact-pair training rows for {pair}")
    missing_features = [
        column for column in feature_columns if column not in pair_frame.columns
    ]
    if missing_features:
        raise ValueError(f"conditional payoff frame missing features: {missing_features}")

    labeled = _with_side_targets(pair_frame)
    fit, early = _split_internal_early_stopping_tail(
        labeled,
        horizon_bars=horizon_bars,
    )
    classifier_builder = classifier_factory or _barrier_classifier
    classifiers: dict[str, Any] = {}
    for side, target_column in (
        ("long", "barrier_long_target"),
        ("short", "barrier_short_target"),
    ):
        if fit[target_column].nunique() < 2 or early[target_column].nunique() < 2:
            raise InsufficientConditionalEvidenceError(
                f"{pair} {side} barrier expert requires both classes"
            )
        model = classifier_builder(side)
        model.fit(
            fit[list(feature_columns)],
            fit[target_column].astype(int),
            sample_weight=_binary_class_weights(fit[target_column]),
            eval_set=[(early[list(feature_columns)], early[target_column].astype(int))],
            sample_weight_eval_set=[_binary_class_weights(early[target_column])],
            verbose=False,
        )
        classifiers[side] = model

    fit_targets = _conditional_severity_targets(fit)
    early_targets = _conditional_severity_targets(early)
    severity_builder = regressor_factory or _severity_regressor
    severity_models: dict[str, Any] = {}
    for component in (
        "long_favorable",
        "long_adverse",
        "short_favorable",
        "short_adverse",
    ):
        fit_target = fit_targets[component]
        early_target = early_targets[component]
        if len(fit_target.values) < min_conditional_fit_rows:
            raise InsufficientConditionalEvidenceError(
                f"{pair} conditional {component} fit evidence too small: "
                f"{len(fit_target.values)}"
            )
        if len(early_target.values) < min_conditional_early_rows:
            raise InsufficientConditionalEvidenceError(
                f"{pair} conditional {component} early evidence too small: "
                f"{len(early_target.values)}"
            )
        model = severity_builder(component)
        model.fit(
            fit.loc[fit_target.row_index, list(feature_columns)],
            fit_target.values,
            eval_set=[
                (
                    early.loc[early_target.row_index, list(feature_columns)],
                    early_target.values,
                )
            ],
            verbose=False,
        )
        severity_models[component] = model

    return ConditionalPayoffPairExpert(
        instrument=pair,
        long_model=classifiers["long"],
        short_model=classifiers["short"],
        severity_models=ConditionalSeverityModels(
            long_favorable=severity_models["long_favorable"],
            long_adverse=severity_models["long_adverse"],
            short_favorable=severity_models["short_favorable"],
            short_adverse=severity_models["short_adverse"],
        ),
        feature_columns=feature_columns,
    )


CALIBRATION_SCORE_QUANTILES = (0.75, 0.80, 0.85, 0.90, 0.95)
CALIBRATION_MIN_ROWS = 200
CALIBRATION_MIN_DENSITY = 0.05
CALIBRATION_MAX_DENSITY = 0.25
CALIBRATION_MIN_SIDE_FRACTION = 0.05
CALIBRATION_MIN_PROFIT_FACTOR = 1.10


def _failed_calibration(reason: str) -> ConditionalPayoffCalibration:
    return ConditionalPayoffCalibration(
        passed=False,
        reason=reason,
        min_expected_net=None,
        active_rows=0,
        density=0.0,
        mean_realized_bps=0.0,
        profit_factor=None,
        profit_throughput_bps=0.0,
        long_fraction=0.0,
        short_fraction=0.0,
    )


def _predict_nonnegative_severity(model: Any, features: pd.DataFrame) -> np.ndarray:
    prediction = np.asarray(model.predict(features), dtype=float)
    if prediction.ndim != 1 or len(prediction) != len(features):
        raise ValueError("conditional severity model must return one value per row")
    if not np.isfinite(prediction).all():
        raise ValueError("conditional severity predictions must be finite")
    return np.maximum(prediction, 0.0)


def _score_pair_expert(
    frame: pd.DataFrame,
    expert: ConditionalPayoffPairExpert,
) -> ConditionalPayoffScore:
    missing = [column for column in expert.feature_columns if column not in frame.columns]
    if missing:
        raise ValueError(f"conditional payoff frame missing features: {missing}")
    features = frame[list(expert.feature_columns)]
    long_probability = _positive_probability(expert.long_model, features)
    short_probability = _positive_probability(expert.short_model, features)
    severity = expert.severity_models
    return score_conditional_payoff(
        long_probability=long_probability,
        short_probability=short_probability,
        long_favorable_severity=_predict_nonnegative_severity(
            severity.long_favorable, features
        ),
        long_adverse_severity=_predict_nonnegative_severity(
            severity.long_adverse, features
        ),
        short_favorable_severity=_predict_nonnegative_severity(
            severity.short_favorable, features
        ),
        short_adverse_severity=_predict_nonnegative_severity(
            severity.short_adverse, features
        ),
    )


def select_conditional_payoff_calibration(
    score: ConditionalPayoffScore,
    realized_long_bps: np.ndarray | Iterable[float],
    realized_short_bps: np.ndarray | Iterable[float],
    *,
    score_quantiles: tuple[float, ...] = CALIBRATION_SCORE_QUANTILES,
    min_rows: int = CALIBRATION_MIN_ROWS,
    min_density: float = CALIBRATION_MIN_DENSITY,
    max_density: float = CALIBRATION_MAX_DENSITY,
    min_side_fraction: float = CALIBRATION_MIN_SIDE_FRACTION,
    min_profit_factor: float = CALIBRATION_MIN_PROFIT_FACTOR,
) -> ConditionalPayoffCalibration:
    selected_expected_net = _as_vector(score.selected_expected_net)
    predicted_long = np.asarray(score.predicted_long, dtype=bool)
    long_bps = _as_vector(realized_long_bps)
    short_bps = _as_vector(realized_short_bps)
    lengths = {
        len(selected_expected_net),
        len(predicted_long),
        len(long_bps),
        len(short_bps),
    }
    if len(lengths) != 1:
        raise ValueError("conditional payoff calibration inputs must have equal lengths")
    rows = len(selected_expected_net)
    if rows < min_rows:
        return _failed_calibration("INSUFFICIENT_CALIBRATION_ROWS")
    if not all(
        np.isfinite(values).all()
        for values in (selected_expected_net, long_bps, short_bps)
    ):
        return _failed_calibration("NON_FINITE_CALIBRATION_INPUT")
    if (
        not score_quantiles
        or min_rows < 1
        or not (0.0 <= min_density <= max_density <= 1.0)
        or not (0.0 <= min_side_fraction <= 0.5)
        or min_profit_factor <= 0.0
        or any(not 0.0 < float(value) < 1.0 for value in score_quantiles)
    ):
        raise ValueError("invalid conditional payoff calibration policy")

    thresholds = sorted(
        {
            max(0.0, float(np.quantile(selected_expected_net, float(quantile))))
            for quantile in score_quantiles
        }
    )
    candidates: list[ConditionalPayoffCalibration] = []
    for threshold in thresholds:
        active = (selected_expected_net >= threshold) & (selected_expected_net > 0.0)
        active_rows = int(active.sum())
        if active_rows < min_rows:
            continue
        density = active_rows / rows
        if density < min_density or density > max_density:
            continue
        active_long = predicted_long[active]
        long_fraction = float(active_long.mean())
        short_fraction = 1.0 - long_fraction
        if long_fraction < min_side_fraction or short_fraction < min_side_fraction:
            continue
        selected_realized = np.where(
            active_long,
            long_bps[active],
            short_bps[active],
        )
        mean_realized_bps = float(selected_realized.mean())
        profit_factor = _profit_factor(selected_realized)
        if mean_realized_bps <= 0.0:
            continue
        if (
            profit_factor is None
            or not np.isfinite(profit_factor)
            or float(profit_factor) < min_profit_factor
        ):
            continue
        candidates.append(
            ConditionalPayoffCalibration(
                passed=True,
                reason="CALIBRATED",
                min_expected_net=threshold,
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
        return _failed_calibration("NO_ECONOMIC_SCORE_TAIL")
    return max(
        candidates,
        key=lambda candidate: (
            candidate.profit_throughput_bps,
            candidate.profit_factor or 0.0,
            candidate.density,
            candidate.min_expected_net or 0.0,
        ),
    )


def route_conditional_payoff_predictions(
    frame: pd.DataFrame,
    experts_by_instrument: Mapping[str, ConditionalPayoffPairExpert],
) -> pd.DataFrame:
    if "instrument" not in frame.columns:
        raise ValueError("conditional payoff routing requires instrument identity")
    result = frame.copy()
    for column in (
        "long_probability",
        "short_probability",
        "long_expected_net",
        "short_expected_net",
        "selected_expected_favorable",
        "selected_expected_adverse",
        "selected_expected_net",
        "selected_payoff_ratio",
    ):
        result[column] = np.nan
    result["predicted_long"] = False
    result["active_trade"] = False
    result["action"] = "ABSTAIN"
    result["route_reason"] = "MISSING_PAIR_EXPERT"

    canonical = {str(key).upper(): expert for key, expert in experts_by_instrument.items()}
    instruments = result["instrument"].astype(str).str.upper()
    for instrument in instruments.unique():
        index = result.index[instruments == instrument]
        expert = canonical.get(instrument)
        if expert is None or expert.instrument.upper() != instrument:
            continue
        calibration = expert.calibration
        if (
            calibration is None
            or not calibration.passed
            or calibration.min_expected_net is None
        ):
            result.loc[index, "route_reason"] = "PAIR_CALIBRATION_FAILED"
            continue
        missing = [column for column in expert.feature_columns if column not in result.columns]
        if missing:
            result.loc[index, "route_reason"] = "MISSING_PAIR_FEATURES"
            continue

        pair_frame = result.loc[index]
        score = _score_pair_expert(pair_frame, expert)
        features = pair_frame[list(expert.feature_columns)]
        long_probability = _positive_probability(expert.long_model, features)
        short_probability = _positive_probability(expert.short_model, features)
        active = (
            (score.selected_expected_net >= calibration.min_expected_net)
            & (score.selected_expected_net > 0.0)
        )

        result.loc[index, "long_probability"] = long_probability
        result.loc[index, "short_probability"] = short_probability
        result.loc[index, "long_expected_net"] = score.long_expected_net
        result.loc[index, "short_expected_net"] = score.short_expected_net
        result.loc[index, "selected_expected_favorable"] = score.selected_expected_favorable
        result.loc[index, "selected_expected_adverse"] = score.selected_expected_adverse
        result.loc[index, "selected_expected_net"] = score.selected_expected_net
        result.loc[index, "selected_payoff_ratio"] = score.selected_payoff_ratio
        result.loc[index, "predicted_long"] = score.predicted_long
        result.loc[index, "active_trade"] = active
        result.loc[index, "action"] = np.where(
            active,
            np.where(score.predicted_long, "BUY", "SELL"),
            "ABSTAIN",
        )
        result.loc[index, "route_reason"] = np.where(
            active,
            "CONDITIONAL_PAYOFF_SIGNAL",
            "EXPECTED_NET_THRESHOLD_NOT_MET",
        )

    return result


def score_conditional_payoff(
    *,
    long_probability: np.ndarray | Iterable[float],
    short_probability: np.ndarray | Iterable[float],
    long_favorable_severity: np.ndarray | Iterable[float],
    long_adverse_severity: np.ndarray | Iterable[float],
    short_favorable_severity: np.ndarray | Iterable[float],
    short_adverse_severity: np.ndarray | Iterable[float],
) -> ConditionalPayoffScore:
    long_p = _as_vector(long_probability)
    short_p = _as_vector(short_probability)
    severities = [
        _as_vector(long_favorable_severity),
        _as_vector(long_adverse_severity),
        _as_vector(short_favorable_severity),
        _as_vector(short_adverse_severity),
    ]
    lengths = {len(long_p), len(short_p), *(len(values) for values in severities)}
    if len(lengths) != 1:
        raise ValueError("conditional payoff inputs must have equal lengths")
    if (
        not np.isfinite(long_p).all()
        or not np.isfinite(short_p).all()
        or ((long_p < 0.0) | (long_p > 1.0)).any()
        or ((short_p < 0.0) | (short_p > 1.0)).any()
    ):
        raise ValueError("conditional payoff probabilities must be finite in [0, 1]")
    if any((not np.isfinite(values).all()) or np.any(values < 0.0) for values in severities):
        raise ValueError("conditional payoff severities must be finite non-negative")

    long_fav, long_adv, short_fav, short_adv = severities
    long_expected_favorable = long_p * long_fav
    long_expected_adverse = short_p * long_adv
    short_expected_favorable = short_p * short_fav
    short_expected_adverse = long_p * short_adv
    long_expected_net = long_expected_favorable - long_expected_adverse
    short_expected_net = short_expected_favorable - short_expected_adverse
    predicted_long = long_expected_net >= short_expected_net
    selected_expected_favorable = np.where(
        predicted_long, long_expected_favorable, short_expected_favorable
    )
    selected_expected_adverse = np.where(
        predicted_long, long_expected_adverse, short_expected_adverse
    )
    selected_expected_net = np.where(predicted_long, long_expected_net, short_expected_net)
    selected_payoff_ratio = selected_expected_favorable / np.maximum(
        selected_expected_adverse, 1e-6
    )

    return ConditionalPayoffScore(
        long_expected_favorable=long_expected_favorable,
        long_expected_adverse=long_expected_adverse,
        short_expected_favorable=short_expected_favorable,
        short_expected_adverse=short_expected_adverse,
        long_expected_net=long_expected_net,
        short_expected_net=short_expected_net,
        predicted_long=predicted_long,
        selected_expected_favorable=selected_expected_favorable,
        selected_expected_adverse=selected_expected_adverse,
        selected_expected_net=selected_expected_net,
        selected_payoff_ratio=selected_payoff_ratio,
    )

PARTICIPATION_TARGET_PER_DAY = 24.0


def _fit_and_calibrate_pair_expert(
    training_frame: pd.DataFrame,
    calibration_frame: pd.DataFrame,
    *,
    instrument: str,
    horizon_bars: int,
    calibration_min_rows: int,
    expert_fitter: Callable[..., ConditionalPayoffPairExpert] | None = None,
) -> ConditionalPayoffPairExpert:
    fitter = expert_fitter or fit_pair_conditional_payoff_expert
    pair = instrument.strip().upper()
    try:
        expert = fitter(
            training_frame,
            instrument=instrument,
            horizon_bars=horizon_bars,
        )
    except InsufficientConditionalEvidenceError as exc:
        return ConditionalPayoffPairExpert(
            instrument=pair,
            long_model=None,
            short_model=None,
            severity_models=ConditionalSeverityModels(
                long_favorable=None,
                long_adverse=None,
                short_favorable=None,
                short_adverse=None,
            ),
            feature_columns=(),
            calibration=_failed_calibration("INSUFFICIENT_CONDITIONAL_EVIDENCE"),
            evidence_failure=str(exc),
        )
    if expert.instrument.upper() != pair:
        raise ValueError(
            f"conditional payoff fitter returned mismatched expert for {pair}"
        )
    pair_calibration = calibration_frame.loc[
        calibration_frame["instrument"].astype(str).str.upper() == pair
    ].copy()
    if pair_calibration.empty:
        raise ValueError(f"missing exact-pair calibration rows for {pair}")
    score = _score_pair_expert(pair_calibration, expert)
    calibration = select_conditional_payoff_calibration(
        score,
        pd.to_numeric(
            pair_calibration[EVENT_LONG_NET_RETURN_COLUMN], errors="raise"
        ).to_numpy(float)
        * 10_000.0,
        pd.to_numeric(
            pair_calibration[EVENT_SHORT_NET_RETURN_COLUMN], errors="raise"
        ).to_numpy(float)
        * 10_000.0,
        min_rows=calibration_min_rows,
    )
    return replace(expert, calibration=calibration)


def evaluate_conditional_payoff_frame(
    frame: pd.DataFrame,
    *,
    horizon_bars: int,
    min_train_periods: int,
    validation_periods: int,
    max_splits: int = 3,
    calibration_min_rows: int = CALIBRATION_MIN_ROWS,
    expert_fitter: Callable[..., ConditionalPayoffPairExpert] | None = None,
    router: Callable[
        [pd.DataFrame, Mapping[str, ConditionalPayoffPairExpert]], pd.DataFrame
    ]
    | None = None,
) -> dict[str, Any]:
    """Evaluate six-pair conditional-payoff v6 with purged walk-forward validation."""
    if horizon_bars != 1:
        raise ValueError("conditional payoff v6 first screen requires horizon_bars=1")
    if calibration_min_rows < 1:
        raise ValueError("calibration_min_rows must be positive")
    required = {
        "decision_time",
        "instrument",
        EVENT_ACTIONABLE_TARGET_COLUMN,
        EVENT_DIRECTION_TARGET_COLUMN,
        EVENT_BARRIER_RETURN_COLUMN,
        EVENT_LONG_NET_RETURN_COLUMN,
        EVENT_SHORT_NET_RETURN_COLUMN,
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"conditional payoff evaluator missing columns: {missing}")

    dataset = frame.copy()
    dataset["decision_time"] = pd.to_datetime(
        dataset["decision_time"], utc=True, errors="raise"
    )
    expected_pairs = set(INITIAL_FOREX_UNIVERSE)
    observed_pairs = set(dataset["instrument"].astype(str).str.upper().unique())
    if observed_pairs != expected_pairs:
        raise ValueError(
            "conditional payoff evaluator requires exact six-pair universe; "
            f"got {sorted(observed_pairs)}"
        )
    dataset = dataset.sort_values(["decision_time", "instrument"]).reset_index(
        drop=True
    )

    routing = router or route_conditional_payoff_predictions
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
        model_train, calibration_frame = _split_barrier_train_calibration(
            outer_train,
            horizon_bars=horizon_bars,
        )
        experts: dict[str, ConditionalPayoffPairExpert] = {}
        for instrument in INITIAL_FOREX_UNIVERSE:
            experts[instrument] = _fit_and_calibrate_pair_expert(
                model_train,
                calibration_frame,
                instrument=instrument,
                horizon_bars=horizon_bars,
                calibration_min_rows=calibration_min_rows,
                expert_fitter=expert_fitter,
            )

        routed = routing(validation.copy(), experts)
        required_route = {"active_trade", "predicted_long", "action"}
        if not required_route.issubset(routed.columns):
            raise ValueError("conditional payoff router omitted required execution columns")
        routed = _attach_selected_barrier_return(routed)
        routed["fold"] = fold_index
        fold_periods = collapse_non_overlapping_barrier_signals(
            routed,
            horizon_bars=horizon_bars,
        )
        fold_validation_days = int(
            routed["decision_time"].dt.normalize().drop_duplicates().shape[0]
        )
        fold_metrics = _barrier_metrics(
            fold_periods,
            validation_days=fold_validation_days,
        )
        folds.append(
            {
                "fold": fold_index,
                "train_start": pd.Timestamp(outer_train["decision_time"].min()).isoformat(),
                "train_end": pd.Timestamp(outer_train["decision_time"].max()).isoformat(),
                "calibration_start": pd.Timestamp(
                    calibration_frame["decision_time"].min()
                ).isoformat(),
                "calibration_end": pd.Timestamp(
                    calibration_frame["decision_time"].max()
                ).isoformat(),
                "validation_start": pd.Timestamp(
                    validation["decision_time"].min()
                ).isoformat(),
                "validation_end": pd.Timestamp(
                    validation["decision_time"].max()
                ).isoformat(),
                "pair_calibrations": {
                    instrument: (
                        asdict(expert.calibration)
                        if expert.calibration is not None
                        else None
                    )
                    for instrument, expert in sorted(experts.items())
                },
                "pair_evidence_failures": {
                    instrument: expert.evidence_failure
                    for instrument, expert in sorted(experts.items())
                    if expert.evidence_failure is not None
                },
                "active_signals": int(routed["active_trade"].sum()),
                "non_overlapping_opportunities": int(len(fold_periods)),
                "total_return": float(fold_metrics["total_return"]),
            }
        )
        predictions.append(routed)

    if not predictions:
        raise ValueError("conditional payoff evaluator produced no validation folds")
    all_predictions = pd.concat(predictions, ignore_index=True)
    periods = collapse_non_overlapping_barrier_signals(
        all_predictions,
        horizon_bars=horizon_bars,
    )
    validation_days = int(
        all_predictions["decision_time"].dt.normalize().drop_duplicates().shape[0]
    )
    metrics = _barrier_metrics(periods, validation_days=validation_days)
    opportunities_per_day = float(len(periods) / max(validation_days, 1))
    balanced_accuracy = _active_balanced_accuracy(all_predictions)

    instrument_positive: dict[str, bool] = {}
    for instrument, group in all_predictions.groupby("instrument", sort=True):
        selected = group.loc[
            group["active_trade"].astype(bool), "selected_net_return"
        ]
        instrument_positive[str(instrument)] = bool(
            len(selected) and float(selected.sum()) > 0.0
        )
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
        "participation": opportunities_per_day >= PARTICIPATION_TARGET_PER_DAY,
        "balanced_accuracy": balanced_accuracy is not None
        and balanced_accuracy >= 0.52,
        "profit_factor": profit_factor is not None and float(profit_factor) >= 1.15,
        "sharpe": sharpe is not None and float(sharpe) >= 1.0,
        "max_drawdown": max_drawdown <= 0.12,
        "positive_fold_fraction": positive_fold_fraction >= 0.60,
        "positive_instrument_fraction": positive_instrument_fraction >= 0.67,
    }
    return {
        "candidate": "six-pair-conditional-payoff-v6",
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_demo": False,
        "approved_for_live": False,
        "horizon_minutes": horizon_bars,
        "protocol": {
            "purge_periods": horizon_bars,
            "embargo_periods": horizon_bars,
            "inner_calibration_train_only": True,
            "pair_specific_probability_models": True,
            "pair_specific_severity_models": True,
            "expected_payoff_side_selection": True,
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
            "target_per_validation_day": PARTICIPATION_TARGET_PER_DAY,
        },
        "robustness": {
            "positive_fold_fraction": positive_fold_fraction,
            "positive_instrument_fraction": positive_instrument_fraction,
            "instrument_positive": instrument_positive,
        },
        "gates": gates,
        "research_gate_passed": all(gates.values()),
    }


def evaluate_conditional_payoff_corpora(
    datasets: Mapping[str, str | Path],
    *,
    horizon_bars: int,
    report_path: str | Path,
    min_train_periods: int | None = None,
    validation_periods: int = 7200,
    max_splits: int = 1,
    calibration_min_rows: int = CALIBRATION_MIN_ROWS,
    decision_time_before: str | pd.Timestamp | None = None,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
) -> dict[str, Any]:
    normalized = {str(key).upper(): value for key, value in datasets.items()}
    expected = set(INITIAL_FOREX_UNIVERSE)
    if set(normalized) != expected:
        raise ValueError(
            "conditional payoff corpus evaluation requires exact six-pair universe; "
            f"got {sorted(normalized)}"
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
    report = evaluate_conditional_payoff_frame(
        pooled,
        horizon_bars=horizon_bars,
        min_train_periods=train_periods,
        validation_periods=validation_periods,
        max_splits=max_splits,
        calibration_min_rows=calibration_min_rows,
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
    temporary.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temporary.replace(output)
    return {**report, "report_path": str(output)}
