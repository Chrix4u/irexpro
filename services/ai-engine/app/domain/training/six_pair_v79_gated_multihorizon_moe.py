"""v79 pair-specific gated multi-horizon mixture-of-experts research.

This is a development-only challenger. It deliberately changes model family
instead of tuning thresholds on the failed v74/v75 family.

Frozen before outer evaluation:
- independent pair models
- H5 is the realized trade outcome
- H10 is a directional/EV confirmation horizon
- causal spread/volatility regimes learned only from each outer fold's training window
- four net-return regressors per expert: H5 long/short and H10 long/short
- regime expert with pair-global fallback
- separate chronological fit / early-stop / calibration partitions
- purged outer walk-forward evaluation
- no sealed future holdout access
- no PAPER/DEMO/LIVE authority
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from app.domain.models.quote_microstructure import QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS
from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
    _xgboost_n_jobs,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "v79_gated_multihorizon_pair_moe_v1"
PAIRS = ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
H_FAST = 5
H_CONFIRM = 10
PURGE_BARS = H_CONFIRM
EXTRA_SLIPPAGE_BPS = 0.25

MIN_OUTER_TRADES = 30
MAX_MEDIAN_GAP_MINUTES = 10.0
MIN_BALANCED_ACCURACY = 0.52
MIN_SHARPE = 1.0
MIN_PROFIT_FACTOR = 1.15
MAX_DRAWDOWN = 0.12
MIN_POSITIVE_FOLD_FRACTION = 2 / 3
MIN_CALIBRATION_PASS_FRACTION = 2 / 3
OUTER_FOLDS_REQUIRED = 3

CONTEXT_FEATURES = [
    "m1_atr_pct_14",
    "m1_rsi_14",
    "m1_momentum_3",
    "m5_atr_pct_14",
    "m5_rsi_14",
    "m5_momentum_3",
    "m15_rsi_14",
    "m15_momentum_3",
    "h1_rsi_14",
    "h1_momentum_3",
    "h4_rsi_14",
    "spread_to_atr_ratio",
]
FEATURES = [*QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS, *CONTEXT_FEATURES]
TARGETS = (
    "long_h5",
    "short_h5",
    "long_h10",
    "short_h10",
)
REGIMES = ("calm", "active_clean", "stressed")


def _finite(value: Any) -> bool:
    return value is not None and np.isfinite(value)


def _model(seed: int) -> XGBRegressor:
    return XGBRegressor(
        objective="reg:squarederror",
        eval_metric="rmse",
        n_estimators=700,
        learning_rate=0.02,
        max_depth=4,
        min_child_weight=14.0,
        subsample=0.82,
        colsample_bytree=0.80,
        reg_alpha=0.30,
        reg_lambda=3.5,
        random_state=seed,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=55,
    )


def _three_way(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    times = np.array(sorted(pd.to_datetime(frame["decision_time"], utc=True).unique()))
    n = len(times)
    if n < 900:
        raise ValueError(f"insufficient unique periods for three-way split: {n}")

    fit_end = int(n * 0.70)
    stop_end = int(n * 0.85)

    fit_times = times[: max(0, fit_end - PURGE_BARS)]
    stop_times = times[min(n, fit_end + PURGE_BARS) : max(0, stop_end - PURGE_BARS)]
    cal_times = times[min(n, stop_end + PURGE_BARS) :]

    if len(fit_times) < 500 or len(stop_times) < 100 or len(cal_times) < 100:
        raise ValueError(
            "three-way split too small "
            f"fit={len(fit_times)} stop={len(stop_times)} cal={len(cal_times)}"
        )

    return (
        frame.loc[frame["decision_time"].isin(fit_times)].copy(),
        frame.loc[frame["decision_time"].isin(stop_times)].copy(),
        frame.loc[frame["decision_time"].isin(cal_times)].copy(),
    )


def _regime_thresholds(frame: pd.DataFrame) -> dict[str, float]:
    spread = frame["spread_to_atr_ratio"].astype(float)
    volatility = frame["m1_atr_pct_14"].astype(float)
    return {
        "spread_stressed_q75": float(spread.quantile(0.75)),
        "volatility_active_q60": float(volatility.quantile(0.60)),
    }


def _with_regime(frame: pd.DataFrame, thresholds: dict[str, float]) -> pd.DataFrame:
    out = frame.copy()
    spread = out["spread_to_atr_ratio"].astype(float)
    volatility = out["m1_atr_pct_14"].astype(float)
    out["_regime"] = np.where(
        spread > thresholds["spread_stressed_q75"],
        "stressed",
        np.where(
            volatility > thresholds["volatility_active_q60"],
            "active_clean",
            "calm",
        ),
    )
    return out


def _fit_regressor(
    fit: pd.DataFrame,
    early_stop: pd.DataFrame,
    target: str,
    seed: int,
) -> XGBRegressor:
    if len(fit) < 400 or len(early_stop) < 80:
        raise ValueError(
            f"insufficient model rows target={target} fit={len(fit)} stop={len(early_stop)}"
        )
    model = _model(seed)
    model.fit(
        fit[FEATURES],
        fit[target].astype(float),
        eval_set=[(early_stop[FEATURES], early_stop[target].astype(float))],
        verbose=False,
    )
    return model


def _fit_experts(
    fit: pd.DataFrame,
    early_stop: pd.DataFrame,
    thresholds: dict[str, float],
    seed: int,
) -> dict[str, dict[str, XGBRegressor]]:
    fit_r = _with_regime(fit, thresholds)
    stop_r = _with_regime(early_stop, thresholds)

    models: dict[str, dict[str, XGBRegressor]] = {"global": {}}
    for offset, target in enumerate(TARGETS):
        models["global"][target] = _fit_regressor(
            fit_r,
            stop_r,
            target,
            seed + offset,
        )

    for regime_index, regime in enumerate(REGIMES, 1):
        rf = fit_r.loc[fit_r["_regime"] == regime]
        rs = stop_r.loc[stop_r["_regime"] == regime]
        if len(rf) < 650 or len(rs) < 100:
            continue
        models[regime] = {}
        for offset, target in enumerate(TARGETS):
            models[regime][target] = _fit_regressor(
                rf,
                rs,
                target,
                seed + regime_index * 20 + offset,
            )
    return models


def _route_predict(
    frame: pd.DataFrame,
    models: dict[str, dict[str, XGBRegressor]],
    thresholds: dict[str, float],
) -> pd.DataFrame:
    out = _with_regime(frame, thresholds)
    for target in TARGETS:
        out[f"pred_{target}"] = np.nan

    for regime in REGIMES:
        mask = out["_regime"] == regime
        if not mask.any():
            continue
        expert = models.get(regime, models["global"])
        for target in TARGETS:
            out.loc[mask, f"pred_{target}"] = expert[target].predict(
                out.loc[mask, FEATURES]
            )

    required = [f"pred_{target}" for target in TARGETS]
    if out[required].isna().any().any():
        raise ValueError("mixture router produced missing predictions")

    h5_long = out["pred_long_h5"].astype(float)
    h5_short = out["pred_short_h5"].astype(float)
    h10_long = out["pred_long_h10"].astype(float)
    h10_short = out["pred_short_h10"].astype(float)

    out["_h5_long"] = h5_long >= h5_short
    out["_h10_long"] = h10_long >= h10_short
    out["_horizon_agreement"] = out["_h5_long"] == out["_h10_long"]
    out["predicted_long"] = out["_h5_long"]

    out["_ev_h5"] = np.maximum(h5_long, h5_short)
    out["_ev_h10"] = np.maximum(h10_long, h10_short)
    out["_conservative_ev"] = np.minimum(out["_ev_h5"], out["_ev_h10"])
    out["_direction_margin"] = np.minimum(
        np.abs(h5_long - h5_short),
        np.abs(h10_long - h10_short),
    )

    out["selected_net_return"] = np.where(
        out["predicted_long"],
        out["long_h5"].astype(float),
        out["short_h5"].astype(float),
    )
    out["_actionable_target"] = (
        np.maximum(out["long_h5"].astype(float), out["short_h5"].astype(float)) > 0
    )
    return out


def _apply(frame: pd.DataFrame, config: dict[str, float]) -> pd.DataFrame:
    out = frame.copy()
    ev_floor = float(config["ev_floor_bps"]) / 10000.0
    margin_floor = float(config["margin_floor_bps"]) / 10000.0

    active = (
        out["_horizon_agreement"].astype(bool)
        & (out["_conservative_ev"].astype(float) >= ev_floor)
        & (out["_direction_margin"].astype(float) >= margin_floor)
        & (out["quote_coverage_60s"].astype(float) >= float(config["coverage_floor"]))
        & (
            out["spread_to_atr_ratio"].astype(float)
            <= float(config["spread_atr_cap"])
        )
    )
    out["predicted_opportunity"] = active
    out["active_trade"] = active

    # Informational confidence only. Qualification uses the explicit active mask
    # and realized H5 outcome rather than pretending regression output is a
    # calibrated probability.
    scale = 0.50 / 10000.0
    out["confidence"] = 1.0 / (
        1.0 + np.exp(-np.clip(out["_conservative_ev"] / scale, -20, 20))
    )
    return out


def _balanced_accuracy(y_true: np.ndarray, y_pred: np.ndarray) -> float | None:
    y_true = np.asarray(y_true, dtype=bool)
    y_pred = np.asarray(y_pred, dtype=bool)
    positives = y_true
    negatives = ~y_true
    if positives.sum() == 0 or negatives.sum() == 0:
        return None
    tpr = float((y_pred & positives).sum() / positives.sum())
    tnr = float(((~y_pred) & negatives).sum() / negatives.sum())
    return 0.5 * (tpr + tnr)


def _metrics(frame: pd.DataFrame) -> dict[str, Any]:
    active = frame.loc[frame["active_trade"].astype(bool)].sort_values("decision_time")
    ba = _balanced_accuracy(
        frame["_actionable_target"].to_numpy(bool),
        frame["active_trade"].to_numpy(bool),
    )
    if active.empty:
        return {
            "rows": int(len(frame)),
            "trades": 0,
            "density": 0.0,
            "median_gap_minutes": None,
            "balanced_accuracy": ba,
            "profit_factor": None,
            "sharpe": None,
            "max_drawdown": None,
            "total_return": 0.0,
            "mean_return": None,
            "win_rate": None,
            "longs": 0,
            "shorts": 0,
            "regime_trades": {regime: 0 for regime in REGIMES},
        }

    returns = active["selected_net_return"].to_numpy(float)
    gross_profit = float(returns[returns > 0].sum())
    gross_loss = float(-returns[returns < 0].sum())
    pf = gross_profit / gross_loss if gross_loss > 0 else None
    std = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0
    sharpe = (
        float(np.sqrt(len(returns)) * returns.mean() / std)
        if std > 0
        else None
    )

    equity = np.cumprod(1.0 + returns)
    peaks = np.maximum.accumulate(equity)
    drawdowns = np.where(peaks > 0, (peaks - equity) / peaks, 0.0)
    max_dd = float(drawdowns.max()) if len(drawdowns) else None

    times = pd.to_datetime(active["decision_time"], utc=True)
    gaps = times.diff().dropna().dt.total_seconds() / 60.0

    return {
        "rows": int(len(frame)),
        "trades": int(len(active)),
        "density": float(len(active) / len(frame)) if len(frame) else 0.0,
        "median_gap_minutes": float(gaps.median()) if len(gaps) else None,
        "balanced_accuracy": ba,
        "profit_factor": pf,
        "sharpe": sharpe,
        "max_drawdown": max_dd,
        "total_return": float(returns.sum()),
        "mean_return": float(returns.mean()),
        "win_rate": float((returns > 0).mean()),
        "longs": int(active["predicted_long"].astype(bool).sum()),
        "shorts": int((~active["predicted_long"].astype(bool)).sum()),
        "regime_trades": {
            regime: int((active["_regime"] == regime).sum()) for regime in REGIMES
        },
    }


def _eligible(metrics: dict[str, Any], *, calibration: bool) -> bool:
    min_trades = 40 if calibration else MIN_OUTER_TRADES
    return bool(
        metrics["trades"] >= min_trades
        and metrics["median_gap_minutes"] is not None
        and metrics["median_gap_minutes"] <= MAX_MEDIAN_GAP_MINUTES
        and _finite(metrics["balanced_accuracy"])
        and metrics["balanced_accuracy"] >= MIN_BALANCED_ACCURACY
        and _finite(metrics["profit_factor"])
        and metrics["profit_factor"] >= MIN_PROFIT_FACTOR
        and _finite(metrics["sharpe"])
        and metrics["sharpe"] >= MIN_SHARPE
        and _finite(metrics["max_drawdown"])
        and metrics["max_drawdown"] <= MAX_DRAWDOWN
        and metrics["total_return"] > 0
    )


def _choose(calibration_scored: pd.DataFrame) -> tuple[dict[str, float], bool, list[dict]]:
    rows: list[dict] = []
    for ev_floor_bps in (0.05, 0.10, 0.15, 0.20, 0.30, 0.40):
        for margin_floor_bps in (0.00, 0.05, 0.10, 0.20):
            for coverage_floor in (0.35, 0.50, 0.65):
                for spread_atr_cap in (0.50, 0.75, 1.00):
                    config = {
                        "ev_floor_bps": float(ev_floor_bps),
                        "margin_floor_bps": float(margin_floor_bps),
                        "coverage_floor": float(coverage_floor),
                        "spread_atr_cap": float(spread_atr_cap),
                    }
                    metrics = _metrics(_apply(calibration_scored, config))
                    rows.append(
                        {
                            **config,
                            **metrics,
                            "eligible": _eligible(metrics, calibration=True),
                        }
                    )

    eligible = [row for row in rows if row["eligible"]]
    if eligible:
        chosen = max(
            eligible,
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


def _prepare_pair(
    pair: str,
    corpus_dir: Path,
    quote_a: Path,
    quote_b: Path,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    datasets = {pair: corpus_dir / f"{pair}_MTF.csv"}

    fast, fast_manifest = load_and_prepare_corpora(
        datasets,
        horizon_bars=H_FAST,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=EXTRA_SLIPPAGE_BPS,
    )
    confirm, confirm_manifest = load_and_prepare_corpora(
        datasets,
        horizon_bars=H_CONFIRM,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=EXTRA_SLIPPAGE_BPS,
    )

    fast = fast.rename(
        columns={
            LONG_NET_RETURN_COLUMN: "long_h5",
            SHORT_NET_RETURN_COLUMN: "short_h5",
        }
    )
    confirm = confirm[
        ["decision_time", "instrument", LONG_NET_RETURN_COLUMN, SHORT_NET_RETURN_COLUMN]
    ].rename(
        columns={
            LONG_NET_RETURN_COLUMN: "long_h10",
            SHORT_NET_RETURN_COLUMN: "short_h10",
        }
    )

    fast["decision_time"] = pd.to_datetime(fast["decision_time"], utc=True)
    confirm["decision_time"] = pd.to_datetime(confirm["decision_time"], utc=True)
    frame = fast.merge(
        confirm,
        on=["decision_time", "instrument"],
        how="inner",
        validate="one_to_one",
    )

    quote_root = quote_a if pair in ("AUDUSD", "EURUSD", "GBPUSD") else quote_b
    quotes = pd.read_csv(quote_root / f"{pair}_1S_M1_BOUNDARY.csv")
    quotes["decision_time"] = pd.to_datetime(quotes["decision_time"], utc=True)
    frame = frame.merge(
        quotes[["decision_time", *QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS]],
        on="decision_time",
        how="inner",
        validate="one_to_one",
    )

    frame = (
        frame.dropna(subset=[*FEATURES, *TARGETS])
        .sort_values("decision_time")
        .reset_index(drop=True)
    )

    return frame, {
        "fast": fast_manifest,
        "confirm": confirm_manifest,
        "rows": int(len(frame)),
    }


def _pair_status(folds: list[dict[str, Any]], combined: pd.DataFrame) -> dict[str, Any]:
    metrics = _metrics(combined)
    positive_fold_fraction = (
        sum(1 for fold in folds if fold["metrics"]["total_return"] > 0) / len(folds)
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
        "calibration_stability": (
            calibration_pass_fraction >= MIN_CALIBRATION_PASS_FRACTION
        ),
        "positive_fold_fraction": (
            positive_fold_fraction >= MIN_POSITIVE_FOLD_FRACTION
        ),
        "evidence": metrics["trades"] >= MIN_OUTER_TRADES,
        "frequency": (
            metrics["median_gap_minutes"] is not None
            and metrics["median_gap_minutes"] <= MAX_MEDIAN_GAP_MINUTES
        ),
        "balanced_accuracy": (
            _finite(metrics["balanced_accuracy"])
            and metrics["balanced_accuracy"] >= MIN_BALANCED_ACCURACY
        ),
        "profit_factor": (
            _finite(metrics["profit_factor"])
            and metrics["profit_factor"] >= MIN_PROFIT_FACTOR
        ),
        "sharpe": _finite(metrics["sharpe"]) and metrics["sharpe"] >= MIN_SHARPE,
        "max_drawdown": (
            _finite(metrics["max_drawdown"])
            and metrics["max_drawdown"] <= MAX_DRAWDOWN
        ),
        "positive_return": metrics["total_return"] > 0,
    }
    return {
        "research_challenger": all(checks.values()),
        "production_eligible": False,
        "checks": checks,
        "positive_fold_fraction": positive_fold_fraction,
        "calibration_pass_fraction": calibration_pass_fraction,
        "metrics": metrics,
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
        status = _pair_status(folds, combined) if predictions else {
            "research_challenger": False,
            "production_eligible": False,
            "checks": {},
            "positive_fold_fraction": 0.0,
            "calibration_pass_fraction": 0.0,
            "metrics": {},
        }
        report = {
            "experiment": EXPERIMENT,
            "methodology": (
                "Pair-specific gated multi-horizon mixture-of-experts; H5 realized "
                "outcome with H10 confirmation; causal training-window regimes; "
                "separate fit/early-stop/calibration partitions; purged outer folds."
            ),
            "pair": pair,
            "complete": complete,
            "sealed_future_holdout_touched": False,
            "production_eligible": False,
            "promotion_gates_unchanged": True,
            "horizons": {"fast": H_FAST, "confirm": H_CONFIRM},
            "extra_slippage_bps": EXTRA_SLIPPAGE_BPS,
            "feature_count": len(FEATURES),
            "features": FEATURES,
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
        thresholds = _regime_thresholds(fit)
        models = _fit_experts(
            fit,
            early_stop,
            thresholds,
            7900 + pair_index * 100 + fold_index * 20,
        )

        calibration_scored = _route_predict(calibration, models, thresholds)
        chosen, calibration_passed, candidates = _choose(calibration_scored)

        outer_scored = _route_predict(outer_valid, models, thresholds)
        outer = _apply(outer_scored, chosen)
        outer["fold"] = fold_index
        predictions.append(outer)

        metrics = _metrics(outer)
        fold = {
            "fold": fold_index,
            "calibration_passed": calibration_passed,
            "regime_thresholds": thresholds,
            "available_regime_experts": sorted(
                key for key in models if key != "global"
            ),
            "chosen": {
                key: chosen[key]
                for key in (
                    "ev_floor_bps",
                    "margin_floor_bps",
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
            print(
                json.dumps(
                    {
                        "pair": pair,
                        "early_eliminated": True,
                        "completed_folds": len(folds),
                        "remaining_folds_skipped": remaining,
                        "calibration_passes": calibration_passes,
                        "positive_folds": positive_folds,
                    },
                    indent=2,
                ),
                flush=True,
            )
            return report

    report = checkpoint(True)
    print(
        json.dumps(
            {
                "pair": pair,
                "research_challenger": report["research_challenger"],
                "checks": report["checks"],
                "positive_fold_fraction": report["positive_fold_fraction"],
                "calibration_pass_fraction": report["calibration_pass_fraction"],
                "metrics": report["metrics"],
                "production_eligible": False,
            },
            indent=2,
            default=str,
        ),
        flush=True,
    )
    return report


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
            output_dir / f"v79-{pair}-3fold.json",
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
    (output_dir / "v79-summary.json").write_text(
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
    parser.add_argument(
        "--pairs",
        default="",
        help="Optional comma-separated subset of the six research pairs",
    )
    parser.add_argument("--max-splits", type=int, default=OUTER_FOLDS_REQUIRED)
    args = parser.parse_args()

    selected_pairs = tuple(
        value.strip().upper()
        for value in args.pairs.split(",")
        if value.strip()
    ) or None

    run(
        args.corpus_dir,
        args.quote_a,
        args.quote_b,
        args.output_dir,
        selected_pairs=selected_pairs,
        max_splits=args.max_splits,
    )
