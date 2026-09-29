"""USDJPY v36 high-frequency friction-aware three-class research.

Research only. Targets a dense 5-minute scalping decision:
SHORT / NO_TRADE / LONG, where a side is actionable only when its exact-horizon
net return after observed entry/exit spread is at least +0.5 bps.

No future/UAT rows are used. Thresholds are frozen before outer validation.
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
    ModelVariant,
    _summarize_predictions,
)
from app.domain.training.train_multitimeframe import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_BARRIER_RETURN_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
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

EXPERIMENT = "v36_high_frequency_5m_three_class_net_0p5bps"
MODEL_VARIANT = EXPERIMENT
HORIZON_BARS = 5
MIN_NET_BPS = 0.50
MIN_NET_RETURN = MIN_NET_BPS / 10_000.0
SHORT_CLASS = 0
NO_TRADE_CLASS = 1
LONG_CLASS = 2
# Exploratory fixed research threshold; user-facing Research PAPER may later
# select 0.30-0.70, but outer validation does not tune this value.
CLASS_CONFIDENCE_FLOOR = 0.40
SUMMARY_CONFIDENCE_THRESHOLD = 0.60

ECONOMIC_GATE = {
    "min_sharpe_ratio": 1.0,
    "min_profit_factor": 1.15,
    "max_drawdown": 0.12,
    "min_positive_fold_fraction": 0.60,
    "min_trade_evidence": 500,
    "min_trade_density": 0.20,
    "max_median_minutes_between_entries": 2.0,
}


def _attach_dense_target(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    long_net = pd.to_numeric(out[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    short_net = pd.to_numeric(out[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    best = np.maximum(long_net, short_net)
    actionable = best >= MIN_NET_RETURN
    target = np.full(len(out), NO_TRADE_CLASS, dtype=int)
    target[actionable & (long_net > short_net)] = LONG_CLASS
    target[actionable & (short_net >= long_net)] = SHORT_CLASS
    out["v36_target"] = target
    out["v36_actionable"] = actionable.astype(int)
    return out


def _weights(labels: pd.Series) -> np.ndarray:
    y = labels.to_numpy(dtype=int)
    counts = np.bincount(y, minlength=3).astype(float)
    if (counts <= 0).any():
        raise ValueError(f"v36 requires all classes; counts={counts.tolist()}")
    # Tempered balancing: retain market prevalence while ensuring NO_TRADE does
    # not dominate and neither side disappears.
    total = float(len(y))
    per_class = np.sqrt(total / (3.0 * counts))
    weights = np.clip(per_class[y], 0.45, 2.5)
    return (weights / weights.mean()).astype(float)


def _model() -> XGBClassifier:
    return XGBClassifier(
        objective="multi:softprob",
        num_class=3,
        eval_metric="mlogloss",
        n_estimators=800,
        learning_rate=0.025,
        max_depth=5,
        min_child_weight=4.0,
        subsample=0.85,
        colsample_bytree=0.80,
        reg_alpha=0.10,
        reg_lambda=1.50,
        random_state=42,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=60,
    )


def _fit(training: pd.DataFrame):
    labeled = _attach_dense_target(training)
    fit, early = _split_internal_early_stopping_tail(labeled, horizon_bars=HORIZON_BARS)
    for name, part in (("fit", fit), ("early", early)):
        classes = set(part["v36_target"].unique())
        if classes != {SHORT_CLASS, NO_TRADE_CLASS, LONG_CLASS}:
            raise ValueError(f"v36 {name} lacks classes: {classes}")
    model = _model()
    model.fit(
        fit[MULTITIMEFRAME_FEATURE_COLUMNS],
        fit["v36_target"].astype(int),
        sample_weight=_weights(fit["v36_target"]),
        eval_set=[(early[MULTITIMEFRAME_FEATURE_COLUMNS], early["v36_target"].astype(int))],
        sample_weight_eval_set=[_weights(early["v36_target"])],
        verbose=False,
    )
    return model, {
        "fit_rows": int(len(fit)),
        "early_rows": int(len(early)),
        "fit_class_counts": {
            "SHORT": int((fit["v36_target"] == SHORT_CLASS).sum()),
            "NO_TRADE": int((fit["v36_target"] == NO_TRADE_CLASS).sum()),
            "LONG": int((fit["v36_target"] == LONG_CLASS).sum()),
        },
        "early_class_counts": {
            "SHORT": int((early["v36_target"] == SHORT_CLASS).sum()),
            "NO_TRADE": int((early["v36_target"] == NO_TRADE_CLASS).sum()),
            "LONG": int((early["v36_target"] == LONG_CLASS).sum()),
        },
    }


def _predict(source: pd.DataFrame, model: XGBClassifier, fold: int) -> pd.DataFrame:
    labeled = _attach_dense_target(source)
    prob = np.asarray(model.predict_proba(labeled[MULTITIMEFRAME_FEATURE_COLUMNS]), dtype=float)
    if prob.shape != (len(labeled), 3):
        raise ValueError(f"unexpected probability shape {prob.shape}")

    short_p, no_p, long_p = prob[:, 0], prob[:, 1], prob[:, 2]
    pred_class = prob.argmax(axis=1)
    class_conf = prob.max(axis=1)
    pred_long = long_p >= short_p
    side_conf = np.maximum(long_p, short_p)
    active = (pred_class != NO_TRADE_CLASS) & (class_conf >= CLASS_CONFIDENCE_FLOOR)

    cols = [
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
    cols += [c for c in QUALIFICATION_REGIME_COLUMNS if c in labeled.columns]
    out = labeled[cols].copy()

    exact_long = pd.to_numeric(labeled[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    exact_short = pd.to_numeric(labeled[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    true_long = exact_long > exact_short

    out[TARGET_COLUMN] = true_long.astype(int)
    out[ACTIONABLE_TARGET_COLUMN] = labeled["v36_actionable"].astype(int)
    out[LONG_NET_RETURN_COLUMN] = exact_long
    out[SHORT_NET_RETURN_COLUMN] = exact_short
    out["raw_positive_probability"] = np.clip(long_p / np.maximum(long_p + short_p, 1e-12), 1e-7, 1-1e-7)
    out["positive_probability"] = out["raw_positive_probability"]
    out["predicted_long"] = pred_long
    out["direction_confidence"] = side_conf
    out["opportunity_probability"] = 1.0 - no_p
    out["predicted_opportunity"] = pred_class != NO_TRADE_CLASS
    out["confidence"] = class_conf
    out["active_trade"] = active
    out["selected_net_return"] = np.where(pred_long, exact_long, exact_short)
    out["v36_true_class"] = labeled["v36_target"].astype(int)
    out["v36_predicted_class"] = pred_class
    out["v36_short_probability"] = short_p
    out["v36_no_trade_probability"] = no_p
    out["v36_long_probability"] = long_p
    out["fold"] = fold
    out["experiment"] = EXPERIMENT
    out["model_variant"] = MODEL_VARIANT
    out["calibration_method"] = "none"
    out["decision_threshold"] = 0.5
    out["confidence_floor"] = CLASS_CONFIDENCE_FLOOR
    out["confidence_policy"] = "predicted_non_no_trade_class_and_class_probability_gte_0_40"
    out["actionable_label_policy"] = f"exact_5m_best_side_net_return_gte_{MIN_NET_BPS}_bps"
    out["event_label_policy"] = out["actionable_label_policy"]
    return out


def _entry_density(pred: pd.DataFrame) -> dict[str, Any]:
    active = pred.loc[pred["active_trade"].astype(bool)].sort_values("decision_time")
    density = float(len(active) / len(pred)) if len(pred) else 0.0
    long_count = int(active["predicted_long"].astype(bool).sum())
    short_count = int(len(active) - long_count)
    if len(active) > 1:
        delta = (
            pd.to_datetime(active["decision_time"], utc=True)
            .diff()
            .dropna()
            .dt.total_seconds()
            / 60.0
        )
        median_minutes = float(delta.median())
        mean_minutes = float(delta.mean())
    else:
        median_minutes = None
        mean_minutes = None
    return {
        "rows": int(len(pred)),
        "trades": int(len(active)),
        "trade_density": density,
        "long_trades": long_count,
        "short_trades": short_count,
        "median_calendar_minutes_between_entries": median_minutes,
        "mean_calendar_minutes_between_entries": mean_minutes,
    }


def run(dataset: Path, cutoff: str, output: Path) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        {"USDJPY": dataset},
        horizon_bars=HORIZON_BARS,
        decision_time_before=cutoff,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=0.0,
    )

    unique_periods = int(pooled["decision_time"].nunique())
    min_train = max(250, int(unique_periods * 0.60))
    validation = max(100, int(unique_periods * 0.07))
    splits = list(
        iter_purged_walk_forward_time_splits(
            pooled,
            time_column="decision_time",
            min_train_periods=min_train,
            validation_periods=validation,
            purge_periods=HORIZON_BARS,
            embargo_periods=HORIZON_BARS,
            max_splits=3,
        )
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    cp_dir = output.parent / "checkpoints"
    cp_dir.mkdir(parents=True, exist_ok=True)

    all_pred: list[pd.DataFrame] = []
    folds: list[dict[str, Any]] = []
    for fold, (train, valid) in enumerate(splits, 1):
        model, train_counts = _fit(train)
        pred = _predict(valid, model, fold)
        cp = cp_dir / f"fold-{fold:02d}-v36.csv"
        pred.to_csv(cp, index=False)
        summary = _summarize_predictions(
            pred,
            horizon_bars=HORIZON_BARS,
            confidence_threshold=SUMMARY_CONFIDENCE_THRESHOLD,
        )
        folds.append({
            "fold": fold,
            "train_start": str(train["decision_time"].min()),
            "train_end": str(train["decision_time"].max()),
            "validation_start": str(valid["decision_time"].min()),
            "validation_end": str(valid["decision_time"].max()),
            "training_counts": train_counts,
            "density": _entry_density(pred),
            "trading": summary["trading"],
            "classification": summary["classification"],
            "checkpoint": str(cp),
        })
        all_pred.append(pred)

    combined = pd.concat(all_pred, ignore_index=True)
    overall = _summarize_predictions(
        combined,
        horizon_bars=HORIZON_BARS,
        confidence_threshold=SUMMARY_CONFIDENCE_THRESHOLD,
    )
    density = _entry_density(combined)
    trading = overall["trading"]
    positive_fold_fraction = (
        sum(float(f["trading"]["total_return"]) > 0 for f in folds) / len(folds)
    )

    checks = {
        "sharpe_ratio": trading["sharpe_ratio"] is not None
        and float(trading["sharpe_ratio"]) >= ECONOMIC_GATE["min_sharpe_ratio"],
        "profit_factor": trading["profit_factor"] is not None
        and float(trading["profit_factor"]) >= ECONOMIC_GATE["min_profit_factor"],
        "max_drawdown": float(trading["max_drawdown"]) <= ECONOMIC_GATE["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction
        >= ECONOMIC_GATE["min_positive_fold_fraction"],
        "minimum_trade_evidence": int(trading["trade_or_period_count"])
        >= ECONOMIC_GATE["min_trade_evidence"],
        "trade_density": density["trade_density"] >= ECONOMIC_GATE["min_trade_density"],
        "median_entry_interval": density["median_calendar_minutes_between_entries"] is not None
        and float(density["median_calendar_minutes_between_entries"])
        <= ECONOMIC_GATE["max_median_minutes_between_entries"],
        "two_sided_execution": density["long_trades"] > 0 and density["short_trades"] > 0,
    }

    report = {
        "experiment": EXPERIMENT,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "dataset_sha256": hashes,
        "qualification_decision_time_before": cutoff,
        "horizon_bars": HORIZON_BARS,
        "target": {
            "minimum_net_bps": MIN_NET_BPS,
            "classes": {"SHORT": 0, "NO_TRADE": 1, "LONG": 2},
            "policy": "exact_horizon_best_side_after_observed_entry_exit_spread",
        },
        "policy": {
            "class_confidence_floor": CLASS_CONFIDENCE_FLOOR,
            "outer_validation_used_for_threshold_selection": False,
            "overlapping_entries_allowed_in_research": True,
        },
        "folds": folds,
        "overall": overall,
        "density": density,
        "positive_fold_fraction": positive_fold_fraction,
        "research_gate": {
            "thresholds": ECONOMIC_GATE,
            "checks": checks,
            "research_gate_passed": all(checks.values()),
        },
    }
    output.write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps({
        "output": str(output),
        "trading": trading,
        "density": density,
        "positive_fold_fraction": positive_fold_fraction,
        "folds": [
            {
                "fold": f["fold"],
                "density": f["density"],
                "trading": f["trading"],
            }
            for f in folds
        ],
        "research_gate": report["research_gate"],
    }, indent=2, default=str))
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--cutoff", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run(Path(args.dataset), args.cutoff, Path(args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
