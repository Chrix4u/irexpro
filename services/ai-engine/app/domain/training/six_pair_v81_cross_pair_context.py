"""v81 pooled six-pair cross-context event/actionability router.

Research-only, pre-registered architecture.

The model receives the existing causal per-pair MTF features plus same-timestamp
cross-pair context derived only from the six synchronized FX pairs. A pooled
actionability classifier and a pooled direction classifier are trained on the
past. Runtime selection is fixed: opportunity >= 0.55, direction confidence
>= 0.55, then choose at most the best one candidate per decision minute.

No outer-fold threshold tuning is permitted. The future sealed holdout remains
untouched. This module can never mark itself production eligible.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBClassifier

from app.domain.models.multitimeframe_features import (
    INITIAL_FOREX_UNIVERSE,
    MULTITIMEFRAME_FEATURE_COLUMNS,
)
from app.domain.training.train_multitimeframe import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
    TARGET_COLUMN,
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "v81_cross_pair_context_event_router_v1"
PAIRS = tuple(INITIAL_FOREX_UNIVERSE)
HORIZON_BARS = 5
RESEARCH_CUTOFF = "2026-09-02T19:59:00Z"
EXTRA_SLIPPAGE_BPS = 0.25

OPPORTUNITY_FLOOR = 0.55
DIRECTION_CONFIDENCE_FLOOR = 0.55
MAX_TRADES_PER_DECISION_TIME = 1

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

USD_SIGN = {
    "AUDUSD": -1.0,
    "EURUSD": -1.0,
    "GBPUSD": -1.0,
    "USDCAD": 1.0,
    "USDCHF": 1.0,
    "USDJPY": 1.0,
}

CROSS_FACTOR_COLUMNS = (
    "m1_simple_return",
    "m1_momentum_5",
    "m5_momentum_5",
    "m15_momentum_5",
)

CROSS_RANK_COLUMNS = (
    "m1_simple_return",
    "m1_momentum_5",
    "m5_momentum_5",
    "m15_momentum_5",
    "m1_volatility_20",
    "m1_spread_bps",
    "trend_alignment_score",
    "higher_timeframe_trend_score",
)

CROSS_DISPERSION_COLUMNS = (
    "m1_simple_return",
    "m1_momentum_5",
    "m5_momentum_5",
    "m1_volatility_20",
    "m1_spread_bps",
)

CROSS_FEATURES = tuple(
    [f"cs_usd_factor_{column}" for column in CROSS_FACTOR_COLUMNS]
    + [f"cs_usd_residual_{column}" for column in CROSS_FACTOR_COLUMNS]
    + [f"cs_usd_contribution_rank_{column}" for column in CROSS_FACTOR_COLUMNS]
    + [f"cs_raw_rank_{column}" for column in CROSS_RANK_COLUMNS]
    + [f"cs_dispersion_{column}" for column in CROSS_DISPERSION_COLUMNS]
)

FEATURES = list(MULTITIMEFRAME_FEATURE_COLUMNS) + list(CROSS_FEATURES)


def _classifier(seed: int) -> XGBClassifier:
    return XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        n_estimators=800,
        learning_rate=0.025,
        max_depth=4,
        min_child_weight=8.0,
        subsample=0.85,
        colsample_bytree=0.82,
        reg_alpha=0.25,
        reg_lambda=3.0,
        random_state=seed,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=70,
    )


def _balanced_weights(values: pd.Series) -> np.ndarray:
    y = pd.to_numeric(values, errors="raise").astype(int).to_numpy()
    n = len(y)
    positives = int((y == 1).sum())
    negatives = n - positives
    if positives == 0 or negatives == 0:
        raise ValueError("binary target has only one class")
    weights = np.where(
        y == 1,
        n / (2.0 * positives),
        n / (2.0 * negatives),
    )
    return weights.astype(float)


def _attach_cross_context(pooled: pd.DataFrame) -> pd.DataFrame:
    frame = pooled.copy()
    frame["decision_time"] = pd.to_datetime(frame["decision_time"], utc=True)

    counts = frame.groupby("decision_time")["instrument"].nunique()
    complete_times = counts[counts == len(PAIRS)].index
    frame = frame[frame["decision_time"].isin(complete_times)].copy()
    frame = frame.sort_values(["decision_time", "instrument"]).reset_index(drop=True)
    if frame.empty:
        raise ValueError("no synchronized six-pair rows remain")

    duplicated = frame.duplicated(["decision_time", "instrument"])
    if duplicated.any():
        raise ValueError("cross-pair frame contains duplicate instrument/timestamp rows")

    sign_map = frame["instrument"].map(USD_SIGN)
    if sign_map.isna().any():
        raise ValueError("cross-pair USD sign map incomplete")

    grouped = frame.groupby("decision_time", sort=False)

    for column in CROSS_FACTOR_COLUMNS:
        numeric = pd.to_numeric(frame[column], errors="raise").astype(float)
        contribution = numeric * sign_map.astype(float)
        frame[f"_usd_contribution_{column}"] = contribution
        usd_factor = frame.groupby("decision_time", sort=False)[
            f"_usd_contribution_{column}"
        ].transform("mean")
        frame[f"cs_usd_factor_{column}"] = usd_factor
        frame[f"cs_usd_residual_{column}"] = contribution - usd_factor
        frame[f"cs_usd_contribution_rank_{column}"] = frame.groupby(
            "decision_time",
            sort=False,
        )[f"_usd_contribution_{column}"].rank(method="average", pct=True)

    for column in CROSS_RANK_COLUMNS:
        frame[f"cs_raw_rank_{column}"] = grouped[column].rank(
            method="average",
            pct=True,
        )

    for column in CROSS_DISPERSION_COLUMNS:
        frame[f"cs_dispersion_{column}"] = grouped[column].transform(
            lambda series: float(pd.to_numeric(series, errors="raise").std(ddof=0))
        )

    temporary = [column for column in frame.columns if column.startswith("_usd_contribution_")]
    frame = frame.drop(columns=temporary)

    values = frame[list(CROSS_FEATURES)].apply(pd.to_numeric, errors="coerce")
    finite = np.isfinite(values.to_numpy(dtype=float)).all(axis=1)
    frame.loc[:, list(CROSS_FEATURES)] = values
    frame = frame.loc[finite].copy()
    if frame.empty:
        raise ValueError("all cross-context rows became non-finite")
    return frame.reset_index(drop=True)


def _fit_binary(
    training: pd.DataFrame,
    target: str,
    seed: int,
) -> XGBClassifier:
    fit, early = _split_internal_early_stopping_tail(
        training.sort_values("decision_time"),
        horizon_bars=HORIZON_BARS,
    )
    if len(fit) < 2000 or len(early) < 500:
        raise ValueError(f"insufficient rows to train {target}")

    model = _classifier(seed)
    y_fit = pd.to_numeric(fit[target], errors="raise").astype(int)
    y_early = pd.to_numeric(early[target], errors="raise").astype(int)
    model.fit(
        fit[FEATURES],
        y_fit,
        sample_weight=_balanced_weights(y_fit),
        eval_set=[(early[FEATURES], y_early)],
        verbose=False,
    )
    return model


def _predict(
    validation: pd.DataFrame,
    opportunity_model: XGBClassifier,
    direction_model: XGBClassifier,
) -> pd.DataFrame:
    result = validation[
        [
            "decision_time",
            "instrument",
            TARGET_COLUMN,
            EVENT_ACTIONABLE_TARGET_COLUMN,
            LONG_NET_RETURN_COLUMN,
            SHORT_NET_RETURN_COLUMN,
        ]
    ].copy()

    opportunity_probability = opportunity_model.predict_proba(validation[FEATURES])[:, 1]
    direction_probability_long = direction_model.predict_proba(validation[FEATURES])[:, 1]
    predicted_long = direction_probability_long >= 0.5
    direction_confidence = np.maximum(
        direction_probability_long,
        1.0 - direction_probability_long,
    )
    score = opportunity_probability * direction_confidence

    result["opportunity_probability"] = opportunity_probability
    result["direction_probability_long"] = direction_probability_long
    result["direction_confidence"] = direction_confidence
    result["predicted_long"] = predicted_long
    result["selection_score"] = score

    long_exact = pd.to_numeric(
        result[LONG_NET_RETURN_COLUMN], errors="raise"
    ).to_numpy(float)
    short_exact = pd.to_numeric(
        result[SHORT_NET_RETURN_COLUMN], errors="raise"
    ).to_numpy(float)
    result["selected_net_return"] = np.where(
        predicted_long,
        long_exact,
        short_exact,
    )
    result["true_long"] = pd.to_numeric(
        result[TARGET_COLUMN], errors="raise"
    ).astype(bool)

    result["eligible"] = (
        (result["opportunity_probability"] >= OPPORTUNITY_FLOOR)
        & (result["direction_confidence"] >= DIRECTION_CONFIDENCE_FLOOR)
    )
    result["active_trade"] = False

    candidates = result.loc[result["eligible"]].copy()
    if not candidates.empty:
        candidates = candidates.sort_values(
            [
                "decision_time",
                "selection_score",
                "opportunity_probability",
                "direction_confidence",
                "instrument",
            ],
            ascending=[True, False, False, False, True],
        )
        winners = candidates.groupby("decision_time", sort=False).head(
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
            "mean_opportunity_probability": None,
            "mean_direction_confidence": None,
            "actionable_precision": None,
        }

    returns = pd.to_numeric(active["selected_net_return"], errors="raise").to_numpy(float)
    gains = float(returns[returns > 0].sum())
    losses = float(-returns[returns < 0].sum())
    profit_factor = gains / losses if losses > 0 else None
    std = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0
    sharpe = float(np.sqrt(len(returns)) * returns.mean() / std) if std > 0 else None

    equity = np.cumprod(1.0 + returns)
    equity_with_start = np.concatenate(([1.0], equity))
    peaks = np.maximum.accumulate(equity_with_start)
    drawdowns = np.where(
        peaks > 0,
        (peaks - equity_with_start) / peaks,
        0.0,
    )

    balanced_accuracy = _balanced_accuracy(
        active["true_long"].to_numpy(bool),
        active["predicted_long"].to_numpy(bool),
    )

    times = pd.to_datetime(active["decision_time"], utc=True)
    gaps = times.diff().dropna().dt.total_seconds() / 60.0
    long_trades = int(active["predicted_long"].sum())

    instrument_metrics: dict[str, Any] = {}
    positive = 0
    covered = 0
    for pair in PAIRS:
        subset = active[active["instrument"] == pair]
        pair_return = float(subset["selected_net_return"].sum()) if len(subset) else 0.0
        if len(subset):
            covered += 1
        if pair_return > 0:
            positive += 1
        instrument_metrics[pair] = {
            "trades": int(len(subset)),
            "total_return": pair_return,
            "win_rate": (
                float((subset["selected_net_return"] > 0).mean())
                if len(subset)
                else None
            ),
        }

    return {
        "trades": int(len(active)),
        "profit_factor": profit_factor,
        "sharpe": sharpe,
        "max_drawdown": float(np.max(drawdowns)),
        "balanced_accuracy": balanced_accuracy,
        "total_return": float(returns.sum()),
        "mean_return_bps": float(returns.mean() * 10_000.0),
        "win_rate": float((returns > 0).mean()),
        "median_gap_minutes": float(gaps.median()) if len(gaps) else None,
        "long_trades": long_trades,
        "short_trades": int(len(active) - long_trades),
        "instrument_trade_coverage_fraction": covered / len(PAIRS),
        "positive_instrument_fraction": positive / len(PAIRS),
        "instrument_metrics": instrument_metrics,
        "mean_opportunity_probability": float(
            active["opportunity_probability"].mean()
        ),
        "mean_direction_confidence": float(
            active["direction_confidence"].mean()
        ),
        "actionable_precision": float(
            pd.to_numeric(
                active[EVENT_ACTIONABLE_TARGET_COLUMN],
                errors="raise",
            ).mean()
        ),
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


def _final_status(
    folds: list[dict[str, Any]],
    combined: pd.DataFrame,
) -> dict[str, Any]:
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
        "sharpe": metrics["sharpe"] is not None
        and metrics["sharpe"] >= MIN_SHARPE,
        "profit_factor": metrics["profit_factor"] is not None
        and metrics["profit_factor"] >= MIN_PROFIT_FACTOR,
        "max_drawdown": metrics["max_drawdown"] is not None
        and metrics["max_drawdown"] <= MAX_DRAWDOWN,
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
        "two_sided_execution": metrics["long_trades"] > 0
        and metrics["short_trades"] > 0,
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
    pooled = _attach_cross_context(pooled)

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
    outer: list[pd.DataFrame] = []

    for fold_index, (training, validation) in enumerate(splits, 1):
        opportunity_model = _fit_binary(
            training,
            EVENT_ACTIONABLE_TARGET_COLUMN,
            8100 + fold_index * 20,
        )
        direction_model = _fit_binary(
            training,
            TARGET_COLUMN,
            8101 + fold_index * 20,
        )
        predictions = _predict(
            validation,
            opportunity_model,
            direction_model,
        )
        metrics = _metrics(predictions)
        fold = {
            "fold": fold_index,
            "training_rows": int(len(training)),
            "validation_rows": int(len(validation)),
            "metrics": metrics,
            "fold_gate_passed": _fold_pass(metrics),
        }
        folds.append(fold)
        outer.append(predictions)

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
                "architecture": "pooled_event_actionability_plus_direction_with_same_time_cross_pair_context_top1",
                "opportunity_floor": OPPORTUNITY_FLOOR,
                "direction_confidence_floor": DIRECTION_CONFIDENCE_FLOOR,
                "max_trades_per_decision_time": MAX_TRADES_PER_DECISION_TIME,
                "extra_slippage_bps": EXTRA_SLIPPAGE_BPS,
                "complete_pair_snapshot_required": True,
                "cross_features": list(CROSS_FEATURES),
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

    combined = pd.concat(outer, ignore_index=True)
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
            "architecture": "pooled_event_actionability_plus_direction_with_same_time_cross_pair_context_top1",
            "opportunity_floor": OPPORTUNITY_FLOOR,
            "direction_confidence_floor": DIRECTION_CONFIDENCE_FLOOR,
            "max_trades_per_decision_time": MAX_TRADES_PER_DECISION_TIME,
            "extra_slippage_bps": EXTRA_SLIPPAGE_BPS,
            "complete_pair_snapshot_required": True,
            "cross_features": list(CROSS_FEATURES),
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
