"""USDJPY v32 barrier-normalized payoff research qualification.

Research-only. Reuses frozen v10 outer-fold opportunity/direction predictions
and retrains only the payoff regressors on each corresponding outer training
window. Payoff targets are expressed in causal event-barrier units so the
magnitude model is aligned with the event classifier's label scale.

No UAT/future-holdout rows are used. No PAPER/LIVE approval is produced.
"""
from __future__ import annotations

import argparse, glob, json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.training.model_qualification import (
    CONFIDENCE_FLOOR,
    DUAL_ACTION_MARGIN_FLOOR,
    EVENT_BARRIER_RETURN_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    ModelVariant,
    _feature_columns,
    _regression_model_for_variant,
    _summarize_predictions,
)
from app.domain.training.train_multitimeframe import (
    _split_internal_early_stopping_tail,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "event_barrier_v32_barrier_normalized_payoff"
MODEL_VARIANT = "event_barrier_v32_barrier_normalized_payoff"
PAYOFF_RATIO_FLOOR = 1.15
EXPECTED_UPSIDE_BARRIER_FLOOR = 1.0


def _fit_ratio_regressors(training_window: pd.DataFrame, *, horizon_bars: int):
    variant = ModelVariant(name=MODEL_VARIANT)
    features = _feature_columns(variant.feature_policy)
    fit, early = _split_internal_early_stopping_tail(
        training_window, horizon_bars=horizon_bars
    )

    def targets(frame: pd.DataFrame, side: str) -> tuple[np.ndarray, np.ndarray]:
        ret_col = (
            EVENT_LONG_NET_RETURN_COLUMN
            if side == "long"
            else EVENT_SHORT_NET_RETURN_COLUMN
        )
        returns_bps = (
            pd.to_numeric(frame[ret_col], errors="raise").to_numpy(float) * 10_000.0
        )
        barrier_bps = (
            pd.to_numeric(frame[EVENT_BARRIER_RETURN_COLUMN], errors="raise")
            .to_numpy(float)
            * 10_000.0
        )
        if not np.isfinite(barrier_bps).all() or np.any(barrier_bps <= 0):
            raise ValueError("barrier-normalized payoff requires positive finite barriers")
        normalized = returns_bps / barrier_bps
        return np.maximum(normalized, 0.0), np.maximum(-normalized, 0.0)

    models: dict[str, Any] = {}
    for side in ("long", "short"):
        fit_up, fit_down = targets(fit, side)
        early_up, early_down = targets(early, side)
        for component, y_fit, y_early in (
            ("upside", fit_up, early_up),
            ("downside", fit_down, early_down),
        ):
            model = _regression_model_for_variant(
                ModelVariant(name=f"{MODEL_VARIANT}_{side}_{component}")
            )
            model.fit(
                fit[features],
                y_fit,
                eval_set=[(early[features], y_early)],
                verbose=False,
            )
            models[f"{side}_{component}"] = model
    return models, features, len(fit), len(early)


def _apply_v32(
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

    lu = np.maximum(models["long_upside"].predict(val[features]), 0.0)
    ld = np.maximum(models["long_downside"].predict(val[features]), 0.0)
    su = np.maximum(models["short_upside"].predict(val[features]), 0.0)
    sd = np.maximum(models["short_downside"].predict(val[features]), 0.0)

    predicted_long = cp["predicted_long"].astype(bool).to_numpy()
    upside = np.where(predicted_long, lu, su)
    downside = np.where(predicted_long, ld, sd)
    net = upside - downside
    ratio = upside / np.maximum(downside, 1e-6)

    structural = (
        (pd.to_numeric(cp["confidence"], errors="raise").to_numpy(float) >= CONFIDENCE_FLOOR)
        & (
            pd.to_numeric(cp["action_probability_margin"], errors="raise").to_numpy(float)
            >= DUAL_ACTION_MARGIN_FLOOR
        )
    )
    payoff = (
        (upside >= EXPECTED_UPSIDE_BARRIER_FLOOR)
        & (net > 0.0)
        & (ratio >= PAYOFF_RATIO_FLOOR)
    )

    cp["expected_long_upside_barriers"] = lu
    cp["expected_long_downside_barriers"] = ld
    cp["expected_short_upside_barriers"] = su
    cp["expected_short_downside_barriers"] = sd
    cp["expected_selected_upside_barriers"] = upside
    cp["expected_selected_downside_barriers"] = downside
    cp["expected_selected_net_barriers"] = net
    cp["expected_payoff_ratio"] = ratio
    cp["barrier_consistency_pass"] = upside >= EXPECTED_UPSIDE_BARRIER_FLOOR
    cp["payoff_filter_pass"] = payoff
    cp["active_trade"] = structural & payoff
    cp["confidence_policy"] = (
        "v32_existing_opportunity_direction_confidence_margin_and_"
        "barrier_normalized_expected_upside_gte_1_and_payoff_ratio_gte_1_15"
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

    all_predictions = []
    fold_reports = []
    for fold, ((outer_train, outer_val), cp_path) in enumerate(zip(splits, cp_files), start=1):
        models, features, fit_rows, early_rows = _fit_ratio_regressors(
            outer_train, horizon_bars=1
        )
        cp = pd.read_csv(cp_path)
        pred = _apply_v32(cp, outer_val, models, features)
        pred_path = fold_dir / f"fold-{fold:02d}-v32.csv"
        pred.to_csv(pred_path, index=False)
        summary = _summarize_predictions(
            pred,
            horizon_bars=1,
            confidence_threshold=CONFIDENCE_FLOOR,
            decision_threshold=0.50,
        )
        t = summary["trading"]
        fold_reports.append(
            {
                "fold": fold,
                "train_start": str(outer_train["decision_time"].min()),
                "train_end": str(outer_train["decision_time"].max()),
                "validation_start": str(outer_val["decision_time"].min()),
                "validation_end": str(outer_val["decision_time"].max()),
                "fit_rows": fit_rows,
                "early_stop_rows": early_rows,
                "active_trades": int(pred["active_trade"].sum()),
                "trading": t,
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
    pos_fold = sum(float(f["trading"]["total_return"]) > 0 for f in fold_reports) / len(fold_reports)
    thresholds = {
        "max_drawdown": 0.12,
        "min_positive_fold_fraction": 0.6,
        "min_profit_factor": 1.15,
        "min_sharpe_ratio": 1.0,
    }
    checks = {
        "max_drawdown": float(trading["max_drawdown"]) <= thresholds["max_drawdown"],
        "positive_fold_fraction": pos_fold >= thresholds["min_positive_fold_fraction"],
        "profit_factor": trading["profit_factor"] is not None
        and float(trading["profit_factor"]) >= thresholds["min_profit_factor"],
        "sharpe_ratio": trading["sharpe_ratio"] is not None
        and float(trading["sharpe_ratio"]) >= thresholds["min_sharpe_ratio"],
        "minimum_trade_evidence_30": int(trading["trade_or_period_count"]) >= 30,
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
        "payoff_target": "side_net_return_bps_divided_by_causal_event_barrier_bps",
        "policy": {
            "confidence_floor": CONFIDENCE_FLOOR,
            "action_margin_floor": DUAL_ACTION_MARGIN_FLOOR,
            "expected_selected_upside_barriers_floor": EXPECTED_UPSIDE_BARRIER_FLOOR,
            "payoff_ratio_floor": PAYOFF_RATIO_FLOOR,
            "outer_validation_used_for_tuning": False,
        },
        "folds": fold_reports,
        "overall": overall,
        "positive_fold_fraction": pos_fold,
        "research_gate": {
            "thresholds": thresholds,
            "checks": checks,
            "research_gate_passed": all(checks.values()),
        },
    }
    output.write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps({
        "output": str(output),
        "active_trades": int(trading["trade_or_period_count"]),
        "sharpe_ratio": trading["sharpe_ratio"],
        "profit_factor": trading["profit_factor"],
        "max_drawdown": trading["max_drawdown"],
        "total_return": trading["total_return"],
        "positive_fold_fraction": pos_fold,
        "research_gate": report["research_gate"],
    }, indent=2))
    return report


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--cutoff", required=True)
    ap.add_argument("--checkpoint-root", required=True)
    ap.add_argument("--output", required=True)
    a=ap.parse_args()
    run(Path(a.dataset), a.cutoff, Path(a.checkpoint_root), Path(a.output))


if __name__ == "__main__":
    main()
