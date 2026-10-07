"""USDJPY v33 conditional-event payoff research qualification.

Research-only candidate. Reuses the frozen v10 outer-fold classifier
predictions, and changes only payoff severity modeling:

- LONG favorable severity is learned only from LONG event rows.
- LONG adverse severity is learned only from SHORT event rows.
- SHORT favorable severity is learned only from SHORT event rows.
- SHORT adverse severity is learned only from LONG event rows.

Targets are normalized by each row's causal event barrier. Runtime-style
expected favorable/adverse severity is then weighted by the already-frozen
LONG/SHORT event probabilities. No future-UAT rows are used and this runner
creates no PAPER/LIVE approval.
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.training.model_qualification import (
    CONFIDENCE_FLOOR,
    DUAL_ACTION_MARGIN_FLOOR,
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_BARRIER_RETURN_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    ModelVariant,
    _feature_columns,
    _locked_gate_snapshot,
    _opportunity_classification,
    _regression_model_for_variant,
    _summarize_predictions,
)
from app.domain.training.train_multitimeframe import (
    _split_internal_early_stopping_tail,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "event_barrier_v33_conditional_event_payoff"
MODEL_VARIANT = "event_barrier_v33_conditional_event_payoff"
PAYOFF_RATIO_FLOOR = 1.15
MIN_CONDITIONAL_FIT_ROWS = 500
MIN_CONDITIONAL_EARLY_ROWS = 100


def _barrier_units(frame: pd.DataFrame, return_column: str) -> np.ndarray:
    returns = (
        pd.to_numeric(frame[return_column], errors="raise").to_numpy(dtype=float)
        * 10_000.0
    )
    barriers = (
        pd.to_numeric(frame[EVENT_BARRIER_RETURN_COLUMN], errors="raise")
        .to_numpy(dtype=float)
        * 10_000.0
    )
    if (
        not np.isfinite(returns).all()
        or not np.isfinite(barriers).all()
        or np.any(barriers <= 0.0)
    ):
        raise ValueError("conditional payoff targets require finite positive barriers")
    return returns / barriers


def _conditional_rows(frame: pd.DataFrame, *, direction: int) -> pd.DataFrame:
    rows = frame.loc[
        (frame[EVENT_ACTIONABLE_TARGET_COLUMN] == 1)
        & (frame[EVENT_DIRECTION_TARGET_COLUMN] == direction)
    ].copy()
    return rows.sort_values(["decision_time", "instrument"]).reset_index(drop=True)


def _fit_regressor(
    *,
    fit_rows: pd.DataFrame,
    early_rows: pd.DataFrame,
    feature_columns: list[str],
    target_fit: np.ndarray,
    target_early: np.ndarray,
    name: str,
):
    if len(fit_rows) < MIN_CONDITIONAL_FIT_ROWS:
        raise ValueError(f"{name} conditional fit evidence too small: {len(fit_rows)}")
    if len(early_rows) < MIN_CONDITIONAL_EARLY_ROWS:
        raise ValueError(f"{name} conditional early-stop evidence too small: {len(early_rows)}")
    model = _regression_model_for_variant(ModelVariant(name=name))
    model.fit(
        fit_rows[feature_columns],
        target_fit,
        eval_set=[(early_rows[feature_columns], target_early)],
        verbose=False,
    )
    return model


def _fit_conditional_severity_models(training_window: pd.DataFrame, *, horizon_bars: int):
    variant = ModelVariant(name=MODEL_VARIANT)
    features = _feature_columns(variant.feature_policy)
    fit, early = _split_internal_early_stopping_tail(
        training_window,
        horizon_bars=horizon_bars,
    )

    fit_long = _conditional_rows(fit, direction=1)
    fit_short = _conditional_rows(fit, direction=0)
    early_long = _conditional_rows(early, direction=1)
    early_short = _conditional_rows(early, direction=0)

    fit_long_ret = _barrier_units(fit_long, EVENT_LONG_NET_RETURN_COLUMN)
    early_long_ret = _barrier_units(early_long, EVENT_LONG_NET_RETURN_COLUMN)
    fit_short_ret = _barrier_units(fit_short, EVENT_SHORT_NET_RETURN_COLUMN)
    early_short_ret = _barrier_units(early_short, EVENT_SHORT_NET_RETURN_COLUMN)

    # Adverse severity for a side is learned from rows where the opposite
    # side's event occurred, using that side's own realized return.
    fit_long_adverse = -_barrier_units(fit_short, EVENT_LONG_NET_RETURN_COLUMN)
    early_long_adverse = -_barrier_units(early_short, EVENT_LONG_NET_RETURN_COLUMN)
    fit_short_adverse = -_barrier_units(fit_long, EVENT_SHORT_NET_RETURN_COLUMN)
    early_short_adverse = -_barrier_units(early_long, EVENT_SHORT_NET_RETURN_COLUMN)

    targets = {
        "long_favorable": (
            fit_long,
            early_long,
            np.maximum(fit_long_ret, 0.0),
            np.maximum(early_long_ret, 0.0),
        ),
        "long_adverse": (
            fit_short,
            early_short,
            np.maximum(fit_long_adverse, 0.0),
            np.maximum(early_long_adverse, 0.0),
        ),
        "short_favorable": (
            fit_short,
            early_short,
            np.maximum(fit_short_ret, 0.0),
            np.maximum(early_short_ret, 0.0),
        ),
        "short_adverse": (
            fit_long,
            early_long,
            np.maximum(fit_short_adverse, 0.0),
            np.maximum(early_short_adverse, 0.0),
        ),
    }

    models: dict[str, Any] = {}
    for component, (fit_rows, early_rows, y_fit, y_early) in targets.items():
        models[component] = _fit_regressor(
            fit_rows=fit_rows,
            early_rows=early_rows,
            feature_columns=features,
            target_fit=y_fit,
            target_early=y_early,
            name=f"{MODEL_VARIANT}_{component}",
        )

    counts = {
        "fit_long_events": len(fit_long),
        "fit_short_events": len(fit_short),
        "early_long_events": len(early_long),
        "early_short_events": len(early_short),
    }
    return models, features, counts


def _apply_v33(
    checkpoint: pd.DataFrame,
    outer_validation: pd.DataFrame,
    models: dict[str, Any],
    features: list[str],
) -> pd.DataFrame:
    cp = checkpoint.copy().reset_index(drop=True)
    val = outer_validation.sort_values(["decision_time", "instrument"]).reset_index(drop=True)
    cp["decision_time"] = pd.to_datetime(cp["decision_time"], utc=True)
    val["decision_time"] = pd.to_datetime(val["decision_time"], utc=True)
    if len(cp) != len(val):
        raise ValueError(f"checkpoint/validation row mismatch: {len(cp)} != {len(val)}")
    if not cp[["decision_time", "instrument"]].equals(
        val[["decision_time", "instrument"]]
    ):
        raise ValueError("checkpoint rows do not match frozen outer validation")

    long_fav_sev = np.maximum(models["long_favorable"].predict(val[features]), 0.0)
    long_adv_sev = np.maximum(models["long_adverse"].predict(val[features]), 0.0)
    short_fav_sev = np.maximum(models["short_favorable"].predict(val[features]), 0.0)
    short_adv_sev = np.maximum(models["short_adverse"].predict(val[features]), 0.0)

    p_long = pd.to_numeric(cp["long_action_probability"], errors="raise").to_numpy(float)
    p_short = pd.to_numeric(cp["short_action_probability"], errors="raise").to_numpy(float)
    predicted_long = cp["predicted_long"].astype(bool).to_numpy()

    long_expected_fav = p_long * long_fav_sev
    long_expected_adv = p_short * long_adv_sev
    short_expected_fav = p_short * short_fav_sev
    short_expected_adv = p_long * short_adv_sev

    selected_fav = np.where(predicted_long, long_expected_fav, short_expected_fav)
    selected_adv = np.where(predicted_long, long_expected_adv, short_expected_adv)
    expected_net = selected_fav - selected_adv
    payoff_ratio = selected_fav / np.maximum(selected_adv, 1e-6)

    structural = (
        pd.to_numeric(cp["confidence"], errors="raise").to_numpy(float)
        >= CONFIDENCE_FLOOR
    ) & (
        pd.to_numeric(cp["action_probability_margin"], errors="raise").to_numpy(float)
        >= DUAL_ACTION_MARGIN_FLOOR
    )
    payoff_pass = (expected_net > 0.0) & (payoff_ratio >= PAYOFF_RATIO_FLOOR)

    cp["conditional_long_favorable_severity_barriers"] = long_fav_sev
    cp["conditional_long_adverse_severity_barriers"] = long_adv_sev
    cp["conditional_short_favorable_severity_barriers"] = short_fav_sev
    cp["conditional_short_adverse_severity_barriers"] = short_adv_sev
    cp["expected_long_favorable_barriers"] = long_expected_fav
    cp["expected_long_adverse_barriers"] = long_expected_adv
    cp["expected_short_favorable_barriers"] = short_expected_fav
    cp["expected_short_adverse_barriers"] = short_expected_adv
    cp["expected_selected_favorable_barriers"] = selected_fav
    cp["expected_selected_adverse_barriers"] = selected_adv
    cp["expected_selected_net_barriers"] = expected_net
    cp["expected_payoff_ratio"] = payoff_ratio
    cp["payoff_filter_pass"] = payoff_pass
    cp["active_trade"] = structural & payoff_pass
    cp["confidence_policy"] = (
        "v33_frozen_v10_opportunity_direction_confidence_margin_and_"
        "probability_weighted_conditional_event_payoff_ratio_gte_1_15"
    )
    cp["experiment"] = EXPERIMENT
    cp["model_variant"] = MODEL_VARIANT
    return cp


def run(dataset: Path, cutoff: str, checkpoint_root: Path, output: Path) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        {"USDJPY": dataset},
        horizon_bars=1,
        decision_time_before=cutoff,
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
            purge_periods=1,
            embargo_periods=1,
            max_splits=3,
        )
    )

    cp_files = sorted(
        glob.glob(
            str(
                checkpoint_root
                / "fold-*-event_barrier_hybrid_opportunity_dual_direction_payoff_risk.csv"
            )
        )
    )
    if len(cp_files) != len(splits):
        raise ValueError(f"expected {len(splits)} checkpoints, got {len(cp_files)}")

    output.parent.mkdir(parents=True, exist_ok=True)
    fold_dir = output.parent / "checkpoints"
    fold_dir.mkdir(parents=True, exist_ok=True)

    all_predictions: list[pd.DataFrame] = []
    folds: list[dict[str, Any]] = []
    for fold, ((outer_train, outer_val), cp_path) in enumerate(
        zip(splits, cp_files),
        start=1,
    ):
        models, features, counts = _fit_conditional_severity_models(
            outer_train,
            horizon_bars=1,
        )
        pred = _apply_v33(
            pd.read_csv(cp_path),
            outer_val,
            models,
            features,
        )
        pred_path = fold_dir / f"fold-{fold:02d}-v33.csv"
        pred.to_csv(pred_path, index=False)
        summary = _summarize_predictions(
            pred,
            horizon_bars=1,
            confidence_threshold=CONFIDENCE_FLOOR,
            decision_threshold=0.50,
        )
        folds.append(
            {
                "fold": fold,
                "train_start": str(outer_train["decision_time"].min()),
                "train_end": str(outer_train["decision_time"].max()),
                "validation_start": str(outer_val["decision_time"].min()),
                "validation_end": str(outer_val["decision_time"].max()),
                "conditional_training_counts": counts,
                "active_trades": int(pred["active_trade"].sum()),
                "trading": summary["trading"],
                "checkpoint": str(pred_path),
            }
        )
        all_predictions.append(pred)

    combined = pd.concat(all_predictions, ignore_index=True)
    overall = _summarize_predictions(
        combined,
        horizon_bars=1,
        confidence_threshold=CONFIDENCE_FLOOR,
        decision_threshold=0.50,
    )
    trading = overall["trading"]
    positive_fold_fraction = (
        sum(float(f["trading"]["total_return"]) > 0.0 for f in folds) / len(folds)
    )

    opportunity_classification = _opportunity_classification(combined)
    if opportunity_classification is None:
        raise ValueError("v33 requires frozen opportunity predictions")

    # Start from the exact locked project qualification gate and make it
    # strictly harder with a minimum evidence floor. Because this is a
    # single-pair run, positive_instrument_fraction is either 1 or 0.
    thresholds = {
        **_locked_gate_snapshot(),
        "min_trade_evidence": 30,
    }
    balanced_accuracy = float(overall["classification"]["balanced_accuracy"])
    opportunity_balanced_accuracy = float(
        opportunity_classification["balanced_accuracy"]
    )
    positive_instrument_fraction = (
        1.0 if float(trading["total_return"]) > 0.0 else 0.0
    )
    checks = {
        "balanced_accuracy": balanced_accuracy
        >= thresholds["min_balanced_accuracy"],
        "opportunity_balanced_accuracy": opportunity_balanced_accuracy
        >= thresholds["min_balanced_accuracy"],
        "sharpe_ratio": trading["sharpe_ratio"] is not None
        and float(trading["sharpe_ratio"]) >= thresholds["min_sharpe_ratio"],
        "profit_factor": trading["profit_factor"] is not None
        and float(trading["profit_factor"]) >= thresholds["min_profit_factor"],
        "max_drawdown": float(trading["max_drawdown"])
        <= thresholds["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction
        >= thresholds["min_positive_fold_fraction"],
        "positive_instrument_fraction": positive_instrument_fraction
        >= thresholds["min_positive_instrument_fraction"],
        "minimum_trade_evidence": int(trading["trade_or_period_count"])
        >= thresholds["min_trade_evidence"],
    }
    observed = {
        "balanced_accuracy": balanced_accuracy,
        "opportunity_balanced_accuracy": opportunity_balanced_accuracy,
        "sharpe_ratio": trading["sharpe_ratio"],
        "profit_factor": trading["profit_factor"],
        "max_drawdown": trading["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction,
        "positive_instrument_fraction": positive_instrument_fraction,
        "trade_or_period_count": int(trading["trade_or_period_count"]),
    }

    report = {
        "experiment": EXPERIMENT,
        "model_variant": MODEL_VARIANT,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "dataset_sha256": hashes,
        "qualification_decision_time_before": cutoff,
        "horizon_bars": 1,
        "classifier_source": "frozen v10 outer-fold checkpoints",
        "payoff_target": (
            "conditional_side_event_severity_in_causal_barrier_units_"
            "weighted_by_frozen_side_event_probabilities"
        ),
        "outer_validation_used_for_tuning": False,
        "future_uat_used_for_tuning": False,
        "policy": {
            "confidence_floor": CONFIDENCE_FLOOR,
            "action_margin_floor": DUAL_ACTION_MARGIN_FLOOR,
            "payoff_ratio_floor": PAYOFF_RATIO_FLOOR,
            "expected_net_floor_barriers": 0.0,
        },
        "folds": folds,
        "overall": overall,
        "opportunity_classification": opportunity_classification,
        "positive_fold_fraction": positive_fold_fraction,
        "research_gate": {
            "thresholds": thresholds,
            "observed": observed,
            "checks": checks,
            "research_gate_passed": all(checks.values()),
        },
    }
    output.write_text(json.dumps(report, indent=2, default=str))
    print(
        json.dumps(
            {
                "output": str(output),
                "active_trades": int(trading["trade_or_period_count"]),
                "sharpe_ratio": trading["sharpe_ratio"],
                "profit_factor": trading["profit_factor"],
                "max_drawdown": trading["max_drawdown"],
                "total_return": trading["total_return"],
                "win_rate": trading["win_rate"],
                "positive_fold_fraction": positive_fold_fraction,
                "fold_trade_counts": [f["active_trades"] for f in folds],
                "research_gate": report["research_gate"],
            },
            indent=2,
        )
    )
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--cutoff", required=True)
    ap.add_argument("--checkpoint-root", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    run(
        Path(args.dataset),
        args.cutoff,
        Path(args.checkpoint_root),
        Path(args.output),
    )


if __name__ == "__main__":
    main()
