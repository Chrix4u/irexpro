from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from app.domain.training.model_qualification import _summarize_predictions
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits
from app.domain.training.six_pair_v74_quote_profitability_router import (
    EXTRA_SLIPPAGE_BPS,
    FEATURES,
    H,
    PAIRS,
    apply,
    choose,
    density,
    fit_pair,
    score,
)

OUTER_FOLDS_REQUIRED = 3
MIN_OUTER_TRADES = 30
MAX_MEDIAN_GAP_MINUTES = 10.0
MIN_BALANCED_ACCURACY = 0.52
MIN_SHARPE = 1.0
MIN_PROFIT_FACTOR = 1.15
MAX_DRAWDOWN = 0.12
MIN_POSITIVE_FOLD_FRACTION = 2 / 3
MIN_CALIBRATION_PASS_FRACTION = 2 / 3


def _finite(value):
    return value is not None and np.isfinite(value)


def _fold_snapshot(fold: int, calibration_passed: bool, chosen: dict, pred: pd.DataFrame) -> dict:
    summary = _summarize_predictions(pred, horizon_bars=H, confidence_threshold=0.60)
    return {
        "fold": fold,
        "calibration_passed": calibration_passed,
        "chosen": chosen,
        "density": density(pred),
        "classification": summary["classification"],
        "trading": summary["trading"],
    }


def _research_challenger_status(folds: list[dict], combined: pd.DataFrame) -> dict:
    summary = _summarize_predictions(combined, horizon_bars=H, confidence_threshold=0.60)
    den = density(combined)
    classification = summary["classification"]
    trading = summary["trading"]

    positive_fold_fraction = (
        sum(1 for fold in folds if fold["trading"]["total_return"] > 0) / len(folds)
        if folds
        else 0.0
    )
    calibration_pass_fraction = (
        sum(1 for fold in folds if fold["calibration_passed"]) / len(folds)
        if folds
        else 0.0
    )

    checks = {
        "outer_fold_count": len(folds) >= OUTER_FOLDS_REQUIRED,
        "calibration_stability": calibration_pass_fraction >= MIN_CALIBRATION_PASS_FRACTION,
        "evidence": den["trades"] >= MIN_OUTER_TRADES,
        "frequency": (
            den["median_gap_minutes"] is not None
            and den["median_gap_minutes"] <= MAX_MEDIAN_GAP_MINUTES
        ),
        "balanced_accuracy": (
            _finite(classification["balanced_accuracy"])
            and classification["balanced_accuracy"] >= MIN_BALANCED_ACCURACY
        ),
        "sharpe": _finite(trading["sharpe_ratio"]) and trading["sharpe_ratio"] >= MIN_SHARPE,
        "profit_factor": (
            _finite(trading["profit_factor"])
            and trading["profit_factor"] >= MIN_PROFIT_FACTOR
        ),
        "max_drawdown": (
            _finite(trading["max_drawdown"])
            and trading["max_drawdown"] <= MAX_DRAWDOWN
        ),
        "positive_return": trading["total_return"] > 0,
        "positive_fold_fraction": positive_fold_fraction >= MIN_POSITIVE_FOLD_FRACTION,
    }

    return {
        "research_challenger": all(checks.values()),
        "production_eligible": False,
        "checks": checks,
        "positive_fold_fraction": positive_fold_fraction,
        "calibration_pass_fraction": calibration_pass_fraction,
        "density": den,
        "classification": classification,
        "trading": trading,
    }


