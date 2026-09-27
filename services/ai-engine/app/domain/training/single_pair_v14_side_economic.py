"""USDJPY v14 research: side-specific calibrated economic gating.

v14 is a new candidate built after v13's outer folds were exposed. It does not
retune v13. LONG and SHORT actionability remain independently calibrated, but
threshold pairs are eligible only when nested inner-selection trading economics
and two-sided evidence are acceptable. Outer validation uses a later disjoint
historical era (82%-94% of the pre-boundary corpus), preserving v11-v13 eras.
Frozen v10 and its future holdout remain untouched.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import pandas as pd
from sklearn.metrics import balanced_accuracy_score

from app.domain.training.fold_checkpoint import (
    load_fold_checkpoint,
    research_fingerprint,
    save_fold_checkpoint,
)
from app.domain.training.model_qualification import (
    EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
    EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
    ModelVariant,
    _nested_windows,
    _refit_windows,
)
from app.domain.training.robustness_audit import (
    cost_stress_frontier,
    extended_risk_metrics,
)
from app.domain.training.single_pair_v11_calibrated_gating import (
    _fit_models,
    _trading_metrics,
)
from app.domain.training.single_pair_v13_side_specific import (
    SIDE_THRESHOLD_GRID,
    _apply_side_policy,
    _fit_side_calibrators,
    _score_frame,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v14_side_specific_economic_gating"
MIN_INNER_TRADES = 12
MIN_INNER_SIDE_TRADES = 2
MAX_INNER_SIDE_CONCENTRATION = 0.85
MIN_OUTER_TRADES = 30
MIN_OUTER_SIDE_TRADES = 5
MIN_PER_FOLD_TRADES = 5
MAX_FOLD_TRADE_CONCENTRATION = 0.80


def _candidate_report(
    scored: pd.DataFrame,
    *,
    long_threshold: float,
    short_threshold: float,
) -> dict[str, Any]:
    gated = _apply_side_policy(
        scored,
        long_threshold=long_threshold,
        short_threshold=short_threshold,
    )
    active = gated.loc[gated["active_trade"]].copy()
    trading = _trading_metrics(active)
    long_trades = int(trading.get("long_trades", 0))
    short_trades = int(trading.get("short_trades", 0))
    total_trades = int(trading["trade_count"])
    side_concentration = (
        max(long_trades, short_trades) / total_trades if total_trades else 1.0
    )
    profit_factor = trading.get("profit_factor")
    pf_for_gate = (
        float(profit_factor)
        if profit_factor is not None
        else (float("inf") if total_trades >= MIN_INNER_TRADES else 0.0)
    )
    long_ba = float(
        balanced_accuracy_score(
            gated[EVENT_LONG_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
            (gated["long_action_probability"] >= long_threshold).to_numpy(int),
        )
    )
    short_ba = float(
        balanced_accuracy_score(
            gated[EVENT_SHORT_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
            (gated["short_action_probability"] >= short_threshold).to_numpy(int),
        )
    )
    checks = {
        "minimum_inner_trades": total_trades >= MIN_INNER_TRADES,
        "minimum_long_trades": long_trades >= MIN_INNER_SIDE_TRADES,
        "minimum_short_trades": short_trades >= MIN_INNER_SIDE_TRADES,
        "side_concentration": side_concentration <= MAX_INNER_SIDE_CONCENTRATION,
        "positive_total_return": float(trading["total_return"]) > 0.0,
        "profit_factor": pf_for_gate >= 1.15,
        "max_drawdown": float(trading["max_drawdown"]) <= 0.12,
    }
    eligible = all(checks.values())
    return {
        "long_threshold": float(long_threshold),
        "short_threshold": float(short_threshold),
        "long_balanced_accuracy": long_ba,
        "short_balanced_accuracy": short_ba,
        "mean_side_balanced_accuracy": (long_ba + short_ba) / 2.0,
        "side_concentration": float(side_concentration),
        "trading": trading,
        "checks": checks,
        "eligible": bool(eligible),
    }


def select_economic_side_thresholds(scored: pd.DataFrame) -> dict[str, Any]:
    candidates = [
        _candidate_report(
            scored,
            long_threshold=long_threshold,
            short_threshold=short_threshold,
        )
        for long_threshold in SIDE_THRESHOLD_GRID
        for short_threshold in SIDE_THRESHOLD_GRID
    ]
    eligible = [row for row in candidates if row["eligible"]]
    if not eligible:
        failure_counts = {
            key: sum(not bool(row["checks"][key]) for row in candidates)
            for key in candidates[0]["checks"]
        }
        near_candidates = sorted(
            candidates,
            key=lambda row: (
                sum(bool(value) for value in row["checks"].values()),
                float(row["trading"]["total_return"]),
                -row["side_concentration"],
            ),
            reverse=True,
        )[:5]
        return {
            "selected": None,
            "candidate_count": len(candidates),
            "eligible_count": 0,
            "reason": (
                "No inner side-threshold pair met two-sided evidence, "
                "concentration, profit-factor, return, and drawdown constraints."
            ),
            "failure_counts": failure_counts,
            "best_near_candidates": near_candidates,
            "candidates": candidates,
        }

    selected = max(
        eligible,
        key=lambda row: (
            min(
                float(row["trading"]["profit_factor"])
                if row["trading"]["profit_factor"] is not None
                else 3.0,
                3.0,
            ),
            float(row["trading"]["total_return"]),
            row["mean_side_balanced_accuracy"],
            min(float(row["trading"]["trade_count"]), 40.0) / 40.0,
            -row["side_concentration"],
        ),
    )
    return {
        "selected": selected,
        "candidate_count": len(candidates),
        "eligible_count": len(eligible),
        "candidates": candidates,
    }


def _outer_fold_report(
    scored: pd.DataFrame,
    *,
    selection: dict[str, Any],
) -> dict[str, Any]:
    selected = selection["selected"]
    if selected is None:
        return {
            "selection_failed": True,
            "active_trade_records": [],
            "trading": _trading_metrics(pd.DataFrame()),
        }

    gated = _apply_side_policy(
        scored,
        long_threshold=float(selected["long_threshold"]),
        short_threshold=float(selected["short_threshold"]),
    )
    active = gated.loc[gated["active_trade"]].copy()
    return {
        "selection_failed": False,
        "long_threshold": float(selected["long_threshold"]),
        "short_threshold": float(selected["short_threshold"]),
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


def evaluate_v14(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str,
    max_splits: int = 3,
    candidate_sha: str = "UNSPECIFIED",
    checkpoint_dir: str | Path | None = None,
) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    unique_periods = int(pooled["decision_time"].nunique())
    min_train = int(unique_periods * 0.82)
    validation = int(unique_periods * 0.04)
    variant = ModelVariant(name="event_barrier_v14_side_specific_economic")
    fingerprint = research_fingerprint(
        experiment=EXPERIMENT_NAME,
        candidate_sha=candidate_sha,
        dataset_hashes=hashes,
        decision_time_before=pd.Timestamp(decision_time_before).isoformat(),
        horizon_bars=horizon_bars,
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
        if checkpoint_dir is not None:
            resumed = load_fold_checkpoint(
                checkpoint_dir,
                fingerprint=fingerprint,
                fold_index=fold_index,
            )
            if resumed is not None:
                folds.append(resumed)
                print(
                    json.dumps(
                        {"fold": fold_index, "resumed_from_checkpoint": True},
                        sort_keys=True,
                    ),
                    flush=True,
                )
                continue

        fold_started = time.monotonic()
        print(
            json.dumps(
                {"fold": fold_index, "phase": "training_started"},
                sort_keys=True,
            ),
            flush=True,
        )
        nested = _nested_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        inner_models = _fit_models(nested.fit, nested.early_stop, variant=variant)
        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "phase": "inner_models_fitted",
                    "elapsed_seconds": round(time.monotonic() - fold_started, 3),
                },
                sort_keys=True,
            ),
            flush=True,
        )
        inner_calibrators = _fit_side_calibrators(
            inner_models,
            nested.calibration,
        )
        selection_scored = _score_frame(
            inner_models,
            nested.selection,
            calibrators=inner_calibrators,
        )
        gate_selection = select_economic_side_thresholds(selection_scored)
        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "phase": "inner_gate_selected",
                    "eligible_count": gate_selection["eligible_count"],
                    "elapsed_seconds": round(time.monotonic() - fold_started, 3),
                },
                sort_keys=True,
            ),
            flush=True,
        )

        if gate_selection["selected"] is None:
            fold = _outer_fold_report(
                pd.DataFrame(),
                selection=gate_selection,
            )
            fold["fold"] = fold_index
            fold["validation_start"] = str(
                outer_validation["decision_time"].min()
            )
            fold["validation_end"] = str(
                outer_validation["decision_time"].max()
            )
            fold["inner_gate_selection"] = gate_selection
            folds.append(fold)
            if checkpoint_dir is not None:
                save_fold_checkpoint(
                    checkpoint_dir,
                    fingerprint=fingerprint,
                    fold_index=fold_index,
                    fold_report=fold,
                )
            print(
                json.dumps(
                    {
                        "fold": fold_index,
                        "selection_failed": True,
                        "phase": "outer_refit_skipped",
                        "trades": 0,
                        "long": 0,
                        "short": 0,
                        "total_return": 0.0,
                        "elapsed_seconds": round(
                            time.monotonic() - fold_started,
                            3,
                        ),
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            continue

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_models = _fit_models(refit.fit, refit.early_stop, variant=variant)
        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "phase": "outer_models_fitted",
                    "elapsed_seconds": round(time.monotonic() - fold_started, 3),
                },
                sort_keys=True,
            ),
            flush=True,
        )
        outer_calibrators = _fit_side_calibrators(
            outer_models,
            refit.calibration,
        )
        outer_scored = _score_frame(
            outer_models,
            outer_validation,
            calibrators=outer_calibrators,
        )
        fold = _outer_fold_report(outer_scored, selection=gate_selection)
        fold["fold"] = fold_index
        fold["validation_start"] = str(outer_validation["decision_time"].min())
        fold["validation_end"] = str(outer_validation["decision_time"].max())
        fold["inner_gate_selection"] = gate_selection
        folds.append(fold)
        if checkpoint_dir is not None:
            save_fold_checkpoint(
                checkpoint_dir,
                fingerprint=fingerprint,
                fold_index=fold_index,
                fold_report=fold,
            )

        selected = gate_selection["selected"]
        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "selection_failed": fold["selection_failed"],
                    "long_threshold": (
                        selected["long_threshold"] if selected is not None else None
                    ),
                    "short_threshold": (
                        selected["short_threshold"] if selected is not None else None
                    ),
                    "trades": fold["trading"]["trade_count"],
                    "long": fold["trading"].get("long_trades", 0),
                    "short": fold["trading"].get("short_trades", 0),
                    "total_return": fold["trading"]["total_return"],
                    "elapsed_seconds": round(time.monotonic() - fold_started, 3),
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
            active["decision_time"], utc=True, errors="raise"
        )
        aggregate_trading = _trading_metrics(active)
        active_times = pd.to_datetime(active["decision_time"], utc=True)
        span_years = max(
            (active_times.max() - active_times.min()).total_seconds()
            / (365.25 * 24 * 3600),
            1.0 / 365.25,
        )
        periods_per_year = max(float(len(active)) / span_years, 1.0)
        aggregate_returns = active["selected_net_return"].to_numpy(float)
        aggregate_extended_risk = extended_risk_metrics(
            aggregate_returns,
            annualization_factor=periods_per_year,
        )
        aggregate_cost_stress = cost_stress_frontier(aggregate_returns)
    else:
        aggregate_trading = _trading_metrics(pd.DataFrame())
        aggregate_extended_risk = None
        aggregate_cost_stress = None

    trade_counts = [int(fold["trading"]["trade_count"]) for fold in folds]
    total_trades = int(aggregate_trading["trade_count"])
    long_trades = int(aggregate_trading.get("long_trades", 0))
    short_trades = int(aggregate_trading.get("short_trades", 0))
    max_concentration = (
        max(trade_counts) / total_trades
        if total_trades > 0 and trade_counts
        else 0.0
    )
    positive_folds = sum(
        float(fold["trading"]["total_return"]) > 0.0 for fold in folds
    )
    profit_factor = aggregate_trading.get("profit_factor")
    cost_pf_1bps = None
    if aggregate_cost_stress is not None:
        one_bps = next(
            (
                row
                for row in aggregate_cost_stress["scenarios"]
                if float(row["extra_cost_bps"]) == 1.0
            ),
            None,
        )
        if one_bps is not None:
            cost_pf_1bps = one_bps["profit_factor"]

    side_concentration = (
        max(long_trades, short_trades) / total_trades
        if total_trades > 0
        else 1.0
    )
    robustness_gate = {
        "all_inner_selections_succeeded": all(
            not bool(fold["selection_failed"]) for fold in folds
        ),
        "minimum_trade_evidence": total_trades >= MIN_OUTER_TRADES,
        "minimum_each_fold_trade_evidence": bool(trade_counts)
        and min(trade_counts) >= MIN_PER_FOLD_TRADES,
        "fold_concentration_lte_0_80": max_concentration
        <= MAX_FOLD_TRADE_CONCENTRATION,
        "two_sided_execution": long_trades > 0 and short_trades > 0,
        "minimum_each_side_trade_evidence": (
            long_trades >= MIN_OUTER_SIDE_TRADES
            and short_trades >= MIN_OUTER_SIDE_TRADES
        ),
        "aggregate_side_concentration_lte_0_85": side_concentration <= 0.85,
        "positive_fold_fraction_gte_0_60": (
            positive_folds / len(folds) >= 0.60 if folds else False
        ),
        "aggregate_profit_factor_gte_1_15": profit_factor is not None
        and float(profit_factor) >= 1.15,
        "aggregate_sharpe_gte_1_0": (
            aggregate_trading.get("sharpe_ratio") is not None
            and float(aggregate_trading["sharpe_ratio"]) >= 1.0
        ),
        "aggregate_max_drawdown_lte_0_12": float(
            aggregate_trading.get("max_drawdown", 1.0)
        )
        <= 0.12,
        "profit_factor_after_extra_1bps_gte_1_15": (
            cost_pf_1bps is not None and float(cost_pf_1bps) >= 1.15
        ),
    }
    robustness_gate["research_robustness_passed"] = all(
        bool(value) for key, value in robustness_gate.items()
        if key != "research_robustness_passed"
    )

    return {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "decision_time_before": pd.Timestamp(decision_time_before).isoformat(),
        "protocol": {
            "outer_min_train_fraction": 0.82,
            "outer_validation_fraction": 0.04,
            "outer_era_disjoint_from_v11_v12_v13": True,
            "side_specific_calibration": True,
            "inner_two_sided_economic_threshold_selection": True,
            "future_holdout_touched": False,
            "minimum_outer_side_trades": MIN_OUTER_SIDE_TRADES,
            "maximum_outer_side_concentration": 0.85,
            "execution_stress_gate_extra_bps": 1.0,
            "checkpoint_fingerprint": fingerprint,
        },
        "dataset_sha256": hashes,
        "folds": folds,
        "aggregate": {
            "trading": aggregate_trading,
            "fold_trade_counts": trade_counts,
            "max_fold_trade_fraction": max_concentration,
            "positive_fold_fraction": (
                positive_folds / len(folds) if folds else 0.0
            ),
            "extended_risk": aggregate_extended_risk,
            "execution_cost_stress": aggregate_cost_stress,
        },
        "robustness_gate": robustness_gate,
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
    parser.add_argument("--max-splits", type=int, default=3)
    parser.add_argument("--candidate-sha", default="UNSPECIFIED")
    parser.add_argument("--checkpoint-dir")
    args = parser.parse_args()

    report = evaluate_v14(
        _parse_dataset(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        max_splits=args.max_splits,
        candidate_sha=args.candidate_sha,
        checkpoint_dir=args.checkpoint_dir,
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
