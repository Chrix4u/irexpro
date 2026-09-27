"""USDJPY v11 research: calibrated opportunity gating with nested selection.

This candidate is deliberately separate from frozen v10. It uses only
pre-boundary historical data, selects gating parameters inside each outer
training window, and evaluates the selected policy on untouched outer folds.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
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
    _feature_columns,
    _fit_binary_variant,
    _fit_calibrator,
    _nested_windows,
    _probabilities,
    _refit_windows,
    _regression_model_for_variant,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import (
    compute_backtest_metrics,
    iter_purged_walk_forward_time_splits,
)

EXPERIMENT_NAME = "event_barrier_v11_calibrated_gating"
OPPORTUNITY_THRESHOLD_GRID = (0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30)
MARGIN_FLOOR_GRID = (0.025, 0.05, 0.075, 0.10)
DIRECTION_CONFIDENCE_FLOOR = 0.60
PAYOFF_RATIO_FLOOR = 1.15
MIN_ROBUST_TRADES = 30


@dataclass
class V11Models:
    long_model: Any
    short_model: Any
    opportunity_model: Any
    long_upside: Any
    long_downside: Any
    short_upside: Any
    short_downside: Any
    feature_columns: list[str]


def _fit_models(
    fit: pd.DataFrame,
    early: pd.DataFrame,
    *,
    variant: ModelVariant,
) -> V11Models:
    fit = _ensure_event_dual_actionability_targets(fit)
    early = _ensure_event_dual_actionability_targets(early)
    features = _feature_columns(variant.feature_policy)

    opportunity_variant = ModelVariant(
        name=f"{variant.name}_opportunity",
        sample_weight_policy="class_balance",
        calibration="none",
        feature_policy=variant.feature_policy,
    )
    opportunity_model = _fit_binary_variant(
        opportunity_variant,
        fit=fit,
        early_stop=early,
        feature_columns=features,
        target_column=EVENT_ACTIONABLE_TARGET_COLUMN,
        sample_weight_policy="class_balance",
    )

    direction_models: dict[str, Any] = {}
    for side, target in {
        "long": EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
        "short": EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
    }.items():
        side_variant = ModelVariant(
            name=f"{variant.name}_{side}",
            sample_weight_policy="class_balance",
            calibration="none",
            feature_policy=variant.feature_policy,
        )
        direction_models[side] = _fit_binary_variant(
            side_variant,
            fit=fit,
            early_stop=early,
            feature_columns=features,
            target_column=target,
            sample_weight_policy="class_balance",
        )

    payoff: dict[str, Any] = {}
    for side, target in {
        "long": EVENT_LONG_NET_RETURN_COLUMN,
        "short": EVENT_SHORT_NET_RETURN_COLUMN,
    }.items():
        fit_return = pd.to_numeric(fit[target], errors="raise").to_numpy(float) * 10_000.0
        early_return = (
            pd.to_numeric(early[target], errors="raise").to_numpy(float) * 10_000.0
        )
        for component, fit_target, early_target in (
            ("upside", np.maximum(fit_return, 0.0), np.maximum(early_return, 0.0)),
            ("downside", np.maximum(-fit_return, 0.0), np.maximum(-early_return, 0.0)),
        ):
            model = _regression_model_for_variant(
                ModelVariant(name=f"{variant.name}_{side}_{component}")
            )
            model.fit(
                fit[features],
                fit_target,
                eval_set=[(early[features], early_target)],
                verbose=False,
            )
            payoff[f"{side}_{component}"] = model

    return V11Models(
        long_model=direction_models["long"],
        short_model=direction_models["short"],
        opportunity_model=opportunity_model,
        long_upside=payoff["long_upside"],
        long_downside=payoff["long_downside"],
        short_upside=payoff["short_upside"],
        short_downside=payoff["short_downside"],
        feature_columns=features,
    )


def _score_frame(
    models: V11Models,
    frame: pd.DataFrame,
    *,
    opportunity_calibrator: Any,
) -> pd.DataFrame:
    source = _ensure_event_dual_actionability_targets(frame)
    features = models.feature_columns

    long_prob = _probabilities(models.long_model, source, features)
    short_prob = _probabilities(models.short_model, source, features)
    raw_opportunity = _probabilities(models.opportunity_model, source, features)
    opportunity = _apply_calibrator(opportunity_calibrator, raw_opportunity)

    total = np.maximum(long_prob + short_prob, 1e-7)
    normalized_long = long_prob / total
    predicted_long = long_prob >= short_prob
    direction_confidence = np.maximum(normalized_long, 1.0 - normalized_long)
    margin = np.abs(long_prob - short_prob)

    long_up = np.maximum(models.long_upside.predict(source[features]), 0.0)
    long_dn = np.maximum(models.long_downside.predict(source[features]), 0.0)
    short_up = np.maximum(models.short_upside.predict(source[features]), 0.0)
    short_dn = np.maximum(models.short_downside.predict(source[features]), 0.0)

    selected_up = np.where(predicted_long, long_up, short_up)
    selected_dn = np.where(predicted_long, long_dn, short_dn)
    ratio = selected_up / np.maximum(selected_dn, 1e-6)
    expected_net = selected_up - selected_dn

    result = source[
        [
            "decision_time",
            "instrument",
            EVENT_ACTIONABLE_TARGET_COLUMN,
            EVENT_DIRECTION_TARGET_COLUMN,
            EVENT_LONG_NET_RETURN_COLUMN,
            EVENT_SHORT_NET_RETURN_COLUMN,
        ]
    ].copy()
    result["long_action_probability"] = long_prob
    result["short_action_probability"] = short_prob
    result["raw_opportunity_probability"] = raw_opportunity
    result["opportunity_probability"] = opportunity
    result["predicted_long"] = predicted_long
    result["direction_confidence"] = direction_confidence
    result["action_probability_margin"] = margin
    result["expected_selected_upside_bps"] = selected_up
    result["expected_selected_downside_bps"] = selected_dn
    result["expected_selected_net_bps"] = expected_net
    result["expected_payoff_ratio"] = ratio
    result["selected_net_return"] = np.where(
        predicted_long,
        result[EVENT_LONG_NET_RETURN_COLUMN],
        result[EVENT_SHORT_NET_RETURN_COLUMN],
    )
    return result


def select_opportunity_threshold(scored: pd.DataFrame) -> dict[str, float]:
    labels = scored[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(int)
    probabilities = scored["opportunity_probability"].to_numpy(float)
    candidates: list[dict[str, float]] = []
    for threshold in OPPORTUNITY_THRESHOLD_GRID:
        predicted = probabilities >= threshold
        metrics = {
            "threshold": float(threshold),
            "balanced_accuracy": float(balanced_accuracy_score(labels, predicted)),
            "precision": float(precision_score(labels, predicted, zero_division=0)),
            "recall": float(recall_score(labels, predicted, zero_division=0)),
            "predicted_fraction": float(predicted.mean()),
        }
        candidates.append(metrics)
    return max(
        candidates,
        key=lambda row: (
            row["balanced_accuracy"],
            row["precision"],
            row["recall"],
            -abs(row["predicted_fraction"] - float(labels.mean())),
        ),
    )


def select_margin_floor(
    scored: pd.DataFrame,
    *,
    opportunity_threshold: float,
) -> dict[str, float]:
    actionable = scored.loc[scored[EVENT_ACTIONABLE_TARGET_COLUMN] == 1].copy()
    candidates: list[dict[str, float]] = []
    for margin_floor in MARGIN_FLOOR_GRID:
        eligible = actionable.loc[
            (actionable["opportunity_probability"] >= opportunity_threshold)
            & (actionable["direction_confidence"] >= DIRECTION_CONFIDENCE_FLOOR)
            & (actionable["action_probability_margin"] >= margin_floor)
        ]
        if eligible.empty:
            accuracy = 0.0
            coverage = 0.0
        else:
            truth = eligible[EVENT_DIRECTION_TARGET_COLUMN].to_numpy(int)
            pred = eligible["predicted_long"].to_numpy(int)
            accuracy = float((truth == pred).mean())
            coverage = float(len(eligible) / len(actionable))
        candidates.append(
            {
                "margin_floor": float(margin_floor),
                "direction_accuracy": accuracy,
                "actionable_coverage": coverage,
                "eligible_rows": float(len(eligible)),
            }
        )
    return max(
        candidates,
        key=lambda row: (
            row["direction_accuracy"],
            min(row["actionable_coverage"], 0.20),
            row["eligible_rows"],
            row["margin_floor"],
        ),
    )


def _apply_gate(
    scored: pd.DataFrame,
    *,
    opportunity_threshold: float,
    margin_floor: float,
) -> pd.DataFrame:
    result = scored.copy()
    result["active_trade"] = (
        (result["opportunity_probability"] >= opportunity_threshold)
        & (result["direction_confidence"] >= DIRECTION_CONFIDENCE_FLOOR)
        & (result["action_probability_margin"] >= margin_floor)
        & (result["expected_selected_net_bps"] > 0.0)
        & (result["expected_payoff_ratio"] >= PAYOFF_RATIO_FLOOR)
    )
    return result


def _trading_metrics(active: pd.DataFrame) -> dict[str, Any]:
    if active.empty:
        return {
            "trade_count": 0,
            "long_trades": 0,
            "short_trades": 0,
            "total_return": 0.0,
            "win_rate": 0.0,
            "profit_factor": None,
            "sharpe_ratio": None,
            "max_drawdown": 0.0,
        }
    returns = active["selected_net_return"].to_numpy(float)
    times = pd.to_datetime(active["decision_time"], utc=True)
    span_years = max(
        (times.max() - times.min()).total_seconds() / (365.25 * 24 * 3600),
        1.0 / 365.25,
    )
    periods_per_year = max(float(len(active)) / span_years, 1.0)
    metrics = compute_backtest_metrics(returns, annualization_factor=periods_per_year)
    return {
        "trade_count": int(len(active)),
        "long_trades": int(active["predicted_long"].sum()),
        "short_trades": int((~active["predicted_long"]).sum()),
        **metrics,
    }


def _fold_report(
    scored: pd.DataFrame,
    *,
    opportunity_threshold: float,
    margin_floor: float,
) -> dict[str, Any]:
    gated = _apply_gate(
        scored,
        opportunity_threshold=opportunity_threshold,
        margin_floor=margin_floor,
    )
    active = gated.loc[gated["active_trade"]].copy()
    actionable = gated.loc[gated[EVENT_ACTIONABLE_TARGET_COLUMN] == 1]
    direction_balanced = None
    if not actionable.empty and actionable[EVENT_DIRECTION_TARGET_COLUMN].nunique() == 2:
        direction_balanced = float(
            balanced_accuracy_score(
                actionable[EVENT_DIRECTION_TARGET_COLUMN].to_numpy(int),
                actionable["predicted_long"].to_numpy(int),
            )
        )
    opportunity_balanced = float(
        balanced_accuracy_score(
            gated[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
            (gated["opportunity_probability"] >= opportunity_threshold).to_numpy(int),
        )
    )
    return {
        "rows": int(len(gated)),
        "opportunity_threshold": float(opportunity_threshold),
        "margin_floor": float(margin_floor),
        "direction_balanced_accuracy": direction_balanced,
        "opportunity_balanced_accuracy": opportunity_balanced,
        "trading": _trading_metrics(active),
    }


def evaluate_v11(
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
    min_train = max(250, int(unique_periods * 0.60))
    validation = max(100, int(unique_periods * 0.07))
    variant = ModelVariant(name="event_barrier_v11_calibrated_gating")

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
        calibration_raw = _probabilities(
            inner_models.opportunity_model,
            nested.calibration,
            inner_models.feature_columns,
        )
        calibrator = _fit_calibrator(
            "platt",
            probabilities=calibration_raw,
            labels=nested.calibration[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
        )
        selection_scored = _score_frame(
            inner_models,
            nested.selection,
            opportunity_calibrator=calibrator,
        )
        opportunity_choice = select_opportunity_threshold(selection_scored)
        margin_choice = select_margin_floor(
            selection_scored,
            opportunity_threshold=opportunity_choice["threshold"],
        )

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_models = _fit_models(refit.fit, refit.early_stop, variant=variant)
        refit_raw = _probabilities(
            outer_models.opportunity_model,
            refit.calibration,
            outer_models.feature_columns,
        )
        outer_calibrator = _fit_calibrator(
            "platt",
            probabilities=refit_raw,
            labels=refit.calibration[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
        )
        outer_scored = _score_frame(
            outer_models,
            outer_validation,
            opportunity_calibrator=outer_calibrator,
        )
        report = _fold_report(
            outer_scored,
            opportunity_threshold=opportunity_choice["threshold"],
            margin_floor=margin_choice["margin_floor"],
        )
        report["fold"] = fold_index
        report["inner_opportunity_selection"] = opportunity_choice
        report["inner_margin_selection"] = margin_choice
        folds.append(report)

    trades = sum(int(f["trading"]["trade_count"]) for f in folds)
    long_trades = sum(int(f["trading"]["long_trades"]) for f in folds)
    short_trades = sum(int(f["trading"]["short_trades"]) for f in folds)
    positive_folds = sum(float(f["trading"]["total_return"]) > 0.0 for f in folds)
    direction_values = [
        float(f["direction_balanced_accuracy"])
        for f in folds
        if f["direction_balanced_accuracy"] is not None
    ]
    opportunity_values = [float(f["opportunity_balanced_accuracy"]) for f in folds]

    return {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "decision_time_before": pd.Timestamp(decision_time_before).isoformat(),
        "dataset_sha256": hashes,
        "folds": folds,
        "aggregate": {
            "trade_count": trades,
            "long_trades": long_trades,
            "short_trades": short_trades,
            "positive_fold_fraction": positive_folds / len(folds) if folds else 0.0,
            "mean_direction_balanced_accuracy": (
                float(np.mean(direction_values)) if direction_values else None
            ),
            "mean_opportunity_balanced_accuracy": (
                float(np.mean(opportunity_values)) if opportunity_values else None
            ),
        },
        "robustness_gate": {
            "minimum_trade_evidence": trades >= MIN_ROBUST_TRADES,
            "two_sided_execution": long_trades > 0 and short_trades > 0,
            "positive_fold_fraction_gte_0_60": (
                positive_folds / len(folds) >= 0.60 if folds else False
            ),
            "note": (
                "This is a research robustness gate only. It cannot approve PAPER/LIVE "
                "and does not consume the frozen v10 future holdout."
            ),
        },
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

    report = evaluate_v11(
        _parse_dataset(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        max_splits=args.max_splits,
    )
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True, default=str))
    print(json.dumps(report["aggregate"], sort_keys=True))
    print(json.dumps(report["robustness_gate"], sort_keys=True))


if __name__ == "__main__":
    main()
