"""v80 profitable-tail ranking mixture-of-experts research.

v79 showed that squared-error regression collapsed toward the negative
conditional mean even when realized returns contained a profitable upper tail.
v80 changes estimator family rather than lowering admission thresholds:

- class-balanced XGBoost tail classifiers
- PR-AUC early stopping
- pair-specific global + causal regime experts
- H5 realized trade horizon + H10 confirmation horizon
- side-specific tail labels frozen from each fold's FIT partition only
- separate fit / early-stop / calibration chronology
- unchanged outer qualification gates
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBClassifier

from app.domain.training.six_pair_v79_gated_multihorizon_moe import (
    EXTRA_SLIPPAGE_BPS,
    FEATURES,
    H_CONFIRM,
    H_FAST,
    OUTER_FOLDS_REQUIRED,
    PAIRS,
    PURGE_BARS,
    REGIMES,
    _finite,
    _metrics,
    _pair_status,
    _prepare_pair,
    _regime_thresholds,
    _three_way,
    _with_regime,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits
from app.domain.training.train_multitimeframe import _xgboost_n_jobs

EXPERIMENT = "v80_profitable_tail_multihorizon_moe_v1"
TAIL_QUANTILE = 0.80
H5_MIN_TAIL_BPS = 0.50
H10_MIN_TAIL_BPS = 1.00
TARGETS = (
    "long_h5",
    "short_h5",
    "long_h10",
    "short_h10",
)


def _classifier(seed: int) -> XGBClassifier:
    return XGBClassifier(
        objective="binary:logistic",
        eval_metric="aucpr",
        n_estimators=700,
        learning_rate=0.025,
        max_depth=3,
        min_child_weight=16.0,
        subsample=0.82,
        colsample_bytree=0.80,
        reg_alpha=0.35,
        reg_lambda=4.0,
        random_state=seed,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=55,
    )


def _tail_thresholds(fit: pd.DataFrame) -> dict[str, float]:
    floors = {
        "long_h5": H5_MIN_TAIL_BPS / 10000.0,
        "short_h5": H5_MIN_TAIL_BPS / 10000.0,
        "long_h10": H10_MIN_TAIL_BPS / 10000.0,
        "short_h10": H10_MIN_TAIL_BPS / 10000.0,
    }
    return {
        target: max(
            floors[target],
            float(fit[target].astype(float).quantile(TAIL_QUANTILE)),
        )
        for target in TARGETS
    }


def _with_labels(
    frame: pd.DataFrame,
    thresholds: dict[str, float],
) -> pd.DataFrame:
    out = frame.copy()
    out["_tail_long_h5"] = (
        (out["long_h5"].astype(float) >= thresholds["long_h5"])
        & (out["long_h5"].astype(float) > out["short_h5"].astype(float))
    ).astype(int)
    out["_tail_short_h5"] = (
        (out["short_h5"].astype(float) >= thresholds["short_h5"])
        & (out["short_h5"].astype(float) > out["long_h5"].astype(float))
    ).astype(int)
    out["_tail_long_h10"] = (
        (out["long_h10"].astype(float) >= thresholds["long_h10"])
        & (out["long_h10"].astype(float) > out["short_h10"].astype(float))
    ).astype(int)
    out["_tail_short_h10"] = (
        (out["short_h10"].astype(float) >= thresholds["short_h10"])
        & (out["short_h10"].astype(float) > out["long_h10"].astype(float))
    ).astype(int)
    return out


def _weights(y: np.ndarray) -> np.ndarray:
    y = np.asarray(y, dtype=int)
    counts = np.bincount(y, minlength=2).astype(float)
    if (counts <= 0).any():
        raise ValueError(f"tail target lacks both classes: {counts.tolist()}")
    weights = np.sqrt(len(y) / (2.0 * counts))[y]
    weights = np.clip(weights, 0.5, 3.0)
    return weights / weights.mean()


def _fit_classifier(
    fit: pd.DataFrame,
    early_stop: pd.DataFrame,
    label: str,
    seed: int,
) -> XGBClassifier:
    y = fit[label].to_numpy(int)
    eval_y = early_stop[label].to_numpy(int)
    if len(np.unique(y)) < 2 or len(np.unique(eval_y)) < 2:
        raise ValueError(
            f"tail target lacks both classes label={label} "
            f"fit={np.bincount(y, minlength=2).tolist()} "
            f"stop={np.bincount(eval_y, minlength=2).tolist()}"
        )
    model = _classifier(seed)
    model.fit(
        fit[FEATURES],
        y,
        sample_weight=_weights(y),
        eval_set=[(early_stop[FEATURES], eval_y)],
        sample_weight_eval_set=[_weights(eval_y)],
        verbose=False,
    )
    return model


def _fit_experts(
    fit: pd.DataFrame,
    early_stop: pd.DataFrame,
    regime_thresholds: dict[str, float],
    tail_thresholds: dict[str, float],
    seed: int,
) -> dict[str, dict[str, XGBClassifier]]:
    fit_r = _with_labels(_with_regime(fit, regime_thresholds), tail_thresholds)
    stop_r = _with_labels(_with_regime(early_stop, regime_thresholds), tail_thresholds)

    labels = {
        "long_h5": "_tail_long_h5",
        "short_h5": "_tail_short_h5",
        "long_h10": "_tail_long_h10",
        "short_h10": "_tail_short_h10",
    }

    models: dict[str, dict[str, XGBClassifier]] = {"global": {}}
    for offset, target in enumerate(TARGETS):
        models["global"][target] = _fit_classifier(
            fit_r,
            stop_r,
            labels[target],
            seed + offset,
        )

    for regime_index, regime in enumerate(REGIMES, 1):
        rf = fit_r.loc[fit_r["_regime"] == regime]
        rs = stop_r.loc[stop_r["_regime"] == regime]
        if len(rf) < 650 or len(rs) < 100:
            continue

        # A regime expert is optional. If any of its four tail labels lacks
        # class support, routing falls back to the pair-global expert.
        try:
            expert: dict[str, XGBClassifier] = {}
            for offset, target in enumerate(TARGETS):
                expert[target] = _fit_classifier(
                    rf,
                    rs,
                    labels[target],
                    seed + regime_index * 20 + offset,
                )
            models[regime] = expert
        except ValueError:
            continue
    return models


def _route_predict(
    frame: pd.DataFrame,
    models: dict[str, dict[str, XGBClassifier]],
    regime_thresholds: dict[str, float],
    tail_thresholds: dict[str, float],
) -> pd.DataFrame:
    out = _with_labels(_with_regime(frame, regime_thresholds), tail_thresholds)
    for target in TARGETS:
        out[f"p_{target}"] = np.nan

    for regime in REGIMES:
        mask = out["_regime"] == regime
        if not mask.any():
            continue
        expert = models.get(regime, models["global"])
        for target in TARGETS:
            out.loc[mask, f"p_{target}"] = expert[target].predict_proba(
                out.loc[mask, FEATURES]
            )[:, 1]

    required = [f"p_{target}" for target in TARGETS]
    if out[required].isna().any().any():
        raise ValueError("tail mixture router produced missing probabilities")

    out["_h5_long"] = out["p_long_h5"] >= out["p_short_h5"]
    out["_h10_long"] = out["p_long_h10"] >= out["p_short_h10"]
    out["_horizon_agreement"] = out["_h5_long"] == out["_h10_long"]
    out["predicted_long"] = out["_h5_long"]

    out["_best_p_h5"] = np.maximum(out["p_long_h5"], out["p_short_h5"])
    out["_best_p_h10"] = np.maximum(out["p_long_h10"], out["p_short_h10"])
    out["_conservative_tail_p"] = np.minimum(
        out["_best_p_h5"],
        out["_best_p_h10"],
    )
    out["_probability_margin"] = np.minimum(
        np.abs(out["p_long_h5"] - out["p_short_h5"]),
        np.abs(out["p_long_h10"] - out["p_short_h10"]),
    )

    out["selected_net_return"] = np.where(
        out["predicted_long"],
        out["long_h5"].astype(float),
        out["short_h5"].astype(float),
    )
    out["_actionable_target"] = (
        (out["_tail_long_h5"].astype(bool))
        | (out["_tail_short_h5"].astype(bool))
    )
    return out


def _apply(frame: pd.DataFrame, config: dict[str, float]) -> pd.DataFrame:
    out = frame.copy()
    active = (
        out["_horizon_agreement"].astype(bool)
        & (out["_conservative_tail_p"] >= float(config["probability_floor"]))
        & (out["_probability_margin"] >= float(config["margin_floor"]))
        & (out["quote_coverage_60s"] >= float(config["coverage_floor"]))
        & (out["spread_to_atr_ratio"] <= float(config["spread_atr_cap"]))
    )
    out["active_trade"] = active
    out["predicted_opportunity"] = active
    out["confidence"] = out["_conservative_tail_p"].astype(float)
    return out


def _diagnostics(frame: pd.DataFrame) -> dict[str, Any]:
    def q(column: str) -> dict[str, float | None]:
        values = frame[column].astype(float).to_numpy()
        values = values[np.isfinite(values)]
        if not len(values):
            return {k: None for k in ("min", "p10", "p50", "p90", "p99", "max")}
        values_q = np.quantile(values, [0, 0.10, 0.50, 0.90, 0.99, 1])
        return dict(
            zip(
                ("min", "p10", "p50", "p90", "p99", "max"),
                [float(value) for value in values_q],
            )
        )

    return {
        "rows": int(len(frame)),
        "horizon_agreement_fraction": (
            float(frame["_horizon_agreement"].mean()) if len(frame) else None
        ),
        "conservative_tail_probability": q("_conservative_tail_p"),
        "probability_margin": q("_probability_margin"),
        "best_probability_h5": q("_best_p_h5"),
        "best_probability_h10": q("_best_p_h10"),
        "realized_long_h5": q("long_h5"),
        "realized_short_h5": q("short_h5"),
        "realized_long_h10": q("long_h10"),
        "realized_short_h10": q("short_h10"),
        "actual_tail_fraction": (
            float(frame["_actionable_target"].mean()) if len(frame) else None
        ),
    }


def _eligible(metrics: dict[str, Any], *, calibration: bool) -> bool:
    min_trades = 40 if calibration else 30
    return bool(
        metrics["trades"] >= min_trades
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
    )


def _choose(calibration: pd.DataFrame) -> tuple[dict[str, float], bool, list[dict]]:
    rows: list[dict] = []
    for probability_floor in (0.45, 0.50, 0.55, 0.60, 0.65, 0.70):
        for margin_floor in (0.00, 0.05, 0.10, 0.15):
            for coverage_floor in (0.35, 0.50, 0.65):
                for spread_atr_cap in (0.50, 0.75, 1.00):
                    config = {
                        "probability_floor": float(probability_floor),
                        "margin_floor": float(margin_floor),
                        "coverage_floor": float(coverage_floor),
                        "spread_atr_cap": float(spread_atr_cap),
                    }
                    metrics = _metrics(_apply(calibration, config))
                    rows.append(
                        {
                            **config,
                            **metrics,
                            "eligible": _eligible(metrics, calibration=True),
                        }
                    )

    good = [row for row in rows if row["eligible"]]
    if good:
        chosen = max(
            good,
            key=lambda row: (
                min(float(row["profit_factor"]), 3.0),
                float(row["sharpe"]),
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
                float(row["profit_factor"]),
                float(row["sharpe"]) if _finite(row["sharpe"]) else -999.0,
                int(row["trades"]),
            ),
        )
        return chosen, False, rows

    return rows[0], False, rows


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
                "Pair-specific profitable-tail classifiers with PR-AUC; H5 realized "
                "outcome + H10 confirmation; causal regime experts; separate "
                "fit/early-stop/calibration partitions; purged outer folds."
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
            8000 + pair_index * 100 + fold_index * 20,
        )

        calibration_scored = _route_predict(
            calibration,
            models,
            regime_thresholds,
            tail_thresholds,
        )
        calibration_diagnostics = _diagnostics(calibration_scored)
        chosen, calibration_passed, candidates = _choose(calibration_scored)

        outer_scored = _route_predict(
            outer_valid,
            models,
            regime_thresholds,
            tail_thresholds,
        )
        outer_diagnostics = _diagnostics(outer_scored)
        outer = _apply(outer_scored, chosen)
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
                    "probability_floor",
                    "margin_floor",
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
            "calibration_diagnostics": calibration_diagnostics,
            "outer_diagnostics": outer_diagnostics,
            "metrics": metrics,
            "top_calibration": sorted(
                candidates,
                key=lambda row: (
                    bool(row["eligible"]),
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
            output_dir / f"v80-{pair}-3fold.json",
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
    (output_dir / "v80-summary.json").write_text(
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
