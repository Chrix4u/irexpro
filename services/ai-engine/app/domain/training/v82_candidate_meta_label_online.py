"""v82 delayed-label candidate-direction meta model.

Research-only challenger. The deterministic iRexPro candidate generator keeps
authority over BUY/SELL direction. This model only asks whether that already
defined candidate deserves admission.

Anti-leakage contract:
- prediction occurs at scan_time;
- an event may update the online model only after its recorded exit_time;
- threshold selection uses a preceding chronological calibration window;
- the outer validation threshold is frozen before the outer window begins;
- no sealed future holdout is read;
- no PAPER/DEMO/LIVE authority is granted.

The online hyperparameters are frozen from the previously inspected causal
development study (lr=.01, l2=.005) rather than tuned on these outer folds.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

EXPERIMENT = "v82_candidate_direction_delayed_online_meta_v1"
PAIRS = ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
DIRECTIONS = ("BUY", "SELL")

LEARNING_RATE = 0.01
L2 = 0.005
PAIR_BLEND_MIN_RESOLVED = 60
PAIR_BLEND_WEIGHT = 0.25

MIN_BALANCED_ACCURACY = 0.52
MIN_SHARPE = 1.0
MIN_PROFIT_FACTOR = 1.15
MAX_DRAWDOWN = 0.12
MIN_POSITIVE_FOLD_FRACTION = 2 / 3
MIN_POSITIVE_INSTRUMENT_FRACTION = 4 / 6
MIN_CONFIDENCE = 0.60
MAX_MEDIAN_GAP_MINUTES = 10.0
MIN_OUTER_TRADES = 100

CALIBRATION_MIN_TRADES = 25
THRESHOLDS = (0.45, 0.48, 0.50, 0.52, 0.55, 0.58, 0.60, 0.62, 0.65)
OUTER_FOLDS = (
    (0.55, 0.65),
    (0.70, 0.80),
    (0.85, 0.95),
)
CALIBRATION_FRACTION_OF_TRAIN = 0.18

BASE_FEATURES = (
    "confidence",
    "score",
    "extension",
    "volatility",
    "ema",
    "mtf",
    "rsi_strength",
    "hour_sin",
    "hour_cos",
    "dow_sin",
    "dow_cos",
    "side",
)
PAIR_FEATURES = tuple(f"pair_{pair}" for pair in PAIRS)
PAIR_SIDE_FEATURES = tuple(
    f"pairside_{pair}_{direction}"
    for pair in PAIRS
    for direction in DIRECTIONS
)
FEATURES = ("bias", *BASE_FEATURES, *PAIR_FEATURES, *PAIR_SIDE_FEATURES)


@dataclass
class Event:
    symbol: str
    direction: str
    scan_time: pd.Timestamp
    exit_time: pd.Timestamp
    r_multiple: float
    features: np.ndarray


@dataclass
class Prediction:
    symbol: str
    direction: str
    scan_time: pd.Timestamp
    exit_time: pd.Timestamp
    r_multiple: float
    probability: float
    accepted: bool = False


class OnlineLogistic:
    def __init__(self, dimension: int, *, learning_rate: float = LEARNING_RATE, l2: float = L2):
        self.weights = np.zeros(dimension, dtype=float)
        self.learning_rate = float(learning_rate)
        self.l2 = float(l2)
        self.positive_updates = 0
        self.negative_updates = 0

    @staticmethod
    def _sigmoid(value: float) -> float:
        value = max(-30.0, min(30.0, float(value)))
        return 1.0 / (1.0 + math.exp(-value))

    def predict(self, x: np.ndarray) -> float:
        return self._sigmoid(float(np.dot(self.weights, x)))

    def update(self, x: np.ndarray, y: int) -> None:
        p = self.predict(x)
        total = self.positive_updates + self.negative_updates
        pos = self.positive_updates
        neg = self.negative_updates
        if y == 1:
            class_count = max(1, pos)
        else:
            class_count = max(1, neg)
        weight = math.sqrt(max(2, total + 2) / (2.0 * class_count))
        weight = max(0.5, min(2.5, weight))

        gradient = weight * (p - float(y)) * x + self.l2 * self.weights
        self.weights -= self.learning_rate * gradient

        if y == 1:
            self.positive_updates += 1
        else:
            self.negative_updates += 1


class DelayedMetaModel:
    def __init__(self) -> None:
        self.global_model = OnlineLogistic(len(FEATURES))
        self.pair_models = {pair: OnlineLogistic(len(FEATURES)) for pair in PAIRS}
        self.pair_resolved = {pair: 0 for pair in PAIRS}
        self.pending: list[Event] = []

    def _release(self, now: pd.Timestamp) -> None:
        if not self.pending:
            return
        still_pending: list[Event] = []
        for event in self.pending:
            if event.exit_time <= now:
                y = int(event.r_multiple > 0)
                self.global_model.update(event.features, y)
                self.pair_models[event.symbol].update(event.features, y)
                self.pair_resolved[event.symbol] += 1
            else:
                still_pending.append(event)
        self.pending = still_pending

    def score(self, event: Event) -> float:
        self._release(event.scan_time)
        global_p = self.global_model.predict(event.features)
        if self.pair_resolved[event.symbol] < PAIR_BLEND_MIN_RESOLVED:
            return global_p
        pair_p = self.pair_models[event.symbol].predict(event.features)
        return (
            (1.0 - PAIR_BLEND_WEIGHT) * global_p
            + PAIR_BLEND_WEIGHT * pair_p
        )

    def observe(self, event: Event) -> None:
        self.pending.append(event)

    def release_through(self, timestamp: pd.Timestamp) -> None:
        self._release(timestamp)


def _utc(value: str) -> pd.Timestamp:
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        return ts.tz_localize("UTC")
    return ts.tz_convert("UTC")


def _feature_vector(row: dict[str, str]) -> np.ndarray:
    symbol = row["symbol"].strip().upper()
    direction = row["direction"].strip().upper()
    if symbol not in PAIRS or direction not in DIRECTIONS:
        raise ValueError(f"unsupported candidate {symbol} {direction}")

    confidence = float(row["confidence"])
    score = float(row["score"])
    extension = float(row["extension_atr"])
    volatility = float(row["volatility_score"])
    ema = float(row["ema_separation"])
    mtf = float(row["mtf_strength"])
    rsi = float(row["rsi14"])

    side = 1.0 if direction == "BUY" else -1.0
    rsi_strength = (rsi - 50.0) if direction == "BUY" else (50.0 - rsi)
    scan = _utc(row["scan_time"])
    hour = scan.hour + scan.minute / 60.0
    dow = scan.dayofweek

    values: list[float] = [
        1.0,
        (confidence - 0.70) / 0.08,
        (score - 0.70) / 0.10,
        (extension - 0.75) / 0.75,
        (volatility - 0.375) / 0.375,
        (ema - 0.50) / 0.50,
        (mtf - 0.50) / 0.50,
        (rsi_strength - 11.0) / 11.0,
        math.sin(2.0 * math.pi * hour / 24.0),
        math.cos(2.0 * math.pi * hour / 24.0),
        math.sin(2.0 * math.pi * dow / 7.0),
        math.cos(2.0 * math.pi * dow / 7.0),
        side,
    ]

    values.extend(1.0 if symbol == pair else 0.0 for pair in PAIRS)
    values.extend(
        1.0 if symbol == pair and direction == candidate_direction else 0.0
        for pair in PAIRS
        for candidate_direction in DIRECTIONS
    )

    array = np.asarray(values, dtype=float)
    if len(array) != len(FEATURES) or not np.isfinite(array).all():
        raise ValueError("invalid v82 feature vector")
    return array


def load_events(path: Path) -> list[Event]:
    events: list[Event] = []
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if not row.get("exit_time") or row.get("r_multiple") in (None, ""):
                continue
            scan_time = _utc(row["scan_time"])
            exit_time = _utc(row["exit_time"])
            r_multiple = float(row["r_multiple"])
            if not np.isfinite(r_multiple) or exit_time < scan_time:
                continue
            events.append(
                Event(
                    symbol=row["symbol"].strip().upper(),
                    direction=row["direction"].strip().upper(),
                    scan_time=scan_time,
                    exit_time=exit_time,
                    r_multiple=r_multiple,
                    features=_feature_vector(row),
                )
            )
    events.sort(key=lambda event: (event.scan_time, event.symbol, event.direction))
    if len(events) < 500:
        raise ValueError(f"insufficient candidate events: {len(events)}")
    return events


def _balanced_accuracy(predictions: list[Prediction], threshold: float) -> float | None:
    if not predictions:
        return None
    y = np.asarray([prediction.r_multiple > 0 for prediction in predictions], dtype=bool)
    p = np.asarray([prediction.probability >= threshold for prediction in predictions], dtype=bool)
    positives = y
    negatives = ~y
    if positives.sum() == 0 or negatives.sum() == 0:
        return None
    tpr = float((p & positives).sum() / positives.sum())
    tnr = float(((~p) & negatives).sum() / negatives.sum())
    return 0.5 * (tpr + tnr)


def _accepted(predictions: list[Prediction], threshold: float) -> list[Prediction]:
    return [prediction for prediction in predictions if prediction.probability >= threshold]


def _performance(predictions: list[Prediction], threshold: float) -> dict[str, Any]:
    accepted = _accepted(predictions, threshold)
    returns = np.asarray([prediction.r_multiple for prediction in accepted], dtype=float)
    if not len(accepted):
        return {
            "trades": 0,
            "profit_factor": None,
            "sharpe": None,
            "max_drawdown": None,
            "net_r": 0.0,
            "mean_r": None,
            "win_rate": None,
            "median_gap_minutes": None,
            "balanced_accuracy": _balanced_accuracy(predictions, threshold),
            "mean_probability": None,
            "positive_instrument_fraction": 0.0,
            "by_instrument": {},
        }

    gross_profit = float(returns[returns > 0].sum())
    gross_loss = float(-returns[returns < 0].sum())
    pf = gross_profit / gross_loss if gross_loss > 0 else None

    std = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0
    sharpe = (
        float(math.sqrt(len(returns)) * returns.mean() / std)
        if std > 0
        else None
    )

    equity = 100.0
    peak = 100.0
    max_drawdown = 0.0
    for value in returns:
        equity += float(value)
        peak = max(peak, equity)
        if peak > 0:
            max_drawdown = max(max_drawdown, (peak - equity) / peak)

    ordered = sorted(accepted, key=lambda prediction: prediction.scan_time)
    gaps = [
        (current.scan_time - prior.scan_time).total_seconds() / 60.0
        for prior, current in zip(ordered, ordered[1:])
    ]

    by_instrument: dict[str, dict[str, Any]] = {}
    for pair in PAIRS:
        pair_rows = [prediction for prediction in accepted if prediction.symbol == pair]
        pair_r = [prediction.r_multiple for prediction in pair_rows]
        by_instrument[pair] = {
            "trades": len(pair_rows),
            "net_r": float(sum(pair_r)),
            "positive": bool(pair_r and sum(pair_r) > 0),
        }
    positive_instrument_fraction = (
        sum(bool(value["positive"]) for value in by_instrument.values()) / len(PAIRS)
    )

    return {
        "trades": len(accepted),
        "profit_factor": pf,
        "sharpe": sharpe,
        "max_drawdown": max_drawdown,
        "net_r": float(returns.sum()),
        "mean_r": float(returns.mean()),
        "win_rate": float((returns > 0).mean()),
        "median_gap_minutes": float(np.median(gaps)) if gaps else None,
        "balanced_accuracy": _balanced_accuracy(predictions, threshold),
        "mean_probability": float(
            np.mean([prediction.probability for prediction in accepted])
        ),
        "positive_instrument_fraction": positive_instrument_fraction,
        "by_instrument": by_instrument,
    }


def _half_stability(predictions: list[Prediction], threshold: float) -> dict[str, Any]:
    ordered = sorted(predictions, key=lambda prediction: prediction.scan_time)
    split = len(ordered) // 2
    halves = [ordered[:split], ordered[split:]]
    snapshots = []
    for index, half in enumerate(halves, 1):
        metrics = _performance(half, threshold)
        pf = metrics["profit_factor"]
        positive = bool(
            metrics["trades"] >= 8
            and metrics["net_r"] > 0
            and _finite(pf)
            and pf >= 1.0
        )
        snapshots.append({"half": index, **metrics, "positive": positive})
    return {
        "halves": snapshots,
        "positive_half_fraction": (
            sum(bool(row["positive"]) for row in snapshots) / len(snapshots)
        ),
        "passed": bool(snapshots and all(row["positive"] for row in snapshots)),
    }


def _finite(value: Any) -> bool:
    return value is not None and np.isfinite(value)


def _calibration_eligible(metrics: dict[str, Any], stability: dict[str, Any]) -> bool:
    return bool(
        metrics["trades"] >= CALIBRATION_MIN_TRADES
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
        and metrics["net_r"] > 0
        and _finite(metrics["mean_probability"])
        and metrics["mean_probability"] >= MIN_CONFIDENCE
        and stability["passed"]
    )


def choose_threshold(predictions: list[Prediction]) -> tuple[float, bool, list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    for threshold in THRESHOLDS:
        metrics = _performance(predictions, threshold)
        stability = _half_stability(predictions, threshold)
        rows.append(
            {
                "threshold": threshold,
                **metrics,
                "stability": stability,
                "eligible": _calibration_eligible(metrics, stability),
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
                int(row["trades"]),
            ),
        )
        return float(chosen["threshold"]), True, rows

    feasible = [
        row
        for row in rows
        if row["trades"] >= 15 and _finite(row["profit_factor"])
    ]
    if feasible:
        chosen = max(
            feasible,
            key=lambda row: (
                float(row["stability"]["positive_half_fraction"]),
                float(row["profit_factor"]),
                float(row["sharpe"]) if _finite(row["sharpe"]) else -999.0,
            ),
        )
        return float(chosen["threshold"]), False, rows
    return float(THRESHOLDS[0]), False, rows


def _run_segment(
    model: DelayedMetaModel,
    events: list[Event],
    *,
    collect: bool,
) -> list[Prediction]:
    predictions: list[Prediction] = []
    for event in events:
        probability = model.score(event)
        if collect:
            predictions.append(
                Prediction(
                    symbol=event.symbol,
                    direction=event.direction,
                    scan_time=event.scan_time,
                    exit_time=event.exit_time,
                    r_multiple=event.r_multiple,
                    probability=probability,
                )
            )
        model.observe(event)
    return predictions


def _split_events(
    events: list[Event],
    train_end_fraction: float,
    outer_end_fraction: float,
) -> tuple[list[Event], list[Event], list[Event]]:
    times = sorted({event.scan_time for event in events})
    n = len(times)
    train_end = times[min(n - 1, max(1, int(n * train_end_fraction)))]
    outer_end = times[min(n - 1, max(2, int(n * outer_end_fraction)))]
    train = [event for event in events if event.scan_time < train_end]
    outer = [
        event
        for event in events
        if train_end <= event.scan_time < outer_end
    ]
    if len(train) < 300 or len(outer) < 50:
        raise ValueError(
            f"insufficient fold rows train={len(train)} outer={len(outer)}"
        )

    train_times = sorted({event.scan_time for event in train})
    cal_start = train_times[
        max(1, int(len(train_times) * (1.0 - CALIBRATION_FRACTION_OF_TRAIN)))
    ]
    fit = [event for event in train if event.scan_time < cal_start]
    calibration = [event for event in train if event.scan_time >= cal_start]
    return fit, calibration, outer


def _score_fold(
    events: list[Event],
    fold: int,
    train_end_fraction: float,
    outer_end_fraction: float,
) -> dict[str, Any]:
    fit, calibration, outer = _split_events(
        events,
        train_end_fraction,
        outer_end_fraction,
    )
    model = DelayedMetaModel()

    _run_segment(model, fit, collect=False)
    calibration_predictions = _run_segment(model, calibration, collect=True)

    calibration_end = max(event.scan_time for event in calibration)
    model.release_through(calibration_end)
    resolved_calibration = [
        prediction
        for prediction in calibration_predictions
        if prediction.exit_time <= calibration_end
    ]

    threshold, calibration_passed, candidates = choose_threshold(
        resolved_calibration
    )

    outer_predictions = _run_segment(model, outer, collect=True)
    outer_end = max(event.scan_time for event in outer)
    outer_metrics = _performance(outer_predictions, threshold)

    chosen_calibration = next(
        row for row in candidates if float(row["threshold"]) == threshold
    )

    return {
        "fold": fold,
        "train_rows": len(fit),
        "calibration_rows": len(calibration),
        "resolved_calibration_rows": len(resolved_calibration),
        "outer_rows": len(outer),
        "calibration_passed": calibration_passed,
        "threshold": threshold,
        "calibration": chosen_calibration,
        "outer": outer_metrics,
        "outer_prediction_count": len(outer_predictions),
        "outer_end": outer_end.isoformat(),
        "top_calibration": sorted(
            candidates,
            key=lambda row: (
                bool(row["eligible"]),
                float(row["stability"]["positive_half_fraction"]),
                float(row["profit_factor"]) if _finite(row["profit_factor"]) else -999.0,
                float(row["sharpe"]) if _finite(row["sharpe"]) else -999.0,
            ),
            reverse=True,
        )[:8],
    }


def run(events_path: Path, output: Path) -> dict[str, Any]:
    events = load_events(events_path)
    folds = [
        _score_fold(events, index, train_end, outer_end)
        for index, (train_end, outer_end) in enumerate(OUTER_FOLDS, 1)
    ]

    calibration_pass_fraction = (
        sum(bool(fold["calibration_passed"]) for fold in folds) / len(folds)
    )
    positive_fold_fraction = (
        sum(fold["outer"]["net_r"] > 0 for fold in folds) / len(folds)
    )

    total_trades = sum(int(fold["outer"]["trades"]) for fold in folds)
    aggregate_returns: list[float] = []
    aggregate_by_pair = {
        pair: {"trades": 0, "net_r": 0.0}
        for pair in PAIRS
    }
    for fold in folds:
        for pair, row in fold["outer"]["by_instrument"].items():
            aggregate_by_pair[pair]["trades"] += int(row["trades"])
            aggregate_by_pair[pair]["net_r"] += float(row["net_r"])

    positive_instrument_fraction = (
        sum(
            1
            for pair in PAIRS
            if aggregate_by_pair[pair]["trades"] > 0
            and aggregate_by_pair[pair]["net_r"] > 0
        )
        / len(PAIRS)
    )

    # Fold-level metrics stay primary; aggregate PF/Sharpe are not reconstructed
    # from summaries because that would discard the original per-trade sequence.
    checks = {
        "outer_fold_count": len(folds) == 3,
        "calibration_stability": (
            calibration_pass_fraction >= MIN_POSITIVE_FOLD_FRACTION
        ),
        "positive_fold_fraction": (
            positive_fold_fraction >= MIN_POSITIVE_FOLD_FRACTION
        ),
        "positive_instrument_fraction": (
            positive_instrument_fraction >= MIN_POSITIVE_INSTRUMENT_FRACTION
        ),
        "minimum_total_outer_trades": total_trades >= MIN_OUTER_TRADES,
        "all_outer_balanced_accuracy": all(
            _finite(fold["outer"]["balanced_accuracy"])
            and fold["outer"]["balanced_accuracy"] >= MIN_BALANCED_ACCURACY
            for fold in folds
        ),
        "all_outer_profit_factor": all(
            _finite(fold["outer"]["profit_factor"])
            and fold["outer"]["profit_factor"] >= MIN_PROFIT_FACTOR
            for fold in folds
        ),
        "all_outer_sharpe": all(
            _finite(fold["outer"]["sharpe"])
            and fold["outer"]["sharpe"] >= MIN_SHARPE
            for fold in folds
        ),
        "all_outer_drawdown": all(
            _finite(fold["outer"]["max_drawdown"])
            and fold["outer"]["max_drawdown"] <= MAX_DRAWDOWN
            for fold in folds
        ),
        "all_outer_frequency": all(
            fold["outer"]["median_gap_minutes"] is not None
            and fold["outer"]["median_gap_minutes"] <= MAX_MEDIAN_GAP_MINUTES
            for fold in folds
        ),
        "all_outer_confidence": all(
            _finite(fold["outer"]["mean_probability"])
            and fold["outer"]["mean_probability"] >= MIN_CONFIDENCE
            for fold in folds
        ),
    }

    report = {
        "experiment": EXPERIMENT,
        "methodology": (
            "Delayed-label online logistic meta-model over deterministic iRexPro "
            "candidate directions; global + pair shrinkage; labels released only "
            "after exit_time; chronological calibration threshold; three outer windows."
        ),
        "events": len(events),
        "feature_count": len(FEATURES),
        "features": FEATURES,
        "frozen_online_hyperparameters": {
            "learning_rate": LEARNING_RATE,
            "l2": L2,
            "pair_blend_min_resolved": PAIR_BLEND_MIN_RESOLVED,
            "pair_blend_weight": PAIR_BLEND_WEIGHT,
        },
        "sealed_future_holdout_touched": False,
        "production_eligible": False,
        "promotion_gates_unchanged": True,
        "folds": folds,
        "calibration_pass_fraction": calibration_pass_fraction,
        "positive_fold_fraction": positive_fold_fraction,
        "positive_instrument_fraction": positive_instrument_fraction,
        "aggregate_by_instrument": aggregate_by_pair,
        "total_outer_trades": total_trades,
        "checks": checks,
        "research_challenger": all(checks.values()),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps(report, indent=2, default=str), flush=True)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.events, args.output)
