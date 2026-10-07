"""Bounded final USDJPY research campaign.

This campaign deliberately evaluates only three materially different strategy
families.  It is a terminal decision loop, not another version treadmill:

A. causal regime/trend/momentum rules (no ML predictor),
B. two-stage event opportunity + direction ML,
C. deterministic directional setup + ML profitability filter.

All outer validation folds are purged/embargoed and untouched by fitting or
threshold selection.  A new future holdout is forbidden unless at least one
family clears the complete research gate.  If all three fail, the report
explicitly terminates this proprietary-edge campaign instead of suggesting a
v73/v74/... continuation.
"""
from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from xgboost import XGBClassifier

from app.domain.training.model_qualification import _summarize_predictions
from app.domain.training.single_pair_v41_live_promotable_microstructure import (
    FEATURES,
    _augment,
)
from app.domain.training.single_pair_v42_side_meta_label import (
    _base_prediction_frame,
    _density,
)
from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

HORIZON_BARS = 10
MIN_NET_BPS = 0.50
MIN_NET_RETURN = MIN_NET_BPS / 10_000.0
CONFIDENCE_FLOOR = 0.60
MIN_SIDE_FRACTION = 0.10

RESEARCH_GATE = {
    "min_balanced_accuracy": 0.52,
    "min_sharpe_ratio": 1.0,
    "min_profit_factor": 1.15,
    "max_drawdown": 0.12,
    "min_positive_fold_fraction": 0.60,
    "min_positive_instrument_fraction": 0.67,
    "min_confidence": 0.60,
    "min_non_overlapping_periods": 100,
    "max_median_calendar_minutes_between_entries": 10.0,
}

FAMILY_REGIME = "regime_trend_momentum_rules"
FAMILY_EVENT = "event_opportunity_two_stage_ml"
FAMILY_HYBRID = "deterministic_setup_ml_filter"
FAMILIES = (FAMILY_REGIME, FAMILY_EVENT, FAMILY_HYBRID)


def _classifier(seed: int) -> XGBClassifier:
    return XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        n_estimators=350,
        learning_rate=0.03,
        max_depth=4,
        min_child_weight=7.0,
        subsample=0.82,
        colsample_bytree=0.78,
        reg_alpha=0.20,
        reg_lambda=2.20,
        random_state=seed,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=35,
    )


def _binary_weights(y: pd.Series) -> np.ndarray:
    arr = y.to_numpy(dtype=int)
    counts = np.bincount(arr, minlength=2).astype(float)
    if (counts <= 0).any():
        raise ValueError(f"binary target lacks both classes: {counts.tolist()}")
    total = float(len(arr))
    per_class = np.sqrt(total / (2.0 * counts))
    weights = np.clip(per_class[arr], 0.5, 3.0)
    return (weights / weights.mean()).astype(float)


