"""USDJPY v15 research: preserve v13 LONG edge and gate SHORT by causal regime.

LONG and SHORT actionability are calibrated independently. The candidate uses
only pre-boundary history and a late disjoint outer-validation era after v14. Frozen v10 and its future holdout remain untouched.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score, precision_score, recall_score

from app.domain.training.model_qualification import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    ModelVariant,
    _apply_calibrator,
    _ensure_event_dual_actionability_targets,
    _fit_calibrator,
    _nested_windows,
    _probabilities,
    _refit_windows,
)
from app.domain.training.single_pair_v11_calibrated_gating import (
    PAYOFF_RATIO_FLOOR,
    _fit_models,
    _trading_metrics,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v15_short_regime_filtered_actionability"
SIDE_THRESHOLD_GRID = (0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20)
MIN_OUTER_TRADES = 20
MIN_PER_FOLD_TRADES = 3
SHORT_VOL_QUANTILES = (None, 0.33, 0.50, 0.67)
SHORT_RSI_QUANTILES = (None, 0.50, 0.67, 0.75)
MIN_SHORT_SELECTION_TRADES = 10
MIN_SHORT_SELECTION_PROFIT_FACTOR = 1.15
MAX_FOLD_TRADE_CONCENTRATION = 0.80


def select_side_threshold(
    labels: np.ndarray,
    probabilities: np.ndarray,
) -> dict[str, float]:
    labels = np.asarray(labels, dtype=int)
    probabilities = np.asarray(probabilities, dtype=float)
    base_rate = float(labels.mean())
    candidates: list[dict[str, float]] = []
    for threshold in SIDE_THRESHOLD_GRID:
        predicted = probabilities >= threshold
        candidates.append(
            {
                "threshold": float(threshold),
                "balanced_accuracy": float(
                    balanced_accuracy_score(labels, predicted)
                ),
                "precision": float(
                    precision_score(labels, predicted, zero_division=0)
                ),
                "recall": float(
                    recall_score(labels, predicted, zero_division=0)
                ),
                "predicted_fraction": float(predicted.mean()),
            }
        )
    return max(
        candidates,
        key=lambda row: (
            row["balanced_accuracy"],
            row["precision"],
            row["recall"],
            -abs(row["predicted_fraction"] - base_rate),
        ),
    )


def _fit_side_calibrators(
    models: Any,
    calibration: pd.DataFrame,
) -> dict[str, Any]:
    calibration = _ensure_event_dual_actionability_targets(calibration)
    calibrators: dict[str, Any] = {}
    for side, model, target in (
        ("long", models.long_model, EVENT_LONG_ACTIONABLE_TARGET_COLUMN),
        ("short", models.short_model, EVENT_SHORT_ACTIONABLE_TARGET_COLUMN),
    ):
        raw = _probabilities(model, calibration, models.feature_columns)
        calibrators[side] = _fit_calibrator(
            "platt",
            probabilities=raw,
            labels=calibration[target].to_numpy(int),
        )
    return calibrators


def _score_frame(
    models: Any,
    frame: pd.DataFrame,
    *,
    calibrators: dict[str, Any],
) -> pd.DataFrame:
    frame = _ensure_event_dual_actionability_targets(frame)
    features = models.feature_columns
    long_prob = _apply_calibrator(
        calibrators["long"],
        _probabilities(models.long_model, frame, features),
    )
    short_prob = _apply_calibrator(
        calibrators["short"],
        _probabilities(models.short_model, frame, features),
    )

    long_up = np.maximum(models.long_upside.predict(frame[features]), 0.0)
    long_dn = np.maximum(models.long_downside.predict(frame[features]), 0.0)
    short_up = np.maximum(models.short_upside.predict(frame[features]), 0.0)
    short_dn = np.maximum(models.short_downside.predict(frame[features]), 0.0)

    result = frame[
        [
            "decision_time",
            "instrument",
            EVENT_ACTIONABLE_TARGET_COLUMN,
            EVENT_DIRECTION_TARGET_COLUMN,
            EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
            EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
            EVENT_LONG_NET_RETURN_COLUMN,
            EVENT_SHORT_NET_RETURN_COLUMN,
            "m1_volatility_20",
            "h1_rsi_14",
        ]
    ].copy()
    result["long_action_probability"] = long_prob
    result["short_action_probability"] = short_prob
    result["long_expected_upside_bps"] = long_up
    result["long_expected_downside_bps"] = long_dn
    result["short_expected_upside_bps"] = short_up
    result["short_expected_downside_bps"] = short_dn
    result["long_expected_net_bps"] = long_up - long_dn
    result["short_expected_net_bps"] = short_up - short_dn
    result["long_payoff_ratio"] = long_up / np.maximum(long_dn, 1e-6)
    result["short_payoff_ratio"] = short_up / np.maximum(short_dn, 1e-6)
    return result


def _apply_side_policy(
    scored: pd.DataFrame,
    *,
    long_threshold: float,
    short_threshold: float,
    short_min_volatility: float | None = None,
    short_min_rsi: float | None = None,
) -> pd.DataFrame:
    result = scored.copy()
    long_pass = (
        (result["long_action_probability"] >= long_threshold)
        & (result["long_expected_net_bps"] > 0.0)
        & (result["long_payoff_ratio"] >= PAYOFF_RATIO_FLOOR)
    )
    short_pass = (
        (result["short_action_probability"] >= short_threshold)
        & (result["short_expected_net_bps"] > 0.0)
        & (result["short_payoff_ratio"] >= PAYOFF_RATIO_FLOOR)
    )
    if short_min_volatility is not None:
        short_pass &= result["m1_volatility_20"] >= short_min_volatility
    if short_min_rsi is not None:
        short_pass &= result["h1_rsi_14"] >= short_min_rsi

    long_strength = (
        (result["long_action_probability"] - long_threshold)
        / max(1.0 - long_threshold, 1e-6)
    )
    short_strength = (
        (result["short_action_probability"] - short_threshold)
        / max(1.0 - short_threshold, 1e-6)
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
        np.where(choose_short, result[EVENT_SHORT_NET_RETURN_COLUMN], 0.0),
    )
    return result



def select_short_regime_policy(scored: pd.DataFrame) -> dict[str, Any]:
    """Select SHORT threshold/regime only from inner chronological selection data."""
    candidates: list[dict[str, Any]] = []
    vol = pd.to_numeric(scored["m1_volatility_20"], errors="raise")
    rsi = pd.to_numeric(scored["h1_rsi_14"], errors="raise")
    for threshold in SIDE_THRESHOLD_GRID:
        for vol_q in SHORT_VOL_QUANTILES:
            vol_cut = None if vol_q is None else float(vol.quantile(vol_q))
            for rsi_q in SHORT_RSI_QUANTILES:
                rsi_cut = None if rsi_q is None else float(rsi.quantile(rsi_q))
                short_pass = (
                    (scored["short_action_probability"] >= threshold)
                    & (scored["short_expected_net_bps"] > 0.0)
                    & (scored["short_payoff_ratio"] >= PAYOFF_RATIO_FLOOR)
                )
                if vol_cut is not None:
                    short_pass &= vol >= vol_cut
                if rsi_cut is not None:
                    short_pass &= rsi >= rsi_cut
                returns = pd.to_numeric(
                    scored.loc[short_pass, EVENT_SHORT_NET_RETURN_COLUMN], errors="raise"
                ).to_numpy(float)
                gains = float(returns[returns > 0.0].sum()) if len(returns) else 0.0
                losses = float(-returns[returns < 0.0].sum()) if len(returns) else 0.0
                pf = gains / losses if losses > 0.0 else (float("inf") if gains > 0.0 else None)
                total = float(returns.sum()) if len(returns) else 0.0
                eligible = (
                    len(returns) >= MIN_SHORT_SELECTION_TRADES
                    and pf is not None
                    and pf >= MIN_SHORT_SELECTION_PROFIT_FACTOR
                    and total > 0.0
                )
                candidates.append({
                    "threshold": float(threshold),
                    "volatility_quantile": vol_q,
                    "volatility_floor": vol_cut,
                    "rsi_quantile": rsi_q,
                    "rsi_floor": rsi_cut,
                    "trade_count": int(len(returns)),
                    "profit_factor": None if pf is None or not np.isfinite(pf) else float(pf),
                    "profit_factor_infinite": bool(pf is not None and not np.isfinite(pf)),
                    "total_return": total,
                    "win_rate": float((returns > 0.0).mean()) if len(returns) else 0.0,
                    "eligible": bool(eligible),
                })
    eligible = [row for row in candidates if row["eligible"]]
    if not eligible:
        return {"enabled": False, "reason": "no_inner_short_regime_candidate_met_economic_evidence", "candidates": candidates}
    selected = max(eligible, key=lambda row: (row["trade_count"], row["profit_factor"] or 0.0, row["total_return"], row["win_rate"]))
    return {"enabled": True, "reason": "inner_only_short_regime_economic_selection", **selected, "candidates": candidates}

def _fold_report(
    scored: pd.DataFrame,
    *,
    long_threshold: float,
    short_threshold: float,
    short_min_volatility: float | None = None,
    short_min_rsi: float | None = None,
) -> dict[str, Any]:
    gated = _apply_side_policy(
        scored,
        long_threshold=long_threshold,
        short_threshold=short_threshold,
        short_min_volatility=short_min_volatility,
        short_min_rsi=short_min_rsi,
    )
    active = gated.loc[gated["active_trade"]].copy()
    return {
        "long_balanced_accuracy": float(
            balanced_accuracy_score(
                gated[EVENT_LONG_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
                (gated["long_action_probability"] >= long_threshold).to_numpy(int),
            )
        ),
        "short_balanced_accuracy": float(
            balanced_accuracy_score(
                gated[EVENT_SHORT_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
                (gated["short_action_probability"] >= short_threshold).to_numpy(int),
            )
        ),
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


def evaluate_v15(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str,
    max_splits: int = 3,
) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    unique_periods = int(pooled["decision_time"].nunique())
    min_train = int(unique_periods * 0.94)
    validation = int(unique_periods * 0.02)
    variant = ModelVariant(name="event_barrier_v15_short_regime_filtered")

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
        selection_labeled = _ensure_event_dual_actionability_targets(
            nested.selection
        )
        selection_scored = _score_frame(
            inner_models,
            selection_labeled,
            calibrators=inner_calibrators,
        )
        long_choice = select_side_threshold(
            selection_labeled[EVENT_LONG_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
            selection_scored["long_action_probability"].to_numpy(float),
        )
        short_choice = select_short_regime_policy(selection_scored)

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
        short_threshold = float(short_choice["threshold"]) if short_choice.get("enabled") else 1.0
        fold = _fold_report(
            outer_scored,
            long_threshold=float(long_choice["threshold"]),
            short_threshold=short_threshold,
            short_min_volatility=short_choice.get("volatility_floor"),
            short_min_rsi=short_choice.get("rsi_floor"),
        )
        fold["fold"] = fold_index
        fold["validation_start"] = str(outer_validation["decision_time"].min())
        fold["validation_end"] = str(outer_validation["decision_time"].max())
        fold["inner_long_threshold_selection"] = long_choice
        fold["inner_short_regime_selection"] = short_choice
        folds.append(fold)
        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "long_threshold": long_choice["threshold"],
                    "short_threshold": short_choice.get("threshold"),
                    "short_enabled": short_choice.get("enabled"),
                    "short_volatility_floor": short_choice.get("volatility_floor"),
                    "short_rsi_floor": short_choice.get("rsi_floor"),
                    "trades": fold["trading"]["trade_count"],
                    "long": fold["trading"]["long_trades"],
                    "short": fold["trading"]["short_trades"],
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
            active["decision_time"], utc=True, errors="raise"
        )
        aggregate_trading = _trading_metrics(active)
    else:
        aggregate_trading = _trading_metrics(pd.DataFrame())

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
    robustness_gate = {
        "minimum_trade_evidence": total_trades >= MIN_OUTER_TRADES,
        "minimum_each_fold_trade_evidence": bool(trade_counts)
        and min(trade_counts) >= MIN_PER_FOLD_TRADES,
        "fold_concentration_lte_0_80": max_concentration
        <= MAX_FOLD_TRADE_CONCENTRATION,
        "two_sided_execution": long_trades > 0 and short_trades > 0,
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
    }
    robustness_gate["research_robustness_passed"] = all(
        bool(value) for value in robustness_gate.values()
    )

    return {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "decision_time_before": pd.Timestamp(decision_time_before).isoformat(),
        "protocol": {
            "outer_min_train_fraction": 0.94,
            "outer_validation_fraction": 0.02,
            "outer_era_disjoint_from_v13_v14": True,
            "short_regime_selection_inner_only": True,
            "side_specific_calibration": True,
            "pooled_opportunity_gate_removed": True,
            "payoff_ratio_floor": PAYOFF_RATIO_FLOOR,
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
    args = parser.parse_args()

    report = evaluate_v15(
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
    print(json.dumps(report["aggregate"], sort_keys=True))
    print(json.dumps(report["robustness_gate"], sort_keys=True))


if __name__ == "__main__":
    main()