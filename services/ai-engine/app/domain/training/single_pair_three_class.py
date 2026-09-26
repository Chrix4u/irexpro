"""Bounded USDJPY three-class research: SHORT / NO_TRADE / LONG.

Research-only. Reuses the frozen v4 corpus and preserves the locked 0.60
confidence floor, purge/embargo, and future-holdout boundary.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBClassifier

from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS
from app.domain.training.model_qualification import (
    ACTIONABLE_TARGET_COLUMN,
    CONFIDENCE_FLOOR,
    ModelVariant,
    OPPORTUNITY_CLASSIFICATION_THRESHOLD,
    _fit_binary_variant,
    _opportunity_classification,
    _probabilities,
    _summarize_predictions,
)
from app.domain.training.single_pair_final_test import _single_pair_final_gate
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
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_three_class_v1"
THREE_CLASS_TARGET = "three_class_target"
SHORT_CLASS = 0
NO_TRADE_CLASS = 1
LONG_CLASS = 2

LOCKED_GATE = {
    "min_balanced_accuracy": 0.52,
    "min_sharpe_ratio": 1.0,
    "min_profit_factor": 1.15,
    "max_drawdown": 0.12,
    "min_positive_fold_fraction": 0.60,
    "min_positive_instrument_fraction": 0.67,
}


def _attach_target(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    actionable = pd.to_numeric(
        result[EVENT_ACTIONABLE_TARGET_COLUMN], errors="raise"
    ).astype(int)
    direction = pd.to_numeric(
        result[EVENT_DIRECTION_TARGET_COLUMN], errors="raise"
    ).astype(int)
    if not actionable.isin((0, 1)).all() or not direction.isin((0, 1)).all():
        raise ValueError("three-class target requires binary event labels")
    target = np.full(len(result), NO_TRADE_CLASS, dtype=int)
    target[(actionable == 1) & (direction == 0)] = SHORT_CLASS
    target[(actionable == 1) & (direction == 1)] = LONG_CLASS
    result[THREE_CLASS_TARGET] = target
    return result


def _weights(labels: pd.Series) -> np.ndarray:
    y = pd.to_numeric(labels, errors="raise").to_numpy(dtype=int)
    counts = np.bincount(y, minlength=3).astype(float)
    if (counts <= 0).any():
        raise ValueError("three-class training requires SHORT, NO_TRADE and LONG")
    total = float(len(y))
    per_class = np.sqrt(total / (3.0 * counts))
    weights = np.clip(per_class[y], 0.35, 3.0)
    return (weights / float(weights.mean())).astype(float)


def _model() -> XGBClassifier:
    return XGBClassifier(
        objective="multi:softprob",
        num_class=3,
        eval_metric="mlogloss",
        n_estimators=600,
        learning_rate=0.025,
        max_depth=4,
        min_child_weight=3.0,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=0.05,
        reg_lambda=1.2,
        random_state=42,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=50,
    )


def _fit(training: pd.DataFrame, *, horizon_bars: int):
    labeled = _attach_target(training)
    fit, early = _split_internal_early_stopping_tail(
        labeled, horizon_bars=horizon_bars
    )
    for name, part in (("fit", fit), ("early", early)):
        if set(part[THREE_CLASS_TARGET].unique()) != {0, 1, 2}:
            raise ValueError(f"three-class {name} partition lacks all classes")

    model = _model()
    model.fit(
        fit[MULTITIMEFRAME_FEATURE_COLUMNS],
        fit[THREE_CLASS_TARGET].astype(int),
        sample_weight=_weights(fit[THREE_CLASS_TARGET]),
        eval_set=[(
            early[MULTITIMEFRAME_FEATURE_COLUMNS],
            early[THREE_CLASS_TARGET].astype(int),
        )],
        sample_weight_eval_set=[_weights(early[THREE_CLASS_TARGET])],
        verbose=False,
    )

    opportunity_variant = ModelVariant(
        name="three_class_v1_opportunity",
        sample_weight_policy="class_balance",
    )
    opportunity = _fit_binary_variant(
        opportunity_variant,
        fit=fit,
        early_stop=early,
        feature_columns=list(MULTITIMEFRAME_FEATURE_COLUMNS),
        target_column=EVENT_ACTIONABLE_TARGET_COLUMN,
        sample_weight_policy="class_balance",
    )
    return model, opportunity, {
        "fit_rows": int(len(fit)),
        "early_stop_rows": int(len(early)),
        "fit_class_counts": {
            str(k): int(v)
            for k, v in fit[THREE_CLASS_TARGET].value_counts().sort_index().items()
        },
    }


def _predictions(
    source: pd.DataFrame,
    *,
    model: XGBClassifier,
    opportunity_model: XGBClassifier,
    confidence_floor: float,
    fold: int,
) -> pd.DataFrame:
    probabilities = np.asarray(
        model.predict_proba(source[MULTITIMEFRAME_FEATURE_COLUMNS]), dtype=float
    )
    if probabilities.shape != (len(source), 3):
        raise ValueError("three-class model returned unexpected probability shape")
    opportunity = np.clip(
        _probabilities(
            opportunity_model, source, list(MULTITIMEFRAME_FEATURE_COLUMNS)
        ),
        1e-7,
        1.0 - 1e-7,
    )

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
        c for c in QUALIFICATION_REGIME_COLUMNS if c in source.columns
    )
    out = source[columns].copy()
    out[TARGET_COLUMN] = out[EVENT_DIRECTION_TARGET_COLUMN].astype(int)
    out[ACTIONABLE_TARGET_COLUMN] = out[EVENT_ACTIONABLE_TARGET_COLUMN].astype(int)
    out[LONG_NET_RETURN_COLUMN] = out[EVENT_LONG_NET_RETURN_COLUMN].astype(float)
    out[SHORT_NET_RETURN_COLUMN] = out[EVENT_SHORT_NET_RETURN_COLUMN].astype(float)

    short_p = probabilities[:, SHORT_CLASS]
    no_trade_p = probabilities[:, NO_TRADE_CLASS]
    long_p = probabilities[:, LONG_CLASS]
    side_sum = np.maximum(short_p + long_p, 1e-12)
    positive_probability = np.clip(long_p / side_sum, 1e-7, 1.0 - 1e-7)
    predicted_class = probabilities.argmax(axis=1)
    side_probability = np.maximum(short_p, long_p)
    predicted_long = long_p >= short_p

    out["raw_positive_probability"] = positive_probability
    out["positive_probability"] = positive_probability
    out["predicted_long"] = predicted_long
    out["direction_confidence"] = side_probability
    out["opportunity_probability"] = opportunity
    out["predicted_opportunity"] = opportunity >= confidence_floor
    out["three_class_short_probability"] = short_p
    out["three_class_no_trade_probability"] = no_trade_p
    out["three_class_long_probability"] = long_p
    out["three_class_predicted_class"] = predicted_class
    out["confidence"] = np.minimum(opportunity, side_probability)
    out["active_trade"] = (
        (opportunity >= confidence_floor)
        & (predicted_class != NO_TRADE_CLASS)
        & (side_probability >= confidence_floor)
    )
    out["selected_net_return"] = np.where(
        out["predicted_long"],
        out[LONG_NET_RETURN_COLUMN],
        out[SHORT_NET_RETURN_COLUMN],
    )
    out["fold"] = fold
    out["experiment"] = EXPERIMENT_NAME
    out["model_variant"] = EXPERIMENT_NAME
    out["calibration_method"] = "none"
    out["decision_threshold"] = 0.50
    out["confidence_floor"] = confidence_floor
    out["confidence_policy"] = (
        "opportunity_gte_0_60_and_three_class_side_probability_gte_0_60"
    )
    out["actionable_label_policy"] = EVENT_LABEL_POLICY
    out["event_label_policy"] = EVENT_LABEL_POLICY
    return out


def _research_gate(
    predictions: pd.DataFrame,
    fold_summaries: list[dict[str, Any]],
    *,
    horizon_bars: int,
    confidence_floor: float,
) -> dict[str, Any]:
    overall = _summarize_predictions(
        predictions,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_floor,
    )
    opportunity = _opportunity_classification(
        predictions,
        classification_threshold=OPPORTUNITY_CLASSIFICATION_THRESHOLD,
    )
    positive_folds = sum(
        float(row["trading"]["total_return"]) > 0 for row in fold_summaries
    )
    fold_fraction = positive_folds / len(fold_summaries)
    instrument_fraction = 1.0 if float(overall["trading"]["total_return"]) > 0 else 0.0
    observed = {
        "balanced_accuracy": overall["classification"]["balanced_accuracy"],
        "opportunity_balanced_accuracy": opportunity["balanced_accuracy"],
        "sharpe_ratio": overall["trading"]["sharpe_ratio"],
        "profit_factor": overall["trading"]["profit_factor"],
        "max_drawdown": overall["trading"]["max_drawdown"],
        "positive_fold_fraction": fold_fraction,
        "positive_instrument_fraction": instrument_fraction,
    }
    checks = {
        "balanced_accuracy": float(observed["balanced_accuracy"]) >= 0.52,
        "opportunity_balanced_accuracy": float(observed["opportunity_balanced_accuracy"]) >= 0.52,
        "sharpe_ratio": observed["sharpe_ratio"] is not None and float(observed["sharpe_ratio"]) >= 1.0,
        "profit_factor": observed["profit_factor"] is not None and float(observed["profit_factor"]) >= 1.15,
        "max_drawdown": float(observed["max_drawdown"]) <= 0.12,
        "positive_fold_fraction": fold_fraction >= 0.60,
        "positive_instrument_fraction": instrument_fraction >= 0.67,
    }
    return {
        "observed": observed,
        "checks": checks,
        "passed": all(checks.values()),
        "active_trades": int(overall["active_trades"]),
        "warnings": overall.get("evidence_sufficiency_warnings", []),
    }


def evaluate(
    dataset_path: str | Path,
    *,
    instrument: str,
    horizon_bars: int,
    holdout_start: str,
    confidence_floor: float = CONFIDENCE_FLOOR,
    max_splits: int = 3,
) -> dict[str, Any]:
    if confidence_floor < CONFIDENCE_FLOOR:
        raise ValueError("confidence floor must remain >= 0.60")
    pooled, hashes = load_and_prepare_corpora(
        {instrument: dataset_path},
        horizon_bars=horizon_bars,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=0.0,
    )
    boundary = pd.Timestamp(holdout_start)
    boundary = (
        boundary.tz_localize("UTC")
        if boundary.tzinfo is None
        else boundary.tz_convert("UTC")
    )
    purge_boundary = boundary - pd.Timedelta(minutes=horizon_bars)
    research = pooled.loc[pooled["decision_time"] < purge_boundary].copy()
    holdout = pooled.loc[pooled["decision_time"] >= boundary].copy()
    if len(holdout) < 2500:
        raise ValueError("fresh holdout requires at least 2500 rows")

    unique_periods = int(research["decision_time"].nunique())
    min_train = max(250, int(unique_periods * 0.60))
    validation = max(100, int(unique_periods * 0.07))
    frames: list[pd.DataFrame] = []
    fold_summaries: list[dict[str, Any]] = []
    for fold, (train, valid) in enumerate(
        iter_purged_walk_forward_time_splits(
            research,
            time_column="decision_time",
            min_train_periods=min_train,
            validation_periods=validation,
            purge_periods=horizon_bars,
            embargo_periods=horizon_bars,
            max_splits=max_splits,
        ),
        start=1,
    ):
        model, opportunity_model, _ = _fit(train, horizon_bars=horizon_bars)
        pred = _predictions(
            valid,
            model=model,
            opportunity_model=opportunity_model,
            confidence_floor=confidence_floor,
            fold=fold,
        )
        frames.append(pred)
        fold_summaries.append(
            _summarize_predictions(
                pred,
                horizon_bars=horizon_bars,
                confidence_threshold=confidence_floor,
            )
        )

    qualification_predictions = pd.concat(frames, ignore_index=True)
    qualification = _research_gate(
        qualification_predictions,
        fold_summaries,
        horizon_bars=horizon_bars,
        confidence_floor=confidence_floor,
    )
    result: dict[str, Any] = {
        "policy": "usdJPY_three_class_bounded_v1",
        "experiment": EXPERIMENT_NAME,
        "dataset_sha256": hashes,
        "holdout_start": boundary.isoformat(),
        "qualification": qualification,
        "future_holdout": None,
        "approved_for_paper": False,
        "approved_for_live": False,
    }
    if not qualification["passed"]:
        return result

    final_model, final_opportunity, training_counts = _fit(
        research, horizon_bars=horizon_bars
    )
    future_predictions = _predictions(
        holdout,
        model=final_model,
        opportunity_model=final_opportunity,
        confidence_floor=confidence_floor,
        fold=0,
    )
    future_metrics = _summarize_predictions(
        future_predictions,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_floor,
    )
    future_opportunity = _opportunity_classification(
        future_predictions,
        classification_threshold=OPPORTUNITY_CLASSIFICATION_THRESHOLD,
    )
    gate = _single_pair_final_gate(future_metrics, future_opportunity)
    result["future_holdout"] = {
        "rows": int(len(holdout)),
        "start": holdout["decision_time"].min().isoformat(),
        "end": holdout["decision_time"].max().isoformat(),
        "training_counts": training_counts,
        "metrics": future_metrics,
        "opportunity_classification": future_opportunity,
        "gate": gate,
    }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--instrument", default="USDJPY")
    parser.add_argument("--horizon-bars", type=int, default=1)
    parser.add_argument("--holdout-start", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--confidence-floor", type=float, default=CONFIDENCE_FLOOR)
    args = parser.parse_args()
    report = evaluate(
        args.dataset,
        instrument=args.instrument.upper(),
        horizon_bars=args.horizon_bars,
        holdout_start=args.holdout_start,
        confidence_floor=args.confidence_floor,
    )
    path = Path(args.report)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
    print(json.dumps({
        "qualification": report["qualification"],
        "future_holdout_gate": (
            report["future_holdout"]["gate"]
            if report["future_holdout"] is not None
            else None
        ),
        "approved_for_paper": False,
        "approved_for_live": False,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