def run(
    corpus_dir: Path,
    quote_a: Path,
    quote_b: Path,
    output: Path,
    max_splits: int = OUTER_FOLDS_REQUIRED,
    selected_pairs: tuple[str, ...] | None = None,
) -> dict:
    pairs = selected_pairs or PAIRS
    unknown = [pair for pair in pairs if pair not in PAIRS]
    if unknown:
        raise ValueError(f"unsupported pair specialists requested: {unknown}")
    datasets = {pair: corpus_dir / f"{pair}_MTF.csv" for pair in pairs}
    pool, _ = load_and_prepare_corpora(
        datasets,
        horizon_bars=H,
        min_net_return_bps=0,
        commission_bps=0,
        slippage_bps=EXTRA_SLIPPAGE_BPS,
    )

    quotes = []
    for pair in pairs:
        root = quote_a if pair in ("AUDUSD", "EURUSD", "GBPUSD") else quote_b
        frame = pd.read_csv(root / f"{pair}_1S_M1_BOUNDARY.csv")
        frame["decision_time"] = pd.to_datetime(frame.decision_time, utc=True)
        quotes.append(frame)

    quotes = pd.concat(quotes, ignore_index=True)
    pool["decision_time"] = pd.to_datetime(pool.decision_time, utc=True)
    joined = pool.merge(
        quotes,
        on=["decision_time", "instrument"],
        how="inner",
        validate="one_to_one",
    )
    joined = (
        joined.dropna(subset=FEATURES)
        .sort_values(["instrument", "decision_time"])
        .reset_index(drop=True)
    )

    results: dict[str, dict] = {}
    for pair in pairs:
        # Preserve the original six-pair seed assignment even when running a
        # subset, so pair-by-pair execution is methodology-identical to the
        # full experiment rather than a new stochastic candidate.
        pair_index = PAIRS.index(pair)
        frame = (
            joined[joined.instrument == pair]
            .sort_values("decision_time")
            .reset_index(drop=True)
        )
        periods = frame.decision_time.nunique()
        splits = list(
            iter_purged_walk_forward_time_splits(
                frame,
                time_column="decision_time",
                min_train_periods=max(500, int(periods * 0.45)),
                validation_periods=max(180, int(periods * 0.12)),
                purge_periods=H,
                embargo_periods=H,
                max_splits=max_splits,
            )
        )

        fold_rows: list[dict] = []
        outer_predictions: list[pd.DataFrame] = []
        for fold_index, (train, valid) in enumerate(splits, 1):
            models, calibration = fit_pair(
                train,
                7500 + pair_index * 100 + fold_index * 10,
            )
            chosen, calibration_passed, candidates = choose(score(calibration, models))
            pred = apply(
                score(valid, models),
                chosen["p"],
                chosen["margin"],
                chosen["coverage"],
                chosen["spread_cap"],
            )
            fold = _fold_snapshot(fold_index, calibration_passed, chosen, pred)
            fold["top_calibration"] = sorted(
                candidates,
                key=lambda row: (
                    row["eligible"],
                    row["pf"] if row["pf"] is not None else -99,
                ),
                reverse=True,
            )[:8]
            fold_rows.append(fold)
            outer_predictions.append(pred)

            print(
                json.dumps(
                    {
                        "pair": pair,
                        "fold": fold_index,
                        "calibration_passed": calibration_passed,
                        "chosen": chosen,
                        "density": fold["density"],
                        "classification": fold["classification"],
                        "trading": fold["trading"],
                    },
                    indent=2,
                    default=str,
                ),
                flush=True,
            )

        if not outer_predictions:
            results[pair] = {
                "rows": len(frame),
                "folds": [],
                "research_challenger": False,
                "production_eligible": False,
                "error": "NO_OUTER_SPLITS",
            }
            continue

        combined = pd.concat(outer_predictions, ignore_index=True)
        status = _research_challenger_status(fold_rows, combined)
        results[pair] = {
            "rows": len(frame),
            "outer_fold_count": len(fold_rows),
            "folds": fold_rows,
            **status,
        }

        print(
            json.dumps(
                {
                    "pair": pair,
                    "research_challenger": status["research_challenger"],
                    "checks": status["checks"],
                    "positive_fold_fraction": status["positive_fold_fraction"],
                    "calibration_pass_fraction": status["calibration_pass_fraction"],
                    "density": status["density"],
                    "classification": status["classification"],
                    "trading": status["trading"],
                },
                indent=2,
                default=str,
            ),
            flush=True,
        )

    challenger_specialists = {
        pair: bool(result.get("research_challenger", False))
        for pair, result in results.items()
    }
    report = {
        "experiment": "v75_pair_specific_quote_specialists_v2",
        "methodology": (
            "Independent pair specialists; internal early-stopping/calibration; "
            "three purged outer walk-forward folds; conservative quote costs. "
            "Research challenger status never grants PAPER/DEMO/LIVE authority."
        ),
        "sealed_future_holdout_touched": False,
        "production_eligible": False,
        "promotion_gates_unchanged": True,
        "joined_rows": len(joined),
        "selected_pairs": list(pairs),
        "required_outer_folds": OUTER_FOLDS_REQUIRED,
        "thresholds": {
            "min_outer_trades": MIN_OUTER_TRADES,
            "max_median_gap_minutes": MAX_MEDIAN_GAP_MINUTES,
            "min_balanced_accuracy": MIN_BALANCED_ACCURACY,
            "min_sharpe": MIN_SHARPE,
            "min_profit_factor": MIN_PROFIT_FACTOR,
            "max_drawdown": MAX_DRAWDOWN,
            "min_positive_fold_fraction": MIN_POSITIVE_FOLD_FRACTION,
            "min_calibration_pass_fraction": MIN_CALIBRATION_PASS_FRACTION,
        },
        "results": results,
        "challenger_specialists": challenger_specialists,
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, default=str))
    print(
        json.dumps(
            {
                "challenger_specialists": challenger_specialists,
                "production_eligible": False,
            },
            indent=2,
        ),
        flush=True,
    )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-dir", type=Path, required=True)
    parser.add_argument("--quote-a", type=Path, required=True)
    parser.add_argument("--quote-b", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-splits", type=int, default=OUTER_FOLDS_REQUIRED)
    parser.add_argument(
        "--pairs",
        default="",
        help="Optional comma-separated subset of the six research pairs",
    )
    args = parser.parse_args()
    selected_pairs = tuple(
        value.strip().upper() for value in args.pairs.split(",") if value.strip()
    ) or None
    run(
        args.corpus_dir,
        args.quote_a,
        args.quote_b,
        args.output,
        max_splits=args.max_splits,
        selected_pairs=selected_pairs,
    )
