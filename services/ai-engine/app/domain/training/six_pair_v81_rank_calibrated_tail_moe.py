"""v81 rank-calibrated profitable-tail mixture-of-experts.

v80 produced useful out-of-sample tail rankings but raw probability scales
varied materially by pair/fold. v81 keeps the frozen v80 classifier family and
converts raw tail probabilities/margins to calibration-window empirical
percentiles. Outer decisions use the frozen calibration ECDF; no outer score
distribution is used.

Additional development safety:
- calibration candidate must pass the existing aggregate research gates;
- both chronological calibration halves must have positive return;
- both halves must have PF >= 1.0 when defined.

No production gate is reduced and the sealed future holdout remains untouched.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.training.six_pair_v79_gated_multihorizon_moe import (
    EXTRA_SLIPPAGE_BPS,
    H_CONFIRM,
    H_FAST,
    OUTER_FOLDS_REQUIRED,
    PAIRS,
    PURGE_BARS,
    _finite,
    _metrics,
    _pair_status,
    _prepare_pair,
    _regime_thresholds,
    _three_way,
)
from app.domain.training.six_pair_v80_tail_ranking_moe import (
    H10_MIN_TAIL_BPS,
    H5_MIN_TAIL_BPS,
    TAIL_QUANTILE,
    _diagnostics,
    _fit_experts,
    _route_predict,
    _tail_thresholds,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "v81_rank_calibrated_tail_moe_v1"


def _ecdf_reference(values: pd.Series) -> np.ndarray:
    array = values.astype(float).to_numpy()
    array = array[np.isfinite(array)]
    if len(array) < 50:
        raise ValueError(f"insufficient ECDF reference rows: {len(array)}")
    return np.sort(array)


def _ecdf_percentile(values: pd.Series, reference: np.ndarray) -> np.ndarray:
    array = values.astype(float).to_numpy()
    return np.searchsorted(reference, array, side="right") / float(len(reference))


def _rank_calibrate(
    frame: pd.DataFrame,
    *,
    score_reference: np.ndarray,
    margin_reference: np.ndarray,
) -> pd.DataFrame:
    out = frame.copy()
    out["_tail_score_percentile"] = _ecdf_percentile(
        out["_conservative_tail_p"],
        score_reference,
    )
    out["_margin_percentile"] = _ecdf_percentile(
        out["_probability_margin"],
        margin_reference,
    )
    return out


def _apply(frame: pd.DataFrame, config: dict[str, float]) -> pd.DataFrame:
    out = frame.copy()
    active = (
        out["_horizon_agreement"].astype(bool)
        & (
            out["_tail_score_percentile"].astype(float)
            >= float(config["score_quantile"])
        )
        & (
            out["_margin_percentile"].astype(float)
            >= float(config["margin_quantile"])
        )
        & (
            out["quote_coverage_60s"].astype(float)
            >= float(config["coverage_floor"])
        )
        & (
            out["spread_to_atr_ratio"].astype(float)
            <= float(config["spread_atr_cap"])
        )
    )
    out["active_trade"] = active
    out["predicted_opportunity"] = active
    out["confidence"] = out["_tail_score_percentile"].astype(float)
    return out


def _chronological_halves(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    ordered = frame.sort_values("decision_time").reset_index(drop=True)
    split = len(ordered) // 2
    return ordered.iloc[:split].copy(), ordered.iloc[split:].copy()


def _calibration_stability(frame: pd.DataFrame) -> dict[str, Any]:
    halves = _chronological_halves(frame)
    rows = []
    for index, half in enumerate(halves, 1):
        metrics = _metrics(half)
        pf = metrics["profit_factor"]
        rows.append(
            {
                "half": index,
                "trades": metrics["trades"],
                "profit_factor": pf,
                "sharpe": metrics["sharpe"],
                "total_return": metrics["total_return"],
                "positive": bool(
                    metrics["trades"] > 0
                    and metrics["total_return"] > 0
                    and _finite(pf)
                    and pf >= 1.0
                ),
            }
        )
    return {
        "halves": rows,
        "positive_half_fraction": (
            sum(bool(row["positive"]) for row in rows) / len(rows) if rows else 0.0
        ),
        "passed": bool(rows and all(row["positive"] for row in rows)),
    }


def _eligible(metrics: dict[str, Any], stability: dict[str, Any]) -> bool:
    return bool(
        metrics["trades"] >= 40
        and metrics["median_gap_minutes"] is not None
        and metrics["median_gap_minutes"] <= 10.0
        and _finite(metrics["balanced_accuracy"])
        and metrics["balanced_accuracy"] >= 0.52
        and _finite(metrics["profit_factor"])
        and metrics["profit_factor"] >= 1.15
        and _finite(metrics["sharpe"])
        and metrics["sharpe"] >= 1.0
        and _finite(metrics["max_drawdown"])
        and metrics["max_drawdown"] <= 0.12
        and metrics["total_return"] > 0
        and stability["passed"]
    )


def _choose(
    calibration: pd.DataFrame,
) -> tuple[dict[str, float], bool, list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    for score_quantile in (0.70, 0.75, 0.80, 0.85, 0.90, 0.95):
        for margin_quantile in (0.00, 0.50, 0.75):
            for coverage_floor in (0.35, 0.50, 0.65):
                for spread_atr_cap in (0.50, 0.75, 1.00):
                    config = {
                        "score_quantile": float(score_quantile),
                        "margin_quantile": float(margin_quantile),
                        "coverage_floor": float(coverage_floor),
                        "spread_atr_cap": float(spread_atr_cap),
                    }
                    applied = _apply(calibration, config)
                    metrics = _metrics(applied)
                    stability = _calibration_stability(applied)
                    rows.append(
                        {
                            **config,
                            **metrics,
                            "stability": stability,
                            "eligible": _eligible(metrics, stability),
                        }
                    )

    good = [row for row in rows if row["eligible"]]
    if good:
        chosen = max(
            good,
            key=lambda row: (
                min(float(row["profit_factor"]), 3.0),
                float(row["sharpe"]),
                float(row["stability"]["positive_half_fraction"]),
                -float(row["max_drawdown"]),
                int(row["trades"]),
            ),
        )
        return chosen, True, rows

    feasible = [
        row
        for row in rows
        if row["trades"] >= 20 and _finite(row["profit_factor"])
    ]
    if feasible:
        chosen = max(
            feasible,
            key=lambda row: (
                float(row["stability"]["positive_half_fraction"]),
                float(row["profit_factor"]),
                float(row["sharpe"]) if _finite(row["sharpe"]) else -999.0,
                int(row["trades"]),
            ),
        )
        return chosen, False, rows

    return rows[0], False, rows


def _rank_diagnostics(frame: pd.DataFrame) -> dict[str, Any]:
    def q(column: str) -> dict[str, float]:
        values = frame[column].astype(float).to_numpy()
        values = values[np.isfinite(values)]
        if not len(values):
            return {}
        qs = np.quantile(values, [0.10, 0.50, 0.90, 0.99, 1.0])
        return dict(zip(("p10", "p50", "p90", "p99", "max"), map(float, qs)))

    return {
        "score_percentile": q("_tail_score_percentile"),
        "margin_percentile": q("_margin_percentile"),
    }


def run_pair(
    pair: str,
    corpus_dir: Path,
    quote_a: Path,
    quote_b: Path,
    output: Path,
    max_splits: int = OUTER_FOLDS_REQUIRED,
) -> dict[str, Any]:
    pair = pair.upper()
    if pair not in PAIRS:
        raise ValueError(f"unsupported pair: {pair}")

    frame, manifests = _prepare_pair(pair, corpus_dir, quote_a, quote_b)
    periods = frame["decision_time"].nunique()
    splits = list(
        iter_purged_walk_forward_time_splits(
            frame,
            time_column="decision_time",
            min_train_periods=max(900, int(periods * 0.45)),
            validation_periods=max(240, int(periods * 0.12)),
            purge_periods=PURGE_BARS,
            embargo_periods=PURGE_BARS,
            max_splits=max_splits,
        )
    )

    pair_index = PAIRS.index(pair)
    folds: list[dict[str, Any]] = []
    predictions: list[pd.DataFrame] = []

    def checkpoint(complete: bool) -> dict[str, Any]:
        combined = (
            pd.concat(predictions, ignore_index=True)
            if predictions
            else frame.iloc[0:0].assign(active_trade=False)
        )
        status = (
            _pair_status(folds, combined)
            if predictions
            else {
                "research_challenger": False,
                "production_eligible": False,
                "checks": {},
                "positive_fold_fraction": 0.0,
                "calibration_pass_fraction": 0.0,
                "metrics": {},
            }
        )
        report = {
            "experiment": EXPERIMENT,
            "methodology": (
                "v80 tail classifiers + calibration ECDF percentile normalization; "
                "H5 realized outcome + H10 confirmation; causal regime experts; "
                "two-half calibration stability; purged outer folds."
            ),
            "pair": pair,
            "complete": complete,
            "sealed_future_holdout_touched": False,
            "production_eligible": False,
            "promotion_gates_unchanged": True,
            "tail_quantile": TAIL_QUANTILE,
            "min_tail_bps": {
                "h5": H5_MIN_TAIL_BPS,
                "h10": H10_MIN_TAIL_BPS,
            },
            "horizons": {"fast": H_FAST, "confirm": H_CONFIRM},
            "extra_slippage_bps": EXTRA_SLIPPAGE_BPS,
            "dataset_manifest": manifests,
            "rows": int(len(frame)),
            "folds": folds,
            **status,
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, default=str))
        return report

    for fold_index, (outer_train, outer_valid) in enumerate(splits, 1):
        fit, early_stop, calibration = _three_way(
            outer_train.sort_values("decision_time").reset_index(drop=True)
        )
        regime_thresholds = _regime_thresholds(fit)
        tail_thresholds = _tail_thresholds(fit)
        models = _fit_experts(
            fit,
            early_stop,
            regime_thresholds,
            tail_thresholds,
            8100 + pair_index * 100 + fold_index * 20,
        )

        calibration_raw = _route_predict(
            calibration,
            models,
            regime_thresholds,
            tail_thresholds,
        )
        score_reference = _ecdf_reference(calibration_raw["_conservative_tail_p"])
        margin_reference = _ecdf_reference(calibration_raw["_probability_margin"])
        calibration_ranked = _rank_calibrate(
            calibration_raw,
            score_reference=score_reference,
            margin_reference=margin_reference,
        )

        chosen, calibration_passed, candidates = _choose(calibration_ranked)

        outer_raw = _route_predict(
            outer_valid,
            models,
            regime_thresholds,
            tail_thresholds,
        )
        outer_ranked = _rank_calibrate(
            outer_raw,
            score_reference=score_reference,
            margin_reference=margin_reference,
        )
        outer = _apply(outer_ranked, chosen)
        outer["fold"] = fold_index
        predictions.append(outer)

        metrics = _metrics(outer)
        fold = {
            "fold": fold_index,
            "calibration_passed": calibration_passed,
            "regime_thresholds": regime_thresholds,
            "tail_thresholds": tail_thresholds,
            "available_regime_experts": sorted(
                key for key in models if key != "global"
            ),
            "chosen": {
                key: chosen[key]
                for key in (
                    "score_quantile",
                    "margin_quantile",
                    "coverage_floor",
                    "spread_atr_cap",
                )
            },
            "calibration_metrics": {
                key: chosen.get(key)
                for key in (
                    "trades",
                    "median_gap_minutes",
                    "balanced_accuracy",
                    "profit_factor",
                    "sharpe",
                    "max_drawdown",
                    "total_return",
                )
            },
            "calibration_stability": chosen["stability"],
            "raw_calibration_diagnostics": _diagnostics(calibration_raw),
            "raw_outer_diagnostics": _diagnostics(outer_raw),
            "rank_calibration_diagnostics": _rank_diagnostics(calibration_ranked),
            "rank_outer_diagnostics": _rank_diagnostics(outer_ranked),
            "metrics": metrics,
            "top_calibration": sorted(
                candidates,
                key=lambda row: (
                    bool(row["eligible"]),
                    float(row["stability"]["positive_half_fraction"]),
                    float(row["profit_factor"])
                    if _finite(row["profit_factor"])
                    else -999.0,
                    float(row["sharpe"]) if _finite(row["sharpe"]) else -999.0,
                ),
                reverse=True,
            )[:8],
        }
        folds.append(fold)
        checkpoint(False)
        print(json.dumps({"pair": pair, **fold}, indent=2, default=str), flush=True)

        remaining = len(splits) - fold_index
        required = 2 if len(splits) >= 3 else len(splits)
        calibration_passes = sum(bool(item["calibration_passed"]) for item in folds)
        positive_folds = sum(item["metrics"]["total_return"] > 0 for item in folds)
        if (
            calibration_passes + remaining < required
            or positive_folds + remaining < required
        ):
            report = checkpoint(False)
            report["early_eliminated"] = True
            report["early_elimination_reason"] = (
                "FROZEN_STABILITY_GATES_MATHEMATICALLY_UNREACHABLE"
            )
            output.write_text(json.dumps(report, indent=2, default=str))
            return report

    return checkpoint(True)


def run(
    corpus_dir: Path,
    quote_a: Path,
    quote_b: Path,
    output_dir: Path,
    selected_pairs: tuple[str, ...] | None = None,
    max_splits: int = OUTER_FOLDS_REQUIRED,
) -> dict[str, Any]:
    pairs = selected_pairs or PAIRS
    results: dict[str, Any] = {}
    for pair in pairs:
        result = run_pair(
            pair,
            corpus_dir,
            quote_a,
            quote_b,
            output_dir / f"v81-{pair}-3fold.json",
            max_splits=max_splits,
        )
        results[pair] = {
            "research_challenger": bool(result.get("research_challenger", False)),
            "complete": bool(result.get("complete", False)),
            "early_eliminated": bool(result.get("early_eliminated", False)),
            "positive_fold_fraction": result.get("positive_fold_fraction"),
            "calibration_pass_fraction": result.get("calibration_pass_fraction"),
            "metrics": result.get("metrics"),
        }

    positive_fraction = (
        sum(bool(value["research_challenger"]) for value in results.values())
        / len(PAIRS)
    )
    summary = {
        "experiment": EXPERIMENT,
        "sealed_future_holdout_touched": False,
        "production_eligible": False,
        "promotion_gates_unchanged": True,
        "required_positive_instrument_fraction": 4 / 6,
        "positive_instrument_fraction": positive_fraction,
        "ensemble_research_challenger": (
            len(pairs) == len(PAIRS) and positive_fraction >= 4 / 6
        ),
        "results": results,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "v81-summary.json").write_text(
        json.dumps(summary, indent=2, default=str)
    )
    print(json.dumps(summary, indent=2, default=str), flush=True)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-dir", type=Path, required=True)
    parser.add_argument("--quote-a", type=Path, required=True)
    parser.add_argument("--quote-b", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--pairs", default="")
    parser.add_argument("--max-splits", type=int, default=OUTER_FOLDS_REQUIRED)
    args = parser.parse_args()
    pairs = tuple(
        value.strip().upper()
        for value in args.pairs.split(",")
        if value.strip()
    ) or None
    run(
        args.corpus_dir,
        args.quote_a,
        args.quote_b,
        args.output_dir,
        selected_pairs=pairs,
        max_splits=args.max_splits,
    )
