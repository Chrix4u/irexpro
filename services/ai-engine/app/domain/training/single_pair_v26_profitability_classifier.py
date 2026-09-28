"""USDJPY v26 research: side-specific profitability classification.

This candidate replaces the unstable payoff-magnitude regressors with binary
classifiers that estimate whether a LONG or SHORT trade would finish positive
after the existing friction model. Side actionability and side profitability
are calibrated independently. Thresholds are selected only on inner
chronological evidence and must satisfy explicit trade-count, PF and temporal
consistency requirements before untouched outer validation.

Frozen v10 and the sealed future holdout remain untouched.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.training.model_qualification import (
    EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    ModelVariant,
    _apply_calibrator,
    _ensure_event_dual_actionability_targets,
    _feature_columns,
    _fit_binary_variant,
    _fit_calibrator,
    _nested_windows,
    _probabilities,
    _refit_windows,
)
from app.domain.training.single_pair_v11_calibrated_gating import _trading_metrics
from app.domain.training.single_pair_v16_two_sided_economic import (
    MAX_FOLD_TRADE_CONCENTRATION,
    MIN_OUTER_TRADES,
    MIN_PER_FOLD_TRADES,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v26_profitability_classifier"
LONG_PROFITABLE_TARGET = "event_long_profitable_target"
SHORT_PROFITABLE_TARGET = "event_short_profitable_target"
ACTION_THRESHOLD_GRID = (0.04, 0.05, 0.06, 0.08, 0.10, 0.12)
PROFIT_THRESHOLD_GRID = (0.45, 0.50, 0.55, 0.60, 0.65)
MIN_SELECTION_TRADES = 30
MIN_SEGMENT_TRADES = 5
SEGMENT_COUNT = 3
MIN_POSITIVE_SEGMENTS = 2
MIN_SELECTION_PROFIT_FACTOR = 1.15
DEFAULT_TRAIN_FRACTION = 0.60
DEFAULT_VALIDATION_FRACTION = 0.02


@dataclass
class V26Models:
    long_action: Any
    short_action: Any
    long_profit: Any
    short_profit: Any
    feature_columns: list[str]


def _with_profitability_targets(frame: pd.DataFrame) -> pd.DataFrame:
    result = _ensure_event_dual_actionability_targets(frame).copy()
    result[LONG_PROFITABLE_TARGET] = (
        pd.to_numeric(result[EVENT_LONG_NET_RETURN_COLUMN], errors="raise") > 0.0
    ).astype(int)
    result[SHORT_PROFITABLE_TARGET] = (
        pd.to_numeric(result[EVENT_SHORT_NET_RETURN_COLUMN], errors="raise") > 0.0
    ).astype(int)
    return result


def _fit_models(
    fit: pd.DataFrame,
    early_stop: pd.DataFrame,
    *,
    variant: ModelVariant,
) -> V26Models:
    fit = _with_profitability_targets(fit)
    early_stop = _with_profitability_targets(early_stop)
    features = _feature_columns(variant.feature_policy)

    models: dict[str, Any] = {}
    targets = {
        "long_action": EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
        "short_action": EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
        "long_profit": LONG_PROFITABLE_TARGET,
        "short_profit": SHORT_PROFITABLE_TARGET,
    }
    for name, target in targets.items():
        side_variant = ModelVariant(
            name=f"{variant.name}_{name}",
            sample_weight_policy="class_balance",
            calibration="none",
            feature_policy=variant.feature_policy,
        )
        models[name] = _fit_binary_variant(
            side_variant,
            fit=fit,
            early_stop=early_stop,
            feature_columns=features,
            target_column=target,
            sample_weight_policy="class_balance",
        )

    return V26Models(
        long_action=models["long_action"],
        short_action=models["short_action"],
        long_profit=models["long_profit"],
        short_profit=models["short_profit"],
        feature_columns=features,
    )


def _fit_calibrators(
    models: V26Models,
    calibration: pd.DataFrame,
) -> dict[str, Any]:
    calibration = _with_profitability_targets(calibration)
    specs = {
        "long_action": (
            models.long_action,
            EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
        ),
        "short_action": (
            models.short_action,
            EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
        ),
        "long_profit": (
            models.long_profit,
            LONG_PROFITABLE_TARGET,
        ),
        "short_profit": (
            models.short_profit,
            SHORT_PROFITABLE_TARGET,
        ),
    }
    calibrators: dict[str, Any] = {}
    for name, (model, target) in specs.items():
        raw = _probabilities(model, calibration, models.feature_columns)
        calibrators[name] = _fit_calibrator(
            "platt",
            probabilities=raw,
            labels=calibration[target].to_numpy(int),
        )
    return calibrators


def _score_frame(
    models: V26Models,
    frame: pd.DataFrame,
    *,
    calibrators: dict[str, Any],
) -> pd.DataFrame:
    source = _with_profitability_targets(frame)
    result = source[
        [
            "decision_time",
            "instrument",
            EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
            EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
            EVENT_LONG_NET_RETURN_COLUMN,
            EVENT_SHORT_NET_RETURN_COLUMN,
            LONG_PROFITABLE_TARGET,
            SHORT_PROFITABLE_TARGET,
            "m1_volatility_20",
            "h1_rsi_14",
            "m1_spread_bps",
        ]
    ].copy()
    for name, model in {
        "long_action": models.long_action,
        "short_action": models.short_action,
        "long_profit": models.long_profit,
        "short_profit": models.short_profit,
    }.items():
        raw = _probabilities(model, source, models.feature_columns)
        result[f"{name}_probability"] = _apply_calibrator(
            calibrators[name],
            raw,
        )
    return result


def _economic_metrics(returns: np.ndarray) -> dict[str, Any]:
    values = np.asarray(returns, dtype=float)
    if len(values) == 0:
        return {
            "trade_count": 0,
            "profit_factor": None,
            "profit_factor_infinite": False,
            "total_return": 0.0,
            "win_rate": 0.0,
        }
    gains = float(values[values > 0.0].sum())
    losses = float(-values[values < 0.0].sum())
    if losses > 0.0:
        pf: float | None = gains / losses
    elif gains > 0.0:
        pf = float("inf")
    else:
        pf = None
    return {
        "trade_count": int(len(values)),
        "profit_factor": None if pf is None or not np.isfinite(pf) else float(pf),
        "profit_factor_infinite": bool(pf is not None and not np.isfinite(pf)),
        "total_return": float(values.sum()),
        "win_rate": float((values > 0.0).mean()),
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
    unique_times = (
        ordered["decision_time"].drop_duplicates().sort_values().to_numpy()
    )
    chunks = np.array_split(unique_times, SEGMENT_COUNT)
    segments: list[pd.DataFrame] = []
    for chunk in chunks:
        if len(chunk) == 0:
            continue
        segments.append(
            ordered.loc[ordered["decision_time"].isin(set(chunk.tolist()))]
            .copy()
            .reset_index(drop=True)
        )
    return segments


def _side_mask(
    scored: pd.DataFrame,
    *,
    side: str,
    action_threshold: float,
    profit_threshold: float,
) -> pd.Series:
    if side not in {"long", "short"}:
        raise ValueError("side must be long or short")
    return (
        (scored[f"{side}_action_probability"] >= action_threshold)
        & (scored[f"{side}_profit_probability"] >= profit_threshold)
    )


def _candidate_metrics(
    scored: pd.DataFrame,
    *,
    side: str,
    action_threshold: float,
    profit_threshold: float,
) -> dict[str, Any]:
    return_column = (
        EVENT_LONG_NET_RETURN_COLUMN
        if side == "long"
        else EVENT_SHORT_NET_RETURN_COLUMN
    )
    mask = _side_mask(
        scored,
        side=side,
        action_threshold=action_threshold,
        profit_threshold=profit_threshold,
    )
    overall = _economic_metrics(
        pd.to_numeric(
            scored.loc[mask, return_column],
            errors="raise",
        ).to_numpy(float)
    )

    positive_segments = 0
    segment_reports: list[dict[str, Any]] = []
    for index, segment in enumerate(_chronological_segments(scored), start=1):
        segment_mask = _side_mask(
            segment,
            side=side,
            action_threshold=action_threshold,
            profit_threshold=profit_threshold,
        )
        metrics = _economic_metrics(
            pd.to_numeric(
                segment.loc[segment_mask, return_column],
                errors="raise",
            ).to_numpy(float)
        )
        positive = (
            int(metrics["trade_count"]) >= MIN_SEGMENT_TRADES
            and float(metrics["total_return"]) > 0.0
        )
        if positive:
            positive_segments += 1
        segment_reports.append(
            {
                "segment": index,
                **metrics,
                "positive": positive,
            }
        )

    overall_pf = _pf_value(overall)
    eligible = (
        int(overall["trade_count"]) >= MIN_SELECTION_TRADES
        and float(overall["total_return"]) > 0.0
        and overall_pf is not None
        and overall_pf >= MIN_SELECTION_PROFIT_FACTOR
        and positive_segments >= MIN_POSITIVE_SEGMENTS
    )
    return {
        **overall,
        "positive_segments": positive_segments,
        "segment_reports": segment_reports,
        "eligible": bool(eligible),
    }


def select_side_policy(
    scored: pd.DataFrame,
    *,
    side: str,
) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    for action_threshold in ACTION_THRESHOLD_GRID:
        for profit_threshold in PROFIT_THRESHOLD_GRID:
            metrics = _candidate_metrics(
                scored,
                side=side,
                action_threshold=float(action_threshold),
                profit_threshold=float(profit_threshold),
            )
            candidates.append(
                {
                    "side": side,
                    "action_threshold": float(action_threshold),
                    "profit_threshold": float(profit_threshold),
                    **metrics,
                }
            )

    eligible = [candidate for candidate in candidates if candidate["eligible"]]
    if not eligible:
        return {
            "side": side,
            "enabled": False,
            "reason": "no_inner_profitability_policy_met_economic_evidence",
            "candidates": candidates,
        }

    def key(row: dict[str, Any]) -> tuple[float, ...]:
        return (
            float(row["positive_segments"]),
            float(row["trade_count"]),
            float(_pf_value(row) or 0.0),
            float(row["total_return"]),
            float(row["win_rate"]),
        )

    selected = max(eligible, key=key)
    return {
        "enabled": True,
        "reason": "inner_actionability_plus_profitability_evidence",
        **selected,
        "candidates": candidates,
    }


def _apply_policy(
    scored: pd.DataFrame,
    *,
    long_choice: dict[str, Any],
    short_choice: dict[str, Any],
) -> pd.DataFrame:
    result = scored.copy()
    if long_choice.get("enabled"):
        long_pass = _side_mask(
            result,
            side="long",
            action_threshold=float(long_choice["action_threshold"]),
            profit_threshold=float(long_choice["profit_threshold"]),
        )
    else:
        long_pass = pd.Series(False, index=result.index)

    if short_choice.get("enabled"):
        short_pass = _side_mask(
            result,
            side="short",
            action_threshold=float(short_choice["action_threshold"]),
            profit_threshold=float(short_choice["profit_threshold"]),
        )
    else:
        short_pass = pd.Series(False, index=result.index)

    long_strength = (
        result["long_action_probability"] * result["long_profit_probability"]
    )
    short_strength = (
        result["short_action_probability"] * result["short_profit_probability"]
    )
    choose_long = long_pass & (~short_pass | (long_strength >= short_strength))
    choose_short = short_pass & ~choose_long

    result["long_gate_pass"] = long_pass
    result["short_gate_pass"] = short_pass
    result["active_trade"] = choose_long | choose_short
    result["predicted_long"] = choose_long
    result["selected_net_return"] = np.where(
        choose_long,
        result[EVENT_LONG_NET_RETURN_COLUMN],
        np.where(
            choose_short,
            result[EVENT_SHORT_NET_RETURN_COLUMN],
            0.0,
        ),
    )
    return result


def _fold_report(
    scored: pd.DataFrame,
    *,
    long_choice: dict[str, Any],
    short_choice: dict[str, Any],
) -> dict[str, Any]:
    gated = _apply_policy(
        scored,
        long_choice=long_choice,
        short_choice=short_choice,
    )
    active = gated.loc[gated["active_trade"]].copy()
    return {
        "trading": _trading_metrics(active),
        "active_trade_records": [
            {
                "decision_time": str(row.decision_time),
                "predicted_long": bool(row.predicted_long),
                "selected_net_return": float(row.selected_net_return),
            }
            for row in active.itertuples(index=False)
        ],
    }


def evaluate_v26(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str,
    train_fraction: float = DEFAULT_TRAIN_FRACTION,
    validation_fraction: float = DEFAULT_VALIDATION_FRACTION,
    max_splits: int = 1,
) -> dict[str, Any]:
    if not 0.30 <= train_fraction <= 0.94:
        raise ValueError("train_fraction out of research range")

    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    unique_periods = int(pooled["decision_time"].nunique())
    min_train = max(250, int(unique_periods * train_fraction))
    validation = max(100, int(unique_periods * validation_fraction))
    variant = ModelVariant(
        name=f"event_barrier_v26_profitability_{int(train_fraction * 100)}"
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
        inner_models = _fit_models(
            nested.fit,
            nested.early_stop,
            variant=variant,
        )
        inner_calibrators = _fit_calibrators(
            inner_models,
            nested.calibration,
        )
        selection_scored = _score_frame(
            inner_models,
            nested.selection,
            calibrators=inner_calibrators,
        )
        long_choice = select_side_policy(selection_scored, side="long")
        short_choice = select_side_policy(selection_scored, side="short")

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_models = _fit_models(
            refit.fit,
            refit.early_stop,
            variant=variant,
        )
        outer_calibrators = _fit_calibrators(
            outer_models,
            refit.calibration,
        )
        outer_scored = _score_frame(
            outer_models,
            outer_validation,
            calibrators=outer_calibrators,
        )
        fold = _fold_report(
            outer_scored,
            long_choice=long_choice,
            short_choice=short_choice,
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
                    "long_action_threshold": long_choice.get(
                        "action_threshold"
                    ),
                    "long_profit_threshold": long_choice.get(
                        "profit_threshold"
                    ),
                    "short_action_threshold": short_choice.get(
                        "action_threshold"
                    ),
                    "short_profit_threshold": short_choice.get(
                        "profit_threshold"
                    ),
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
    gates["research_robustness_passed"] = all(
        bool(value) for value in gates.values()
    )

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
            "positive_return_target_is_after_friction": True,
            "minimum_inner_trade_evidence": MIN_SELECTION_TRADES,
            "minimum_positive_inner_segments": MIN_POSITIVE_SEGMENTS,
            "minimum_selection_profit_factor": MIN_SELECTION_PROFIT_FACTOR,
            "payoff_magnitude_regressors_removed": True,
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
    parser.add_argument(
        "--train-fraction",
        type=float,
        default=DEFAULT_TRAIN_FRACTION,
    )
    parser.add_argument(
        "--validation-fraction",
        type=float,
        default=DEFAULT_VALIDATION_FRACTION,
    )
    parser.add_argument("--max-splits", type=int, default=1)
    args = parser.parse_args()

    report = evaluate_v26(
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
