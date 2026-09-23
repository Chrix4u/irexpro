"""Nested, leakage-safe model-qualification experiments for the six-pair research set."""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from xgboost import XGBClassifier

from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS
from app.domain.training import train_multitimeframe as mtf_training
from app.domain.training.qualification_diagnostics import (
    evidence_sufficiency_warnings,
    feature_gain_diagnostics,
)
from app.domain.training.train_multitimeframe import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_BARRIER_RETURN_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LABEL_POLICY,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    EVENT_STEP_COLUMN,
    LONG_NET_RETURN_COLUMN,
    QUALIFICATION_REGIME_COLUMNS,
    SHORT_NET_RETURN_COLUMN,
    TARGET_COLUMN,
    _build_model,
    _class_balance_sample_weights,
    _economic_sample_weights,
    _split_internal_early_stopping_tail,
    load_and_prepare_corpora,
)
from app.domain.training.validation import (
    compute_classification_metrics,
    iter_purged_walk_forward_time_splits,
)

CONFIDENCE_FLOOR = 0.60
ACTIONABLE_TARGET_COLUMN = "actionable_target"
ACTIONABLE_LABEL_POLICY = "best_direction_net_return_after_friction_gt_zero_v1"
TWO_STAGE_EXPERIMENT_NAME = "actionable_two_stage"
EVENT_TWO_STAGE_EXPERIMENT_NAME = "event_barrier_two_stage"
EVENT_PAIR_EXPERT_EXPERIMENT_NAME = "event_barrier_pair_experts"
QUALIFICATION_CHECKPOINT_VERSION = 1
QUALIFICATION_CHECKPOINT_POLICY = "experiment_outer_fold_atomic_v1"
DECISION_THRESHOLD_GRID = (0.45, 0.475, 0.50, 0.525, 0.55)
MIN_ISOTONIC_ROWS = 500
MIN_ISOTONIC_CLASS_ROWS = 100
VOLUME_FEATURE_SUFFIXES = (
    "volume_change",
    "log_tick_volume",
    "volume_zscore_20",
)
STRUCTURE_FEATURE_SUFFIXES = (
    "breakout_strength_20",
    "range_compression_5_20",
    "momentum_acceleration_3_10",
)
STRUCTURE_GLOBAL_FEATURES = (
    "trend_alignment_score",
    "momentum_alignment_score",
)
ExperimentCalibration = Literal["none", "platt", "isotonic"]
SampleWeightPolicy = Literal["economic", "class_balance"]
FeaturePolicy = Literal["all", "drop_volume", "drop_structure"]
ExperimentMode = Literal[
    "directional",
    "two_stage_actionable",
    "two_stage_event",
    "two_stage_event_pair_experts",
]


@dataclass(frozen=True)
class ModelVariant:
    name: str
    parameter_overrides: tuple[tuple[str, float | int], ...] = ()
    sample_weight_policy: SampleWeightPolicy = "economic"
    calibration: ExperimentCalibration = "none"
    feature_policy: FeaturePolicy = "all"

    def overrides(self) -> dict[str, float | int]:
        return dict(self.parameter_overrides)


@dataclass(frozen=True)
class QualificationExperiment:
    name: str
    variants: tuple[ModelVariant, ...]
    tune_decision_threshold: bool = False
    mode: ExperimentMode = "directional"


@dataclass
class _CalibrationModel:
    method: ExperimentCalibration
    estimator: Any | None = None


@dataclass
class _NestedWindows:
    fit: pd.DataFrame
    early_stop: pd.DataFrame
    calibration: pd.DataFrame
    selection: pd.DataFrame


@dataclass
class _RefitWindows:
    fit: pd.DataFrame
    early_stop: pd.DataFrame
    calibration: pd.DataFrame


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temporary.replace(path)


def _experiment_matrix_payload(
    experiments: tuple[QualificationExperiment, ...],
) -> list[dict[str, Any]]:
    return [
        {
            "name": experiment.name,
            "tune_decision_threshold": experiment.tune_decision_threshold,
            "mode": experiment.mode,
            "variants": [
                {
                    "name": variant.name,
                    "parameter_overrides": list(variant.parameter_overrides),
                    "sample_weight_policy": variant.sample_weight_policy,
                    "calibration": variant.calibration,
                    "feature_policy": variant.feature_policy,
                }
                for variant in experiment.variants
            ],
        }
        for experiment in experiments
    ]


