"""USDJPY v25 research: temporal-consistency side policy.

This candidate keeps the side-specific calibrated models and locked economic
floors from v16, but rejects a side policy unless its inner chronological
selection evidence is distributed across multiple contiguous subwindows.

The purpose is to detect regime-fragile policies before untouched outer
validation. Frozen v10 and the sealed future holdout remain untouched.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.training.model_qualification import (
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
    LONG_RSI_QUANTILES,
    LONG_VOL_QUANTILES,
    MAX_FOLD_TRADE_CONCENTRATION,
    MIN_OUTER_TRADES,
    MIN_PER_FOLD_TRADES,
    SHORT_RSI_QUANTILES,
    SHORT_VOL_QUANTILES,
    SIDE_THRESHOLD_GRID,
    _fit_side_calibrators,
    _fold_report,
    _score_frame,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v25_temporal_consistency"
MIN_SIDE_SELECTION_TRADES = 12
MIN_SEGMENT_TRADES = 3
MIN_STABLE_SEGMENTS = 2
SELECTION_PROFIT_FACTOR_FLOOR = 1.15
SEGMENT_PROFIT_FACTOR_FLOOR = 1.00
SEGMENT_COUNT = 3
DEFAULT_TRAIN_FRACTION = 0.60
DEFAULT_VALIDATION_FRACTION = 0.02


def _economic_metrics(returns: np.ndarray) -> dict[str, Any]:
    returns = np.asarray(returns, dtype=float)
    if len(returns) == 0:
        return {
            "trade_count": 0,
            "profit_factor": None,
            "profit_factor_infinite": False,
            "total_return": 0.0,
            "win_rate": 0.0,
        }
    gains = float(returns[returns > 0.0].sum())
    losses = float(-returns[returns < 0.0].sum())
    if losses > 0.0:
        profit_factor: float | None = gains / losses
    elif gains > 0.0:
        profit_factor = float("inf")
    else:
        profit_factor = None
    return {
        "trade_count": int(len(returns)),
        "profit_factor": (
            None
            if profit_factor is None or not np.isfinite(profit_factor)
            else float(profit_factor)
        ),
        "profit_factor_infinite": bool(
            profit_factor is not None and not np.isfinite(profit_factor)
        ),
        "total_return": float(returns.sum()),
        "win_rate": float((returns > 0.0).mean()),
    }


def _pf_value(metrics: dict[str, Any]) -> float | None:
    if metrics["profit_factor_infinite"]:
        return float("inf")
    value = metrics["profit_factor"]
    return None if value is None else float(value)


def _chronological_segments(scored: pd.DataFrame) -> list[pd.DataFrame]:
    ordered = scored.sort_values(["decision_time", "instrument"]).reset_index(
        drop=True
    )
    if len(ordered) < SEGMENT_COUNT:
        return [ordered]
    positions = np.array_split(np.arange(len(ordered)), SEGMENT_COUNT)
    return [ordered.iloc[index].copy() for index in positions if len(index)]


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
    mask = (
        (scored[f"{side}_action_probability"] >= threshold)
        & (scored[f"{side}_expected_net_bps"] > 0.0)
        & (scored[f"{side}_payoff_ratio"] >= PAYOFF_RATIO_FLOOR)
    )
    if volatility_floor is not None:
        mask &= scored["m1_volatility_20"] >= volatility_floor
    if rsi_floor is not None:
        mask &= scored["h1_rsi_14"] >= rsi_floor
    return mask


def _candidate_metrics(
    scored: pd.DataFrame,
    *,
    side: str,
    threshold: float,
    volatility_floor: float | None,
    rsi_floor: float | None,
) -> dict[str, Any]:
    return_column = f"event_{side}_net_return"
    mask = _side_mask(
        scored,
        side=side,
        threshold=threshold,
        volatility_floor=volatility_floor,
        rsi_floor=rsi_floor,
    )
    overall = _economic_metrics(
        pd.to_numeric(scored.loc[mask, return_column], errors="raise").to_numpy(
            float
        )
    )

    segment_metrics: list[dict[str, Any]] = []
    stable_segments = 0
    for index, segment in enumerate(_chronological_segments(scored), start=1):
        segment_mask = _side_mask(
            segment,
            side=side,
            threshold=threshold,
            volatility_floor=volatility_floor,
            rsi_floor=rsi_floor,
        )
        metrics = _economic_metrics(
            pd.to_numeric(
                segment.loc[segment_mask, return_column],
                errors="raise",
            ).to_numpy(float)
        )
        pf = _pf_value(metrics)
        stable = (
            int(metrics["trade_count"]) >= MIN_SEGMENT_TRADES
            and float(metrics["total_return"]) > 0.0
            and pf is not None
            and pf >= SEGMENT_PROFIT_FACTOR_FLOOR
        )
        if stable:
            stable_segments += 1
        segment_metrics.append(
            {
                "segment": index,
                **metrics,
                "stable": stable,
            }
        )

    overall_pf = _pf_value(overall)
    eligible = (
        int(overall["trade_count"]) >= MIN_SIDE_SELECTION_TRADES
        and float(overall["total_return"]) > 0.0
        and overall_pf is not None
        and overall_pf >= SELECTION_PROFIT_FACTOR_FLOOR
        and stable_segments >= MIN_STABLE_SEGMENTS
    )
    return {
        **overall,
        "stable_segments": stable_segments,
        "segment_count": len(segment_metrics),
        "segment_metrics": segment_metrics,
        "eligible": bool(eligible),
    }


def select_temporally_stable_side_policy(
    scored: pd.DataFrame,
    *,
    side: str,
) -> dict[str, Any]:
    """Select one side policy using only inner chronological evidence."""
    if side == "long":
        volatility_quantiles = LONG_VOL_QUANTILES
        rsi_quantiles = LONG_RSI_QUANTILES
    elif side == "short":
        volatility_quantiles = SHORT_VOL_QUANTILES
        rsi_quantiles = SHORT_RSI_QUANTILES
    else:
        raise ValueError("side must be long or short")

    vol = pd.to_numeric(scored["m1_volatility_20"], errors="raise")
    rsi = pd.to_numeric(scored["h1_rsi_14"], errors="raise")
    candidates: list[dict[str, Any]] = []
    for threshold in SIDE_THRESHOLD_GRID:
        for vol_q in volatility_quantiles:
            vol_floor = None if vol_q is None else float(vol.quantile(vol_q))
            for rsi_q in rsi_quantiles:
                rsi_floor = None if rsi_q is None else float(rsi.quantile(rsi_q))
                metrics = _candidate_metrics(
                    scored,
                    side=side,
                    threshold=float(threshold),
                    volatility_floor=vol_floor,
                    rsi_floor=rsi_floor,
                )
                candidates.append(
                    {
                        "side": side,
                        "threshold": float(threshold),
                        "volatility_quantile": vol_q,
                        "volatility_floor": vol_floor,
                        "rsi_quantile": rsi_q,
                        "rsi_floor": rsi_floor,
                        **metrics,
                    }
                )

    eligible = [candidate for candidate in candidates if candidate["eligible"]]
    if not eligible:
        return {
            "side": side,
            "enabled": False,
            "reason": "no_temporally_stable_inner_policy",
            "candidates": candidates,
        }

    def key(row: dict[str, Any]) -> tuple[float, ...]:
        return (
            float(row["stable_segments"]),
            float(row["trade_count"]),
            float(_pf_value(row) or 0.0),
            float(row["total_return"]),
            float(row["win_rate"]),
            float(row["threshold"]),
        )

    selected = max(eligible, key=key)
    return {
        "enabled": True,
        "reason": "inner_temporal_consistency_evidence",
        **selected,
        "candidates": candidates,
    }


def evaluate_v25(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str,
    train_fraction: float = DEFAULT_TRAIN_FRACTION,
    validation_fraction: float = DEFAULT_VALIDATION_FRACTION,
    max_splits: int = 1,
) -> dict[str, Any]:
    if not 0.30 <= train_fraction <= 0.94:
        raise ValueError("train_fraction out of research audit range")

    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    unique_periods = int(pooled["decision_time"].nunique())
    min_train = max(250, int(unique_periods * train_fraction))
    validation = max(100, int(unique_periods * validation_fraction))
    variant = ModelVariant(
        name=f"event_barrier_v25_temporal_consistency_{int(train_fraction * 100)}"
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
        inner_calibrators = _fit_side_calibrators(
            inner_models,
            nested.calibration,
        )
        selection = _ensure_event_dual_actionability_targets(nested.selection)
        selection_scored = _score_frame(
            inner_models,
            selection,
            calibrators=inner_calibrators,
        )
        long_choice = select_temporally_stable_side_policy(
            selection_scored,
            side="long",
        )
        short_choice = select_temporally_stable_side_policy(
            selection_scored,
            side="short",
        )

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_models = _fit_models(refit.fit, refit.early_stop, variant=variant)
        outer_calibrators = _fit_side_calibrators(
            outer_models,
            refit.calibration,
        )
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
        fold["inner_long_policy"] = long_choice
        fold["inner_short_policy"] = short_choice
        folds.append(fold)

        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "train_fraction": train_fraction,
                    "long_enabled": long_choice.get("enabled"),
                    "short_enabled": short_choice.get("enabled"),
                    "long_stable_segments": long_choice.get("stable_segments", 0),
                    "short_stable_segments": short_choice.get("stable_segments", 0),
                    "trades": fold["trading"]["trade_count"],
                    "long": fold["trading"]["long_trades"],
                    "short": fold["trading"]["short_trades"],
                    "profit_factor": fold["trading"]["profit_factor"],
                    "total_return": fold["trading"]["total_return"],
                },
                sort_keys=True,
            ),
            flush=True,
        )

    records = [
        record
        for fold in folds
        for record in fold["active_trade_records"]
    ]
    if records:
        active = pd.DataFrame(records)
        active["decision_time"] = pd.to_datetime(
            active["decision_time"],
            utc=True,
            errors="raise",
        )
        trading = _trading_metrics(active)
    else:
        trading = _trading_metrics(pd.DataFrame())

    trade_counts = [int(fold["trading"]["trade_count"]) for fold in folds]
    total_trades = int(trading["trade_count"])
    long_trades = int(trading.get("long_trades", 0))
    short_trades = int(trading.get("short_trades", 0))
    max_concentration = (
        max(trade_counts) / total_trades
        if total_trades > 0 and trade_counts
        else 0.0
    )
    positive_folds = sum(
        float(fold["trading"]["total_return"]) > 0.0 for fold in folds
    )
    pf = trading.get("profit_factor")
    sharpe = trading.get("sharpe_ratio")
    gates = {
        "minimum_trade_evidence": total_trades >= MIN_OUTER_TRADES,
        "minimum_each_fold_trade_evidence": bool(trade_counts)
        and min(trade_counts) >= MIN_PER_FOLD_TRADES,
        "fold_concentration_lte_0_80": max_concentration
        <= MAX_FOLD_TRADE_CONCENTRATION,
        "two_sided_execution": long_trades > 0 and short_trades > 0,
        "positive_fold_fraction_gte_0_60": (
            positive_folds / len(folds) >= 0.60 if folds else False
        ),
        "aggregate_profit_factor_gte_1_15": pf is not None and float(pf) >= 1.15,
        "aggregate_sharpe_gte_1_0": sharpe is not None and float(sharpe) >= 1.0,
        "aggregate_max_drawdown_lte_0_12": float(
            trading.get("max_drawdown", 1.0)
        )
        <= 0.12,
    }
    gates["research_robustness_passed"] = all(bool(value) for value in gates.values())

    return {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "decision_time_before": pd.Timestamp(decision_time_before).isoformat(),
        "dataset_sha256": hashes,
        "protocol": {
            "train_fraction": train_fraction,
            "validation_fraction": validation_fraction,
            "selection_segment_count": SEGMENT_COUNT,
            "minimum_stable_segments": MIN_STABLE_SEGMENTS,
            "selection_profit_factor_floor": SELECTION_PROFIT_FACTOR_FLOOR,
            "segment_profit_factor_floor": SEGMENT_PROFIT_FACTOR_FLOOR,
            "payoff_ratio_floor": PAYOFF_RATIO_FLOOR,
            "no_outer_retuning": True,
            "frozen_v10_holdout_unchanged": True,
        },
        "folds": folds,
        "aggregate": {
            "trading": trading,
            "fold_trade_counts": trade_counts,
            "max_fold_trade_fraction": max_concentration,
            "positive_fold_fraction": (
                positive_folds / len(folds) if folds else 0.0
            ),
        },
        "robustness_gate": gates,
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
    parser.add_argument("--train-fraction", type=float, default=DEFAULT_TRAIN_FRACTION)
    parser.add_argument(
        "--validation-fraction",
        type=float,
        default=DEFAULT_VALIDATION_FRACTION,
    )
    parser.add_argument("--max-splits", type=int, default=1)
    args = parser.parse_args()

    report = evaluate_v25(
        _parse_dataset(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        train_fraction=args.train_fraction,
        validation_fraction=args.validation_fraction,
        max_splits=args.max_splits,
    )
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    print(json.dumps(report["aggregate"], sort_keys=True))
    print(json.dumps(report["robustness_gate"], sort_keys=True))


if __name__ == "__main__":
    main()
