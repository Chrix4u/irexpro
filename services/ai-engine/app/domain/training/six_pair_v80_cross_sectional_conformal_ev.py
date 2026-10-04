"""v80 cross-sectional conformal net-EV router.

Research-only, pre-registered architecture.

A pooled six-pair model predicts friction-aware LONG and SHORT net return.
Only inner training history is used to calibrate per-pair conformal uncertainty.
At each outer-fold decision time, at most one pair/side is selected: the candidate
with the strongest positive lower confidence bound after the fixed uncertainty
and side-margin rules.

No outer-fold threshold tuning is allowed. The reserved future holdout remains
untouched and production eligibility is always false.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from app.domain.models.multitimeframe_features import (
    INITIAL_FOREX_UNIVERSE,
    MULTITIMEFRAME_FEATURE_COLUMNS,
)
from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "v80_cross_sectional_conformal_ev_v1"
PAIRS = tuple(INITIAL_FOREX_UNIVERSE)
HORIZON_BARS = 5
RESEARCH_CUTOFF = "2026-09-02T19:59:00Z"
EXTRA_SLIPPAGE_BPS = 0.25

# Pre-registered uncertainty / selection contract.
INNER_CALIBRATION_FRACTION = 0.20
CONFORMAL_COVERAGE = 0.80
MIN_PAIR_CALIBRATION_ROWS = 500
LCB_NET_FLOOR_BPS = 0.05
LCB_SIDE_MARGIN_BPS = 0.05
MAX_TRADES_PER_DECISION_TIME = 1

# Frozen qualification gates.
OUTER_FOLDS_REQUIRED = 3
MIN_FOLD_TRADES = 20
MIN_TRADES = 100
MAX_MEDIAN_GAP_MINUTES = 10.0
MIN_BALANCED_ACCURACY = 0.52
MIN_SHARPE = 1.0
MIN_PROFIT_FACTOR = 1.15
MAX_DRAWDOWN = 0.12
MIN_POSITIVE_FOLD_FRACTION = 2 / 3
MIN_POSITIVE_INSTRUMENT_FRACTION = 2 / 3
MIN_INSTRUMENT_COVERAGE_FRACTION = 2 / 3

FEATURES = list(MULTITIMEFRAME_FEATURE_COLUMNS)


def _regressor(seed: int) -> XGBRegressor:
    return XGBRegressor(
        objective="reg:squarederror",
        eval_metric="rmse",
        n_estimators=800,
        learning_rate=0.02,
        max_depth=4,
        min_child_weight=10.0,
        subsample=0.85,
        colsample_bytree=0.82,
        reg_alpha=0.25,
        reg_lambda=3.0,
        random_state=seed,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=70,
    )


def _split_fit_calibration(training: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    times = pd.Index(
        pd.to_datetime(training["decision_time"], utc=True)
        .drop_duplicates()
        .sort_values()
        .to_list()
    )
    if len(times) < 1500:
        raise ValueError("insufficient unique training periods for conformal split")

    calibration_periods = max(300, int(len(times) * INNER_CALIBRATION_FRACTION))
    calibration_start = len(times) - calibration_periods
    fit_end = calibration_start - HORIZON_BARS
    if fit_end < 900:
        raise ValueError("insufficient purged fit periods before conformal calibration")

    fit_times = set(times[:fit_end])
    calibration_times = set(times[calibration_start:])
    fit = training[pd.to_datetime(training["decision_time"], utc=True).isin(fit_times)].copy()
    calibration = training[
        pd.to_datetime(training["decision_time"], utc=True).isin(calibration_times)
    ].copy()
    if len(fit) < 3000 or len(calibration) < 1000:
        raise ValueError("insufficient rows for fit/calibration split")
    return fit.sort_values("decision_time"), calibration.sort_values("decision_time")


def _fit_models(training: pd.DataFrame, seed: int) -> tuple[XGBRegressor, XGBRegressor]:
    fit, early = _split_internal_early_stopping_tail(
        training,
        horizon_bars=HORIZON_BARS,
    )
    if len(fit) < 1000 or len(early) < 300:
        raise ValueError("insufficient rows for pooled regression fit/early split")

    models = []
    for offset, target in enumerate((LONG_NET_RETURN_COLUMN, SHORT_NET_RETURN_COLUMN)):
        model = _regressor(seed + offset)
        y_fit = pd.to_numeric(fit[target], errors="raise").to_numpy(float) * 10_000.0
        y_early = pd.to_numeric(early[target], errors="raise").to_numpy(float) * 10_000.0
        model.fit(
            fit[FEATURES],
            y_fit,
            eval_set=[(early[FEATURES], y_early)],
            verbose=False,
        )
        models.append(model)
    return models[0], models[1]


def _finite_sample_quantile(values: np.ndarray, coverage: float) -> float:
    finite = np.asarray(values, dtype=float)
    finite = finite[np.isfinite(finite)]
    if len(finite) == 0:
        raise ValueError("cannot calibrate conformal radius from empty residuals")
    finite.sort()
    rank = int(math.ceil((len(finite) + 1) * coverage)) - 1
    rank = min(max(rank, 0), len(finite) - 1)
    return float(finite[rank])


def _calibrate(
    calibration: pd.DataFrame,
    long_model: XGBRegressor,
    short_model: XGBRegressor,
) -> dict[str, Any]:
    frame = calibration[["decision_time", "instrument", LONG_NET_RETURN_COLUMN, SHORT_NET_RETURN_COLUMN]].copy()
    long_pred = long_model.predict(calibration[FEATURES]).astype(float)
    short_pred = short_model.predict(calibration[FEATURES]).astype(float)
    long_true = pd.to_numeric(calibration[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float) * 10_000.0
    short_true = pd.to_numeric(calibration[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float) * 10_000.0

    frame["long_abs_error_bps"] = np.abs(long_true - long_pred)
    frame["short_abs_error_bps"] = np.abs(short_true - short_pred)

    global_long = _finite_sample_quantile(
        frame["long_abs_error_bps"].to_numpy(float),
        CONFORMAL_COVERAGE,
    )
    global_short = _finite_sample_quantile(
        frame["short_abs_error_bps"].to_numpy(float),
        CONFORMAL_COVERAGE,
    )

    by_pair: dict[str, dict[str, Any]] = {}
    for pair in PAIRS:
        subset = frame[frame["instrument"] == pair]
        if len(subset) >= MIN_PAIR_CALIBRATION_ROWS:
            long_radius = _finite_sample_quantile(
                subset["long_abs_error_bps"].to_numpy(float),
                CONFORMAL_COVERAGE,
            )
            short_radius = _finite_sample_quantile(
                subset["short_abs_error_bps"].to_numpy(float),
                CONFORMAL_COVERAGE,
            )
            source = "PAIR"
        else:
            long_radius = global_long
            short_radius = global_short
            source = "GLOBAL_FALLBACK"
        by_pair[pair] = {
            "rows": int(len(subset)),
            "source": source,
            "long_radius_bps": long_radius,
            "short_radius_bps": short_radius,
        }

    return {
        "coverage": CONFORMAL_COVERAGE,
        "global_long_radius_bps": global_long,
        "global_short_radius_bps": global_short,
        "by_pair": by_pair,
    }


def _predict_outer(
    validation: pd.DataFrame,
    long_model: XGBRegressor,
    short_model: XGBRegressor,
    calibration: dict[str, Any],
) -> pd.DataFrame:
    result = validation[
        ["decision_time", "instrument", LONG_NET_RETURN_COLUMN, SHORT_NET_RETURN_COLUMN]
    ].copy()
    result["long_pred_bps"] = long_model.predict(validation[FEATURES]).astype(float)
    result["short_pred_bps"] = short_model.predict(validation[FEATURES]).astype(float)

    long_radius = result["instrument"].map(
        {pair: values["long_radius_bps"] for pair, values in calibration["by_pair"].items()}
    ).astype(float)
    short_radius = result["instrument"].map(
        {pair: values["short_radius_bps"] for pair, values in calibration["by_pair"].items()}
    ).astype(float)

    result["long_radius_bps"] = long_radius
    result["short_radius_bps"] = short_radius
    result["long_lcb_bps"] = result["long_pred_bps"] - long_radius
    result["short_lcb_bps"] = result["short_pred_bps"] - short_radius
    result["long_ucb_bps"] = result["long_pred_bps"] + long_radius
    result["short_ucb_bps"] = result["short_pred_bps"] + short_radius

    result["predicted_long"] = result["long_lcb_bps"] >= result["short_lcb_bps"]
    result["selected_lcb_bps"] = np.where(
        result["predicted_long"],
        result["long_lcb_bps"],
        result["short_lcb_bps"],
    )
    result["opposite_lcb_bps"] = np.where(
        result["predicted_long"],
        result["short_lcb_bps"],
        result["long_lcb_bps"],
    )
    result["lcb_margin_bps"] = result["selected_lcb_bps"] - result["opposite_lcb_bps"]

    long_exact = pd.to_numeric(result[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    short_exact = pd.to_numeric(result[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    result["true_long"] = long_exact > short_exact
    result["selected_net_return"] = np.where(
        result["predicted_long"],
        long_exact,
        short_exact,
    )

    eligible = (
        (result["selected_lcb_bps"] >= LCB_NET_FLOOR_BPS)
        & (result["lcb_margin_bps"] >= LCB_SIDE_MARGIN_BPS)
    )
    result["eligible"] = eligible
    result["active_trade"] = False

    eligible_rows = result.loc[eligible].copy()
    if not eligible_rows.empty:
        eligible_rows = eligible_rows.sort_values(
            ["decision_time", "selected_lcb_bps", "lcb_margin_bps", "instrument"],
            ascending=[True, False, False, True],
        )
        winners = eligible_rows.groupby("decision_time", sort=False).head(
            MAX_TRADES_PER_DECISION_TIME
        )
        result.loc[winners.index, "active_trade"] = True

    return result


def _balanced_accuracy(y_true: np.ndarray, y_pred: np.ndarray) -> float | None:
    recalls = []
    for cls in (False, True):
        mask = y_true == cls
        if not mask.any():
            return None
        recalls.append(float((y_pred[mask] == cls).mean()))
    return float(np.mean(recalls))


def _metrics(predictions: pd.DataFrame) -> dict[str, Any]:
    active = predictions.loc[predictions["active_trade"].astype(bool)].sort_values(
        "decision_time"
    )
    if active.empty:
        return {
            "trades": 0,
            "profit_factor": None,
            "sharpe": None,
            "max_drawdown": None,
            "balanced_accuracy": None,
            "total_return": 0.0,
            "win_rate": None,
            "median_gap_minutes": None,
            "long_trades": 0,
            "short_trades": 0,
            "instrument_trade_coverage_fraction": 0.0,
            "positive_instrument_fraction": 0.0,
            "instrument_metrics": {},
        }

    returns = pd.to_numeric(active["selected_net_return"], errors="raise").to_numpy(float)
    gains = float(returns[returns > 0].sum())
    losses = float(-returns[returns < 0].sum())
    profit_factor = gains / losses if losses > 0 else None
    standard_deviation = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0
    sharpe = (
        float(np.sqrt(len(returns)) * returns.mean() / standard_deviation)
        if standard_deviation > 0
        else None
    )

    equity = np.cumprod(1.0 + returns)
    equity_with_start = np.concatenate(([1.0], equity))
    peak = np.maximum.accumulate(equity_with_start)
    drawdown = np.where(peak > 0, (peak - equity_with_start) / peak, 0.0)

    y_true = active["true_long"].to_numpy(bool)
    y_pred = active["predicted_long"].to_numpy(bool)
    balanced_accuracy = _balanced_accuracy(y_true, y_pred)

    times = pd.to_datetime(active["decision_time"], utc=True)
    gaps = times.diff().dropna().dt.total_seconds() / 60.0
    long_trades = int(active["predicted_long"].sum())

    instrument_metrics: dict[str, Any] = {}
    positive_instruments = 0
    covered_instruments = 0
    for pair in PAIRS:
        subset = active[active["instrument"] == pair]
        pair_return = float(subset["selected_net_return"].sum()) if len(subset) else 0.0
        if len(subset):
            covered_instruments += 1
        if pair_return > 0:
            positive_instruments += 1
        instrument_metrics[pair] = {
            "trades": int(len(subset)),
            "total_return": pair_return,
            "win_rate": (
                float((subset["selected_net_return"] > 0).mean()) if len(subset) else None
            ),
        }

    return {
        "trades": int(len(active)),
        "profit_factor": profit_factor,
        "sharpe": sharpe,
        "max_drawdown": float(np.max(drawdown)),
        "balanced_accuracy": balanced_accuracy,
        "total_return": float(returns.sum()),
        "mean_return_bps": float(returns.mean() * 10_000.0),
        "win_rate": float((returns > 0).mean()),
        "median_gap_minutes": float(gaps.median()) if len(gaps) else None,
        "long_trades": long_trades,
        "short_trades": int(len(active) - long_trades),
        "instrument_trade_coverage_fraction": covered_instruments / len(PAIRS),
        "positive_instrument_fraction": positive_instruments / len(PAIRS),
        "instrument_metrics": instrument_metrics,
    }


def _fold_pass(metrics: dict[str, Any]) -> bool:
    return bool(
        metrics["trades"] >= MIN_FOLD_TRADES
        and metrics["profit_factor"] is not None
        and metrics["profit_factor"] >= MIN_PROFIT_FACTOR
        and metrics["sharpe"] is not None
        and metrics["sharpe"] >= MIN_SHARPE
        and metrics["max_drawdown"] is not None
        and metrics["max_drawdown"] <= MAX_DRAWDOWN
        and metrics["balanced_accuracy"] is not None
        and metrics["balanced_accuracy"] >= MIN_BALANCED_ACCURACY
        and metrics["total_return"] > 0
    )


def _final_status(folds: list[dict[str, Any]], combined: pd.DataFrame) -> dict[str, Any]:
    metrics = _metrics(combined)
    positive_fold_fraction = (
        sum(fold["metrics"]["total_return"] > 0 for fold in folds) / len(folds)
        if folds
        else 0.0
    )
    fold_gate_fraction = (
        sum(bool(fold["fold_gate_passed"]) for fold in folds) / len(folds)
        if folds
        else 0.0
    )
    checks = {
        "outer_fold_count": len(folds) >= OUTER_FOLDS_REQUIRED,
        "minimum_trade_evidence": metrics["trades"] >= MIN_TRADES,
        "frequency": (
            metrics["median_gap_minutes"] is not None
            and metrics["median_gap_minutes"] <= MAX_MEDIAN_GAP_MINUTES
        ),
        "balanced_accuracy": (
            metrics["balanced_accuracy"] is not None
            and metrics["balanced_accuracy"] >= MIN_BALANCED_ACCURACY
        ),
        "sharpe": metrics["sharpe"] is not None and metrics["sharpe"] >= MIN_SHARPE,
        "profit_factor": (
            metrics["profit_factor"] is not None
            and metrics["profit_factor"] >= MIN_PROFIT_FACTOR
        ),
        "max_drawdown": (
            metrics["max_drawdown"] is not None
            and metrics["max_drawdown"] <= MAX_DRAWDOWN
        ),
        "positive_return": metrics["total_return"] > 0,
        "positive_fold_fraction": (
            positive_fold_fraction >= MIN_POSITIVE_FOLD_FRACTION
        ),
        "fold_gate_fraction": fold_gate_fraction >= MIN_POSITIVE_FOLD_FRACTION,
        "instrument_coverage": (
            metrics["instrument_trade_coverage_fraction"]
            >= MIN_INSTRUMENT_COVERAGE_FRACTION
        ),
        "positive_instrument_fraction": (
            metrics["positive_instrument_fraction"]
            >= MIN_POSITIVE_INSTRUMENT_FRACTION
        ),
        "two_sided_execution": metrics["long_trades"] > 0 and metrics["short_trades"] > 0,
    }
    return {
        "research_challenger": all(checks.values()),
        "production_eligible": False,
        "checks": checks,
        "positive_fold_fraction": positive_fold_fraction,
        "fold_gate_fraction": fold_gate_fraction,
        "metrics": metrics,
    }


def run(
    *,
    corpus_dir: Path,
    output: Path,
    cutoff: str = RESEARCH_CUTOFF,
    max_splits: int = OUTER_FOLDS_REQUIRED,
) -> dict[str, Any]:
    datasets = {pair: corpus_dir / f"{pair}_MTF.csv" for pair in PAIRS}
    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=HORIZON_BARS,
        decision_time_before=cutoff,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=EXTRA_SLIPPAGE_BPS,
    )
    pooled = pooled.sort_values(["decision_time", "instrument"]).reset_index(drop=True)

    periods = int(pooled["decision_time"].nunique())
    splits = list(
        iter_purged_walk_forward_time_splits(
            pooled,
            time_column="decision_time",
            min_train_periods=max(600, int(periods * 0.50)),
            validation_periods=max(200, int(periods * 0.12)),
            purge_periods=HORIZON_BARS,
            embargo_periods=HORIZON_BARS,
            max_splits=max_splits,
        )
    )
    if not splits:
        raise ValueError("no purged walk-forward splits produced")

    output.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = output.parent / f"{output.stem}.checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    folds: list[dict[str, Any]] = []
    outer_predictions: list[pd.DataFrame] = []

    for fold_index, (training, validation) in enumerate(splits, 1):
        fit_training, conformal_calibration = _split_fit_calibration(training)
        long_model, short_model = _fit_models(
            fit_training,
            8000 + fold_index * 20,
        )
        calibration = _calibrate(
            conformal_calibration,
            long_model,
            short_model,
        )
        predictions = _predict_outer(
            validation,
            long_model,
            short_model,
            calibration,
        )
        metrics = _metrics(predictions)
        fold = {
            "fold": fold_index,
            "training_rows": int(len(training)),
            "fit_training_rows": int(len(fit_training)),
            "conformal_calibration_rows": int(len(conformal_calibration)),
            "validation_rows": int(len(validation)),
            "calibration": calibration,
            "metrics": metrics,
            "fold_gate_passed": _fold_pass(metrics),
        }
        folds.append(fold)
        outer_predictions.append(predictions)

        predictions.to_csv(
            checkpoint_dir / f"fold-{fold_index:02d}.csv",
            index=False,
        )
        partial = {
            "experiment": EXPERIMENT,
            "complete": False,
            "research_only": True,
            "production_eligible": False,
            "sealed_future_holdout_touched": False,
            "promotion_gates_unchanged": True,
            "research_cutoff": cutoff,
            "corpus_sha256": hashes,
            "policy": {
                "architecture": "pooled_long_short_regression_plus_pair_conformal_lcb_cross_sectional_top1",
                "inner_calibration_fraction": INNER_CALIBRATION_FRACTION,
                "conformal_coverage": CONFORMAL_COVERAGE,
                "min_pair_calibration_rows": MIN_PAIR_CALIBRATION_ROWS,
                "lcb_net_floor_bps": LCB_NET_FLOOR_BPS,
                "lcb_side_margin_bps": LCB_SIDE_MARGIN_BPS,
                "max_trades_per_decision_time": MAX_TRADES_PER_DECISION_TIME,
                "extra_slippage_bps": EXTRA_SLIPPAGE_BPS,
                "threshold_selection": "NONE_FIXED_PREDECLARED",
            },
            "folds": folds,
        }
        output.write_text(json.dumps(partial, indent=2, default=str))
        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "fold_gate_passed": fold["fold_gate_passed"],
                    "metrics": metrics,
                    "calibration_global": {
                        "long_radius_bps": calibration["global_long_radius_bps"],
                        "short_radius_bps": calibration["global_short_radius_bps"],
                    },
                },
                indent=2,
                default=str,
            ),
            flush=True,
        )

        remaining = len(splits) - fold_index
        required = 2 if len(splits) >= 3 else len(splits)
        positive = sum(item["metrics"]["total_return"] > 0 for item in folds)
        passed = sum(bool(item["fold_gate_passed"]) for item in folds)
        if positive + remaining < required or passed + remaining < required:
            partial["early_eliminated"] = True
            partial["early_elimination_reason"] = (
                "FROZEN_STABILITY_GATES_MATHEMATICALLY_UNREACHABLE"
            )
            output.write_text(json.dumps(partial, indent=2, default=str))
            print(
                json.dumps(
                    {
                        "early_eliminated": True,
                        "completed_folds": len(folds),
                        "remaining_folds_skipped": remaining,
                        "positive_folds": positive,
                        "fold_gate_passes": passed,
                    },
                    indent=2,
                ),
                flush=True,
            )
            return partial

    combined = pd.concat(outer_predictions, ignore_index=True)
    status = _final_status(folds, combined)
    report = {
        "experiment": EXPERIMENT,
        "complete": True,
        "research_only": True,
        "production_eligible": False,
        "sealed_future_holdout_touched": False,
        "promotion_gates_unchanged": True,
        "research_cutoff": cutoff,
        "corpus_sha256": hashes,
        "policy": {
            "architecture": "pooled_long_short_regression_plus_pair_conformal_lcb_cross_sectional_top1",
            "inner_calibration_fraction": INNER_CALIBRATION_FRACTION,
            "conformal_coverage": CONFORMAL_COVERAGE,
            "min_pair_calibration_rows": MIN_PAIR_CALIBRATION_ROWS,
            "lcb_net_floor_bps": LCB_NET_FLOOR_BPS,
            "lcb_side_margin_bps": LCB_SIDE_MARGIN_BPS,
            "max_trades_per_decision_time": MAX_TRADES_PER_DECISION_TIME,
            "extra_slippage_bps": EXTRA_SLIPPAGE_BPS,
            "threshold_selection": "NONE_FIXED_PREDECLARED",
        },
        "folds": folds,
        **status,
    }
    output.write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps(status, indent=2, default=str), flush=True)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cutoff", default=RESEARCH_CUTOFF)
    parser.add_argument("--max-splits", type=int, default=OUTER_FOLDS_REQUIRED)
    args = parser.parse_args()
    run(
        corpus_dir=args.corpus_dir,
        output=args.output,
        cutoff=args.cutoff,
        max_splits=args.max_splits,
    )
