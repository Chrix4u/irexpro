"""USDJPY v37 high-frequency expected-net-return ranker.

Research-only 5-minute architecture. Two regressors estimate friction-aware
LONG and SHORT net return in basis points. The higher predicted side is chosen.
A fold-local threshold is selected only from the inner early-stop training tail;
outer validation and future/UAT data never select the threshold.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS
from app.domain.training.model_qualification import ACTIONABLE_TARGET_COLUMN, _summarize_predictions
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

EXPERIMENT = "v37_high_frequency_5m_expected_net_ranker"
HORIZON_BARS = 5
SUMMARY_CONFIDENCE_THRESHOLD = 0.60
MIN_CALIBRATION_DENSITY = 0.20
MIN_CALIBRATION_ROWS = 500
MIN_SIDE_FRACTION = 0.05
CALIBRATION_MIN_PF = 1.05
CALIBRATION_MIN_MEAN_BPS = 0.0

GATE = {
    "min_sharpe_ratio": 1.0,
    "min_profit_factor": 1.15,
    "max_drawdown": 0.12,
    "min_positive_fold_fraction": 0.60,
    "min_trade_evidence": 500,
    "min_trade_density": 0.20,
    "max_median_minutes_between_entries": 2.0,
}


def _regressor(name: str) -> XGBRegressor:
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
        random_state=42 if name == "long" else 43,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=70,
    )


def _raw_pf(values_bps: np.ndarray) -> float | None:
    gains = float(values_bps[values_bps > 0].sum())
    losses = float(-values_bps[values_bps < 0].sum())
    if losses <= 0:
        return None if gains <= 0 else float("inf")
    return gains / losses


def _fit(training: pd.DataFrame):
    fit, early = _split_internal_early_stopping_tail(training, horizon_bars=HORIZON_BARS)
    features = list(MULTITIMEFRAME_FEATURE_COLUMNS)
    models: dict[str, XGBRegressor] = {}
    for side, column in (("long", LONG_NET_RETURN_COLUMN), ("short", SHORT_NET_RETURN_COLUMN)):
        y_fit = pd.to_numeric(fit[column], errors="raise").to_numpy(float) * 10_000.0
        y_early = pd.to_numeric(early[column], errors="raise").to_numpy(float) * 10_000.0
        model = _regressor(side)
        model.fit(
            fit[features],
            y_fit,
            eval_set=[(early[features], y_early)],
            verbose=False,
        )
        models[side] = model

    early_long_pred = models["long"].predict(early[features]).astype(float)
    early_short_pred = models["short"].predict(early[features]).astype(float)
    pred_long = early_long_pred >= early_short_pred
    predicted_best = np.maximum(early_long_pred, early_short_pred)
    realized_long = pd.to_numeric(early[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float) * 10_000.0
    realized_short = pd.to_numeric(early[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float) * 10_000.0
    realized_selected = np.where(pred_long, realized_long, realized_short)

    quantiles = np.linspace(0.0, 0.90, 37)
    candidate_thresholds = sorted(set(float(np.quantile(predicted_best, q)) for q in quantiles))
    rows: list[dict[str, Any]] = []
    valid_candidates: list[dict[str, Any]] = []
    for threshold in candidate_thresholds:
        mask = predicted_best >= threshold
        count = int(mask.sum())
        if count == 0:
            continue
        selected = realized_selected[mask]
        sides = pred_long[mask]
        density = count / len(early)
        long_fraction = float(sides.mean())
        short_fraction = 1.0 - long_fraction
        pf = _raw_pf(selected)
        row = {
            "threshold_bps": threshold,
            "rows": count,
            "density": density,
            "mean_realized_bps": float(selected.mean()),
            "median_realized_bps": float(np.median(selected)),
            "win_rate": float((selected > 0).mean()),
            "profit_factor": pf,
            "long_fraction": long_fraction,
            "short_fraction": short_fraction,
        }
        rows.append(row)
        if (
            count >= MIN_CALIBRATION_ROWS
            and density >= MIN_CALIBRATION_DENSITY
            and float(selected.mean()) > CALIBRATION_MIN_MEAN_BPS
            and pf is not None
            and np.isfinite(pf)
            and pf >= CALIBRATION_MIN_PF
            and long_fraction >= MIN_SIDE_FRACTION
            and short_fraction >= MIN_SIDE_FRACTION
        ):
            valid_candidates.append(row)

    # Highest-density threshold satisfying inner economic conditions. If no
    # threshold satisfies them, fail honestly and use the best inner PF among
    # density-eligible/two-sided candidates only for outer diagnostic scoring.
    calibration_passed = bool(valid_candidates)
    if valid_candidates:
        chosen = max(valid_candidates, key=lambda x: (x["density"], x["profit_factor"]))
    else:
        fallback = [
            r for r in rows
            if r["rows"] >= MIN_CALIBRATION_ROWS
            and r["density"] >= MIN_CALIBRATION_DENSITY
            and r["long_fraction"] >= MIN_SIDE_FRACTION
            and r["short_fraction"] >= MIN_SIDE_FRACTION
            and r["profit_factor"] is not None
            and np.isfinite(r["profit_factor"])
        ]
        if not fallback:
            raise ValueError("v37 inner calibration has no density-eligible two-sided threshold")
        chosen = max(fallback, key=lambda x: (x["profit_factor"], x["mean_realized_bps"]))

    return models, float(chosen["threshold_bps"]), {
        "fit_rows": int(len(fit)),
        "early_rows": int(len(early)),
        "calibration_passed": calibration_passed,
        "chosen": chosen,
        "candidate_count": len(rows),
        "eligible_candidate_count": len(valid_candidates),
        "top_candidates_by_pf": sorted(
            [r for r in rows if r["profit_factor"] is not None and np.isfinite(r["profit_factor"])],
            key=lambda x: x["profit_factor"],
            reverse=True,
        )[:10],
    }


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def _predict(source: pd.DataFrame, models, threshold_bps: float, fold: int) -> pd.DataFrame:
    features = list(MULTITIMEFRAME_FEATURE_COLUMNS)
    long_pred = models["long"].predict(source[features]).astype(float)
    short_pred = models["short"].predict(source[features]).astype(float)
    pred_long = long_pred >= short_pred
    predicted_best = np.maximum(long_pred, short_pred)
    predicted_margin = np.abs(long_pred - short_pred)
    active = predicted_best >= threshold_bps

    exact_long = pd.to_numeric(source[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    exact_short = pd.to_numeric(source[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    true_long = exact_long > exact_short
    dense_actionable = (np.maximum(exact_long, exact_short) >= 0.5 / 10_000.0)

    # Diagnostic pseudo-probabilities derived monotonically from predicted edge.
    direction_p = _sigmoid((long_pred - short_pred) / 0.75)
    opportunity_p = _sigmoid((predicted_best - threshold_bps) / 0.50)
    confidence = np.minimum(
        np.maximum(direction_p, 1.0 - direction_p),
        opportunity_p,
    )

    cols = [
        "decision_time", "instrument",
        EVENT_DIRECTION_TARGET_COLUMN, EVENT_ACTIONABLE_TARGET_COLUMN,
        EVENT_LONG_NET_RETURN_COLUMN, EVENT_SHORT_NET_RETURN_COLUMN,
        EVENT_STEP_COLUMN, EVENT_BARRIER_RETURN_COLUMN, "m1_spread_bps",
    ]
    cols += [c for c in QUALIFICATION_REGIME_COLUMNS if c in source.columns]
    out = source[cols].copy()
    out[TARGET_COLUMN] = true_long.astype(int)
    out[ACTIONABLE_TARGET_COLUMN] = dense_actionable.astype(int)
    out[LONG_NET_RETURN_COLUMN] = exact_long
    out[SHORT_NET_RETURN_COLUMN] = exact_short
    out["raw_positive_probability"] = direction_p
    out["positive_probability"] = direction_p
    out["predicted_long"] = pred_long
    out["direction_confidence"] = np.maximum(direction_p, 1.0 - direction_p)
    out["opportunity_probability"] = opportunity_p
    out["predicted_opportunity"] = active
    out["confidence"] = confidence
    out["active_trade"] = active
    out["selected_net_return"] = np.where(pred_long, exact_long, exact_short)
    out["predicted_long_net_bps"] = long_pred
    out["predicted_short_net_bps"] = short_pred
    out["predicted_best_net_bps"] = predicted_best
    out["predicted_side_margin_bps"] = predicted_margin
    out["selected_threshold_bps"] = threshold_bps
    out["fold"] = fold
    out["experiment"] = EXPERIMENT
    out["model_variant"] = EXPERIMENT
    out["calibration_method"] = "inner_early_stop_economic_density_calibration"
    out["decision_threshold"] = 0.5
    out["confidence_floor"] = SUMMARY_CONFIDENCE_THRESHOLD
    out["confidence_policy"] = "predicted_best_5m_net_bps_gte_inner_calibrated_threshold"
    out["actionable_label_policy"] = "exact_5m_best_side_net_return_gte_0p5bps"
    out["event_label_policy"] = out["actionable_label_policy"]
    return out


def _density(pred: pd.DataFrame) -> dict[str, Any]:
    active = pred.loc[pred["active_trade"].astype(bool)].sort_values("decision_time")
    long_count = int(active["predicted_long"].astype(bool).sum())
    short_count = int(len(active) - long_count)
    interval = None
    mean_interval = None
    if len(active) > 1:
        delta = pd.to_datetime(active["decision_time"], utc=True).diff().dropna().dt.total_seconds() / 60
        interval = float(delta.median())
        mean_interval = float(delta.mean())
    return {
        "rows": int(len(pred)),
        "trades": int(len(active)),
        "trade_density": float(len(active) / len(pred)) if len(pred) else 0.0,
        "long_trades": long_count,
        "short_trades": short_count,
        "median_calendar_minutes_between_entries": interval,
        "mean_calendar_minutes_between_entries": mean_interval,
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
    periods = int(pooled["decision_time"].nunique())
    min_train = max(250, int(periods * 0.60))
    validation = max(100, int(periods * 0.07))
    splits = list(iter_purged_walk_forward_time_splits(
        pooled,
        time_column="decision_time",
        min_train_periods=min_train,
        validation_periods=validation,
        purge_periods=HORIZON_BARS,
        embargo_periods=HORIZON_BARS,
        max_splits=3,
    ))

    output.parent.mkdir(parents=True, exist_ok=True)
    cp_dir = output.parent / "checkpoints"
    cp_dir.mkdir(parents=True, exist_ok=True)
    folds = []
    all_pred = []
    for fold, (train, valid) in enumerate(splits, 1):
        models, threshold, calibration = _fit(train)
        pred = _predict(valid, models, threshold, fold)
        cp = cp_dir / f"fold-{fold:02d}-v37.csv"
        pred.to_csv(cp, index=False)
        summary = _summarize_predictions(
            pred,
            horizon_bars=HORIZON_BARS,
            confidence_threshold=SUMMARY_CONFIDENCE_THRESHOLD,
        )
        folds.append({
            "fold": fold,
            "threshold_bps": threshold,
            "calibration": calibration,
            "density": _density(pred),
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
    density = _density(combined)
    trading = overall["trading"]
    positive_fold_fraction = sum(float(f["trading"]["total_return"]) > 0 for f in folds) / len(folds)
    calibration_fraction = sum(bool(f["calibration"]["calibration_passed"]) for f in folds) / len(folds)
    checks = {
        "inner_calibration_stability": calibration_fraction >= 2 / 3,
        "sharpe_ratio": trading["sharpe_ratio"] is not None and float(trading["sharpe_ratio"]) >= GATE["min_sharpe_ratio"],
        "profit_factor": trading["profit_factor"] is not None and float(trading["profit_factor"]) >= GATE["min_profit_factor"],
        "max_drawdown": float(trading["max_drawdown"]) <= GATE["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction >= GATE["min_positive_fold_fraction"],
        "minimum_trade_evidence": int(trading["trade_or_period_count"]) >= GATE["min_trade_evidence"],
        "trade_density": density["trade_density"] >= GATE["min_trade_density"],
        "median_entry_interval": density["median_calendar_minutes_between_entries"] is not None and float(density["median_calendar_minutes_between_entries"]) <= GATE["max_median_minutes_between_entries"],
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
        "policy": {
            "outer_validation_used_for_threshold_selection": False,
            "threshold_source": "inner_early_stop_only",
            "overlapping_entries_allowed_in_research": True,
        },
        "folds": folds,
        "overall": overall,
        "density": density,
        "positive_fold_fraction": positive_fold_fraction,
        "calibration_pass_fraction": calibration_fraction,
        "research_gate": {"thresholds": GATE, "checks": checks, "research_gate_passed": all(checks.values())},
    }
    output.write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps({
        "output": str(output),
        "trading": trading,
        "density": density,
        "positive_fold_fraction": positive_fold_fraction,
        "calibration_pass_fraction": calibration_fraction,
        "folds": [{
            "fold": f["fold"],
            "threshold_bps": f["threshold_bps"],
            "calibration_passed": f["calibration"]["calibration_passed"],
            "density": f["density"],
            "trading": f["trading"],
        } for f in folds],
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