def _qualification_checkpoint_fingerprint(
    *,
    dataset_sha256: dict[str, str],
    decision_time_before: str | pd.Timestamp,
    horizon_bars: int,
    confidence_floor: float,
    max_splits: int,
    experiments: tuple[QualificationExperiment, ...],
) -> str:
    payload = {
        "policy": QUALIFICATION_CHECKPOINT_POLICY,
        "dataset_sha256": dict(sorted(dataset_sha256.items())),
        "decision_time_before": pd.Timestamp(decision_time_before).isoformat(),
        "horizon_bars": int(horizon_bars),
        "confidence_floor": float(confidence_floor),
        "max_splits": int(max_splits),
        "feature_columns": list(MULTITIMEFRAME_FEATURE_COLUMNS),
        "actionable_label_policy": ACTIONABLE_LABEL_POLICY,
        "event_label_policy": EVENT_LABEL_POLICY,
        "experiments": _experiment_matrix_payload(experiments),
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _qualification_checkpoint_paths(
    checkpoint_dir: Path,
    *,
    experiment_name: str,
    fold_index: int,
) -> tuple[Path, Path]:
    safe_name = "".join(
        character if character.isalnum() or character in {"-", "_"} else "_"
        for character in experiment_name
    )
    stem = checkpoint_dir / f"fold-{fold_index:02d}-{safe_name}"
    return stem.with_suffix(".json"), stem.with_suffix(".csv")


def _qualification_checkpoint_expected(
    outer_train: pd.DataFrame,
    outer_validation: pd.DataFrame,
) -> dict[str, Any]:
    return {
        "train_start": outer_train["decision_time"].min().isoformat(),
        "train_end": outer_train["decision_time"].max().isoformat(),
        "validation_start": outer_validation["decision_time"].min().isoformat(),
        "validation_end": outer_validation["decision_time"].max().isoformat(),
        "validation_rows": int(len(outer_validation)),
    }


def _load_qualification_checkpoint(
    checkpoint_dir: Path,
    *,
    fingerprint: str,
    experiment_name: str,
    fold_index: int,
    expected: dict[str, Any],
) -> tuple[pd.DataFrame, dict[str, Any]] | None:
    metadata_path, predictions_path = _qualification_checkpoint_paths(
        checkpoint_dir,
        experiment_name=experiment_name,
        fold_index=fold_index,
    )
    if not metadata_path.is_file() or not predictions_path.is_file():
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("checkpoint_version") != QUALIFICATION_CHECKPOINT_VERSION:
            return None
        if metadata.get("fingerprint") != fingerprint:
            return None
        if metadata.get("experiment") != experiment_name:
            return None
        if int(metadata.get("fold", -1)) != int(fold_index):
            return None
        if metadata.get("expected") != expected:
            return None
        if metadata.get("predictions_sha256") != _sha256_file(predictions_path):
            return None
        report = metadata.get("fold_report")
        if not isinstance(report, dict):
            return None

        predictions = pd.read_csv(predictions_path)
        if len(predictions) != int(expected["validation_rows"]):
            return None
        required = {
            "decision_time",
            "instrument",
            TARGET_COLUMN,
            LONG_NET_RETURN_COLUMN,
            SHORT_NET_RETURN_COLUMN,
            "positive_probability",
            "predicted_long",
            "confidence",
            "active_trade",
            "selected_net_return",
            "fold",
            "experiment",
            "model_variant",
            "calibration_method",
            "decision_threshold",
        }
        if not required.issubset(predictions.columns):
            return None
        predictions["decision_time"] = pd.to_datetime(
            predictions["decision_time"],
            utc=True,
            errors="raise",
        )
        for column in ("predicted_long", "active_trade"):
            if predictions[column].dtype == object:
                predictions[column] = predictions[column].map(
                    {"True": True, "False": False, True: True, False: False}
                )
            if predictions[column].isna().any():
                return None
            predictions[column] = predictions[column].astype(bool)
        return predictions, report
    except Exception:
        return None


def _write_qualification_checkpoint(
    checkpoint_dir: Path,
    *,
    fingerprint: str,
    experiment_name: str,
    fold_index: int,
    expected: dict[str, Any],
    predictions: pd.DataFrame,
    fold_report: dict[str, Any],
) -> None:
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    metadata_path, predictions_path = _qualification_checkpoint_paths(
        checkpoint_dir,
        experiment_name=experiment_name,
        fold_index=fold_index,
    )
    predictions_tmp = predictions_path.with_suffix(".csv.tmp")
    predictions.to_csv(predictions_tmp, index=False)
    predictions_tmp.replace(predictions_path)
    _atomic_write_json(
        metadata_path,
        {
            "checkpoint_version": QUALIFICATION_CHECKPOINT_VERSION,
            "policy": QUALIFICATION_CHECKPOINT_POLICY,
            "fingerprint": fingerprint,
            "experiment": experiment_name,
            "fold": int(fold_index),
            "expected": expected,
            "predictions_sha256": _sha256_file(predictions_path),
            "fold_report": fold_report,
        },
    )


def default_experiments() -> tuple[QualificationExperiment, ...]:
    """Return the bounded, deterministic experiment matrix."""
    baseline = ModelVariant(name="baseline_locked")
    platt = ModelVariant(name="baseline_platt", calibration="platt")
    isotonic = ModelVariant(name="baseline_isotonic", calibration="isotonic")
    directional = ModelVariant(
        name="class_balance_platt",
        sample_weight_policy="class_balance",
        calibration="platt",
    )
    bounded_variants = (
        ModelVariant(name="xgb_baseline_platt", calibration="platt"),
        ModelVariant(
            name="xgb_shallow_regularized_platt",
            parameter_overrides=(
                ("max_depth", 3),
                ("min_child_weight", 5.0),
                ("learning_rate", 0.03),
                ("subsample", 0.90),
                ("colsample_bytree", 0.85),
                ("reg_alpha", 0.10),
                ("reg_lambda", 2.0),
            ),
            calibration="platt",
        ),
        ModelVariant(
            name="xgb_deeper_regularized_platt",
            parameter_overrides=(
                ("max_depth", 5),
                ("min_child_weight", 5.0),
                ("learning_rate", 0.02),
                ("subsample", 0.80),
                ("colsample_bytree", 0.75),
                ("reg_alpha", 0.10),
                ("reg_lambda", 2.0),
            ),
            calibration="platt",
        ),
    )
    volume_ablation = ModelVariant(
        name="drop_volume_features_platt",
        calibration="platt",
        feature_policy="drop_volume",
    )
    structure_ablation = ModelVariant(
        name="drop_v3_structure_features",
        feature_policy="drop_structure",
    )
    return (
        QualificationExperiment(name="baseline", variants=(baseline,)),
        QualificationExperiment(name="platt_calibration", variants=(platt,)),
        QualificationExperiment(name="isotonic_calibration", variants=(isotonic,)),
        QualificationExperiment(
            name="directional_bias_correction",
            variants=(directional,),
            tune_decision_threshold=True,
        ),
        QualificationExperiment(
            name="bounded_xgboost_search",
            variants=bounded_variants,
            tune_decision_threshold=True,
        ),
        QualificationExperiment(
            name="volume_feature_ablation",
            variants=(volume_ablation,),
            tune_decision_threshold=True,
        ),
        QualificationExperiment(
            name="structure_feature_ablation",
            variants=(structure_ablation,),
        ),
        QualificationExperiment(
            name=TWO_STAGE_EXPERIMENT_NAME,
            variants=(ModelVariant(name="actionable_v2_direction"),),
            mode="two_stage_actionable",
        ),
        QualificationExperiment(
            name=EVENT_TWO_STAGE_EXPERIMENT_NAME,
            variants=(ModelVariant(name="event_barrier_v3_direction"),),
            mode="two_stage_event",
        ),
        QualificationExperiment(
            name=EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
            variants=(ModelVariant(name="event_barrier_v4_pair_direction"),),
            mode="two_stage_event_pair_experts",
        ),
    )


def _feature_columns(policy: FeaturePolicy) -> list[str]:
    if policy == "all":
        return list(MULTITIMEFRAME_FEATURE_COLUMNS)
    if policy == "drop_volume":
        columns = [
            column
            for column in MULTITIMEFRAME_FEATURE_COLUMNS
            if not any(column.endswith(suffix) for suffix in VOLUME_FEATURE_SUFFIXES)
        ]
    elif policy == "drop_structure":
        columns = [
            column
            for column in MULTITIMEFRAME_FEATURE_COLUMNS
            if column not in STRUCTURE_GLOBAL_FEATURES
            and not any(
                column.endswith(suffix) for suffix in STRUCTURE_FEATURE_SUFFIXES
            )
        ]
    else:
        raise ValueError(f"Unsupported feature policy: {policy}")
    if not columns:
        raise ValueError("Feature ablation removed every model feature")
    return columns


def _time_slice(frame: pd.DataFrame, periods: pd.Index) -> pd.DataFrame:
    return frame.loc[frame["decision_time"].isin(periods)].copy()


def _nested_windows(
    training_window: pd.DataFrame,
    *,
    horizon_bars: int,
    min_inner_periods: int = 50,
) -> _NestedWindows:
    """Create chronological fit/early/calibration/selection windows with purges."""
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")
    times = pd.Index(
        pd.to_datetime(
            training_window["decision_time"],
            utc=True,
            errors="coerce",
        )
        .drop_duplicates()
        .sort_values()
    )
    if times.isna().any():
        raise ValueError("nested training window contains invalid decision times")

    early_count = max(min_inner_periods, int(len(times) * 0.10))
    calibration_count = max(min_inner_periods, int(len(times) * 0.10))
    selection_count = max(min_inner_periods, int(len(times) * 0.15))
    purge = horizon_bars
    fit_count = (
        len(times)
        - early_count
        - calibration_count
        - selection_count
        - (3 * purge)
    )
    if fit_count < max(2 * min_inner_periods, 100):
        raise ValueError("outer training window is too small for nested qualification")

    cursor = fit_count
    fit_periods = times[:cursor]
    cursor += purge
    early_periods = times[cursor : cursor + early_count]
    cursor += early_count + purge
    calibration_periods = times[cursor : cursor + calibration_count]
    cursor += calibration_count + purge
    selection_periods = times[cursor:]

    windows = _NestedWindows(
        fit=_time_slice(training_window, fit_periods),
        early_stop=_time_slice(training_window, early_periods),
        calibration=_time_slice(training_window, calibration_periods),
        selection=_time_slice(training_window, selection_periods),
    )
    if any(
        frame.empty
        for frame in (
            windows.fit,
            windows.early_stop,
            windows.calibration,
            windows.selection,
        )
    ):
        raise ValueError("nested qualification produced an empty inner window")
    return windows


def _refit_windows(
    training_window: pd.DataFrame,
    *,
    horizon_bars: int,
    min_inner_periods: int = 50,
) -> _RefitWindows:
    """Use the full outer-training era for a post-selection refit without outer leakage."""
    times = pd.Index(
        pd.to_datetime(
            training_window["decision_time"],
            utc=True,
            errors="coerce",
        )
        .drop_duplicates()
        .sort_values()
    )
    if times.isna().any():
        raise ValueError("refit training window contains invalid decision times")

    early_count = max(min_inner_periods, int(len(times) * 0.10))
    calibration_count = max(min_inner_periods, int(len(times) * 0.15))
    purge = horizon_bars
    fit_count = len(times) - early_count - calibration_count - (2 * purge)
    if fit_count < max(2 * min_inner_periods, 100):
        raise ValueError("outer training window is too small for leakage-safe refit")

    cursor = fit_count
    fit_periods = times[:cursor]
    cursor += purge
    early_periods = times[cursor : cursor + early_count]
    cursor += early_count + purge
    calibration_periods = times[cursor:]

    return _RefitWindows(
        fit=_time_slice(training_window, fit_periods),
        early_stop=_time_slice(training_window, early_periods),
        calibration=_time_slice(training_window, calibration_periods),
    )


def _ensure_actionable_target(frame: pd.DataFrame) -> pd.DataFrame:
    """Attach the research-only opportunity label without removing any rows."""
    result = frame.copy()
    long_net = pd.to_numeric(result[LONG_NET_RETURN_COLUMN], errors="coerce")
    short_net = pd.to_numeric(result[SHORT_NET_RETURN_COLUMN], errors="coerce")
    if not np.isfinite(long_net.to_numpy(dtype=float)).all():
        raise ValueError("actionable labels require finite long net returns")
    if not np.isfinite(short_net.to_numpy(dtype=float)).all():
        raise ValueError("actionable labels require finite short net returns")
    best_net = np.maximum(
        long_net.to_numpy(dtype=float),
        short_net.to_numpy(dtype=float),
    )
    result[ACTIONABLE_TARGET_COLUMN] = (best_net > 0.0).astype(int)
    return result


def _binary_class_balance_weights(
    frame: pd.DataFrame,
    *,
    target_column: str,
) -> np.ndarray:
    target = pd.to_numeric(frame[target_column], errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(target).all():
        raise ValueError(f"{target_column} class-balance weights require finite targets")
    if not np.isin(target, [0.0, 1.0]).all():
        raise ValueError(f"{target_column} must be binary")
    labels = target.astype(int)
    counts = np.bincount(labels, minlength=2).astype(float)
    if (counts <= 0.0).any():
        raise ValueError(f"{target_column} requires both classes")
    total = float(len(labels))
    per_class = np.sqrt(total / (2.0 * counts))
    weights = np.clip(per_class[labels], 0.5, 2.0)
    return (weights / float(weights.mean())).astype(float)


def _sample_weights(frame: pd.DataFrame, policy: SampleWeightPolicy) -> np.ndarray:
    if policy == "economic":
        return _economic_sample_weights(frame)
    if policy == "class_balance":
        return _class_balance_sample_weights(frame)
    raise ValueError(f"Unsupported sample-weight policy: {policy}")


def _model_for_variant(variant: ModelVariant) -> XGBClassifier:
    if not variant.parameter_overrides:
        return _build_model()
    params = _build_model().get_params()
    params.update(variant.overrides())
    return XGBClassifier(**params)


def _fit_binary_variant(
    variant: ModelVariant,
    *,
    fit: pd.DataFrame,
    early_stop: pd.DataFrame,
    feature_columns: list[str],
    target_column: str,
    sample_weight_policy: SampleWeightPolicy,
) -> XGBClassifier:
    if fit[target_column].nunique() < 2:
        raise ValueError(f"fit data contains one {target_column} class")
    if early_stop[target_column].nunique() < 2:
        raise ValueError(f"early-stop data contains one {target_column} class")

    model = _model_for_variant(variant)
    if target_column == TARGET_COLUMN:
        fit_weights = _sample_weights(fit, sample_weight_policy)
        early_weights = _class_balance_sample_weights(early_stop)
    else:
        fit_weights = _binary_class_balance_weights(
            fit,
            target_column=target_column,
        )
        early_weights = _binary_class_balance_weights(
            early_stop,
            target_column=target_column,
        )
    model.fit(
        fit[feature_columns],
        fit[target_column].astype(int),
        sample_weight=fit_weights,
        eval_set=[
            (
                early_stop[feature_columns],
                early_stop[target_column].astype(int),
            )
        ],
        sample_weight_eval_set=[early_weights],
        verbose=False,
    )
    return model


def _fit_variant(
    variant: ModelVariant,
    *,
    fit: pd.DataFrame,
    early_stop: pd.DataFrame,
    feature_columns: list[str],
) -> XGBClassifier:
    return _fit_binary_variant(
        variant,
        fit=fit,
        early_stop=early_stop,
        feature_columns=feature_columns,
        target_column=TARGET_COLUMN,
        sample_weight_policy=variant.sample_weight_policy,
    )


def _probabilities(
    model: XGBClassifier,
    frame: pd.DataFrame,
    feature_columns: list[str],
) -> np.ndarray:
    probabilities = model.predict_proba(frame[feature_columns])[:, 1]
    return np.clip(np.asarray(probabilities, dtype=float), 1e-7, 1.0 - 1e-7)


def _fit_calibrator(
    method: ExperimentCalibration,
    *,
    probabilities: np.ndarray,
    labels: np.ndarray,
) -> _CalibrationModel:
    if method == "none":
        return _CalibrationModel(method="none")
    if len(np.unique(labels)) < 2:
        raise ValueError("calibration window must contain both directional classes")

    clipped = np.clip(probabilities, 1e-7, 1.0 - 1e-7)
    if method == "platt":
        logits = np.log(clipped / (1.0 - clipped)).reshape(-1, 1)
        estimator = LogisticRegression(
            random_state=42,
            solver="lbfgs",
            max_iter=1000,
        )
        estimator.fit(logits, labels.astype(int))
        return _CalibrationModel(method="platt", estimator=estimator)

    if method == "isotonic":
        class_counts = np.bincount(labels.astype(int), minlength=2)
        if len(labels) < MIN_ISOTONIC_ROWS or int(class_counts.min()) < MIN_ISOTONIC_CLASS_ROWS:
            raise ValueError(
                "isotonic calibration requires sufficient rows and both class counts"
            )
        estimator = IsotonicRegression(out_of_bounds="clip")
        estimator.fit(clipped, labels.astype(int))
        return _CalibrationModel(method="isotonic", estimator=estimator)

    raise ValueError(f"Unsupported calibration method: {method}")


def _apply_calibrator(
    calibrator: _CalibrationModel,
    probabilities: np.ndarray,
) -> np.ndarray:
    clipped = np.clip(probabilities, 1e-7, 1.0 - 1e-7)
    if calibrator.method == "none":
        return clipped
    if calibrator.method == "platt":
        logits = np.log(clipped / (1.0 - clipped)).reshape(-1, 1)
        calibrated = calibrator.estimator.predict_proba(logits)[:, 1]
    elif calibrator.method == "isotonic":
        calibrated = calibrator.estimator.predict(clipped)
    else:
        raise ValueError(f"Unsupported fitted calibrator: {calibrator.method}")
    return np.clip(np.asarray(calibrated, dtype=float), 1e-7, 1.0 - 1e-7)


def _select_decision_threshold(
    labels: np.ndarray,
    probabilities: np.ndarray,
) -> tuple[float, dict[str, float | None]]:
    """Tune only direction classification; confidence gating remains >= 0.60."""
    candidates: list[tuple[tuple[float, float, float, float], float, dict[str, float | None]]] = []
    true_long_fraction = float(np.asarray(labels, dtype=int).mean())
    for threshold in DECISION_THRESHOLD_GRID:
        metrics = compute_classification_metrics(
            labels,
            probabilities,
            threshold=threshold,
        )
        predicted_long_fraction = float((probabilities >= threshold).mean())
        key = (
            float(metrics["balanced_accuracy"] or 0.0),
            -abs(predicted_long_fraction - true_long_fraction),
            -float(metrics["brier_score"] or 1.0),
            -abs(threshold - 0.50),
        )
        candidates.append((key, threshold, metrics))
    _, threshold, metrics = max(candidates, key=lambda item: (item[0], -item[1]))
    return float(threshold), metrics


def _prediction_frame(
    source: pd.DataFrame,
    *,
    raw_probabilities: np.ndarray,
    calibrated_probabilities: np.ndarray,
    decision_threshold: float,
    confidence_floor: float,
    fold: int,
    experiment: str,
    variant: ModelVariant,
) -> pd.DataFrame:
    if confidence_floor < CONFIDENCE_FLOOR:
        raise ValueError("confidence floor must not be lowered below 0.60")
    columns = [
        "decision_time",
        "instrument",
        TARGET_COLUMN,
        LONG_NET_RETURN_COLUMN,
        SHORT_NET_RETURN_COLUMN,
        "m1_spread_bps",
    ]
    columns.extend(
        column for column in QUALIFICATION_REGIME_COLUMNS if column in source.columns
    )
    predictions = source[columns].copy()
    predictions["raw_positive_probability"] = raw_probabilities
    predictions["positive_probability"] = calibrated_probabilities
    predictions["predicted_long"] = calibrated_probabilities >= decision_threshold
    predictions["confidence"] = np.maximum(
        calibrated_probabilities,
        1.0 - calibrated_probabilities,
    )
    predictions["active_trade"] = predictions["confidence"] >= confidence_floor
    predictions["selected_net_return"] = np.where(
        predictions["predicted_long"],
        predictions[LONG_NET_RETURN_COLUMN],
        predictions[SHORT_NET_RETURN_COLUMN],
    )
    predictions["fold"] = fold
    predictions["experiment"] = experiment
    predictions["model_variant"] = variant.name
    predictions["calibration_method"] = variant.calibration
    predictions["decision_threshold"] = decision_threshold
    predictions["confidence_floor"] = confidence_floor
    return predictions


def _two_stage_prediction_frame(
    source: pd.DataFrame,
    *,
    direction_probabilities: np.ndarray,
    opportunity_probabilities: np.ndarray,
    confidence_floor: float,
    fold: int,
    experiment: str,
    variant: ModelVariant,
) -> pd.DataFrame:
    if confidence_floor < CONFIDENCE_FLOOR:
        raise ValueError("confidence floor must not be lowered below 0.60")
    columns = [
        "decision_time",
        "instrument",
        TARGET_COLUMN,
        ACTIONABLE_TARGET_COLUMN,
        LONG_NET_RETURN_COLUMN,
        SHORT_NET_RETURN_COLUMN,
        "m1_spread_bps",
    ]
    columns.extend(
        column for column in QUALIFICATION_REGIME_COLUMNS if column in source.columns
    )
    predictions = source[columns].copy()
    direction_probabilities = np.clip(
        np.asarray(direction_probabilities, dtype=float),
        1e-7,
        1.0 - 1e-7,
    )
    opportunity_probabilities = np.clip(
        np.asarray(opportunity_probabilities, dtype=float),
        1e-7,
        1.0 - 1e-7,
    )
    predictions["raw_positive_probability"] = direction_probabilities
    predictions["positive_probability"] = direction_probabilities
    predictions["predicted_long"] = direction_probabilities >= 0.50
    predictions["direction_confidence"] = np.maximum(
        direction_probabilities,
        1.0 - direction_probabilities,
    )
    predictions["opportunity_probability"] = opportunity_probabilities
    predictions["predicted_opportunity"] = (
        opportunity_probabilities >= confidence_floor
    )
    predictions["confidence"] = np.minimum(
        predictions["direction_confidence"],
        predictions["opportunity_probability"],
    )
    predictions["active_trade"] = (
        predictions["predicted_opportunity"]
        & (predictions["direction_confidence"] >= confidence_floor)
    )
    predictions["selected_net_return"] = np.where(
        predictions["predicted_long"],
        predictions[LONG_NET_RETURN_COLUMN],
        predictions[SHORT_NET_RETURN_COLUMN],
    )
    predictions["fold"] = fold
    predictions["experiment"] = experiment
    predictions["model_variant"] = variant.name
    predictions["calibration_method"] = "none"
    predictions["decision_threshold"] = 0.50
    predictions["confidence_floor"] = confidence_floor
    predictions["actionable_label_policy"] = ACTIONABLE_LABEL_POLICY
    return predictions


def _event_two_stage_prediction_frame(
    source: pd.DataFrame,
    *,
    direction_probabilities: np.ndarray,
    opportunity_probabilities: np.ndarray,
    confidence_floor: float,
    fold: int,
    experiment: str,
    variant: ModelVariant,
) -> pd.DataFrame:
    """Build full-stream predictions for the event/barrier two-stage experiment."""
    if confidence_floor < CONFIDENCE_FLOOR:
        raise ValueError("confidence floor must not be lowered below 0.60")
    columns = [
        "decision_time",
        "instrument",
        EVENT_DIRECTION_TARGET_COLUMN,
        EVENT_ACTIONABLE_TARGET_COLUMN,
        EVENT_LONG_NET_RETURN_COLUMN,
        EVENT_SHORT_NET_RETURN_COLUMN,
        EVENT_STEP_COLUMN,
        EVENT_BARRIER_RETURN_COLUMN,
        "m1_spread_bps",
    ]
    columns.extend(
        column for column in QUALIFICATION_REGIME_COLUMNS if column in source.columns
    )
    predictions = source[columns].copy()
    predictions[TARGET_COLUMN] = predictions[EVENT_DIRECTION_TARGET_COLUMN].astype(int)
    predictions[ACTIONABLE_TARGET_COLUMN] = predictions[
        EVENT_ACTIONABLE_TARGET_COLUMN
    ].astype(int)
    predictions[LONG_NET_RETURN_COLUMN] = predictions[
        EVENT_LONG_NET_RETURN_COLUMN
    ].astype(float)
    predictions[SHORT_NET_RETURN_COLUMN] = predictions[
        EVENT_SHORT_NET_RETURN_COLUMN
    ].astype(float)

    direction_probabilities = np.clip(
        np.asarray(direction_probabilities, dtype=float),
        1e-7,
        1.0 - 1e-7,
    )
    opportunity_probabilities = np.clip(
        np.asarray(opportunity_probabilities, dtype=float),
        1e-7,
        1.0 - 1e-7,
    )
    predictions["raw_positive_probability"] = direction_probabilities
    predictions["positive_probability"] = direction_probabilities
    predictions["predicted_long"] = direction_probabilities >= 0.50
    predictions["direction_confidence"] = np.maximum(
        direction_probabilities,
        1.0 - direction_probabilities,
    )
    predictions["opportunity_probability"] = opportunity_probabilities
    predictions["predicted_opportunity"] = (
        opportunity_probabilities >= confidence_floor
    )
    predictions["confidence"] = np.minimum(
        predictions["direction_confidence"],
        predictions["opportunity_probability"],
    )
    predictions["active_trade"] = (
        predictions["predicted_opportunity"]
        & (predictions["direction_confidence"] >= confidence_floor)
    )
    predictions["selected_net_return"] = np.where(
        predictions["predicted_long"],
        predictions[LONG_NET_RETURN_COLUMN],
        predictions[SHORT_NET_RETURN_COLUMN],
    )
    predictions["fold"] = fold
    predictions["experiment"] = experiment
    predictions["model_variant"] = variant.name
    predictions["calibration_method"] = "none"
    predictions["decision_threshold"] = 0.50
    predictions["confidence_floor"] = confidence_floor
    predictions["actionable_label_policy"] = EVENT_LABEL_POLICY
    predictions["event_label_policy"] = EVENT_LABEL_POLICY
    return predictions


def _opportunity_classification(
    predictions: pd.DataFrame,
    *,
    confidence_floor: float,
) -> dict[str, float | int | None] | None:
    required = {
        ACTIONABLE_TARGET_COLUMN,
        "opportunity_probability",
    }
    if not required.issubset(predictions.columns):
        return None
    return compute_classification_metrics(
        predictions[ACTIONABLE_TARGET_COLUMN].to_numpy(dtype=int),
        predictions["opportunity_probability"].to_numpy(dtype=float),
        threshold=confidence_floor,
    )


def _summarize_predictions(
    predictions: pd.DataFrame,
    *,
    horizon_bars: int,
    confidence_threshold: float = CONFIDENCE_FLOOR,
    decision_threshold: float = 0.50,
) -> dict[str, Any]:
    """Preserve directional metrics while using true joint coverage for two-stage rows."""
    summary = mtf_training._summarize_predictions(
        predictions,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_threshold,
        decision_threshold=decision_threshold,
    )
    if "opportunity_probability" not in predictions.columns:
        return summary

    if "event_label_policy" in predictions.columns:
        event_direction = predictions.loc[
            predictions[ACTIONABLE_TARGET_COLUMN] == 1
        ].copy()
        summary["event_direction_evaluated_rows"] = int(len(event_direction))
        if (
            not event_direction.empty
            and event_direction[TARGET_COLUMN].nunique() >= 2
        ):
            direction_summary = mtf_training._summarize_predictions(
                event_direction,
                horizon_bars=horizon_bars,
                confidence_threshold=confidence_threshold,
                decision_threshold=decision_threshold,
            )
            summary["classification"] = direction_summary["classification"]
            summary["diagnostics"]["directional_bias"] = direction_summary[
                "diagnostics"
            ]["directional_bias"]
            summary["diagnostics"]["event_direction_probability_quantiles"] = (
                direction_summary["diagnostics"]["probability_quantiles"]
            )
        else:
            summary["classification"]["balanced_accuracy"] = 0.0
            summary["classification"]["sample_count"] = int(len(event_direction))
            summary["diagnostics"]["warnings"] = list(
                dict.fromkeys(
                    [
                        *summary["diagnostics"].get("warnings", []),
                        "insufficient_event_direction_classes",
                    ]
                )
            )

    direction_coverage = dict(summary["diagnostics"]["confidence_coverage"])
    active_count = int(predictions["active_trade"].sum())
    joint_fraction = float(active_count / len(predictions)) if len(predictions) else 0.0
    summary["diagnostics"]["direction_only_confidence_coverage"] = direction_coverage
    summary["diagnostics"]["confidence_coverage"] = {
        "count": active_count,
        "fraction": joint_fraction,
        "policy": "opportunity_probability_and_direction_confidence_gte_floor",
    }
    summary["evidence_sufficiency_warnings"] = evidence_sufficiency_warnings(
        trade_or_period_count=int(summary["trading"]["trade_or_period_count"]),
        sharpe_ratio=(
            float(summary["trading"]["sharpe_ratio"])
            if summary["trading"]["sharpe_ratio"] is not None
            else None
        ),
        confidence_coverage=joint_fraction,
    )
    return summary


def _instrument_positive_fraction(
    predictions: pd.DataFrame,
    *,
    horizon_bars: int,
    confidence_floor: float,
    decision_threshold: float,
) -> float:
    if predictions.empty:
        return 0.0
    positive = 0
    total = 0
    for _, group in predictions.groupby("instrument", sort=True):
        summary = _summarize_predictions(
            group,
            horizon_bars=horizon_bars,
            confidence_threshold=confidence_floor,
            decision_threshold=decision_threshold,
        )
        total += 1
        if float(summary["trading"]["total_return"]) > 0.0:
            positive += 1
    return float(positive / total) if total else 0.0


def _inner_candidate_report(
    predictions: pd.DataFrame,
    *,
    horizon_bars: int,
    confidence_floor: float,
    decision_threshold: float,
) -> dict[str, Any]:
    summary = _summarize_predictions(
        predictions,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_floor,
        decision_threshold=decision_threshold,
    )
    positive_instrument_fraction = _instrument_positive_fraction(
        predictions,
        horizon_bars=horizon_bars,
        confidence_floor=confidence_floor,
        decision_threshold=decision_threshold,
    )
    return {
        "summary": summary,
        "positive_instrument_fraction": positive_instrument_fraction,
    }


def _inner_selection_key(report: dict[str, Any]) -> tuple[float, float, float, float, float]:
    summary = report["summary"]
    diagnostics = summary["diagnostics"]
    trading = summary["trading"]
    balanced = float(summary["classification"]["balanced_accuracy"])
    brier = float(summary["classification"]["brier_score"])
    instrument_fraction = float(report["positive_instrument_fraction"])
    trade_count = min(float(trading["trade_or_period_count"]), 30.0) / 30.0
    bias = abs(float(diagnostics["directional_bias"]["predicted_minus_true"]))
    return (
        balanced,
        -brier,
        instrument_fraction,
        trade_count,
        -bias,
    )


def _select_variant_inside_outer_training(
    training_window: pd.DataFrame,
    *,
    experiment: QualificationExperiment,
    horizon_bars: int,
    confidence_floor: float,
    min_inner_periods: int,
) -> tuple[ModelVariant, float, list[dict[str, Any]]]:
    windows = _nested_windows(
        training_window,
        horizon_bars=horizon_bars,
        min_inner_periods=min_inner_periods,
    )
    candidate_reports: list[dict[str, Any]] = []
    for variant in experiment.variants:
        feature_columns = _feature_columns(variant.feature_policy)
        try:
            model = _fit_variant(
                variant,
                fit=windows.fit,
                early_stop=windows.early_stop,
                feature_columns=feature_columns,
            )
            calibration_raw = _probabilities(
                model,
                windows.calibration,
                feature_columns,
            )
            calibrator = _fit_calibrator(
                variant.calibration,
                probabilities=calibration_raw,
                labels=windows.calibration[TARGET_COLUMN].to_numpy(dtype=int),
            )
            selection_raw = _probabilities(model, windows.selection, feature_columns)
            selection_probabilities = _apply_calibrator(calibrator, selection_raw)
            if experiment.tune_decision_threshold:
                decision_threshold, threshold_metrics = _select_decision_threshold(
                    windows.selection[TARGET_COLUMN].to_numpy(dtype=int),
                    selection_probabilities,
                )
            else:
                decision_threshold = 0.50
                threshold_metrics = compute_classification_metrics(
                    windows.selection[TARGET_COLUMN].to_numpy(dtype=int),
                    selection_probabilities,
                    threshold=decision_threshold,
                )
            predictions = _prediction_frame(
                windows.selection,
                raw_probabilities=selection_raw,
                calibrated_probabilities=selection_probabilities,
                decision_threshold=decision_threshold,
                confidence_floor=confidence_floor,
                fold=0,
                experiment=experiment.name,
                variant=variant,
            )
            report = _inner_candidate_report(
                predictions,
                horizon_bars=horizon_bars,
                confidence_floor=confidence_floor,
                decision_threshold=decision_threshold,
            )
            candidate_reports.append(
                {
                    "variant": variant.name,
                    "feature_policy": variant.feature_policy,
                    "sample_weight_policy": variant.sample_weight_policy,
                    "calibration": variant.calibration,
                    "parameter_overrides": variant.overrides(),
                    "decision_threshold": decision_threshold,
                    "threshold_selection_metrics": threshold_metrics,
                    "inner_selection": report,
                    "selection_key": list(_inner_selection_key(report)),
                    "eligible": True,
                }
            )
            del model
        except ValueError as exc:
            candidate_reports.append(
                {
                    "variant": variant.name,
                    "feature_policy": variant.feature_policy,
                    "sample_weight_policy": variant.sample_weight_policy,
                    "calibration": variant.calibration,
                    "parameter_overrides": variant.overrides(),
                    "eligible": False,
                    "reason": str(exc),
                }
            )
        gc.collect()

    eligible = [row for row in candidate_reports if row.get("eligible")]
    if not eligible:
        raise ValueError(f"No eligible inner candidate for experiment {experiment.name}")
    selected = max(
        eligible,
        key=lambda row: (tuple(row["selection_key"]), str(row["variant"])),
    )
    variant = next(
        item for item in experiment.variants if item.name == selected["variant"]
    )
    return variant, float(selected["decision_threshold"]), candidate_reports


def _fit_two_stage_for_outer(
    training_window: pd.DataFrame,
    *,
    variant: ModelVariant,
    horizon_bars: int,
) -> tuple[XGBClassifier, XGBClassifier, list[str], dict[str, int]]:
    """Fit opportunity on all rows and direction only on actionable training rows."""
    feature_columns = _feature_columns(variant.feature_policy)
    fit, early = _split_internal_early_stopping_tail(
        training_window,
        horizon_bars=horizon_bars,
    )
    opportunity_variant = ModelVariant(
        name="actionable_v2_opportunity",
        parameter_overrides=variant.parameter_overrides,
        sample_weight_policy="class_balance",
        calibration="none",
        feature_policy=variant.feature_policy,
    )
    opportunity_model = _fit_binary_variant(
        opportunity_variant,
        fit=fit,
        early_stop=early,
        feature_columns=feature_columns,
        target_column=ACTIONABLE_TARGET_COLUMN,
        sample_weight_policy="class_balance",
    )

    directional_fit = fit.loc[fit[ACTIONABLE_TARGET_COLUMN] == 1].copy()
    directional_early = early.loc[early[ACTIONABLE_TARGET_COLUMN] == 1].copy()
    direction_model = _fit_binary_variant(
        variant,
        fit=directional_fit,
        early_stop=directional_early,
        feature_columns=feature_columns,
        target_column=TARGET_COLUMN,
        sample_weight_policy=variant.sample_weight_policy,
    )
    counts = {
        "fit_rows": int(len(fit)),
        "early_stop_rows": int(len(early)),
        "actionable_fit_rows": int(len(directional_fit)),
        "actionable_early_stop_rows": int(len(directional_early)),
    }
    return direction_model, opportunity_model, feature_columns, counts


def _fit_event_two_stage_for_outer(
    training_window: pd.DataFrame,
    *,
    variant: ModelVariant,
    horizon_bars: int,
) -> tuple[XGBClassifier, XGBClassifier, list[str], dict[str, int]]:
    """Fit event opportunity on all rows and direction only on true event rows."""
    feature_columns = _feature_columns(variant.feature_policy)
    fit, early = _split_internal_early_stopping_tail(
        training_window,
        horizon_bars=horizon_bars,
    )
    opportunity_variant = ModelVariant(
        name="event_barrier_v3_opportunity",
        parameter_overrides=variant.parameter_overrides,
        sample_weight_policy="class_balance",
        calibration="none",
        feature_policy=variant.feature_policy,
    )
    opportunity_model = _fit_binary_variant(
        opportunity_variant,
        fit=fit,
        early_stop=early,
        feature_columns=feature_columns,
        target_column=EVENT_ACTIONABLE_TARGET_COLUMN,
        sample_weight_policy="class_balance",
    )

    directional_fit = fit.loc[
        fit[EVENT_ACTIONABLE_TARGET_COLUMN] == 1
    ].copy()
    directional_early = early.loc[
        early[EVENT_ACTIONABLE_TARGET_COLUMN] == 1
    ].copy()
    direction_model = _fit_binary_variant(
        variant,
        fit=directional_fit,
        early_stop=directional_early,
        feature_columns=feature_columns,
        target_column=EVENT_DIRECTION_TARGET_COLUMN,
        sample_weight_policy="class_balance",
    )
    counts = {
        "fit_rows": int(len(fit)),
        "early_stop_rows": int(len(early)),
        "event_actionable_fit_rows": int(len(directional_fit)),
        "event_actionable_early_stop_rows": int(len(directional_early)),
    }
    return direction_model, opportunity_model, feature_columns, counts


def _fit_selected_for_outer(
    training_window: pd.DataFrame,
    *,
    variant: ModelVariant,
    horizon_bars: int,
    min_inner_periods: int,
) -> tuple[XGBClassifier, _CalibrationModel, list[str]]:
    feature_columns = _feature_columns(variant.feature_policy)
    if (
        variant.name == "baseline_locked"
        and variant.calibration == "none"
        and variant.feature_policy == "all"
        and variant.sample_weight_policy == "economic"
        and not variant.parameter_overrides
    ):
        fit, early = _split_internal_early_stopping_tail(
            training_window,
            horizon_bars=horizon_bars,
        )
        model = _fit_variant(
            variant,
            fit=fit,
            early_stop=early,
            feature_columns=feature_columns,
        )
        return model, _CalibrationModel(method="none"), feature_columns

    windows = _refit_windows(
        training_window,
        horizon_bars=horizon_bars,
        min_inner_periods=min_inner_periods,
    )
    model = _fit_variant(
        variant,
        fit=windows.fit,
        early_stop=windows.early_stop,
        feature_columns=feature_columns,
    )
    calibration_raw = _probabilities(model, windows.calibration, feature_columns)
    calibrator = _fit_calibrator(
        variant.calibration,
        probabilities=calibration_raw,
        labels=windows.calibration[TARGET_COLUMN].to_numpy(dtype=int),
    )
    return model, calibrator, feature_columns


def _fold_report(
    predictions: pd.DataFrame,
    *,
    horizon_bars: int,
    confidence_floor: float,
    decision_threshold: float,
    model: XGBClassifier,
    feature_columns: list[str],
    selection: dict[str, Any],
    opportunity_model: XGBClassifier | None = None,
) -> dict[str, Any]:
    by_instrument = {
        instrument: _summarize_predictions(
            group,
            horizon_bars=horizon_bars,
            confidence_threshold=confidence_floor,
            decision_threshold=decision_threshold,
        )
        for instrument, group in predictions.groupby("instrument", sort=True)
    }
    report = {
        "aggregate": _summarize_predictions(
            predictions,
            horizon_bars=horizon_bars,
            confidence_threshold=confidence_floor,
            decision_threshold=decision_threshold,
        ),
        "by_instrument": by_instrument,
        "feature_importance_gain": feature_gain_diagnostics(
            model,
            feature_columns,
        ),
        "selection": selection,
    }
    opportunity = _opportunity_classification(
        predictions,
        confidence_floor=confidence_floor,
    )
    if opportunity is not None:
        report["opportunity_classification"] = opportunity
    if opportunity_model is not None:
        report["opportunity_feature_importance_gain"] = feature_gain_diagnostics(
            opportunity_model,
            feature_columns,
        )
    return report


def _locked_gate_snapshot() -> dict[str, float]:
    from app.domain.training.run_first_six_pair import DEFAULT_RESEARCH_GATE

    return dict(DEFAULT_RESEARCH_GATE)


def _qualification_gate_from_aggregate(
    *,
    overall: dict[str, Any],
    fold_reports: list[dict[str, Any]],
    by_instrument: dict[str, Any],
    opportunity_classification: dict[str, Any] | None = None,
) -> dict[str, Any]:
    thresholds = _locked_gate_snapshot()
    positive_folds = sum(
        1
        for fold in fold_reports
        if float(fold["aggregate"]["trading"]["total_return"]) > 0.0
    )
    positive_instruments = sum(
        1
        for report in by_instrument.values()
        if float(report["trading"]["total_return"]) > 0.0
    )
    fold_fraction = positive_folds / len(fold_reports) if fold_reports else 0.0
    instrument_fraction = (
        positive_instruments / len(by_instrument) if by_instrument else 0.0
    )
    classification = overall["classification"]
    trading = overall["trading"]
    observed = {
        "balanced_accuracy": classification["balanced_accuracy"],
        "sharpe_ratio": trading["sharpe_ratio"],
        "profit_factor": trading["profit_factor"],
        "max_drawdown": trading["max_drawdown"],
        "positive_fold_fraction": fold_fraction,
        "positive_instrument_fraction": instrument_fraction,
    }
    checks = {
        "balanced_accuracy": float(observed["balanced_accuracy"]) >= thresholds["min_balanced_accuracy"],
        "sharpe_ratio": (
            observed["sharpe_ratio"] is not None
            and float(observed["sharpe_ratio"]) >= thresholds["min_sharpe_ratio"]
        ),
        "profit_factor": (
            observed["profit_factor"] is not None
            and float(observed["profit_factor"]) >= thresholds["min_profit_factor"]
        ),
        "max_drawdown": float(observed["max_drawdown"]) <= thresholds["max_drawdown"],
        "positive_fold_fraction": fold_fraction >= thresholds["min_positive_fold_fraction"],
        "positive_instrument_fraction": instrument_fraction
        >= thresholds["min_positive_instrument_fraction"],
    }
    if opportunity_classification is not None:
        opportunity_balanced = float(
            opportunity_classification["balanced_accuracy"]
        )
        observed["opportunity_balanced_accuracy"] = opportunity_balanced
        checks["opportunity_balanced_accuracy"] = (
            opportunity_balanced >= thresholds["min_balanced_accuracy"]
        )
    return {
        "thresholds": thresholds,
        "observed": observed,
        "checks": checks,
        "research_gate_passed": all(checks.values()),
        "approved_for_staging": False,
        "approved_for_live": False,
    }


def _pooled_architecture_diagnostic(
    by_instrument: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Describe pair heterogeneity without changing model selection or promotion."""
    if not by_instrument:
        return {
            "status": "insufficient_instrument_evidence",
            "instrument_count": 0,
            "diagnostic_only": True,
        }

    balanced = [
        float(report["classification"]["balanced_accuracy"])
        for report in by_instrument.values()
    ]
    predicted_long = [
        float(report["diagnostics"]["directional_bias"]["predicted_long_fraction"])
        for report in by_instrument.values()
    ]
    confidence_coverage = [
        float(report["diagnostics"]["confidence_coverage"]["fraction"])
        for report in by_instrument.values()
    ]
    positive_count = sum(
        1
        for report in by_instrument.values()
        if float(report["trading"]["total_return"]) > 0.0
    )
    instrument_count = len(by_instrument)
    positive_fraction = float(positive_count / instrument_count)
    balanced_range = float(max(balanced) - min(balanced))
    predicted_long_range = float(max(predicted_long) - min(predicted_long))
    coverage_range = float(max(confidence_coverage) - min(confidence_coverage))

    # These are research-review heuristics, not promotion gates. They merely
    # surface cross-pair heterogeneity that would make a pooled result fragile.
    material_pair_heterogeneity = (
        balanced_range >= 0.05
        or predicted_long_range >= 0.20
        or coverage_range >= 0.20
    )
    normalization_follow_up = material_pair_heterogeneity
    mixture_of_experts_follow_up = bool(
        material_pair_heterogeneity
        and positive_fraction < _locked_gate_snapshot()["min_positive_instrument_fraction"]
    )
    status = (
        "pooled_architecture_remains_reasonable_for_research"
        if not material_pair_heterogeneity
        else "pooled_architecture_requires_pair_heterogeneity_follow_up"
    )

    return {
        "status": status,
        "instrument_count": instrument_count,
        "positive_instrument_fraction": positive_fraction,
        "balanced_accuracy_range": balanced_range,
        "predicted_long_fraction_range": predicted_long_range,
        "confidence_coverage_range": coverage_range,
        "material_pair_heterogeneity": material_pair_heterogeneity,
        "stronger_instrument_normalization_research_warranted": normalization_follow_up,
        "future_mixture_of_experts_research_warranted": mixture_of_experts_follow_up,
        "diagnostic_only": True,
        "note": (
            "This assessment is descriptive research evidence only. It does not "
            "remove weak instruments, alter the pooled runtime model, or change "
            "any research/final-test promotion gate."
        ),
    }


def _aggregate_experiment(
    *,
    name: str,
    prediction_frames: list[pd.DataFrame],
    fold_reports: list[dict[str, Any]],
    horizon_bars: int,
    confidence_floor: float,
) -> dict[str, Any]:
    predictions = pd.concat(prediction_frames, ignore_index=True).sort_values(
        ["decision_time", "instrument", "fold"]
    )
    overall = _summarize_predictions(
        predictions,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_floor,
        decision_threshold=0.50,
    )
    recorded_thresholds = sorted(
        float(value) for value in predictions["decision_threshold"].drop_duplicates()
    )
    overall["diagnostics"]["decision_threshold"] = {
        "policy": "selected_inside_each_outer_training_window",
        "observed_thresholds": recorded_thresholds,
    }
    by_instrument = {
        instrument: _summarize_predictions(
            group,
            horizon_bars=horizon_bars,
            confidence_threshold=confidence_floor,
            decision_threshold=0.50,
        )
        for instrument, group in predictions.groupby("instrument", sort=True)
    }
    opportunity_classification = _opportunity_classification(
        predictions,
        confidence_floor=confidence_floor,
    )
    gate = _qualification_gate_from_aggregate(
        overall=overall,
        fold_reports=fold_reports,
        by_instrument=by_instrument,
        opportunity_classification=opportunity_classification,
    )
    return {
        "experiment": name,
        "overall": overall,
        "opportunity_classification": opportunity_classification,
        "by_instrument": by_instrument,
        "pooled_architecture_diagnostic": _pooled_architecture_diagnostic(
            by_instrument
        ),
        "folds": fold_reports,
        "fold_count": len(fold_reports),
        "evaluated_rows": int(len(predictions)),
        "research_gate": gate,
        "decision_thresholds": recorded_thresholds,
        "confidence_floor": confidence_floor,
        "calibration_methods": sorted(
            str(value) for value in predictions["calibration_method"].drop_duplicates()
        ),
        "model_variants": sorted(
            str(value) for value in predictions["model_variant"].drop_duplicates()
        ),
    }


def _candidate_comparison_table(
    aggregates: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return one deterministic Baseline-vs-experiment metric row per strategy."""
    rows: list[dict[str, Any]] = []
    for name, report in aggregates.items():
        overall = report["overall"]
        classification = overall["classification"]
        trading = overall["trading"]
        observed = report["research_gate"]["observed"]
        rows.append(
            {
                "experiment": name,
                "balanced_accuracy": float(classification["balanced_accuracy"]),
                "opportunity_balanced_accuracy": (
                    float(report["opportunity_classification"]["balanced_accuracy"])
                    if report.get("opportunity_classification") is not None
                    else None
                ),
                "sharpe_ratio": (
                    float(trading["sharpe_ratio"])
                    if trading["sharpe_ratio"] is not None
                    else None
                ),
                "profit_factor": (
                    float(trading["profit_factor"])
                    if trading["profit_factor"] is not None
                    else None
                ),
                "max_drawdown": float(trading["max_drawdown"]),
                "positive_fold_fraction": float(observed["positive_fold_fraction"]),
                "positive_instrument_fraction": float(
                    observed["positive_instrument_fraction"]
                ),
                "trade_or_period_count": int(trading["trade_or_period_count"]),
                "confidence_coverage": float(
                    overall["diagnostics"]["confidence_coverage"]["fraction"]
                ),
                "brier_score": float(classification["brier_score"]),
                "calibration_methods": list(report["calibration_methods"]),
                "model_variants": list(report["model_variants"]),
                "research_gate_passed": bool(
                    report["research_gate"]["research_gate_passed"]
                ),
            }
        )
    return rows


def _metric_or_negative_infinity(value: Any) -> float:
    return float(value) if value is not None else float("-inf")


def _positive_return_concentration(values: list[float]) -> float | None:
    positive = [max(float(value), 0.0) for value in values]
    total = float(sum(positive))
    if total <= 0.0:
        return None
    return float(max(positive) / total)


def _broad_improvement_flag(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    base_class = baseline["overall"]["classification"]
    cand_class = candidate["overall"]["classification"]
    base_trade = baseline["overall"]["trading"]
    cand_trade = candidate["overall"]["trading"]
    base_gate = baseline["research_gate"]["observed"]
    cand_gate = candidate["research_gate"]["observed"]

    balanced_uplift = float(cand_class["balanced_accuracy"]) - float(
        base_class["balanced_accuracy"]
    )
    brier_delta = float(cand_class["brier_score"]) - float(base_class["brier_score"])
    fold_not_worse = float(cand_gate["positive_fold_fraction"]) >= float(
        base_gate["positive_fold_fraction"]
    )
    instrument_not_worse = float(cand_gate["positive_instrument_fraction"]) >= float(
        base_gate["positive_instrument_fraction"]
    )
    economics_not_both_worse = not (
        _metric_or_negative_infinity(cand_trade["sharpe_ratio"])
        < _metric_or_negative_infinity(base_trade["sharpe_ratio"])
        and _metric_or_negative_infinity(cand_trade["profit_factor"])
        < _metric_or_negative_infinity(base_trade["profit_factor"])
    )
    evidence_warnings = set(
        candidate["overall"].get("evidence_sufficiency_warnings", [])
    )
    small_sample_rejection = bool(
        {
            "very_small_non_overlapping_trade_sample",
            "high_sharpe_with_small_trade_sample",
        }
        & evidence_warnings
    )

    pair_profit_concentration = _positive_return_concentration(
        [
            float(report["trading"]["total_return"])
            for report in candidate["by_instrument"].values()
        ]
    )
    fold_profit_concentration = _positive_return_concentration(
        [
            float(report["aggregate"]["trading"]["total_return"])
            for report in candidate["folds"]
        ]
    )
    pair_concentration_rejection = bool(
        pair_profit_concentration is not None and pair_profit_concentration > 0.50
    )
    fold_concentration_rejection = bool(
        fold_profit_concentration is not None and fold_profit_concentration > 0.50
    )

    base_drawdown = float(base_trade["max_drawdown"])
    candidate_drawdown = float(cand_trade["max_drawdown"])
    material_drawdown_limit = max(base_drawdown + 0.005, base_drawdown * 1.25)
    material_drawdown_rejection = candidate_drawdown > material_drawdown_limit

    interesting = (
        balanced_uplift >= 0.002
        and brier_delta <= 0.002
        and fold_not_worse
        and instrument_not_worse
        and economics_not_both_worse
        and not small_sample_rejection
        and not pair_concentration_rejection
        and not fold_concentration_rejection
        and not material_drawdown_rejection
    )
    return {
        "interesting_for_follow_up": interesting,
        "balanced_accuracy_uplift": balanced_uplift,
        "brier_score_delta": brier_delta,
        "positive_fold_fraction_not_worse": fold_not_worse,
        "positive_instrument_fraction_not_worse": instrument_not_worse,
        "economics_not_both_worse": economics_not_both_worse,
        "small_sample_rejection": small_sample_rejection,
        "pair_positive_profit_concentration": pair_profit_concentration,
        "fold_positive_profit_concentration": fold_profit_concentration,
        "pair_concentration_rejection": pair_concentration_rejection,
        "fold_concentration_rejection": fold_concentration_rejection,
        "material_drawdown_limit": material_drawdown_limit,
        "material_drawdown_rejection": material_drawdown_rejection,
        "note": (
            "Research comparison only; this flag is not a promotion gate and cannot "
            "override the immutable research or untouched-test gates."
        ),
    }


def run_nested_qualification_experiments(
    dataset: pd.DataFrame,
    *,
    horizon_bars: int,
    confidence_floor: float = CONFIDENCE_FLOOR,
    max_splits: int = 5,
    min_train_periods: int | None = None,
    validation_periods: int | None = None,
    min_inner_periods: int = 50,
    experiments: tuple[QualificationExperiment, ...] | None = None,
    checkpoint_dir: str | Path | None = None,
    checkpoint_fingerprint: str | None = None,
) -> dict[str, Any]:
    """Evaluate fixed experiment strategies with nested selection and untouched outer folds."""
    if confidence_floor < CONFIDENCE_FLOOR:
        raise ValueError("confidence floor must not be lowered below 0.60")
    if dataset[TARGET_COLUMN].nunique() < 2:
        raise ValueError("qualification dataset must contain both directional classes")
    if experiments is None:
        experiments = default_experiments()
    if any(experiment.mode == "two_stage_actionable" for experiment in experiments):
        dataset = _ensure_actionable_target(dataset)
        if dataset[ACTIONABLE_TARGET_COLUMN].nunique() < 2:
            raise ValueError(
                "qualification dataset must contain actionable and no-trade classes"
            )
    if any(experiment.mode == "two_stage_event" for experiment in experiments):
        required_event_columns = {
            EVENT_ACTIONABLE_TARGET_COLUMN,
            EVENT_DIRECTION_TARGET_COLUMN,
            EVENT_LONG_NET_RETURN_COLUMN,
            EVENT_SHORT_NET_RETURN_COLUMN,
            EVENT_STEP_COLUMN,
            EVENT_BARRIER_RETURN_COLUMN,
        }
        missing_event = sorted(required_event_columns.difference(dataset.columns))
        if missing_event:
            raise ValueError(
                f"qualification dataset missing event-barrier columns: {missing_event}"
            )
        if dataset[EVENT_ACTIONABLE_TARGET_COLUMN].nunique() < 2:
            raise ValueError(
                "event qualification requires event and timeout/no-trade classes"
            )
        event_rows = dataset.loc[dataset[EVENT_ACTIONABLE_TARGET_COLUMN] == 1]
        if event_rows[EVENT_DIRECTION_TARGET_COLUMN].nunique() < 2:
            raise ValueError(
                "event qualification requires both event direction classes"
            )
    if not experiments or experiments[0].name != "baseline":
        raise ValueError("experiment matrix must start with the locked baseline")
    if (checkpoint_dir is None) != (checkpoint_fingerprint is None):
        raise ValueError(
            "checkpoint_dir and checkpoint_fingerprint must be provided together"
        )
    checkpoint_root = Path(checkpoint_dir) if checkpoint_dir is not None else None

    unique_periods = int(dataset["decision_time"].nunique())
    min_train = min_train_periods or max(250, int(unique_periods * 0.60))
    validation = validation_periods or max(100, int(unique_periods * 0.07))
    outer_splits = iter_purged_walk_forward_time_splits(
        dataset,
        time_column="decision_time",
        min_train_periods=min_train,
        validation_periods=validation,
        purge_periods=horizon_bars,
        embargo_periods=horizon_bars,
        max_splits=max_splits,
    )

    predictions_by_experiment: dict[str, list[pd.DataFrame]] = {
        experiment.name: [] for experiment in experiments
    }
    folds_by_experiment: dict[str, list[dict[str, Any]]] = {
        experiment.name: [] for experiment in experiments
    }

    completed_outer_folds = 0
    for fold_index, (outer_train, outer_validation) in enumerate(
        outer_splits,
        start=1,
    ):
        completed_outer_folds += 1
        for experiment in experiments:
            expected_checkpoint = _qualification_checkpoint_expected(
                outer_train,
                outer_validation,
            )
            if checkpoint_root is not None and checkpoint_fingerprint is not None:
                resumed = _load_qualification_checkpoint(
                    checkpoint_root,
                    fingerprint=checkpoint_fingerprint,
                    experiment_name=experiment.name,
                    fold_index=fold_index,
                    expected=expected_checkpoint,
                )
                if resumed is not None:
                    resumed_predictions, resumed_report = resumed
                    predictions_by_experiment[experiment.name].append(
                        resumed_predictions
                    )
                    folds_by_experiment[experiment.name].append(resumed_report)
                    continue

            opportunity_model: XGBClassifier | None = None
            if experiment.mode == "two_stage_actionable":
                if len(experiment.variants) != 1 or experiment.tune_decision_threshold:
                    raise ValueError(
                        "two-stage actionable research must remain a fixed bounded candidate"
                    )
                variant = experiment.variants[0]
                decision_threshold = 0.50
                (
                    model,
                    opportunity_model,
                    feature_columns,
                    training_counts,
                ) = _fit_two_stage_for_outer(
                    outer_train,
                    variant=variant,
                    horizon_bars=horizon_bars,
                )
                direction_probabilities = _probabilities(
                    model,
                    outer_validation,
                    feature_columns,
                )
                opportunity_probabilities = _probabilities(
                    opportunity_model,
                    outer_validation,
                    feature_columns,
                )
                predictions = _two_stage_prediction_frame(
                    outer_validation,
                    direction_probabilities=direction_probabilities,
                    opportunity_probabilities=opportunity_probabilities,
                    confidence_floor=confidence_floor,
                    fold=fold_index,
                    experiment=experiment.name,
                    variant=variant,
                )
                selection = {
                    "policy": "fixed_two_stage_actionable_v2_no_outer_tuning",
                    "selected_variant": variant.name,
                    "decision_threshold": decision_threshold,
                    "opportunity_threshold": confidence_floor,
                    "actionable_label_policy": ACTIONABLE_LABEL_POLICY,
                    "candidate_reports": [],
                    "training_counts": training_counts,
                }
            elif experiment.mode == "two_stage_event":
                if len(experiment.variants) != 1 or experiment.tune_decision_threshold:
                    raise ValueError(
                        "event-barrier research must remain a fixed bounded candidate"
                    )
                variant = experiment.variants[0]
                decision_threshold = 0.50
                (
                    model,
                    opportunity_model,
                    feature_columns,
                    training_counts,
                ) = _fit_event_two_stage_for_outer(
                    outer_train,
                    variant=variant,
                    horizon_bars=horizon_bars,
                )
                direction_probabilities = _probabilities(
                    model,
                    outer_validation,
                    feature_columns,
                )
                opportunity_probabilities = _probabilities(
                    opportunity_model,
                    outer_validation,
                    feature_columns,
                )
                predictions = _event_two_stage_prediction_frame(
                    outer_validation,
                    direction_probabilities=direction_probabilities,
                    opportunity_probabilities=opportunity_probabilities,
                    confidence_floor=confidence_floor,
                    fold=fold_index,
                    experiment=experiment.name,
                    variant=variant,
                )
                selection = {
                    "policy": "fixed_event_barrier_v3_no_outer_tuning",
                    "selected_variant": variant.name,
                    "decision_threshold": decision_threshold,
                    "opportunity_threshold": confidence_floor,
                    "event_label_policy": EVENT_LABEL_POLICY,
                    "candidate_reports": [],
                    "training_counts": training_counts,
                }
            else:
                if experiment.name == "baseline":
                    variant = experiment.variants[0]
                    decision_threshold = 0.50
                    selection = {
                        "policy": "locked_baseline_no_outer_or_inner_tuning",
                        "selected_variant": variant.name,
                        "decision_threshold": decision_threshold,
                        "candidate_reports": [],
                    }
                elif len(experiment.variants) == 1 and not experiment.tune_decision_threshold:
                    # A predeclared single calibration strategy has nothing to select.
                    # Fitting an extra inner model would add cost without adding
                    # scientific information. Calibration is still fitted only on
                    # the refit's inner calibration window before outer evaluation.
                    variant = experiment.variants[0]
                    decision_threshold = 0.50
                    selection = {
                        "policy": "fixed_candidate_inner_calibration_only",
                        "selected_variant": variant.name,
                        "decision_threshold": decision_threshold,
                        "candidate_reports": [],
                    }
                else:
                    variant, decision_threshold, candidate_reports = (
                        _select_variant_inside_outer_training(
                            outer_train,
                            experiment=experiment,
                            horizon_bars=horizon_bars,
                            confidence_floor=confidence_floor,
                            min_inner_periods=min_inner_periods,
                        )
                    )
                    selection = {
                        "policy": "nested_inner_selection_only",
                        "selected_variant": variant.name,
                        "decision_threshold": decision_threshold,
                        "candidate_reports": candidate_reports,
                    }

                model, calibrator, feature_columns = _fit_selected_for_outer(
                    outer_train,
                    variant=variant,
                    horizon_bars=horizon_bars,
                    min_inner_periods=min_inner_periods,
                )
                raw = _probabilities(model, outer_validation, feature_columns)
                calibrated = _apply_calibrator(calibrator, raw)
                predictions = _prediction_frame(
                    outer_validation,
                    raw_probabilities=raw,
                    calibrated_probabilities=calibrated,
                    decision_threshold=decision_threshold,
                    confidence_floor=confidence_floor,
                    fold=fold_index,
                    experiment=experiment.name,
                    variant=variant,
                )

            report = _fold_report(
                predictions,
                horizon_bars=horizon_bars,
                confidence_floor=confidence_floor,
                decision_threshold=decision_threshold,
                model=model,
                feature_columns=feature_columns,
                selection=selection,
                opportunity_model=opportunity_model,
            )
            report.update(
                {
                    "fold": fold_index,
                    "train_start": outer_train["decision_time"].min().isoformat(),
                    "train_end": outer_train["decision_time"].max().isoformat(),
                    "validation_start": outer_validation["decision_time"].min().isoformat(),
                    "validation_end": outer_validation["decision_time"].max().isoformat(),
                }
            )
            predictions_by_experiment[experiment.name].append(predictions)
            folds_by_experiment[experiment.name].append(report)
            if checkpoint_root is not None and checkpoint_fingerprint is not None:
                _write_qualification_checkpoint(
                    checkpoint_root,
                    fingerprint=checkpoint_fingerprint,
                    experiment_name=experiment.name,
                    fold_index=fold_index,
                    expected=expected_checkpoint,
                    predictions=predictions,
                    fold_report=report,
                )
            if opportunity_model is not None:
                del opportunity_model
            del model
            gc.collect()
        del outer_train, outer_validation
        gc.collect()

    if completed_outer_folds == 0:
        raise ValueError("qualification dataset produced no outer walk-forward folds")

    aggregates = {
        experiment.name: _aggregate_experiment(
            name=experiment.name,
            prediction_frames=predictions_by_experiment[experiment.name],
            fold_reports=folds_by_experiment[experiment.name],
            horizon_bars=horizon_bars,
            confidence_floor=confidence_floor,
        )
        for experiment in experiments
    }
    baseline = aggregates["baseline"]
    for name, report in aggregates.items():
        if name == "baseline":
            report["comparison_to_baseline"] = {
                "interesting_for_follow_up": False,
                "note": "Locked baseline reference.",
            }
        else:
            report["comparison_to_baseline"] = _broad_improvement_flag(
                baseline,
                report,
            )

    return {
        "report_version": 1,
        "purpose": "model_qualification_research_only",
        "horizon_bars": horizon_bars,
        "confidence_floor": confidence_floor,
        "actionable_label_policy": ACTIONABLE_LABEL_POLICY,
        "event_label_policy": EVENT_LABEL_POLICY,
        "untouched_final_test_used": False,
        "outer_validation_used_for_tuning": False,
        "experiment_count": len(experiments),
        "experiments": aggregates,
        "candidate_comparison_table": _candidate_comparison_table(aggregates),
        "governance": {
            "research_gates_lowered": False,
            "confidence_floor_lowered_below_0_60": False,
            "weak_pairs_removed": False,
            "bad_folds_removed": False,
            "live_approval_created": False,
            "real_money_order_placed": False,
        },
    }


def evaluate_qualification_corpora(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str | pd.Timestamp,
    report_path: str | Path,
    confidence_floor: float = CONFIDENCE_FLOOR,
    max_splits: int = 5,
) -> dict[str, Any]:
    """Load only the research 80% and run the nested experiment matrix."""
    if decision_time_before is None:
        raise ValueError("decision_time_before is required; untouched final 20% is excluded")
    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    pooled = _ensure_actionable_target(pooled)
    experiments = default_experiments()
    checkpoint_fingerprint = _qualification_checkpoint_fingerprint(
        dataset_sha256=hashes,
        decision_time_before=decision_time_before,
        horizon_bars=horizon_bars,
        confidence_floor=confidence_floor,
        max_splits=max_splits,
        experiments=experiments,
    )
    output = Path(report_path)
    checkpoint_dir = output.parent / f"{output.stem}.checkpoints"
    report = run_nested_qualification_experiments(
        pooled,
        horizon_bars=horizon_bars,
        confidence_floor=confidence_floor,
        max_splits=max_splits,
        experiments=experiments,
        checkpoint_dir=checkpoint_dir,
        checkpoint_fingerprint=checkpoint_fingerprint,
    )
    report["dataset_sha256"] = hashes
    report["qualification_checkpoint_policy"] = QUALIFICATION_CHECKPOINT_POLICY
    report["qualification_checkpoint_fingerprint"] = checkpoint_fingerprint
    report["qualification_decision_time_before"] = pd.Timestamp(
        decision_time_before
    ).isoformat()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temporary.replace(output)
    return {**report, "report_path": str(output)}


def _parse_dataset_args(values: list[str]) -> dict[str, str]:
    datasets: dict[str, str] = {}
    for value in values:
        instrument, separator, path = value.partition("=")
        if not separator or not instrument or not path:
            raise ValueError("--dataset must use INSTRUMENT=/path/to/corpus.csv")
        datasets[instrument.upper()] = path
    return datasets


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run nested six-pair model-qualification experiments"
    )
    parser.add_argument(
        "--dataset",
        action="append",
        required=True,
        help="INSTRUMENT=/path/to/MTF.csv (repeat for all six pairs)",
    )
    parser.add_argument("--horizon-bars", type=int, required=True)
    parser.add_argument("--decision-time-before", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--max-splits", type=int, default=5)
    parser.add_argument("--confidence-floor", type=float, default=CONFIDENCE_FLOOR)
    args = parser.parse_args()

    report = evaluate_qualification_corpora(
        _parse_dataset_args(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        report_path=args.report,
        confidence_floor=args.confidence_floor,
        max_splits=args.max_splits,
    )
    print(json.dumps(report, indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
