"""USDJPY v25 research: inner-chronological economic consensus gating.

A side is enabled only when one bounded threshold/regime policy shows positive
economic evidence across multiple chronological inner subwindows. This is a
direct response to v15/v23 late-era strength failing disjoint replication.
Frozen v10 and the sealed future holdout remain untouched.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.training.model_qualification import (
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    ModelVariant,
    _ensure_event_dual_actionability_targets,
    _nested_windows,
    _refit_windows,
)
from app.domain.training.single_pair_v11_calibrated_gating import (
    PAYOFF_RATIO_FLOOR,
    _fit_models,
    _trading_metrics,
)
from app.domain.training.single_pair_v16_two_sided_economic import (
    MAX_FOLD_TRADE_CONCENTRATION,
    MIN_OUTER_TRADES,
    MIN_PER_FOLD_TRADES,
    SIDE_THRESHOLD_GRID,
    _apply_side_policy,
    _fit_side_calibrators,
    _fold_report,
    _score_frame,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v25_inner_consensus_economic"
TRAIN_FRACTIONS = (0.60, 0.94)
VALIDATION_FRACTION = 0.02
VOL_QUANTILES = (None, 0.33, 0.50, 0.67)
RSI_QUANTILES = (None, 0.50, 0.67, 0.75)
INNER_WINDOWS = 3
MIN_TOTAL_SELECTION_TRADES = 12
MIN_ACTIVE_SELECTION_WINDOWS = 2
MIN_POSITIVE_SELECTION_WINDOWS = 2
MIN_WINDOW_TRADES = 3
MIN_AGGREGATE_SELECTION_PF = 1.15


def _economic_metrics(returns: np.ndarray) -> dict[str, Any]:
    returns = np.asarray(returns, dtype=float)
    if len(returns) == 0:
        return {
            "trade_count": 0,
            "total_return": 0.0,
            "profit_factor": None,
            "profit_factor_infinite": False,
            "win_rate": 0.0,
        }
    gains = float(returns[returns > 0.0].sum())
    losses = float(-returns[returns < 0.0].sum())
    pf = gains / losses if losses > 0.0 else (float("inf") if gains > 0.0 else None)
    return {
        "trade_count": int(len(returns)),
        "total_return": float(returns.sum()),
        "profit_factor": None if pf is None or not np.isfinite(pf) else float(pf),
        "profit_factor_infinite": bool(pf is not None and not np.isfinite(pf)),
        "win_rate": float((returns > 0.0).mean()),
    }


def _split_inner_windows(scored: pd.DataFrame) -> list[pd.DataFrame]:
    ordered = scored.sort_values(["decision_time", "instrument"]).reset_index(drop=True)
    times = ordered["decision_time"].drop_duplicates().sort_values().reset_index(drop=True)
    chunks = np.array_split(times.to_numpy(), INNER_WINDOWS)
    result: list[pd.DataFrame] = []
    for chunk in chunks:
        if len(chunk) == 0:
            continue
        allowed = set(chunk.tolist())
        result.append(
            ordered.loc[ordered["decision_time"].isin(allowed)].copy().reset_index(drop=True)
        )
    return result


def _side_mask(
    scored: pd.DataFrame,
    *,
    side: str,
    threshold: float,
    volatility_floor: float | None,
    rsi_floor: float | None,
) -> pd.Series:
    if side not in {"long", "short"}:
        raise ValueError("side must be long or short")
    probability = scored[f"{side}_action_probability"]
    expected_net = scored[f"{side}_expected_net_bps"]
    payoff_ratio = scored[f"{side}_payoff_ratio"]
    mask = (
        (probability >= threshold)
        & (expected_net > 0.0)
        & (payoff_ratio >= PAYOFF_RATIO_FLOOR)
    )
    if volatility_floor is not None:
        mask &= scored["m1_volatility_20"] >= volatility_floor
    if rsi_floor is not None:
        mask &= scored["h1_rsi_14"] >= rsi_floor
    return mask


def select_consensus_policy(
    scored: pd.DataFrame,
    *,
    side: str,
) -> dict[str, Any]:
    """Choose one side policy only when it is stable across inner subwindows."""
    return_column = (
        EVENT_LONG_NET_RETURN_COLUMN if side == "long" else EVENT_SHORT_NET_RETURN_COLUMN
    )
    volatility = pd.to_numeric(scored["m1_volatility_20"], errors="raise")
    rsi = pd.to_numeric(scored["h1_rsi_14"], errors="raise")
    windows = _split_inner_windows(scored)
    candidates: list[dict[str, Any]] = []

    for threshold in SIDE_THRESHOLD_GRID:
        for vol_q in VOL_QUANTILES:
            vol_floor = None if vol_q is None else float(volatility.quantile(vol_q))
            for rsi_q in RSI_QUANTILES:
                rsi_floor = None if rsi_q is None else float(rsi.quantile(rsi_q))
                aggregate_mask = _side_mask(
                    scored,
                    side=side,
                    threshold=threshold,
                    volatility_floor=vol_floor,
                    rsi_floor=rsi_floor,
                )
                aggregate_returns = pd.to_numeric(
                    scored.loc[aggregate_mask, return_column], errors="raise"
                ).to_numpy(float)
                aggregate = _economic_metrics(aggregate_returns)

                window_reports: list[dict[str, Any]] = []
                active_windows = 0
                positive_windows = 0
                for index, window in enumerate(windows, start=1):
                    window_mask = _side_mask(
                        window,
                        side=side,
                        threshold=threshold,
                        volatility_floor=vol_floor,
                        rsi_floor=rsi_floor,
                    )
                    returns = pd.to_numeric(
                        window.loc[window_mask, return_column], errors="raise"
                    ).to_numpy(float)
                    metrics = _economic_metrics(returns)
                    if metrics["trade_count"] >= MIN_WINDOW_TRADES:
                        active_windows += 1
                        if metrics["total_return"] > 0.0:
                            positive_windows += 1
                    window_reports.append({"window": index, **metrics})

                pf_ok = (
                    aggregate["profit_factor_infinite"]
                    or (
                        aggregate["profit_factor"] is not None
                        and float(aggregate["profit_factor"]) >= MIN_AGGREGATE_SELECTION_PF
                    )
                )
                eligible = (
                    aggregate["trade_count"] >= MIN_TOTAL_SELECTION_TRADES
                    and aggregate["total_return"] > 0.0
                    and pf_ok
                    and active_windows >= MIN_ACTIVE_SELECTION_WINDOWS
                    and positive_windows >= MIN_POSITIVE_SELECTION_WINDOWS
                )
                candidates.append(
                    {
                        "side": side,
                        "threshold": float(threshold),
                        "volatility_quantile": vol_q,
                        "volatility_floor": vol_floor,
                        "rsi_quantile": rsi_q,
                        "rsi_floor": rsi_floor,
                        "active_windows": active_windows,
                        "positive_windows": positive_windows,
                        "window_reports": window_reports,
                        "eligible": bool(eligible),
                        **aggregate,
                    }
                )

    eligible = [row for row in candidates if row["eligible"]]
    if not eligible:
        return {
            "enabled": False,
            "side": side,
            "reason": "no_inner_consensus_policy_met_cross_window_evidence",
            "candidates": candidates,
        }

    selected = max(
        eligible,
        key=lambda row: (
            row["positive_windows"],
            row["active_windows"],
            row["trade_count"],
            row["profit_factor"] or float("inf"),
            row["total_return"],
        ),
    )
    return {
        "enabled": True,
        "side": side,
        "reason": "inner_chronological_consensus_economic_selection",
        **selected,
        "candidates": candidates,
    }


def _evaluate_era(
    pooled: pd.DataFrame,
    *,
    train_fraction: float,
    horizon_bars: int,
    max_splits: int,
) -> dict[str, Any]:
    unique_periods = int(pooled["decision_time"].nunique())
    min_train = max(250, int(unique_periods * train_fraction))
    validation = max(100, int(unique_periods * VALIDATION_FRACTION))
    variant = ModelVariant(
        name=f"event_barrier_v25_consensus_{int(train_fraction * 100):02d}"
    )

    folds: list[dict[str, Any]] = []
    for fold_index, (outer_train, outer_validation) in enumerate(
        iter_purged_walk_forward_time_splits(
            pooled,
            time_column="decision_time",
            min_train_periods=min_train,
            validation_periods=validation,
            purge_periods=horizon_bars,
            embargo_periods=horizon_bars,
            max_splits=max_splits,
        ),
        start=1,
    ):
        nested = _nested_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        inner_models = _fit_models(nested.fit, nested.early_stop, variant=variant)
        inner_calibrators = _fit_side_calibrators(inner_models, nested.calibration)
        selection = _ensure_event_dual_actionability_targets(nested.selection)
        selection_scored = _score_frame(
            inner_models,
            selection,
            calibrators=inner_calibrators,
        )
        long_choice = select_consensus_policy(selection_scored, side="long")
        short_choice = select_consensus_policy(selection_scored, side="short")

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_models = _fit_models(refit.fit, refit.early_stop, variant=variant)
        outer_calibrators = _fit_side_calibrators(outer_models, refit.calibration)
        outer_scored = _score_frame(
            outer_models,
            outer_validation,
            calibrators=outer_calibrators,
        )
        long_threshold = (
            float(long_choice["threshold"]) if long_choice.get("enabled") else 1.0
        )
        short_threshold = (
            float(short_choice["threshold"]) if short_choice.get("enabled") else 1.0
        )
        gated = _apply_side_policy(
            outer_scored,
            long_threshold=long_threshold,
            short_threshold=short_threshold,
            long_min_volatility=long_choice.get("volatility_floor"),
            long_min_rsi=long_choice.get("rsi_floor"),
            short_min_volatility=short_choice.get("volatility_floor"),
            short_min_rsi=short_choice.get("rsi_floor"),
        )
        active = gated.loc[gated["active_trade"]].copy()
        fold = _fold_report(
            outer_scored,
            long_threshold=long_threshold,
            short_threshold=short_threshold,
            long_min_volatility=long_choice.get("volatility_floor"),
            long_min_rsi=long_choice.get("rsi_floor"),
            short_min_volatility=short_choice.get("volatility_floor"),
            short_min_rsi=short_choice.get("rsi_floor"),
        )
        fold["fold"] = fold_index
        fold["validation_start"] = str(outer_validation["decision_time"].min())
        fold["validation_end"] = str(outer_validation["decision_time"].max())
        fold["inner_long_consensus"] = long_choice
        fold["inner_short_consensus"] = short_choice
        folds.append(fold)
        print(json.dumps({
            "train_fraction": train_fraction,
            "fold": fold_index,
            "long_enabled": long_choice.get("enabled"),
            "short_enabled": short_choice.get("enabled"),
            "trades": int(len(active)),
            "long": int(active["predicted_long"].sum()) if not active.empty else 0,
            "short": int((~active["predicted_long"]).sum()) if not active.empty else 0,
            "total_return": fold["trading"]["total_return"],
            "profit_factor": fold["trading"]["profit_factor"],
        }, sort_keys=True), flush=True)

    records = [record for fold in folds for record in fold["active_trade_records"]]
    if records:
        active = pd.DataFrame(records)
        active["decision_time"] = pd.to_datetime(
            active["decision_time"], utc=True, errors="raise"
        )
        trading = _trading_metrics(active)
    else:
        trading = _trading_metrics(pd.DataFrame())

    trade_counts = [int(f["trading"]["trade_count"]) for f in folds]
    total = int(trading["trade_count"])
    long_trades = int(trading.get("long_trades", 0))
    short_trades = int(trading.get("short_trades", 0))
    positive_folds = sum(float(f["trading"]["total_return"]) > 0.0 for f in folds)
    concentration = max(trade_counts) / total if total and trade_counts else 0.0
    pf = trading.get("profit_factor")
    sharpe = trading.get("sharpe_ratio")
    gates = {
        "minimum_trade_evidence": total >= MIN_OUTER_TRADES,
        "minimum_each_fold_trade_evidence": bool(trade_counts)
        and min(trade_counts) >= MIN_PER_FOLD_TRADES,
        "fold_concentration_lte_0_80": concentration <= MAX_FOLD_TRADE_CONCENTRATION,
        "two_sided_execution": long_trades > 0 and short_trades > 0,
        "positive_fold_fraction_gte_0_60": (
            positive_folds / len(folds) >= 0.60 if folds else False
        ),
        "aggregate_profit_factor_gte_1_15": pf is not None and float(pf) >= 1.15,
        "aggregate_sharpe_gte_1_0": sharpe is not None and float(sharpe) >= 1.0,
        "aggregate_max_drawdown_lte_0_12": float(
            trading.get("max_drawdown", 1.0)
        ) <= 0.12,
    }
    gates["era_passed"] = all(bool(v) for v in gates.values())
    return {
        "train_fraction": train_fraction,
        "folds": folds,
        "aggregate": {
            "trading": trading,
            "fold_trade_counts": trade_counts,
            "max_fold_trade_fraction": concentration,
            "positive_fold_fraction": positive_folds / len(folds) if folds else 0.0,
        },
        "gates": gates,
    }


def evaluate_v25(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str,
    max_splits: int = 1,
) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    eras = [
        _evaluate_era(
            pooled,
            train_fraction=fraction,
            horizon_bars=horizon_bars,
            max_splits=max_splits,
        )
        for fraction in TRAIN_FRACTIONS
    ]
    return {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "frozen_v10_holdout_unchanged": True,
        "decision_time_before": pd.Timestamp(decision_time_before).isoformat(),
        "dataset_sha256": hashes,
        "protocol": {
            "train_fractions": list(TRAIN_FRACTIONS),
            "validation_fraction": VALIDATION_FRACTION,
            "inner_windows": INNER_WINDOWS,
            "cross_window_consensus_required": True,
            "no_outer_retuning": True,
            "payoff_ratio_floor": PAYOFF_RATIO_FLOOR,
        },
        "eras": eras,
        "stability_passed": bool(eras) and all(
            bool(era["gates"]["era_passed"]) for era in eras
        ),
    }


def _parse_dataset(value: str) -> dict[str, str]:
    instrument, sep, path = value.partition("=")
    if not sep:
        raise ValueError("--dataset must use INSTRUMENT=/path.csv")
    return {instrument.strip().upper(): path.strip()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--horizon-bars", type=int, default=1)
    parser.add_argument("--decision-time-before", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--max-splits", type=int, default=1)
    args = parser.parse_args()

    report = evaluate_v25(
        _parse_dataset(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        max_splits=args.max_splits,
    )
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    print(json.dumps({
        "stability_passed": report["stability_passed"],
        "eras": [
            {
                "train_fraction": era["train_fraction"],
                "trading": era["aggregate"]["trading"],
                "gates": era["gates"],
            }
            for era in report["eras"]
        ],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
