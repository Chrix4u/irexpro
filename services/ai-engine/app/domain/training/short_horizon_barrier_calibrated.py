from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBClassifier

from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS
from app.domain.training.train_multitimeframe import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
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
