from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS
from app.domain.training.model_qualification import ModelVariant, _regression_model_for_variant
from app.domain.training.short_horizon_barrier_calibrated import (
    _barrier_classifier,
    _binary_class_weights,
    _with_side_targets,
)
from app.domain.training.train_multitimeframe import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_BARRIER_RETURN_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    _split_internal_early_stopping_tail,
)


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
class ConditionalPayoffPairExpert:
    instrument: str
    long_model: Any
    short_model: Any
    severity_models: ConditionalSeverityModels
    feature_columns: tuple[str, ...]


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
            raise ValueError(f"{pair} {side} barrier expert requires both classes")
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
            raise ValueError(
                f"{pair} conditional {component} fit evidence too small: "
                f"{len(fit_target.values)}"
            )
        if len(early_target.values) < min_conditional_early_rows:
            raise ValueError(
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
