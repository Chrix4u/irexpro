"""Six-pair cross-horizon opportunity selector research campaign.

This is the post-USDJPY pivot architecture.  It does not train another
single-pair predictor.  It stacks already out-of-sample pair-expert predictions
from 1m/5m/10m horizons, learns side-specific profitability across the six
major-pair universe, calibrates probabilities chronologically, and chooses at
most one strongest pair per decision minute.

Chronology is fixed:
- base predictions are already outer-fold out-of-sample,
- selector fit: base folds 1-2,
- probability calibration: base fold 3,
- untouched selector validation: base folds 4-5.

The 0.60 confidence floor and existing economic promotion gates are not
lowered. No fresh future holdout is allowed unless the untouched selector
validation clears every gate.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from app.domain.training.model_qualification import _summarize_predictions

INSTRUMENTS = ("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF")
HORIZONS = (1, 5, 10)
TRADE_HORIZON = 5
CONFIDENCE_FLOOR = 0.60
MIN_NET_RETURN = 0.50 / 10_000.0

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

BASE_EXPERIMENT = "event_barrier_pair_experts"
CAMPAIGN = "six_pair_cross_horizon_opportunity_selector_v1"


def _load_horizon(report_root: Path, horizon: int) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    checkpoint_root = report_root / f"model_qualification_{horizon}m.checkpoints"
    for fold in range(1, 6):
        path = checkpoint_root / f"fold-{fold:02d}-{BASE_EXPERIMENT}.csv"
        if not path.is_file():
            raise FileNotFoundError(path)
        frame = pd.read_csv(path)
        frame["decision_time"] = pd.to_datetime(frame["decision_time"], utc=True)
        keep = [
            "fold", "decision_time", "instrument", "opportunity_probability",
            "positive_probability", "direction_confidence", "predicted_long",
        ]
        if horizon == TRADE_HORIZON:
            keep += [
                "target", "actionable_target", "long_net_return", "short_net_return",
                "event_direction_target", "event_actionable_target",
                "event_long_net_return", "event_short_net_return", "event_step",
                "event_barrier_return", "m1_spread_bps", "m1_volatility_20",
                "h1_rsi_14", "trend_alignment_score", "momentum_alignment_score",
            ]
        frame = frame[keep].copy()
        rename = {
            "opportunity_probability": f"h{horizon}_opportunity_probability",
            "positive_probability": f"h{horizon}_direction_probability",
            "direction_confidence": f"h{horizon}_direction_confidence",
            "predicted_long": f"h{horizon}_predicted_long",
        }
        frame.rename(columns=rename, inplace=True)
        frames.append(frame)
    return pd.concat(frames, ignore_index=True)


def _stack_frame(report_root: Path) -> pd.DataFrame:
    merged = _load_horizon(report_root, TRADE_HORIZON)
    keys = ["fold", "decision_time", "instrument"]
    for horizon in (1, 10):
        merged = merged.merge(_load_horizon(report_root, horizon), on=keys, how="inner", validate="one_to_one")
    merged = merged.sort_values(keys).reset_index(drop=True)
    merged["selector_long_profitable"] = (
        pd.to_numeric(merged["long_net_return"], errors="raise") >= MIN_NET_RETURN
    ).astype(int)
    merged["selector_short_profitable"] = (
        pd.to_numeric(merged["short_net_return"], errors="raise") >= MIN_NET_RETURN
    ).astype(int)
    return merged


def _feature_frame(frame: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=frame.index)
    for horizon in HORIZONS:
        for suffix in (
            "opportunity_probability", "direction_probability", "direction_confidence",
        ):
            col = f"h{horizon}_{suffix}"
            out[col] = pd.to_numeric(frame[col], errors="raise").astype(float)
        out[f"h{horizon}_predicted_long"] = frame[f"h{horizon}_predicted_long"].astype(bool).astype(float)
    # Cross-horizon agreement/dispersion are observable at decision time.
    dirs = np.column_stack([
        out[f"h{h}_predicted_long"].to_numpy(float) for h in HORIZONS
    ])
    opps = np.column_stack([
        out[f"h{h}_opportunity_probability"].to_numpy(float) for h in HORIZONS
    ])
    dps = np.column_stack([
        out[f"h{h}_direction_probability"].to_numpy(float) for h in HORIZONS
    ])
    out["direction_vote_fraction_long"] = dirs.mean(axis=1)
    out["direction_vote_strength"] = np.abs(out["direction_vote_fraction_long"] - 0.5) * 2.0
    out["opportunity_mean"] = opps.mean(axis=1)
    out["opportunity_max"] = opps.max(axis=1)
    out["opportunity_min"] = opps.min(axis=1)
    out["opportunity_std"] = opps.std(axis=1)
    out["direction_probability_mean"] = dps.mean(axis=1)
    out["direction_probability_std"] = dps.std(axis=1)
    for col in (
        "m1_spread_bps", "m1_volatility_20", "h1_rsi_14",
        "trend_alignment_score", "momentum_alignment_score",
    ):
        out[col] = pd.to_numeric(frame[col], errors="raise").astype(float)
    for instrument in INSTRUMENTS:
        out[f"instrument_{instrument}"] = (frame["instrument"] == instrument).astype(float)
    return out


def _model(seed: int) -> Pipeline:
    return Pipeline([
        ("scale", StandardScaler()),
        ("clf", LogisticRegression(
            C=0.5, max_iter=700, solver="lbfgs", class_weight="balanced",
            random_state=seed,
        )),
    ])


def _fit_platt(raw_probability: np.ndarray, labels: np.ndarray, seed: int) -> LogisticRegression:
    p = np.asarray(raw_probability, dtype=float).reshape(-1, 1)
    y = np.asarray(labels, dtype=int)
    if len(np.unique(y)) < 2:
        raise ValueError("calibration target has one class")
    model = LogisticRegression(C=1.0, max_iter=500, solver="lbfgs", random_state=seed)
    model.fit(p, y)
    return model


def _calibrate(model: LogisticRegression, raw_probability: np.ndarray) -> np.ndarray:
    return model.predict_proba(np.asarray(raw_probability, dtype=float).reshape(-1, 1))[:, 1]


def _fit_selector(stacked: pd.DataFrame) -> dict[str, Any]:
    fit = stacked.loc[stacked["fold"].isin([1, 2])].copy()
    calibration = stacked.loc[stacked["fold"] == 3].copy()
    if fit.empty or calibration.empty:
        raise ValueError("selector requires folds 1-2 for fit and fold 3 for calibration")
    x_fit = _feature_frame(fit)
    x_cal = _feature_frame(calibration)
    state: dict[str, Any] = {"features": list(x_fit.columns)}
    for side, target, seed in (
        ("long", "selector_long_profitable", 8101),
        ("short", "selector_short_profitable", 8102),
    ):
        model = _model(seed)
        model.fit(x_fit, fit[target].astype(int))
        raw_cal = model.predict_proba(x_cal)[:, 1]
        calibrator = _fit_platt(raw_cal, calibration[target].to_numpy(int), seed + 100)
        state[f"{side}_model"] = model
        state[f"{side}_calibrator"] = calibrator
        state[f"{side}_fit_positive_rate"] = float(fit[target].mean())
        state[f"{side}_calibration_positive_rate"] = float(calibration[target].mean())
    state["fit_rows"] = int(len(fit))
    state["calibration_rows"] = int(len(calibration))
    return state


def _score(stacked: pd.DataFrame, state: dict[str, Any]) -> pd.DataFrame:
    x = _feature_frame(stacked)
    raw_long = state["long_model"].predict_proba(x)[:, 1]
    raw_short = state["short_model"].predict_proba(x)[:, 1]
    p_long = _calibrate(state["long_calibrator"], raw_long)
    p_short = _calibrate(state["short_calibrator"], raw_short)
    out = stacked.copy()
    out["selector_long_probability"] = p_long
    out["selector_short_probability"] = p_short
    out["predicted_long"] = p_long >= p_short
    denom = np.maximum(p_long + p_short, 1e-12)
    out["positive_probability"] = np.clip(p_long / denom, 1e-7, 1 - 1e-7)
    out["raw_positive_probability"] = out["positive_probability"]
    out["direction_confidence"] = np.maximum(
        out["positive_probability"].to_numpy(float),
        1.0 - out["positive_probability"].to_numpy(float),
    )
    out["opportunity_probability"] = np.maximum(p_long, p_short)
    out["confidence"] = np.minimum(out["opportunity_probability"], out["direction_confidence"])
    long_ret = pd.to_numeric(out["long_net_return"], errors="raise").to_numpy(float)
    short_ret = pd.to_numeric(out["short_net_return"], errors="raise").to_numpy(float)
    out["selected_net_return"] = np.where(out["predicted_long"].to_numpy(bool), long_ret, short_ret)
    out["predicted_opportunity"] = out["opportunity_probability"] >= CONFIDENCE_FLOOR
    out["eligible_signal"] = (
        (out["opportunity_probability"] >= CONFIDENCE_FLOOR)
        & (out["direction_confidence"] >= CONFIDENCE_FLOOR)
    )
    return out


def _select_top_one(scored: pd.DataFrame) -> pd.DataFrame:
    eligible = scored.loc[scored["eligible_signal"]].copy()
    if eligible.empty:
        return eligible
    eligible["selector_rank_score"] = (
        eligible["opportunity_probability"].astype(float)
        * eligible["direction_confidence"].astype(float)
    )
    chosen = (
        eligible.sort_values(
            ["fold", "decision_time", "selector_rank_score", "opportunity_probability"],
            ascending=[True, True, False, False],
        )
        .groupby(["fold", "decision_time"], as_index=False)
        .head(1)
        .copy()
    )
    chosen["active_trade"] = True
    chosen["experiment"] = CAMPAIGN
    chosen["model_variant"] = CAMPAIGN
    chosen["calibration_method"] = "chronological_platt_fold3"
    chosen["decision_threshold"] = 0.50
    chosen["confidence_floor"] = CONFIDENCE_FLOOR
    chosen["confidence_policy"] = "side_profitability_and_direction_confidence_gte_0p60_top1_universe"
    chosen["actionable_label_policy"] = "exact_5m_side_net_return_gte_0p5bps"
    # Do not set event_label_policy: classification below is explicitly scored
    # on the selected trades rather than event-only base labels.
    if "event_label_policy" in chosen.columns:
        chosen.drop(columns=["event_label_policy"], inplace=True)
    return chosen


def _manual_direction_ba(chosen: pd.DataFrame) -> float:
    if chosen.empty:
        return 0.0
    y_true = (pd.to_numeric(chosen["long_net_return"], errors="raise") > pd.to_numeric(chosen["short_net_return"], errors="raise")).astype(int)
    y_pred = chosen["predicted_long"].astype(bool).astype(int)
    if y_true.nunique() < 2:
        return 0.0
    return float(balanced_accuracy_score(y_true, y_pred))


def _instrument_metrics(chosen: pd.DataFrame) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for instrument in INSTRUMENTS:
        g = chosen.loc[chosen["instrument"] == instrument]
        result[instrument] = {
            "signals": int(len(g)),
            "total_selected_net_return": float(g["selected_net_return"].sum()) if len(g) else 0.0,
            "positive": bool(len(g) and float(g["selected_net_return"].sum()) > 0.0),
        }
    return result


def _fold_metrics(chosen: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for fold in (4, 5):
        g = chosen.loc[chosen["fold"] == fold].copy()
        if g.empty:
            rows.append({"fold": fold, "signals": 0, "total_return": 0.0, "profit_factor": None, "sharpe_ratio": None, "balanced_accuracy": 0.0})
            continue
        summary = _summarize_predictions(g, horizon_bars=TRADE_HORIZON, confidence_threshold=CONFIDENCE_FLOOR)
        rows.append({
            "fold": fold,
            "signals": int(len(g)),
            "total_return": float(summary["trading"]["total_return"]),
            "profit_factor": summary["trading"]["profit_factor"],
            "sharpe_ratio": summary["trading"]["sharpe_ratio"],
            "balanced_accuracy": _manual_direction_ba(g),
        })
    return rows


def _gate(chosen: pd.DataFrame) -> dict[str, Any]:
    if chosen.empty:
        observed = {
            "balanced_accuracy": 0.0, "sharpe_ratio": None, "profit_factor": None,
            "max_drawdown": 0.0, "positive_fold_fraction": 0.0,
            "positive_instrument_fraction": 0.0, "min_active_confidence": 0.0,
            "non_overlapping_periods": 0, "median_calendar_minutes_between_entries": None,
            "signals": 0,
        }
        return {"passed": False, "observed": observed, "checks": {k: False for k in (
            "balanced_accuracy", "sharpe_ratio", "profit_factor", "max_drawdown",
            "positive_fold_fraction", "positive_instrument_fraction", "confidence",
            "trade_evidence", "frequency",
        )}}

    summary = _summarize_predictions(chosen, horizon_bars=TRADE_HORIZON, confidence_threshold=CONFIDENCE_FLOOR)
    trading = summary["trading"]
    ba = _manual_direction_ba(chosen)
    folds = _fold_metrics(chosen)
    positive_fold_fraction = sum(row["total_return"] > 0.0 for row in folds) / len(folds)
    by_instrument = _instrument_metrics(chosen)
    positive_instrument_fraction = sum(v["positive"] for v in by_instrument.values()) / len(INSTRUMENTS)
    times = pd.to_datetime(chosen["decision_time"], utc=True).sort_values()
    gaps = times.diff().dropna().dt.total_seconds() / 60.0
    median_gap = float(gaps.median()) if len(gaps) else None
    pf = trading["profit_factor"]
    sharpe = trading["sharpe_ratio"]
    observed = {
        "balanced_accuracy": ba,
        "sharpe_ratio": sharpe,
        "profit_factor": pf,
        "max_drawdown": float(trading["max_drawdown"]),
        "positive_fold_fraction": float(positive_fold_fraction),
        "positive_instrument_fraction": float(positive_instrument_fraction),
        "min_active_confidence": float(chosen["confidence"].min()),
        "non_overlapping_periods": int(trading["non_overlapping_periods"]),
        "median_calendar_minutes_between_entries": median_gap,
        "signals": int(len(chosen)),
        "total_return": float(trading["total_return"]),
    }
    checks = {
        "balanced_accuracy": ba >= RESEARCH_GATE["min_balanced_accuracy"],
        "sharpe_ratio": sharpe is not None and np.isfinite(sharpe) and sharpe >= RESEARCH_GATE["min_sharpe_ratio"],
        "profit_factor": pf is not None and np.isfinite(pf) and pf >= RESEARCH_GATE["min_profit_factor"],
        "max_drawdown": observed["max_drawdown"] <= RESEARCH_GATE["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction >= RESEARCH_GATE["min_positive_fold_fraction"],
        "positive_instrument_fraction": positive_instrument_fraction >= RESEARCH_GATE["min_positive_instrument_fraction"],
        "confidence": observed["min_active_confidence"] >= RESEARCH_GATE["min_confidence"],
        "trade_evidence": observed["non_overlapping_periods"] >= RESEARCH_GATE["min_non_overlapping_periods"],
        "frequency": median_gap is not None and median_gap <= RESEARCH_GATE["max_median_calendar_minutes_between_entries"],
    }
    return {
        "passed": bool(all(checks.values())),
        "thresholds": RESEARCH_GATE,
        "observed": observed,
        "checks": checks,
        "folds": folds,
        "by_instrument": by_instrument,
        "trading": trading,
    }


def run(report_root: Path, output: Path) -> dict[str, Any]:
    stacked = _stack_frame(report_root)
    state = _fit_selector(stacked)
    untouched = stacked.loc[stacked["fold"].isin([4, 5])].copy()
    scored = _score(untouched, state)
    chosen = _select_top_one(scored)
    gate = _gate(chosen)
    report = {
        "campaign": CAMPAIGN,
        "base_experiment": BASE_EXPERIMENT,
        "base_horizons": list(HORIZONS),
        "trade_horizon": TRADE_HORIZON,
        "selector_fit_folds": [1, 2],
        "selector_calibration_fold": 3,
        "selector_untouched_validation_folds": [4, 5],
        "confidence_floor": CONFIDENCE_FLOOR,
        "stacked_rows": int(len(stacked)),
        "untouched_validation_rows": int(len(untouched)),
        "selector_state": {k: v for k, v in state.items() if not k.endswith("_model") and not k.endswith("_calibrator")},
        "research_gate": gate,
        "future_holdout_allowed": bool(gate["passed"]),
        "next_action": (
            "FREEZE_SELECTOR_AND_PREPARE_FINAL_FUTURE_HOLDOUT"
            if gate["passed"] else
            "DO_NOT_START_FUTURE_HOLDOUT_REVIEW_EXTERNAL_SIGNAL_OR_STRATEGY_INTEGRATION"
        ),
        "approved_for_paper": False,
        "approved_for_live": False,
        "fresh_future_holdout_touched": False,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
    if not chosen.empty:
        chosen.to_csv(output.with_suffix('.selected.csv'), index=False)
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report-root", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    a = ap.parse_args()
    report = run(a.report_root, a.output)
    print(json.dumps({
        "campaign": report["campaign"],
        "future_holdout_allowed": report["future_holdout_allowed"],
        "next_action": report["next_action"],
        "observed": report["research_gate"]["observed"],
        "checks": report["research_gate"]["checks"],
        "output": str(a.output),
    }, indent=2, default=str), flush=True)


if __name__ == "__main__":
    main()
