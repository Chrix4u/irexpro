"""v79 pair-specific temporal-committee net-EV specialists.

Research-only architecture. Each pair is evaluated independently with three
temporal LONG/SHORT return-regression experts trained on different historical
windows. Admission uses fixed predeclared agreement / robust-EV rules. No outer
fold is used to tune thresholds, and the reserved future holdout is untouched.
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
from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "v79_temporal_committee_net_ev_v1"
PAIRS = ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
HORIZON_BARS = 5
RESEARCH_CUTOFF = "2026-09-02T19:59:00Z"
EXTRA_SLIPPAGE_BPS = 0.25
WINDOW_FRACTIONS = (1.0, 0.70, 0.45)
WINDOW_NAMES = ("full", "recent70", "recent45")
VOTES_REQUIRED = 2
ROBUST_NET_FLOOR_BPS = 0.05
MEDIAN_NET_FLOOR_BPS = 0.25
MEDIAN_MARGIN_FLOOR_BPS = 0.10
DISPERSION_CAP_BPS = 0.75

OUTER_FOLDS_REQUIRED = 3
MIN_TRADES = 100
MAX_MEDIAN_GAP_MINUTES = 10.0
MIN_BALANCED_ACCURACY = 0.52
MIN_SHARPE = 1.0
MIN_PROFIT_FACTOR = 1.15
MAX_DRAWDOWN = 0.12
MIN_POSITIVE_FOLD_FRACTION = 2 / 3

FEATURES = list(MULTITIMEFRAME_FEATURE_COLUMNS)


def _regressor(seed: int) -> XGBRegressor:
    return XGBRegressor(
        objective="reg:squarederror",
        eval_metric="rmse",
        n_estimators=700,
        learning_rate=0.02,
        max_depth=4,
        min_child_weight=8.0,
        subsample=0.85,
        colsample_bytree=0.82,
        reg_alpha=0.20,
        reg_lambda=2.5,
        random_state=seed,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=60,
    )


def _fit_one(training: pd.DataFrame, seed: int) -> tuple[XGBRegressor, XGBRegressor]:
    fit, early = _split_internal_early_stopping_tail(training, horizon_bars=HORIZON_BARS)
    if len(fit) < 250 or len(early) < 50:
        raise ValueError("insufficient temporal-window rows for stable fit/early split")

    models = []
    for offset, column in enumerate((LONG_NET_RETURN_COLUMN, SHORT_NET_RETURN_COLUMN)):
        model = _regressor(seed + offset)
        y_fit = pd.to_numeric(fit[column], errors="raise").to_numpy(float) * 10_000.0
        y_early = pd.to_numeric(early[column], errors="raise").to_numpy(float) * 10_000.0
        model.fit(
            fit[FEATURES],
            y_fit,
            eval_set=[(early[FEATURES], y_early)],
            verbose=False,
        )
        models.append(model)
    return models[0], models[1]


def _temporal_training_window(training: pd.DataFrame, fraction: float) -> pd.DataFrame:
    if fraction >= 0.999:
        return training.copy()
    rows = max(400, int(len(training) * fraction))
    return training.iloc[-rows:].copy()


def _fit_committee(training: pd.DataFrame, seed: int):
    experts = []
    for index, (name, fraction) in enumerate(zip(WINDOW_NAMES, WINDOW_FRACTIONS)):
        subset = _temporal_training_window(training, fraction)
        long_model, short_model = _fit_one(subset, seed + index * 100)
        experts.append(
            {
                "name": name,
                "fraction": fraction,
                "rows": int(len(subset)),
                "long": long_model,
                "short": short_model,
            }
        )
    return experts


def _predict(source: pd.DataFrame, committee: list[dict[str, Any]]) -> pd.DataFrame:
    result = source[["decision_time", "instrument", LONG_NET_RETURN_COLUMN, SHORT_NET_RETURN_COLUMN]].copy()
    long_preds = []
    short_preds = []
    side_votes = []

    for expert in committee:
        long_pred = expert["long"].predict(source[FEATURES]).astype(float)
        short_pred = expert["short"].predict(source[FEATURES]).astype(float)
        long_preds.append(long_pred)
        short_preds.append(short_pred)
        side_votes.append(long_pred >= short_pred)

    long_matrix = np.column_stack(long_preds)
    short_matrix = np.column_stack(short_preds)
    votes = np.column_stack(side_votes)
    long_vote_count = votes.sum(axis=1)
    consensus_long = long_vote_count >= VOTES_REQUIRED
    consensus_votes = np.maximum(long_vote_count, len(committee) - long_vote_count)

    selected_matrix = np.where(consensus_long[:, None], long_matrix, short_matrix)
    opposite_matrix = np.where(consensus_long[:, None], short_matrix, long_matrix)
    selected_median = np.median(selected_matrix, axis=1)
    selected_mad = np.median(np.abs(selected_matrix - selected_median[:, None]), axis=1)
    margin_matrix = selected_matrix - opposite_matrix
    margin_median = np.median(margin_matrix, axis=1)
    robust_net = selected_median - selected_mad

    active = (
        (consensus_votes >= VOTES_REQUIRED)
        & (selected_median >= MEDIAN_NET_FLOOR_BPS)
        & (robust_net >= ROBUST_NET_FLOOR_BPS)
        & (margin_median >= MEDIAN_MARGIN_FLOOR_BPS)
        & (selected_mad <= DISPERSION_CAP_BPS)
    )

    exact_long = pd.to_numeric(source[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    exact_short = pd.to_numeric(source[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    true_long = exact_long > exact_short
    selected_return = np.where(consensus_long, exact_long, exact_short)

    result["predicted_long"] = consensus_long
    result["true_long"] = true_long
    result["active_trade"] = active
    result["selected_net_return"] = selected_return
    result["long_vote_count"] = long_vote_count
    result["consensus_votes"] = consensus_votes
    result["predicted_selected_median_bps"] = selected_median
    result["predicted_selected_mad_bps"] = selected_mad
    result["predicted_robust_net_bps"] = robust_net
    result["predicted_margin_median_bps"] = margin_median

    for index, name in enumerate(WINDOW_NAMES):
        result[f"{name}_long_ev_bps"] = long_matrix[:, index]
        result[f"{name}_short_ev_bps"] = short_matrix[:, index]

    return result


def _balanced_accuracy(y_true: np.ndarray, y_pred: np.ndarray) -> float | None:
    scores = []
    for cls in (False, True):
        mask = y_true == cls
        if not mask.any():
            return None
        scores.append(float((y_pred[mask] == cls).mean()))
    return float(np.mean(scores))


def _metrics(pred: pd.DataFrame) -> dict[str, Any]:
    active = pred.loc[pred["active_trade"].astype(bool)].sort_values("decision_time").copy()
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
        }

    returns = pd.to_numeric(active["selected_net_return"], errors="raise").to_numpy(float)
    gains = float(returns[returns > 0].sum())
    losses = float(-returns[returns < 0].sum())
    pf = gains / losses if losses > 0 else None

    std = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0
    sharpe = float(np.sqrt(len(returns)) * returns.mean() / std) if std > 0 else None

    equity = np.cumprod(1.0 + returns)
    peaks = np.maximum.accumulate(np.concatenate(([1.0], equity)))
    equity_with_start = np.concatenate(([1.0], equity))
    drawdowns = np.where(peaks > 0, (peaks - equity_with_start) / peaks, 0.0)
    max_dd = float(np.max(drawdowns))

    y_true = active["true_long"].to_numpy(bool)
    y_pred = active["predicted_long"].to_numpy(bool)
    ba = _balanced_accuracy(y_true, y_pred)

    times = pd.to_datetime(active["decision_time"], utc=True)
    gaps = times.diff().dropna().dt.total_seconds() / 60.0

    long_count = int(active["predicted_long"].sum())
    return {
        "trades": int(len(active)),
        "profit_factor": pf,
        "sharpe": sharpe,
        "max_drawdown": max_dd,
        "balanced_accuracy": ba,
        "total_return": float(returns.sum()),
        "mean_return_bps": float(returns.mean() * 10_000.0),
        "win_rate": float((returns > 0).mean()),
        "median_gap_minutes": float(gaps.median()) if len(gaps) else None,
        "long_trades": long_count,
        "short_trades": int(len(active) - long_count),
    }


def _fold_pass(metrics: dict[str, Any]) -> bool:
    return bool(
        metrics["trades"] > 0
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
        sum(fold["metrics"]["total_return"] > 0 for fold in folds) / len(folds) if folds else 0.0
    )
    fold_pass_fraction = (
        sum(bool(fold["fold_gate_passed"]) for fold in folds) / len(folds) if folds else 0.0
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
        "positive_fold_fraction": positive_fold_fraction >= MIN_POSITIVE_FOLD_FRACTION,
        "fold_gate_fraction": fold_pass_fraction >= MIN_POSITIVE_FOLD_FRACTION,
        "two_sided_execution": metrics["long_trades"] > 0 and metrics["short_trades"] > 0,
    }
    return {
        "research_challenger": all(checks.values()),
        "production_eligible": False,
        "checks": checks,
        "positive_fold_fraction": positive_fold_fraction,
        "fold_gate_fraction": fold_pass_fraction,
        "metrics": metrics,
    }


def run_pair(
    *,
    dataset: Path,
    pair: str,
    output: Path,
    cutoff: str = RESEARCH_CUTOFF,
    max_splits: int = OUTER_FOLDS_REQUIRED,
) -> dict[str, Any]:
    pair = pair.upper()
    if pair not in PAIRS:
        raise ValueError(f"unsupported pair: {pair}")

    pooled, hashes = load_and_prepare_corpora(
        {pair: dataset},
        horizon_bars=HORIZON_BARS,
        decision_time_before=cutoff,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=EXTRA_SLIPPAGE_BPS,
    )
    pooled = pooled.sort_values("decision_time").reset_index(drop=True)
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

    output.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = output.parent / f"{output.stem}.checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    folds: list[dict[str, Any]] = []
    outer: list[pd.DataFrame] = []
    pair_index = PAIRS.index(pair)

    for fold_index, (train, valid) in enumerate(splits, 1):
        committee = _fit_committee(train, 7900 + pair_index * 100 + fold_index * 10)
        pred = _predict(valid, committee)
        metrics = _metrics(pred)
        row = {
            "fold": fold_index,
            "training_rows": int(len(train)),
            "validation_rows": int(len(valid)),
            "committee": [
                {"name": expert["name"], "fraction": expert["fraction"], "rows": expert["rows"]}
                for expert in committee
            ],
            "metrics": metrics,
            "fold_gate_passed": _fold_pass(metrics),
        }
        folds.append(row)
        outer.append(pred)

        cp = checkpoint_dir / f"fold-{fold_index:02d}.csv"
        pred.to_csv(cp, index=False)

        partial = {
            "experiment": EXPERIMENT,
            "pair": pair,
            "complete": False,
            "research_only": True,
            "production_eligible": False,
            "sealed_future_holdout_touched": False,
            "promotion_gates_unchanged": True,
            "research_cutoff": cutoff,
            "corpus_sha256": hashes,
            "policy": {
                "window_fractions": WINDOW_FRACTIONS,
                "votes_required": VOTES_REQUIRED,
                "robust_net_floor_bps": ROBUST_NET_FLOOR_BPS,
                "median_net_floor_bps": MEDIAN_NET_FLOOR_BPS,
                "median_margin_floor_bps": MEDIAN_MARGIN_FLOOR_BPS,
                "dispersion_cap_bps": DISPERSION_CAP_BPS,
                "extra_slippage_bps": EXTRA_SLIPPAGE_BPS,
                "threshold_selection": "NONE_FIXED_PREDECLARED",
            },
            "folds": folds,
        }
        output.write_text(json.dumps(partial, indent=2, default=str))
        print(json.dumps({"pair": pair, **row}, indent=2, default=str), flush=True)

        remaining = len(splits) - fold_index
        positive = sum(f["metrics"]["total_return"] > 0 for f in folds)
        fold_passes = sum(bool(f["fold_gate_passed"]) for f in folds)
        required = 2 if len(splits) >= 3 else len(splits)
        if positive + remaining < required or fold_passes + remaining < required:
            partial["early_eliminated"] = True
            partial["early_elimination_reason"] = "FROZEN_STABILITY_GATES_MATHEMATICALLY_UNREACHABLE"
            output.write_text(json.dumps(partial, indent=2, default=str))
            print(
                json.dumps(
                    {
                        "pair": pair,
                        "early_eliminated": True,
                        "completed_folds": len(folds),
                        "remaining_folds_skipped": remaining,
                    },
                    indent=2,
                ),
                flush=True,
            )
            return partial

    if not outer:
        raise ValueError("no outer folds produced")

    combined = pd.concat(outer, ignore_index=True)
    status = _final_status(folds, combined)
    report = {
        "experiment": EXPERIMENT,
        "pair": pair,
        "complete": True,
        "research_only": True,
        "production_eligible": False,
        "sealed_future_holdout_touched": False,
        "promotion_gates_unchanged": True,
        "research_cutoff": cutoff,
        "corpus_sha256": hashes,
        "policy": {
            "window_fractions": WINDOW_FRACTIONS,
            "votes_required": VOTES_REQUIRED,
            "robust_net_floor_bps": ROBUST_NET_FLOOR_BPS,
            "median_net_floor_bps": MEDIAN_NET_FLOOR_BPS,
            "median_margin_floor_bps": MEDIAN_MARGIN_FLOOR_BPS,
            "dispersion_cap_bps": DISPERSION_CAP_BPS,
            "extra_slippage_bps": EXTRA_SLIPPAGE_BPS,
            "threshold_selection": "NONE_FIXED_PREDECLARED",
        },
        "folds": folds,
        **status,
    }
    output.write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps({"pair": pair, **status}, indent=2, default=str), flush=True)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--pair", required=True, choices=PAIRS)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cutoff", default=RESEARCH_CUTOFF)
    parser.add_argument("--max-splits", type=int, default=OUTER_FOLDS_REQUIRED)
    args = parser.parse_args()
    run_pair(
        dataset=args.dataset,
        pair=args.pair,
        output=args.output,
        cutoff=args.cutoff,
        max_splits=args.max_splits,
    )