def _split_early_calibration(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split an inner chronological tail into early-stop and calibration sets."""
    times = pd.Index(pd.to_datetime(frame["decision_time"], utc=True).drop_duplicates().sort_values())
    calibration_periods = max(100, int(len(times) * 0.40))
    calibration_start = len(times) - calibration_periods
    early_end = calibration_start - HORIZON_BARS
    if early_end < 100:
        raise ValueError("inner tail is too small for purged calibration split")
    early_times = times[:early_end]
    calibration_times = times[calibration_start:]
    ts = pd.to_datetime(frame["decision_time"], utc=True)
    early = frame.loc[ts.isin(early_times)].copy()
    calibration = frame.loc[ts.isin(calibration_times)].copy()
    if early.empty or calibration.empty:
        raise ValueError("inner calibration split produced an empty frame")
    return early, calibration


def _fit_platt(raw_probability: np.ndarray, labels: pd.Series | np.ndarray) -> LogisticRegression:
    raw = np.asarray(raw_probability, dtype=float).reshape(-1, 1)
    y = np.asarray(labels, dtype=int)
    if len(y) < 50 or len(np.unique(y)) < 2:
        raise ValueError("probability calibration requires at least 50 rows and both classes")
    model = LogisticRegression(C=1.0, solver="lbfgs", max_iter=500, random_state=42)
    model.fit(raw, y)
    return model


def _apply_platt(model: LogisticRegression, raw_probability: np.ndarray) -> np.ndarray:
    raw = np.asarray(raw_probability, dtype=float).reshape(-1, 1)
    return model.predict_proba(raw)[:, 1]


def _profit_labels(frame: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    long_return = pd.to_numeric(frame[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    short_return = pd.to_numeric(frame[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    actionable = np.maximum(long_return, short_return) >= MIN_NET_RETURN
    direction_long = long_return > short_return
    return actionable.astype(int), direction_long.astype(int), np.maximum(long_return, short_return)


def _rule_score(frame: pd.DataFrame) -> np.ndarray:
    """Causal cross-timeframe directional score in approximately [-1, 1]."""
    htf = pd.to_numeric(frame["higher_timeframe_trend_score"], errors="raise").to_numpy(float)
    entry = pd.to_numeric(frame["entry_momentum_score"], errors="raise").to_numpy(float)
    trend = pd.to_numeric(frame["trend_alignment_score"], errors="raise").to_numpy(float)
    momentum = pd.to_numeric(frame["momentum_alignment_score"], errors="raise").to_numpy(float)
    breakout = pd.to_numeric(frame["m1_breakout_strength_20"], errors="raise").to_numpy(float)
    score = (
        0.30 * htf
        + 0.25 * entry
        + 0.20 * trend
        + 0.20 * momentum
        + 0.05 * np.tanh(breakout)
    )
    return np.clip(score, -1.0, 1.0)


def _regime_limits(frame: pd.DataFrame) -> dict[str, float]:
    spread = pd.to_numeric(frame["m1_spread_bps"], errors="raise").to_numpy(float)
    volatility = pd.to_numeric(frame["m1_volatility_20"], errors="raise").to_numpy(float)
    return {
        "spread_cap": float(np.quantile(spread, 0.75)),
        "volatility_floor": float(np.quantile(volatility, 0.10)),
        "volatility_cap": float(np.quantile(volatility, 0.90)),
    }


def _regime_mask(frame: pd.DataFrame, limits: dict[str, float]) -> np.ndarray:
    spread = pd.to_numeric(frame["m1_spread_bps"], errors="raise").to_numpy(float)
    volatility = pd.to_numeric(frame["m1_volatility_20"], errors="raise").to_numpy(float)
    return (
        (spread <= limits["spread_cap"])
        & (volatility >= limits["volatility_floor"])
        & (volatility <= limits["volatility_cap"])
    )


def _prediction_frame(
    source: pd.DataFrame,
    *,
    direction_probability: np.ndarray,
    opportunity_probability: np.ndarray,
    active: np.ndarray,
    family: str,
    fold: int,
    confidence_policy: str,
) -> pd.DataFrame:
    direction_probability = np.clip(np.asarray(direction_probability, dtype=float), 1e-6, 1 - 1e-6)
    opportunity_probability = np.clip(np.asarray(opportunity_probability, dtype=float), 0.0, 1.0)
    active = np.asarray(active, dtype=bool)
    out = _base_prediction_frame(source, direction_probability, 1.0 - direction_probability)
    direction_confidence = np.maximum(direction_probability, 1.0 - direction_probability)
    confidence = np.minimum(direction_confidence, opportunity_probability)
    out["opportunity_probability"] = opportunity_probability
    out["direction_confidence"] = direction_confidence
    out["confidence"] = confidence
    out["predicted_opportunity"] = active
    out["active_trade"] = active
    out["fold"] = int(fold)
    out["experiment"] = family
    out["model_variant"] = family
    out["confidence_floor"] = CONFIDENCE_FLOOR
    out["confidence_policy"] = confidence_policy
    out["decision_threshold"] = 0.50
    out["event_label_policy"] = "exact_10m_best_side_net_return_gte_0p5bps"
    out["actionable_label_policy"] = out["event_label_policy"]
    return out


def _inner_ok(pred: pd.DataFrame) -> tuple[bool, dict[str, Any]]:
    summary = _summarize_predictions(
        pred,
        horizon_bars=HORIZON_BARS,
        confidence_threshold=CONFIDENCE_FLOOR,
    )
    density = _density(pred)
    tr = summary["trading"]
    pf = tr["profit_factor"]
    total = max(1, density["trades"])
    long_fraction = density["long_trades"] / total
    short_fraction = density["short_trades"] / total
    ok = bool(
        density["trades"] >= 30
        and long_fraction >= MIN_SIDE_FRACTION
        and short_fraction >= MIN_SIDE_FRACTION
        and tr["non_overlapping_periods"] >= 25
        and pf is not None
        and np.isfinite(pf)
        and pf >= 1.0
        and tr["total_return"] > 0
    )
    return ok, {
        "eligible": ok,
        "density": density,
        "balanced_accuracy": summary["classification"]["balanced_accuracy"],
        "trading": tr,
    }


def _fit_regime_family(train: pd.DataFrame) -> dict[str, Any]:
    fit, inner = _split_internal_early_stopping_tail(train, horizon_bars=HORIZON_BARS)
    limits = _regime_limits(fit)
    base_score = _rule_score(inner)
    regime = _regime_mask(inner, limits)
    candidates: list[dict[str, Any]] = []
    # Orientation is selected only inside outer training.  This lets the same
    # causal structure express either trend-following or mean-reversion without
    # peeking at the untouched validation fold.
    for orientation in (1.0, -1.0):
        score = orientation * base_score
        for threshold in (0.60, 0.70, 0.80, 0.90):
            direction_p = 1.0 / (1.0 + np.exp(-4.0 * score))
            quality = np.abs(score)
            opportunity_p = np.clip(0.50 + 0.50 * quality, 0.0, 1.0)
            active = regime & (quality >= threshold) & (opportunity_p >= CONFIDENCE_FLOOR)
            pred = _prediction_frame(
                inner,
                direction_probability=direction_p,
                opportunity_probability=opportunity_p,
                active=active,
                family=FAMILY_REGIME,
                fold=0,
                confidence_policy="causal_rule_quality_and_regime_filter",
            )
            ok, report = _inner_ok(pred)
            candidates.append({
                "orientation": "trend_follow" if orientation > 0 else "contrarian",
                "orientation_sign": orientation,
                "quality_floor": threshold,
                **report,
            })
    eligible = [row for row in candidates if row["eligible"]]
    pool = eligible or candidates
    chosen = max(
        pool,
        key=lambda row: (
            float(row["trading"]["profit_factor"] or 0.0),
            float(row["trading"]["sharpe_ratio"] or -999.0),
            float(row["balanced_accuracy"]),
            int(row["density"]["trades"]),
        ),
    )
    return {
        "limits": limits,
        "orientation": chosen["orientation"],
        "orientation_sign": float(chosen["orientation_sign"]),
        "quality_floor": float(chosen["quality_floor"]),
        "calibration_passed": bool(eligible),
        "inner_candidates": candidates,
    }


def _predict_regime(valid: pd.DataFrame, state: dict[str, Any], fold: int) -> pd.DataFrame:
    score = state["orientation_sign"] * _rule_score(valid)
    quality = np.abs(score)
    direction_p = 1.0 / (1.0 + np.exp(-4.0 * score))
    opportunity_p = np.clip(0.50 + 0.50 * quality, 0.0, 1.0)
    active = (
        _regime_mask(valid, state["limits"])
        & (quality >= state["quality_floor"])
        & (opportunity_p >= CONFIDENCE_FLOOR)
    )
    return _prediction_frame(
        valid,
        direction_probability=direction_p,
        opportunity_probability=opportunity_p,
        active=active,
        family=FAMILY_REGIME,
        fold=fold,
        confidence_policy=f"causal_{state['orientation']}_rule_quality_and_regime_filter",
    )


def _fit_event_family(train: pd.DataFrame) -> dict[str, Any]:
    labeled = _augment(train)
    actionable, direction, _ = _profit_labels(labeled)
    labeled = labeled.copy()
    labeled["campaign_actionable"] = actionable
    labeled["campaign_direction_long"] = direction
    fit, inner_full = _split_internal_early_stopping_tail(labeled, horizon_bars=HORIZON_BARS)
    early, calibration = _split_early_calibration(inner_full)

    fit_model = fit.iloc[::2].copy()
    opportunity = _classifier(7301)
    opportunity.fit(
        fit_model[FEATURES],
        fit_model["campaign_actionable"].astype(int),
        sample_weight=_binary_weights(fit_model["campaign_actionable"]),
        eval_set=[(early[FEATURES], early["campaign_actionable"].astype(int))],
        sample_weight_eval_set=[_binary_weights(early["campaign_actionable"])],
        verbose=False,
    )

    fit_dir = fit_model.loc[fit_model["campaign_actionable"] == 1].copy()
    early_dir = early.loc[early["campaign_actionable"] == 1].copy()
    if len(fit_dir) < 200 or len(early_dir) < 50:
        raise ValueError("insufficient actionable rows for event direction model")
    direction_model = _classifier(7302)
    direction_model.fit(
        fit_dir[FEATURES],
        fit_dir["campaign_direction_long"].astype(int),
        sample_weight=_binary_weights(fit_dir["campaign_direction_long"]),
        eval_set=[(early_dir[FEATURES], early_dir["campaign_direction_long"].astype(int))],
        sample_weight_eval_set=[_binary_weights(early_dir["campaign_direction_long"])],
        verbose=False,
    )

    raw_opp_cal = opportunity.predict_proba(calibration[FEATURES])[:, 1]
    opp_calibrator = _fit_platt(raw_opp_cal, calibration["campaign_actionable"])
    calibration_dir = calibration.loc[calibration["campaign_actionable"] == 1].copy()
    if len(calibration_dir) < 50:
        raise ValueError("insufficient actionable calibration rows for event direction")
    raw_dir_cal = direction_model.predict_proba(calibration_dir[FEATURES])[:, 1]
    dir_calibrator = _fit_platt(raw_dir_cal, calibration_dir["campaign_direction_long"])

    p_opp = _apply_platt(opp_calibrator, raw_opp_cal)
    p_dir = _apply_platt(dir_calibrator, direction_model.predict_proba(calibration[FEATURES])[:, 1])
    dir_conf = np.maximum(p_dir, 1.0 - p_dir)
    active = (p_opp >= CONFIDENCE_FLOOR) & (dir_conf >= CONFIDENCE_FLOOR)
    pred = _prediction_frame(
        calibration,
        direction_probability=p_dir,
        opportunity_probability=p_opp,
        active=active,
        family=FAMILY_EVENT,
        fold=0,
        confidence_policy="platt_calibrated_opportunity_and_direction_confidence_gte_0p60",
    )
    ok, inner_report = _inner_ok(pred)
    return {
        "opportunity": opportunity,
        "direction": direction_model,
        "opportunity_calibrator": opp_calibrator,
        "direction_calibrator": dir_calibrator,
        "calibration_passed": ok,
        "inner": inner_report,
        "fit_rows": int(len(fit_model)),
        "direction_fit_rows": int(len(fit_dir)),
        "calibration_rows": int(len(calibration)),
    }


def _predict_event(valid: pd.DataFrame, state: dict[str, Any], fold: int) -> pd.DataFrame:
    labeled = _augment(valid)
    raw_opp = state["opportunity"].predict_proba(labeled[FEATURES])[:, 1]
    raw_dir = state["direction"].predict_proba(labeled[FEATURES])[:, 1]
    p_opp = _apply_platt(state["opportunity_calibrator"], raw_opp)
    p_dir = _apply_platt(state["direction_calibrator"], raw_dir)
    dir_conf = np.maximum(p_dir, 1.0 - p_dir)
    active = (p_opp >= CONFIDENCE_FLOOR) & (dir_conf >= CONFIDENCE_FLOOR)
    return _prediction_frame(
        labeled,
        direction_probability=p_dir,
        opportunity_probability=p_opp,
        active=active,
        family=FAMILY_EVENT,
        fold=fold,
        confidence_policy="platt_calibrated_opportunity_and_direction_confidence_gte_0p60",
    )


def _hybrid_setup(frame: pd.DataFrame, limits: dict[str, float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    score = _rule_score(frame)
    quality = np.abs(score)
    regime = _regime_mask(frame, limits)
    candidate = regime & (quality >= 0.45)
    predicted_long = score >= 0.0
    return score, predicted_long, candidate


def _hybrid_features(frame: pd.DataFrame) -> pd.DataFrame:
    out = _augment(frame).copy()
    score = _rule_score(out)
    out["campaign_rule_score"] = score
    out["campaign_rule_quality"] = np.abs(score)
    return out


def _fit_hybrid_family(train: pd.DataFrame) -> dict[str, Any]:
    expanded = _hybrid_features(train)
    fit, inner_full = _split_internal_early_stopping_tail(expanded, horizon_bars=HORIZON_BARS)
    early, calibration = _split_early_calibration(inner_full)
    limits = _regime_limits(fit)
    extra = ["campaign_rule_score", "campaign_rule_quality"]
    model_features = FEATURES + extra

    _, fit_long, fit_candidate = _hybrid_setup(fit, limits)
    long_ret = pd.to_numeric(fit[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    short_ret = pd.to_numeric(fit[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    selected_ret = np.where(fit_long, long_ret, short_ret)
    fit = fit.copy()
    fit["campaign_setup_profitable"] = (selected_ret >= MIN_NET_RETURN).astype(int)
    fit_rows = fit.loc[fit_candidate].iloc[::2].copy()
    if len(fit_rows) < 300 or fit_rows["campaign_setup_profitable"].nunique() < 2:
        raise ValueError("insufficient deterministic setup rows for hybrid filter")

    _, early_long, early_candidate = _hybrid_setup(early, limits)
    early_long_ret = pd.to_numeric(early[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    early_short_ret = pd.to_numeric(early[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    early_selected_ret = np.where(early_long, early_long_ret, early_short_ret)
    early = early.copy()
    early["campaign_setup_profitable"] = (early_selected_ret >= MIN_NET_RETURN).astype(int)
    early_rows = early.loc[early_candidate].copy()
    if len(early_rows) < 100 or early_rows["campaign_setup_profitable"].nunique() < 2:
        raise ValueError("insufficient early deterministic setup rows for hybrid filter")

    model = _classifier(7401)
    model.fit(
        fit_rows[model_features],
        fit_rows["campaign_setup_profitable"].astype(int),
        sample_weight=_binary_weights(fit_rows["campaign_setup_profitable"]),
        eval_set=[(early_rows[model_features], early_rows["campaign_setup_profitable"].astype(int))],
        sample_weight_eval_set=[_binary_weights(early_rows["campaign_setup_profitable"])],
        verbose=False,
    )

    _, calibration_long, calibration_candidate = _hybrid_setup(calibration, limits)
    calibration_long_ret = pd.to_numeric(calibration[LONG_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    calibration_short_ret = pd.to_numeric(calibration[SHORT_NET_RETURN_COLUMN], errors="raise").to_numpy(float)
    calibration_selected_ret = np.where(calibration_long, calibration_long_ret, calibration_short_ret)
    calibration = calibration.copy()
    calibration["campaign_setup_profitable"] = (calibration_selected_ret >= MIN_NET_RETURN).astype(int)
    calibration_rows = calibration.loc[calibration_candidate].copy()
    if len(calibration_rows) < 50 or calibration_rows["campaign_setup_profitable"].nunique() < 2:
        raise ValueError("insufficient calibration setup rows for hybrid filter")
    raw_cal = model.predict_proba(calibration_rows[model_features])[:, 1]
    calibrator = _fit_platt(raw_cal, calibration_rows["campaign_setup_profitable"])

    p_profit = np.zeros(len(calibration), dtype=float)
    p_profit[calibration_candidate] = _apply_platt(calibrator, model.predict_proba(calibration.loc[calibration_candidate, model_features])[:, 1])
    direction_p = np.where(calibration_long, 0.65, 0.35)
    active = calibration_candidate & (p_profit >= CONFIDENCE_FLOOR)
    pred = _prediction_frame(
        calibration,
        direction_probability=direction_p,
        opportunity_probability=p_profit,
        active=active,
        family=FAMILY_HYBRID,
        fold=0,
        confidence_policy="deterministic_setup_then_platt_profitability_probability_gte_0p60",
    )
    ok, inner_report = _inner_ok(pred)
    return {
        "model": model,
        "calibrator": calibrator,
        "limits": limits,
        "features": model_features,
        "calibration_passed": ok,
        "inner": inner_report,
        "fit_setup_rows": int(len(fit_rows)),
        "calibration_setup_rows": int(len(calibration_rows)),
    }


def _predict_hybrid(valid: pd.DataFrame, state: dict[str, Any], fold: int) -> pd.DataFrame:
    expanded = _hybrid_features(valid)
    _, predicted_long, candidate = _hybrid_setup(expanded, state["limits"])
    p_profit = np.zeros(len(expanded), dtype=float)
    if candidate.any():
        raw = state["model"].predict_proba(expanded.loc[candidate, state["features"]])[:, 1]
        p_profit[candidate] = _apply_platt(state["calibrator"], raw)
    direction_p = np.where(predicted_long, 0.65, 0.35)
    active = candidate & (p_profit >= CONFIDENCE_FLOOR)
    return _prediction_frame(
        expanded,
        direction_probability=direction_p,
        opportunity_probability=p_profit,
        active=active,
        family=FAMILY_HYBRID,
        fold=fold,
        confidence_policy="deterministic_setup_then_platt_profitability_probability_gte_0p60",
    )


def _gate(folds: list[dict[str, Any]], combined: pd.DataFrame) -> dict[str, Any]:
    overall = _summarize_predictions(
        combined,
        horizon_bars=HORIZON_BARS,
        confidence_threshold=CONFIDENCE_FLOOR,
    )
    density = _density(combined)
    trading = overall["trading"]
    active = combined.loc[combined["active_trade"].astype(bool)]
    min_active_confidence = float(active["confidence"].min()) if not active.empty else 0.0
    positive_fold_fraction = float(
        sum(float(row["trading"]["total_return"]) > 0.0 for row in folds) / max(1, len(folds))
    )
    positive_instrument_fraction = 1.0 if float(trading["total_return"]) > 0.0 else 0.0
    pf = trading["profit_factor"]
    sharpe = trading["sharpe_ratio"]
    median_gap = density["median_calendar_minutes_between_entries"]
    observed = {
        "balanced_accuracy": float(overall["classification"]["balanced_accuracy"]),
        "sharpe_ratio": None if sharpe is None else float(sharpe),
        "profit_factor": None if pf is None else float(pf),
        "max_drawdown": float(trading["max_drawdown"]),
        "positive_fold_fraction": positive_fold_fraction,
        "positive_instrument_fraction": positive_instrument_fraction,
        "min_active_confidence": min_active_confidence,
        "non_overlapping_periods": int(trading["non_overlapping_periods"]),
        "raw_active_signals": int(trading["raw_active_signals"]),
        "trade_density": float(density["trade_density"]),
        "median_calendar_minutes_between_entries": median_gap,
        "long_trades": int(density["long_trades"]),
        "short_trades": int(density["short_trades"]),
    }
    checks = {
        "balanced_accuracy": observed["balanced_accuracy"] >= RESEARCH_GATE["min_balanced_accuracy"],
        "sharpe_ratio": sharpe is not None and np.isfinite(sharpe) and sharpe >= RESEARCH_GATE["min_sharpe_ratio"],
        "profit_factor": pf is not None and np.isfinite(pf) and pf >= RESEARCH_GATE["min_profit_factor"],
        "max_drawdown": observed["max_drawdown"] <= RESEARCH_GATE["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction >= RESEARCH_GATE["min_positive_fold_fraction"],
        "positive_instrument_fraction": positive_instrument_fraction >= RESEARCH_GATE["min_positive_instrument_fraction"],
        "confidence": min_active_confidence >= RESEARCH_GATE["min_confidence"],
        "trade_evidence": observed["non_overlapping_periods"] >= RESEARCH_GATE["min_non_overlapping_periods"],
        "frequency": median_gap is not None and median_gap <= RESEARCH_GATE["max_median_calendar_minutes_between_entries"],
        "two_sided": observed["long_trades"] > 0 and observed["short_trades"] > 0,
    }
    return {
        "passed": bool(all(checks.values())),
        "thresholds": RESEARCH_GATE,
        "observed": observed,
        "checks": checks,
        "overall": overall,
        "density": density,
    }


def _fold_row(fold: int, state: dict[str, Any], pred: pd.DataFrame) -> dict[str, Any]:
    summary = _summarize_predictions(
        pred,
        horizon_bars=HORIZON_BARS,
        confidence_threshold=CONFIDENCE_FLOOR,
    )
    return {
        "fold": fold,
        "calibration_passed": bool(state.get("calibration_passed", False)),
        "validation_rows": int(len(pred)),
        "density": _density(pred),
        "classification": summary["classification"],
        "trading": summary["trading"],
        "evidence_sufficiency_warnings": summary.get("evidence_sufficiency_warnings", []),
    }


def run_campaign(dataset: Path, cutoff: str, output: Path, max_splits: int = 3) -> dict[str, Any]:
    pooled, manifest = load_and_prepare_corpora(
        {"USDJPY": dataset},
        horizon_bars=HORIZON_BARS,
        decision_time_before=cutoff,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=0.0,
    )
    periods = int(pooled["decision_time"].nunique())
    splits = list(
        iter_purged_walk_forward_time_splits(
            pooled,
            time_column="decision_time",
            min_train_periods=max(10_000, int(periods * 0.55)),
            validation_periods=max(3_000, int(periods * 0.10)),
            purge_periods=HORIZON_BARS,
            embargo_periods=HORIZON_BARS,
            max_splits=max_splits,
        )
    )
    if len(splits) < max_splits:
        raise ValueError(f"requested {max_splits} folds but only {len(splits)} are available")

    family_rows: dict[str, list[dict[str, Any]]] = {name: [] for name in FAMILIES}
    family_predictions: dict[str, list[pd.DataFrame]] = {name: [] for name in FAMILIES}
    family_errors: dict[str, list[str]] = {name: [] for name in FAMILIES}

    for fold, (train, valid) in enumerate(splits, 1):
        print(json.dumps({"stage": "fold_start", "fold": fold, "train_rows": len(train), "validation_rows": len(valid)}), flush=True)
        runners = (
            (FAMILY_REGIME, _fit_regime_family, _predict_regime),
            (FAMILY_EVENT, _fit_event_family, _predict_event),
            (FAMILY_HYBRID, _fit_hybrid_family, _predict_hybrid),
        )
        for family, fit_fn, predict_fn in runners:
            try:
                state = fit_fn(train)
                pred = predict_fn(valid, state, fold)
                family_predictions[family].append(pred)
                row = _fold_row(fold, state, pred)
                family_rows[family].append(row)
                print(json.dumps({"stage": "family_fold", "family": family, **row}, default=str), flush=True)
                del state, pred
            except Exception as exc:  # terminal campaign must record failure, not silently continue versions
                family_errors[family].append(f"fold {fold}: {type(exc).__name__}: {exc}")
                print(json.dumps({"stage": "family_error", "family": family, "fold": fold, "error": str(exc)}), flush=True)
            gc.collect()

    families: dict[str, Any] = {}
    eligible: list[str] = []
    for family in FAMILIES:
        rows = family_rows[family]
        preds = family_predictions[family]
        if len(rows) != len(splits) or len(preds) != len(splits):
            families[family] = {
                "passed": False,
                "status": "INCOMPLETE",
                "errors": family_errors[family],
                "folds": rows,
            }
            continue
        combined = pd.concat(preds, ignore_index=True)
        gate = _gate(rows, combined)
        families[family] = {
            "passed": bool(gate["passed"]),
            "status": "PASS" if gate["passed"] else "FAIL",
            "errors": family_errors[family],
            "folds": rows,
            "research_gate": {k: v for k, v in gate.items() if k not in {"overall", "density"}},
            "overall": gate["overall"],
            "density": gate["density"],
        }
        if gate["passed"]:
            eligible.append(family)

    future_holdout_allowed = bool(eligible)
    report = {
        "campaign": "bounded_final_three_family_campaign_v1",
        "terminal_policy": "three_families_only_no_incremental_version_treadmill",
        "dataset": str(dataset),
        "dataset_manifest": manifest,
        "cutoff_exclusive": cutoff,
        "horizon_bars": HORIZON_BARS,
        "max_splits": max_splits,
        "families": families,
        "eligible_families": eligible,
        "future_holdout_allowed": future_holdout_allowed,
        "future_holdout_target_new_m1_candles": 3000 if future_holdout_allowed else 0,
        "next_action": (
            "FREEZE_ELIGIBLE_FAMILY_AND_RUN_ONE_FINAL_3000_M1_FUTURE_HOLDOUT"
            if future_holdout_allowed
            else "STOP_CURRENT_PROPRIETARY_EDGE_CAMPAIGN_NO_MORE_VERSIONING"
        ),
        "approved_for_paper": False,
        "approved_for_live": False,
        "sealed_future_holdout_touched": False,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(output.suffix + ".tmp")
    tmp.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
    tmp.replace(output)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Run bounded three-family USDJPY final research campaign")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--cutoff", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-splits", type=int, default=3)
    args = parser.parse_args()
    report = run_campaign(args.dataset, args.cutoff, args.output, args.max_splits)
    print(json.dumps({
        "campaign": report["campaign"],
        "eligible_families": report["eligible_families"],
        "future_holdout_allowed": report["future_holdout_allowed"],
        "next_action": report["next_action"],
        "report": str(args.output),
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
