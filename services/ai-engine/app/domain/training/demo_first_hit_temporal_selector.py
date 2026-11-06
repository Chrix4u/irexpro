"""Strictly read-only, non-promoting, time-split rejected-entry TP/SL model.

Train on earlier complete UTC days. Select latest *completed* UTC day
without using its realized first-hit labels to fit, rank, or tune cutoffs.
The input contains only non-executed cTrader DEMO candidates and a bounded
broker-native quote-close reconstruction with conservative censored paths.
No broker API, registry, model artifact, live gating, or account writes.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression

from .demo_rejected_first_hit_shadow import (
    DEOVERLAP_MINUTES,
    EXTRA_FRICTION_PIPS,
    PIP,
    evaluate_decision,
    timestamp,
    valid_decision,
)

VERSION = "demo-first-hit-temporal-selector-shadow-v1"
SAFE_REASONS = frozenset((
    "DIRECTION_QUALITY", "EXIT_FEASIBILITY", "TRADE_QUALITY",
    "REGIME_TREND_EXTENDED", "REGIME_TREND_WEAK",
    "META_EXPECTED_VALUE", "EXPECTED_R", "SESSION_QUALITY",
    "REGIME_ROLLOVER_RISK",
))
SAFE_BLOCKERS = frozenset((
    "PAPER_NET_EXPECTED_R", "DRIFT_OUT_OF_DISTRIBUTION", "DRIFT_STRESSED",
    "MULTIMODEL_CONTINUATION_TIMING_NOT_READY",
    "M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION", "EVENT_RISK_HIGH_IMPACT_BLOCK",
    "M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED",
))
TP = "TP_FIRST_QUOTE_CLOSE_PROXY"
SL = "SL_FIRST_QUOTE_CLOSE_PROXY"
TOP_FRACTION = 0.20
MIN_TRAIN_DAYS = 2
MIN_TRAIN_RESOLVED = 60
MIN_HOLDOUT_CANDIDATES = 30
MIN_HOLDOUT_RESOLVED = 15
EMBARGO_MINUTES = 35
C = 0.25


def parse_codes(value: object) -> set[str]:
    try:
        items = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        return set()
    if not isinstance(items, list):
        return set()
    return {item for item in items if isinstance(item, str)}


def bounded_number(value: object, low: float, high: float) -> float:
    try:
        number = float(value)
        if not math.isfinite(number):
            return 0.0
        return max(low, min(high, number))
    except (ValueError, TypeError):
        return 0.0


def asof_features(row: dict) -> dict[str, float]:
    """As-of prediction features; no future quote or outcome inputs."""
    features = {
        f"instrument_{row['instrument']}": 1.0,
        f"direction_{row['direction']}": 1.0,
        f"m1_route_{row['route']}": 1.0,
        f"planb_route_{str(row.get('planb_route') or 'UNKNOWN')[:50]}": 1.0,
        f"regime_{str(row.get('regime_asof') or 'UNKNOWN')[:50]}": 1.0,
        f"drift_{str(row.get('drift_state_asof') or 'UNKNOWN')[:50]}": 1.0,
        "paper_admitted": float(row["paper_admitted"] in (True, "true")),
        "predicted_net_r": bounded_number(row.get("predicted_net_r"), -2.0, 2.0),
        "estimated_cost_r": bounded_number(row.get("estimated_cost_r_asof"), 0.0, 1.0),
        "reward_to_risk": bounded_number(
            float(row["target_distance"]) / float(row["stop_distance"]), 0.0, 5.0
        ),
    }
    reason_codes = parse_codes(row.get("admission_reasons_json"))
    blocker_codes = parse_codes(row.get("blockers_json"))
    features.update({f"admission_{reason}": float(reason in reason_codes) for reason in SAFE_REASONS})
    features.update({f"blocker_{reason}": float(reason in blocker_codes) for reason in SAFE_BLOCKERS})
    return features


def prepare(path: Path) -> tuple[list[dict], dict]:
    df = pd.read_csv(path, dtype=str)
    expected = {
        "instrument", "direction", "route", "paper_admitted",
        "decision_time_utc", "stop_distance", "target_distance",
        "entry_bid", "entry_ask", "entry_seen_utc", "minute_path_json",
        "predicted_net_r", "regime_asof", "drift_state_asof",
        "estimated_cost_r_asof", "admission_reasons_json", "blockers_json",
    }
    if not expected.issubset(df.columns):
        raise ValueError("Missing required as-of DEMO first-hit columns")
    records = []
    invalid = 0
    for row in df.to_dict(orient="records"):
        try:
            if valid_decision(row):
                records.append(row)
            else:
                invalid += 1
        except (KeyError, ValueError, TypeError, OverflowError):
            invalid += 1
    records.sort(
        key=lambda r: (timestamp(r["decision_time_utc"]), r["instrument"], r["direction"], r["route"])
    )
    selected = []
    previous: dict[str, pd.Timestamp] = {}
    for record in records:
        at = timestamp(record["decision_time_utc"])
        older = previous.get(record["instrument"])
        if older is not None and at <= older + timedelta(minutes=DEOVERLAP_MINUTES):
            continue
        previous[record["instrument"]] = at
        try:
            verdict = evaluate_decision(record)
        except (KeyError, ValueError, TypeError, OverflowError):
            invalid += 1
            continue
        selected.append({
            "decision_at": at,
            "asof": record,
            "status": verdict["status"],
            "reward_r": bounded_number(
                float(record["target_distance"]) / float(record["stop_distance"]), 0, 5
            ),
            "cost_r": EXTRA_FRICTION_PIPS * PIP / float(record["stop_distance"]),
        })
    return selected, {
        "source_rows": len(df),
        "invalid_rows": invalid,
        "independent_episodes": len(selected),
        "source_utc_days": len({x["decision_at"].date() for x in selected}),
    }


def rank_holdout(training: list[dict], holdout: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    """Fit on older observed outcomes only; predict for ALL holdout candidates."""
    resolved_train = [x for x in training if x["status"] in (TP, SL)]
    if not resolved_train or not holdout:
        raise ValueError("Missing train or holdout")
    y = np.asarray([int(x["status"] == TP) for x in resolved_train], dtype=int)
    if len(set(y.tolist())) < 2:
        raise ValueError("Train needs both TP and SL observed outcomes")
    vectorizer = DictVectorizer(sparse=False)
    train_x = vectorizer.fit_transform([asof_features(x["asof"]) for x in resolved_train])
    hold_x = vectorizer.transform([asof_features(x["asof"]) for x in holdout])
    classifier = LogisticRegression(
        C=C, max_iter=500, solver="liblinear", random_state=19
    )
    classifier.fit(train_x, y)
    p_tp = classifier.predict_proba(hold_x)[:, 1]
    # Original stop/target geometry and estimated extra one-pip friction.
    expected_r = np.asarray([
        p_tp[i] * x["reward_r"] - (1.0 - p_tp[i]) - x["cost_r"]
        for i, x in enumerate(holdout)
    ])
    return np.argsort(-expected_r, kind="stable"), expected_r


def summarize(cohort: list[dict]) -> dict:
    counts = Counter(x["status"] for x in cohort)
    tp = counts.get(TP, 0)
    sl = counts.get(SL, 0)
    resolved = [x for x in cohort if x["status"] in (TP, SL)]
    total_r = sum(
        (x["reward_r"] if x["status"] == TP else -1.0) - x["cost_r"]
        for x in resolved
    )
    # Censored cases have unknown outcomes: explicitly show pessimistic and
    # optimistic R bounds, not a fake average over only resolved winners.
    pessimistic_r = sum(
        ((x["reward_r"] if x["status"] == TP else -1.0) - x["cost_r"])
        if x["status"] in (TP, SL) else (-1.0 - x["cost_r"])
        for x in cohort
    )
    optimistic_r = sum(
        ((x["reward_r"] if x["status"] == TP else -1.0) - x["cost_r"])
        if x["status"] in (TP, SL) else (x["reward_r"] - x["cost_r"])
        for x in cohort
    )
    n = len(cohort)
    return {
        "candidates": n,
        "quote_close_tp_first": tp,
        "quote_close_sl_first": sl,
        "censored_or_ambiguous": n - tp - sl,
        "resolved_fraction": round((tp + sl) / n, 4) if n else None,
        "tp_fraction_of_resolved_only": round(tp / (tp + sl), 4) if tp + sl else None,
        "estimated_net_r_on_resolved_only": round(total_r / len(resolved), 4) if resolved else None,
        "pessimistic_mean_r_if_all_censored_sl": round(pessimistic_r / n, 4) if n else None,
        "optimistic_mean_r_if_all_censored_tp": round(optimistic_r / n, 4) if n else None,
    }


def evaluate(episodes: list[dict], *, as_of: datetime, quality: dict) -> dict:
    now = timestamp(as_of)
    # Evaluate a *fully completed* UTC date, not the partially observed
    # current UTC trading day. The current UTC date is always excluded.
    earliest_end = now.floor("D")
    days = sorted({
        x["decision_at"].date() for x in episodes
        if x["decision_at"] < earliest_end
    })
    report = {
        "version": VERSION,
        "execution_authority": "RESEARCH_ONLY_NO_ORDER_PATH",
        "model_fitted": False,
        "model_persisted": False,
        "promotion_allowed": False,
        "broker_orders": 0,
        "real_broker_fill_or_commission_replay": False,
        "cost_basis": "observed entry-side quote, original SL/TP, estimated additional 1 pip; NOT verified commission",
        "label_caveat": "quote-close first-hit proxy; midpoint wick ambiguity, gaps and unresolved paths censored",
        "selection_rule": "fixed top 20% of ALL independent holdout candidates by in-memory expected-R rank",
        "train_minimum_days": MIN_TRAIN_DAYS,
        "embargo_minutes": EMBARGO_MINUTES,
        "data_quality": quality,
        "readiness": "INSUFFICIENT_TEMPORAL_EVIDENCE",
        "holdout_utc_day": None,
        "train_days": 0,
        "train_resolved": 0,
        "holdout_all": summarize([]),
        "holdout_planb_admitted": summarize([]),
        "holdout_challenger": summarize([]),
    }
    if len(days) < MIN_TRAIN_DAYS + 1:
        return report
    holdout_day = days[-1]
    start = pd.Timestamp(holdout_day, tz="UTC")
    train = [
        x for x in episodes
        if x["decision_at"] < start - timedelta(minutes=EMBARGO_MINUTES)
    ]
    holdout = [
        x for x in episodes if x["decision_at"].date() == holdout_day
    ]
    resolved = [x for x in train if x["status"] in (TP, SL)]
    report["holdout_utc_day"] = holdout_day.isoformat()
    report["train_days"] = len({x["decision_at"].date() for x in train})
    report["train_resolved"] = len(resolved)
    report["holdout_all"] = summarize(holdout)
    report["holdout_planb_admitted"] = summarize([
        x for x in holdout if x["asof"]["paper_admitted"] in (True, "true")
    ])
    holdout_resolved = sum(x["status"] in (TP, SL) for x in holdout)
    if (
        report["train_days"] < MIN_TRAIN_DAYS
        or len(resolved) < MIN_TRAIN_RESOLVED
        or len(holdout) < MIN_HOLDOUT_CANDIDATES
        or holdout_resolved < MIN_HOLDOUT_RESOLVED
    ):
        return report
    if len({x["status"] for x in resolved}) < 2:
        return report
    ranked, _ = rank_holdout(train, holdout)
    top = max(1, math.floor(len(holdout) * TOP_FRACTION))
    report["holdout_challenger"] = summarize([holdout[i] for i in ranked[:top]])
    report["model_fitted"] = True
    report["readiness"] = "EXPLORATORY_ONLY_INSUFFICIENT_MARKET_DAYS"
    return report


def report_from_csv(path: Path, *, as_of: datetime | None = None) -> dict:
    episodes, quality = prepare(path)
    return evaluate(episodes, quality=quality, as_of=as_of or datetime.now(UTC))


def main() -> None:
    parser = argparse.ArgumentParser(description="Non-executing chronological first-hit entry selector")
    parser.add_argument("--cohort-csv", required=True, type=Path)
    parser.add_argument("--report-json", required=True, type=Path)
    args = parser.parse_args()
    if any(part in ("models", "artifacts", "production") for part in args.report_json.parts):
        raise ValueError("Research report must not be stored in execution/model directory")
    report = report_from_csv(args.cohort_csv)
    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    print(json.dumps({
        "artifact": VERSION,
        "holdout_day": report["holdout_utc_day"],
        "train_resolved": report["train_resolved"],
        "challenger": report["holdout_challenger"],
        "baseline_all": report["holdout_all"],
        "baseline_planb_admitted": report["holdout_planb_admitted"],
        "model_fitted": report["model_fitted"],
        "promotion_allowed": False,
        "broker_orders": 0,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
