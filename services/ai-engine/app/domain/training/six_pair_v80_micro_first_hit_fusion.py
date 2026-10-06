"""v80 quote-microstructure + MTF first-hit fusion specialists.

Research-only, pair-specific two-stage architecture:
1) opportunity classifier predicts whether exactly one executable side reaches
   +1 bp before -1 bp within five minutes;
2) direction classifier predicts LONG vs SHORT among those clean opportunities.

Inputs are causal: 60-second quote microstructure plus the existing 128-feature
M1/M5/M15/H1/H4 runtime contract. Admission thresholds are fixed before any
outer-fold evaluation. The sealed future holdout is untouched.
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
from app.domain.models.quote_microstructure import QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS
from app.domain.training.train_multitimeframe import (
    _xgboost_n_jobs,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "v80_micro_first_hit_fusion_v1"
PAIRS = ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
RESEARCH_CUTOFF = "2026-09-02T19:59:00Z"
HORIZON_BARS = 5
OUTER_FOLDS_REQUIRED = 3

BARRIER_SUFFIX = "1p0"
OPPORTUNITY_FLOOR = 0.55
DIRECTION_CONFIDENCE_FLOOR = 0.55
DIRECTION_MARGIN_FLOOR = 0.10

MIN_TRADES = 100
MAX_MEDIAN_GAP_MINUTES = 10.0
MIN_BALANCED_ACCURACY = 0.52
MIN_SHARPE = 1.0
MIN_PROFIT_FACTOR = 1.15
MAX_DRAWDOWN = 0.12
MIN_POSITIVE_FOLD_FRACTION = 2 / 3

MTF_FEATURES = list(MULTITIMEFRAME_FEATURE_COLUMNS)
MICRO_FEATURES = list(QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS)
FEATURES = MTF_FEATURES + MICRO_FEATURES


def _classifier(seed: int) -> XGBClassifier:
    return XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        n_estimators=700,
        learning_rate=0.025,
        max_depth=5,
        min_child_weight=8.0,
        subsample=0.85,
        colsample_bytree=0.82,
        reg_alpha=0.20,
        reg_lambda=2.5,
        random_state=seed,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
    )


def _class_weights(y: np.ndarray) -> np.ndarray:
    y = y.astype(int)
    counts = np.bincount(y, minlength=2).astype(float)
    total = max(1.0, float(counts.sum()))
    weights = np.ones(len(y), dtype=float)
    for cls in (0, 1):
        if counts[cls] <= 0:
            continue
        class_weight = np.clip(total / (2.0 * counts[cls]), 0.5, 5.0)
        weights[y == cls] = class_weight
    return weights


def _load_pair(
    *,
    pair: str,
    mtf_path: Path,
    micro_path: Path,
    labels_path: Path,
    cutoff: str,
) -> pd.DataFrame:
    mtf, _ = load_and_prepare_corpora(
        {pair: mtf_path},
        horizon_bars=HORIZON_BARS,
        decision_time_before=cutoff,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=0.0,
    )
    mtf = mtf[["decision_time", *MTF_FEATURES]].copy()
    micro = pd.read_csv(micro_path, usecols=["decision_time", *MICRO_FEATURES])
    labels = pd.read_csv(labels_path)

    for frame in (mtf, micro, labels):
        frame["decision_time"] = pd.to_datetime(frame["decision_time"], utc=True)

    cutoff_ts = pd.Timestamp(cutoff)
    micro = micro.loc[micro["decision_time"] <= cutoff_ts].copy()
    labels = labels.loc[labels["decision_time"] <= cutoff_ts].copy()

    long_hit = f"long_first_hit_{BARRIER_SUFFIX}bps"
    short_hit = f"short_first_hit_{BARRIER_SUFFIX}bps"
    required_labels = [
        long_hit,
        short_hit,
        "long_terminal_5m_bps",
        "short_terminal_5m_bps",
    ]
    missing = [name for name in required_labels if name not in labels.columns]
    if missing:
        raise ValueError(f"missing path-label columns: {missing}")

    joined = (
        mtf.merge(micro, on="decision_time", how="inner", validate="one_to_one")
        .merge(
            labels[["decision_time", *required_labels]],
            on="decision_time",
            how="inner",
            validate="one_to_one",
        )
        .sort_values("decision_time")
        .drop_duplicates("decision_time", keep="last")
        .reset_index(drop=True)
    )
    joined.insert(1, "instrument", pair)

    long_outcome = pd.to_numeric(joined[long_hit], errors="raise").to_numpy(int)
    short_outcome = pd.to_numeric(joined[short_hit], errors="raise").to_numpy(int)

    clean_long = (long_outcome == 1) & (short_outcome != 1)
    clean_short = (short_outcome == 1) & (long_outcome != 1)
    opportunity = clean_long | clean_short

    joined["opportunity_target"] = opportunity.astype(int)
    joined["direction_target_long"] = clean_long.astype(int)

    values = joined[FEATURES].to_numpy(float)
    finite = np.isfinite(values).all(axis=1)
    joined = joined.loc[finite].reset_index(drop=True)
    if len(joined) < 1500:
        raise ValueError(f"insufficient joined v80 rows for {pair}: {len(joined)}")
    return joined


def _fit(training: pd.DataFrame, seed: int) -> tuple[XGBClassifier, XGBClassifier]:
    opportunity = _classifier(seed)
    y_opp = training["opportunity_target"].to_numpy(int)
    opportunity.fit(
        training[FEATURES],
        y_opp,
        sample_weight=_class_weights(y_opp),
        verbose=False,
    )

    direction_rows = training.loc[training["opportunity_target"].astype(bool)].copy()
    if len(direction_rows) < 250:
        raise ValueError("insufficient clean directional opportunities for direction fit")
    y_dir = direction_rows["direction_target_long"].to_numpy(int)
    if len(np.unique(y_dir)) < 2:
        raise ValueError("direction training contains only one side")
    direction = _classifier(seed + 1)
    direction.fit(
        direction_rows[FEATURES],
        y_dir,
        sample_weight=_class_weights(y_dir),
        verbose=False,
    )
    return opportunity, direction


def _realized_selected_return(source: pd.DataFrame, predicted_long: np.ndarray) -> np.ndarray:
    long_hit = pd.to_numeric(
        source[f"long_first_hit_{BARRIER_SUFFIX}bps"], errors="raise"
    ).to_numpy(int)
    short_hit = pd.to_numeric(
        source[f"short_first_hit_{BARRIER_SUFFIX}bps"], errors="raise"
    ).to_numpy(int)
    long_terminal = pd.to_numeric(source["long_terminal_5m_bps"], errors="raise").to_numpy(float)
    short_terminal = pd.to_numeric(source["short_terminal_5m_bps"], errors="raise").to_numpy(float)

    def side_return(hit: np.ndarray, terminal_bps: np.ndarray) -> np.ndarray:
        return np.where(
            hit == 1,
            1.0 / 10_000.0,
            np.where(hit == -1, -1.0 / 10_000.0, terminal_bps / 10_000.0),
        )

    long_return = side_return(long_hit, long_terminal)
    short_return = side_return(short_hit, short_terminal)
    return np.where(predicted_long, long_return, short_return)


def _predict(source: pd.DataFrame, opportunity: XGBClassifier, direction: XGBClassifier) -> pd.DataFrame:
    p_opp = opportunity.predict_proba(source[FEATURES])[:, 1].astype(float)
    p_long = direction.predict_proba(source[FEATURES])[:, 1].astype(float)
    predicted_long = p_long >= 0.5
    direction_confidence = np.maximum(p_long, 1.0 - p_long)
    direction_margin = np.abs(p_long - 0.5) * 2.0

    active = (
        (p_opp >= OPPORTUNITY_FLOOR)
        & (direction_confidence >= DIRECTION_CONFIDENCE_FLOOR)
        & (direction_margin >= DIRECTION_MARGIN_FLOOR)
    )

    exact_long_terminal = pd.to_numeric(
        source["long_terminal_5m_bps"], errors="raise"
    ).to_numpy(float)
    exact_short_terminal = pd.to_numeric(
        source["short_terminal_5m_bps"], errors="raise"
    ).to_numpy(float)
    true_long = exact_long_terminal > exact_short_terminal

    result = source[["decision_time", "instrument"]].copy()
    result["opportunity_probability"] = p_opp
    result["direction_probability_long"] = p_long
    result["direction_confidence"] = direction_confidence
    result["direction_margin"] = direction_margin
    result["predicted_long"] = predicted_long
    result["true_long"] = true_long
    result["active_trade"] = active
    result["selected_net_return"] = _realized_selected_return(source, predicted_long)
    return result


def _balanced_accuracy(y_true: np.ndarray, y_pred: np.ndarray) -> float | None:
    recalls = []
    for cls in (False, True):
        mask = y_true == cls
        if not mask.any():
            return None
        recalls.append(float((y_pred[mask] == cls).mean()))
    return float(np.mean(recalls))


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
    equity_with_start = np.concatenate(([1.0], equity))
    peaks = np.maximum.accumulate(equity_with_start)
    max_dd = float(np.max(np.where(peaks > 0, (peaks - equity_with_start) / peaks, 0.0)))

    y_true = active["true_long"].to_numpy(bool)
    y_pred = active["predicted_long"].to_numpy(bool)
    ba = _balanced_accuracy(y_true, y_pred)

    times = pd.to_datetime(active["decision_time"], utc=True)
    gaps = times.diff().dropna().dt.total_seconds() / 60.0
    longs = int(active["predicted_long"].sum())
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
        "long_trades": longs,
        "short_trades": int(len(active) - longs),
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


def _combined_status(folds: list[dict[str, Any]], combined: pd.DataFrame) -> dict[str, Any]:
    metrics = _metrics(combined)
    positive_fold_fraction = (
        sum(fold["metrics"]["total_return"] > 0 for fold in folds) / len(folds) if folds else 0.0
    )
    fold_gate_fraction = (
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
        "fold_gate_fraction": fold_gate_fraction >= MIN_POSITIVE_FOLD_FRACTION,
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


def run_pair(
    *,
    pair: str,
    mtf_path: Path,
    micro_path: Path,
    labels_path: Path,
    output: Path,
    cutoff: str = RESEARCH_CUTOFF,
    max_splits: int = OUTER_FOLDS_REQUIRED,
) -> dict[str, Any]:
    pair = pair.upper()
    if pair not in PAIRS:
        raise ValueError(f"unsupported pair: {pair}")

    data = _load_pair(
        pair=pair,
        mtf_path=mtf_path,
        micro_path=micro_path,
        labels_path=labels_path,
        cutoff=cutoff,
    )
    periods = int(data["decision_time"].nunique())
    splits = list(
        iter_purged_walk_forward_time_splits(
            data,
            time_column="decision_time",
            min_train_periods=max(5000, int(periods * 0.50)),
            validation_periods=max(1500, int(periods * 0.12)),
            purge_periods=HORIZON_BARS,
            embargo_periods=HORIZON_BARS,
            max_splits=max_splits,
        )
    )
    if len(splits) < max_splits:
        raise ValueError(f"insufficient purged outer folds for {pair}: {len(splits)}")

    output.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = output.parent / f"{output.stem}.checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    folds: list[dict[str, Any]] = []
    outer: list[pd.DataFrame] = []
    pair_index = PAIRS.index(pair)

    def checkpoint(complete: bool) -> dict[str, Any]:
        combined = pd.concat(outer, ignore_index=True) if outer else pd.DataFrame()
        status = (
            _combined_status(folds, combined)
            if not combined.empty
            else {
                "research_challenger": False,
                "production_eligible": False,
                "checks": {},
                "positive_fold_fraction": 0.0,
                "fold_gate_fraction": 0.0,
                "metrics": _metrics(pd.DataFrame(columns=[
                    "active_trade","selected_net_return","decision_time","true_long","predicted_long"
                ])),
            }
        )
        return {
            "experiment": EXPERIMENT,
            "pair": pair,
            "complete": complete,
            "research_only": True,
            "production_eligible": False,
            "sealed_future_holdout_touched": False,
            "promotion_gates_unchanged": True,
            "research_cutoff": cutoff,
            "feature_count": len(FEATURES),
            "mtf_feature_count": len(MTF_FEATURES),
            "micro_feature_count": len(MICRO_FEATURES),
            "policy": {
                "barrier_bps": 1.0,
                "horizon_minutes": 5,
                "opportunity_floor": OPPORTUNITY_FLOOR,
                "direction_confidence_floor": DIRECTION_CONFIDENCE_FLOOR,
                "direction_margin_floor": DIRECTION_MARGIN_FLOOR,
                "threshold_selection": "NONE_FIXED_PREDECLARED",
                "ambiguous_both_profit": "NO_TRADE",
                "selected_outcome": "FIRST_HIT_PLUS_MINUS_1BP_ELSE_5M_TERMINAL",
            },
            "joined_rows": int(len(data)),
            "folds": folds,
            **status,
        }

    for fold_index, (train, valid) in enumerate(splits, 1):
        opportunity, direction = _fit(train, 8000 + pair_index * 100 + fold_index * 10)
        pred = _predict(valid, opportunity, direction)
        metrics = _metrics(pred)
        row = {
            "fold": fold_index,
            "training_rows": int(len(train)),
            "validation_rows": int(len(valid)),
            "training_opportunities": int(train["opportunity_target"].sum()),
            "metrics": metrics,
            "fold_gate_passed": _fold_pass(metrics),
        }
        folds.append(row)
        outer.append(pred)
        pred.to_csv(checkpoint_dir / f"fold-{fold_index:02d}.csv", index=False)
        partial = checkpoint(False)
        output.write_text(json.dumps(partial, indent=2, default=str))
        print(json.dumps({"pair": pair, **row}, indent=2, default=str), flush=True)

        remaining = len(splits) - fold_index
        required = 2 if len(splits) >= 3 else len(splits)
        positive = sum(item["metrics"]["total_return"] > 0 for item in folds)
        fold_passes = sum(bool(item["fold_gate_passed"]) for item in folds)
        if positive + remaining < required or fold_passes + remaining < required:
            partial["early_eliminated"] = True
            partial["early_elimination_reason"] = (
                "FROZEN_STABILITY_GATES_MATHEMATICALLY_UNREACHABLE"
            )
            output.write_text(json.dumps(partial, indent=2, default=str))
            print(json.dumps({
                "pair": pair,
                "early_eliminated": True,
                "completed_folds": len(folds),
                "remaining_folds_skipped": remaining,
            }, indent=2), flush=True)
            return partial

    report = checkpoint(True)
    output.write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps({"pair": pair, **{k:report[k] for k in (
        "research_challenger","checks","positive_fold_fraction","fold_gate_fraction","metrics"
    )}}, indent=2, default=str), flush=True)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pair", required=True, choices=PAIRS)
    parser.add_argument("--mtf-path", type=Path, required=True)
    parser.add_argument("--micro-path", type=Path, required=True)
    parser.add_argument("--labels-path", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cutoff", default=RESEARCH_CUTOFF)
    parser.add_argument("--max-splits", type=int, default=OUTER_FOLDS_REQUIRED)
    args = parser.parse_args()
    run_pair(
        pair=args.pair,
        mtf_path=args.mtf_path,
        micro_path=args.micro_path,
        labels_path=args.labels_path,
        output=args.output,
        cutoff=args.cutoff,
        max_splits=args.max_splits,
    )
