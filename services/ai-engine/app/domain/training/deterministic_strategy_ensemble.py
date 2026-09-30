"""Deterministic six-pair strategy ensemble with calibrated confidence.

The strategy direction itself is rule-based; no ML model predicts price
direction.  Historical out-of-sample folds 1-3 are used only to:
1. establish causal per-instrument spread/volatility operating limits,
2. screen rule families for basic economic evidence, and
3. calibrate raw rule strength into empirical probability of a positive
   selected-side 5-minute net return.

Folds 4-5 remain untouched ensemble validation. At most one candidate is
selected per decision minute across all six pairs and all retained strategies.
The 0.60 confidence floor and production economic gates are unchanged.
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

from app.domain.training.model_qualification import _summarize_predictions

INSTRUMENTS = ("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF")
STRATEGIES = ("trend_continuation", "momentum_consensus", "breakout", "mean_reversion")
HORIZON = 5
CONFIDENCE_FLOOR = 0.60
MIN_NET_RETURN = 0.50 / 10_000.0
CAMPAIGN = "deterministic_six_pair_strategy_ensemble_v1"

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

FEATURE_COLUMNS = [
    "decision_time",
    "m1_spread_bps", "m1_volatility_20", "m1_price_vs_ma20", "m1_rsi_14",
    "m1_momentum_3", "m1_momentum_5", "m1_momentum_10",
    "m1_breakout_strength_20", "m1_range_expansion_20",
    "m5_price_vs_ma20", "m5_rsi_14", "m5_momentum_3", "m5_momentum_5",
    "m5_momentum_10", "m5_breakout_strength_20", "m5_range_expansion_20",
    "m15_price_vs_ma20", "m15_rsi_14", "m15_momentum_5", "m15_momentum_10",
    "m15_breakout_strength_20", "m15_range_expansion_20",
    "h1_price_vs_ma20", "h1_rsi_14", "h1_momentum_10",
    "h4_price_vs_ma20", "h4_rsi_14", "h4_momentum_10",
]


def _load_validation_labels(report_root: Path) -> pd.DataFrame:
    path = report_root / "six_pair_walkforward_5m_predictions.csv"
    frame = pd.read_csv(path)
    frame["decision_time"] = pd.to_datetime(frame["decision_time"], utc=True)
    return frame[[
        "fold", "decision_time", "instrument", "target", "long_net_return",
        "short_net_return", "trend_alignment_score", "momentum_alignment_score",
    ]].copy()


def _load_features(corpus_root: Path, labels: pd.DataFrame) -> pd.DataFrame:
    pieces: list[pd.DataFrame] = []
    for instrument in INSTRUMENTS:
        path = corpus_root / f"{instrument}_MTF.csv"
        raw = pd.read_csv(path, usecols=FEATURE_COLUMNS)
        raw["decision_time"] = pd.to_datetime(raw["decision_time"], utc=True)
        raw["instrument"] = instrument
        wanted = labels.loc[labels["instrument"] == instrument, "decision_time"].drop_duplicates()
        raw = raw.loc[raw["decision_time"].isin(wanted)].copy()
        pieces.append(raw)
    features = pd.concat(pieces, ignore_index=True)
    joined = labels.merge(features, on=["decision_time", "instrument"], how="inner", validate="one_to_one")
    if len(joined) != len(labels):
        raise ValueError(f"feature join lost rows labels={len(labels)} joined={len(joined)}")
    return joined.sort_values(["fold", "decision_time", "instrument"]).reset_index(drop=True)


def _safe_sign(values: pd.Series | np.ndarray, eps: float = 1e-12) -> np.ndarray:
    a = np.asarray(values, dtype=float)
    return np.where(a > eps, 1.0, np.where(a < -eps, -1.0, 0.0))


def _operating_limits(frame: pd.DataFrame) -> dict[str, dict[str, float]]:
    dev = frame.loc[frame["fold"].isin([1, 2, 3])]
    limits: dict[str, dict[str, float]] = {}
    for instrument in INSTRUMENTS:
        g = dev.loc[dev["instrument"] == instrument]
        limits[instrument] = {
            "spread_cap": float(g["m1_spread_bps"].quantile(0.80)),
            "vol_floor": float(g["m1_volatility_20"].quantile(0.05)),
            "vol_cap": float(g["m1_volatility_20"].quantile(0.95)),
            "price_dev_scale": float(max(g["m1_price_vs_ma20"].abs().quantile(0.90), 1e-8)),
        }
    return limits


def _market_ok(frame: pd.DataFrame, limits: dict[str, dict[str, float]]) -> np.ndarray:
    out = np.zeros(len(frame), dtype=bool)
    for instrument in INSTRUMENTS:
        mask = frame["instrument"].eq(instrument).to_numpy()
        lim = limits[instrument]
        spread = frame["m1_spread_bps"].to_numpy(float)
        vol = frame["m1_volatility_20"].to_numpy(float)
        out |= mask & (spread <= lim["spread_cap"]) & (vol >= lim["vol_floor"]) & (vol <= lim["vol_cap"])
    return out


def _strategy_signal(frame: pd.DataFrame, strategy: str, limits: dict[str, dict[str, float]]) -> pd.DataFrame:
    market_ok = _market_ok(frame, limits)
    trend_align = frame["trend_alignment_score"].to_numpy(float)
    mom_align = frame["momentum_alignment_score"].to_numpy(float)

    if strategy == "trend_continuation":
        votes = np.column_stack([
            _safe_sign(frame["h1_price_vs_ma20"]),
            _safe_sign(frame["h4_price_vs_ma20"]),
            _safe_sign(frame["m15_price_vs_ma20"]),
            _safe_sign(frame["m5_momentum_10"]),
            _safe_sign(frame["m15_momentum_10"]),
        ])
        mean_vote = votes.mean(axis=1)
        direction = mean_vote >= 0.0
        agreement = np.abs(mean_vote)
        strength = np.clip(0.55 * agreement + 0.25 * np.abs(trend_align) + 0.20 * np.abs(mom_align), 0, 1)
        signal = market_ok & (agreement >= 0.60) & (np.abs(trend_align) >= 0.20)

    elif strategy == "momentum_consensus":
        votes = np.column_stack([
            _safe_sign(frame["m1_momentum_3"]), _safe_sign(frame["m1_momentum_5"]),
            _safe_sign(frame["m1_momentum_10"]), _safe_sign(frame["m5_momentum_3"]),
            _safe_sign(frame["m5_momentum_5"]), _safe_sign(frame["m5_momentum_10"]),
            _safe_sign(frame["m15_momentum_5"]), _safe_sign(frame["m15_momentum_10"]),
        ])
        mean_vote = votes.mean(axis=1)
        direction = mean_vote >= 0.0
        agreement = np.abs(mean_vote)
        strength = np.clip(0.75 * agreement + 0.25 * np.abs(mom_align), 0, 1)
        signal = market_ok & (agreement >= 0.50) & (np.abs(mom_align) >= 0.20)

    elif strategy == "breakout":
        b1 = frame["m1_breakout_strength_20"].to_numpy(float)
        b5 = frame["m5_breakout_strength_20"].to_numpy(float)
        b15 = frame["m15_breakout_strength_20"].to_numpy(float)
        signs = np.column_stack([_safe_sign(b1), _safe_sign(b5), _safe_sign(b15)])
        mean_vote = signs.mean(axis=1)
        direction = mean_vote >= 0.0
        agreement = np.abs(mean_vote)
        magnitude = np.tanh((np.abs(b1) + np.abs(b5) + np.abs(b15)) / 2.0)
        expansion = np.clip(
            (frame["m1_range_expansion_20"].to_numpy(float)
             + frame["m5_range_expansion_20"].to_numpy(float)
             + frame["m15_range_expansion_20"].to_numpy(float)) / 6.0,
            0, 1,
        )
        strength = np.clip(0.50 * agreement + 0.35 * magnitude + 0.15 * expansion, 0, 1)
        nonzero = (np.abs(signs) > 0).sum(axis=1)
        signal = market_ok & (nonzero >= 2) & (agreement >= (1.0 / 3.0)) & (magnitude >= 0.25)

    elif strategy == "mean_reversion":
        rsi = (frame["m1_rsi_14"].to_numpy(float) + frame["m5_rsi_14"].to_numpy(float)) / 2.0
        direction = rsi < 0.50
        rsi_extreme = np.abs(rsi - 0.50) * 2.0
        dev_strength = np.zeros(len(frame), dtype=float)
        for instrument in INSTRUMENTS:
            mask = frame["instrument"].eq(instrument).to_numpy()
            scale = limits[instrument]["price_dev_scale"]
            dev_strength[mask] = np.clip(np.abs(frame.loc[mask, "m1_price_vs_ma20"].to_numpy(float)) / scale, 0, 1)
        # Mean reversion should not fight a fully aligned higher-timeframe trend.
        weak_trend = np.abs(trend_align) <= 0.60
        price_direction_ok = np.where(direction, frame["m1_price_vs_ma20"].to_numpy(float) < 0, frame["m1_price_vs_ma20"].to_numpy(float) > 0)
        strength = np.clip(0.65 * rsi_extreme + 0.35 * dev_strength, 0, 1)
        signal = market_ok & weak_trend & price_direction_ok & (rsi_extreme >= 0.25) & (dev_strength >= 0.25)

    else:
        raise ValueError(strategy)

    long_ret = frame["long_net_return"].to_numpy(float)
    short_ret = frame["short_net_return"].to_numpy(float)
    selected_ret = np.where(direction, long_ret, short_ret)
    out = frame[["fold", "decision_time", "instrument", "target", "long_net_return", "short_net_return"]].copy()
    out["strategy"] = strategy
    out["predicted_long"] = direction
    out["raw_strength"] = strength
    out["rule_signal"] = signal
    out["selected_net_return"] = selected_ret
    out["positive_outcome"] = (selected_ret > 0.0).astype(int)
    return out


def _pf(values: np.ndarray) -> float | None:
    v = np.asarray(values, dtype=float)
    pos = v[v > 0].sum()
    neg = -v[v < 0].sum()
    if neg <= 0:
        return float("inf") if pos > 0 else None
    return float(pos / neg)


def _screen_strategy(signal_frame: pd.DataFrame) -> dict[str, Any]:
    dev = signal_frame.loc[signal_frame["fold"].isin([1, 2, 3]) & signal_frame["rule_signal"]].copy()
    if dev.empty:
        return {"eligible": False, "reason": "no_development_signals", "signals": 0}
    fold_returns = [float(dev.loc[dev["fold"] == f, "selected_net_return"].sum()) for f in (1, 2, 3)]
    positive_fold_fraction = sum(x > 0 for x in fold_returns) / 3.0
    pf = _pf(dev["selected_net_return"].to_numpy(float))
    y_true = (dev["long_net_return"] > dev["short_net_return"]).astype(int)
    y_pred = dev["predicted_long"].astype(int)
    ba = float(balanced_accuracy_score(y_true, y_pred)) if y_true.nunique() >= 2 else 0.0
    eligible = bool(
        len(dev) >= 150
        and pf is not None and np.isfinite(pf) and pf >= 1.02
        and positive_fold_fraction >= 2 / 3
        and ba >= 0.50
    )
    return {
        "eligible": eligible,
        "signals": int(len(dev)),
        "profit_factor": pf,
        "balanced_accuracy": ba,
        "positive_fold_fraction": positive_fold_fraction,
        "fold_total_returns": fold_returns,
        "total_return": float(dev["selected_net_return"].sum()),
    }


def _fit_calibrator(signal_frame: pd.DataFrame) -> LogisticRegression:
    dev = signal_frame.loc[signal_frame["fold"].isin([1, 2, 3]) & signal_frame["rule_signal"]].copy()
    if len(dev) < 100 or dev["positive_outcome"].nunique() < 2:
        raise ValueError("insufficient calibration evidence")
    x = dev[["raw_strength"]].to_numpy(float)
    y = dev["positive_outcome"].to_numpy(int)
    model = LogisticRegression(C=0.5, max_iter=500, solver="lbfgs", random_state=42)
    model.fit(x, y)
    return model


def _score_strategy(signal_frame: pd.DataFrame, calibrator: LogisticRegression) -> pd.DataFrame:
    out = signal_frame.copy()
    out["confidence"] = calibrator.predict_proba(out[["raw_strength"]].to_numpy(float))[:, 1]
    return out


def _select_candidates(all_scored: pd.DataFrame) -> pd.DataFrame:
    test = all_scored.loc[
        all_scored["fold"].isin([4, 5])
        & all_scored["rule_signal"]
        & (all_scored["confidence"] >= CONFIDENCE_FLOOR)
    ].copy()
    if test.empty:
        return test
    chosen = (
        test.sort_values(
            ["fold", "decision_time", "confidence", "raw_strength"],
            ascending=[True, True, False, False],
        )
        .groupby(["fold", "decision_time"], as_index=False)
        .head(1)
        .copy()
    )
    chosen["positive_probability"] = np.where(chosen["predicted_long"], chosen["confidence"], 1.0 - chosen["confidence"])
    chosen["raw_positive_probability"] = chosen["positive_probability"]
    chosen["direction_confidence"] = chosen["confidence"]
    chosen["opportunity_probability"] = chosen["confidence"]
    chosen["predicted_opportunity"] = True
    chosen["active_trade"] = True
    chosen["experiment"] = CAMPAIGN
    chosen["model_variant"] = chosen["strategy"]
    chosen["calibration_method"] = "logistic_rule_strength_to_positive_return_probability"
    chosen["decision_threshold"] = 0.50
    chosen["confidence_floor"] = CONFIDENCE_FLOOR
    chosen["confidence_policy"] = "empirical_positive_return_probability_gte_0p60_top1_universe_strategy"
    chosen["actionable_target"] = (np.maximum(chosen["long_net_return"], chosen["short_net_return"]) >= MIN_NET_RETURN).astype(int)
    return chosen


def _direction_ba(frame: pd.DataFrame) -> float:
    if frame.empty:
        return 0.0
    y_true = (frame["long_net_return"] > frame["short_net_return"]).astype(int)
    y_pred = frame["predicted_long"].astype(int)
    return float(balanced_accuracy_score(y_true, y_pred)) if y_true.nunique() >= 2 else 0.0


def _gate(chosen: pd.DataFrame) -> dict[str, Any]:
    if chosen.empty:
        return {
            "passed": False,
            "observed": {"signals": 0, "balanced_accuracy": 0.0},
            "checks": {k: False for k in RESEARCH_GATE},
        }
    summary = _summarize_predictions(chosen, horizon_bars=HORIZON, confidence_threshold=CONFIDENCE_FLOOR)
    trading = summary["trading"]
    ba = _direction_ba(chosen)
    fold_returns = [float(chosen.loc[chosen["fold"] == f, "selected_net_return"].sum()) for f in (4, 5)]
    positive_fold_fraction = sum(x > 0 for x in fold_returns) / 2.0
    inst_returns = {inst: float(chosen.loc[chosen["instrument"] == inst, "selected_net_return"].sum()) for inst in INSTRUMENTS}
    positive_instrument_fraction = sum(x > 0 for x in inst_returns.values()) / len(INSTRUMENTS)
    times = pd.to_datetime(chosen["decision_time"], utc=True).sort_values()
    gaps = times.diff().dropna().dt.total_seconds() / 60.0
    median_gap = float(gaps.median()) if len(gaps) else None
    pf = trading["profit_factor"]
    sharpe = trading["sharpe_ratio"]
    observed = {
        "signals": int(len(chosen)),
        "balanced_accuracy": ba,
        "profit_factor": pf,
        "sharpe_ratio": sharpe,
        "max_drawdown": float(trading["max_drawdown"]),
        "total_return": float(trading["total_return"]),
        "positive_fold_fraction": positive_fold_fraction,
        "positive_instrument_fraction": positive_instrument_fraction,
        "min_active_confidence": float(chosen["confidence"].min()),
        "non_overlapping_periods": int(trading["non_overlapping_periods"]),
        "median_calendar_minutes_between_entries": median_gap,
    }
    checks = {
        "min_balanced_accuracy": ba >= RESEARCH_GATE["min_balanced_accuracy"],
        "min_sharpe_ratio": sharpe is not None and np.isfinite(sharpe) and sharpe >= RESEARCH_GATE["min_sharpe_ratio"],
        "min_profit_factor": pf is not None and np.isfinite(pf) and pf >= RESEARCH_GATE["min_profit_factor"],
        "max_drawdown": observed["max_drawdown"] <= RESEARCH_GATE["max_drawdown"],
        "min_positive_fold_fraction": positive_fold_fraction >= RESEARCH_GATE["min_positive_fold_fraction"],
        "min_positive_instrument_fraction": positive_instrument_fraction >= RESEARCH_GATE["min_positive_instrument_fraction"],
        "min_confidence": observed["min_active_confidence"] >= RESEARCH_GATE["min_confidence"],
        "min_non_overlapping_periods": observed["non_overlapping_periods"] >= RESEARCH_GATE["min_non_overlapping_periods"],
        "max_median_calendar_minutes_between_entries": median_gap is not None and median_gap <= RESEARCH_GATE["max_median_calendar_minutes_between_entries"],
    }
    return {
        "passed": bool(all(checks.values())),
        "thresholds": RESEARCH_GATE,
        "observed": observed,
        "checks": checks,
        "fold_total_returns": fold_returns,
        "instrument_total_returns": inst_returns,
        "strategy_counts": chosen["strategy"].value_counts().to_dict(),
        "trading": trading,
    }


def run(report_root: Path, corpus_root: Path, output: Path) -> dict[str, Any]:
    labels = _load_validation_labels(report_root)
    frame = _load_features(corpus_root, labels)
    limits = _operating_limits(frame)
    screens: dict[str, Any] = {}
    scored_frames: list[pd.DataFrame] = []
    retained: list[str] = []
    for strategy in STRATEGIES:
        signals = _strategy_signal(frame, strategy, limits)
        screen = _screen_strategy(signals)
        screens[strategy] = screen
        if not screen["eligible"]:
            continue
        calibrator = _fit_calibrator(signals)
        scored_frames.append(_score_strategy(signals, calibrator))
        retained.append(strategy)
    all_scored = pd.concat(scored_frames, ignore_index=True) if scored_frames else pd.DataFrame()
    chosen = _select_candidates(all_scored) if not all_scored.empty else pd.DataFrame()
    gate = _gate(chosen)
    report = {
        "campaign": CAMPAIGN,
        "direction_source": "deterministic_rules_only",
        "confidence_source": "development_fold_empirical_calibration_only",
        "development_folds": [1, 2, 3],
        "untouched_ensemble_validation_folds": [4, 5],
        "confidence_floor": CONFIDENCE_FLOOR,
        "strategy_screens": screens,
        "retained_strategies": retained,
        "research_gate": gate,
        "future_holdout_allowed": bool(gate["passed"]),
        "next_action": (
            "FREEZE_DETERMINISTIC_ENSEMBLE_AND_PREPARE_FINAL_FUTURE_HOLDOUT"
            if gate["passed"] else
            "DO_NOT_START_FUTURE_HOLDOUT_ENABLE_EXTERNAL_SIGNAL_PROVIDER_PATH"
        ),
        "approved_for_paper": False,
        "approved_for_live": False,
        "fresh_future_holdout_touched": False,
        "operating_limits": limits,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
    if not chosen.empty:
        chosen.to_csv(output.with_suffix('.selected.csv'), index=False)
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report-root", type=Path, required=True)
    ap.add_argument("--corpus-root", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    a = ap.parse_args()
    r = run(a.report_root, a.corpus_root, a.output)
    print(json.dumps({
        "campaign": r["campaign"],
        "retained_strategies": r["retained_strategies"],
        "future_holdout_allowed": r["future_holdout_allowed"],
        "next_action": r["next_action"],
        "strategy_screens": r["strategy_screens"],
        "research_gate": r["research_gate"],
        "output": str(a.output),
    }, indent=2, default=str), flush=True)


if __name__ == "__main__":
    main()
