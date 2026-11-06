"""Prospective, research-only Plan B rejection-feature challenger.

Fits a simple logistic selector on older as-of admission features and checks
its 15-minute, quote-side outcomes on an untouched latest UTC day. This code
can NEVER publish model weights, grant DEMO/LIVE execution, or auto-promote.
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression

from .demo_rejected_entry_outcomes_shadow import (
    EXTRA_FRICTION_PIPS,
    HORIZON_MINUTES,
    KNOWN_ADMISSION_REASONS,
    MIN_QUALIFIED_DAYS,
    prepare_cohort,
    price_proxy_summary,
)

VERSION = "demo-planb-temporal-challenger-shadow-v1"
HOLDOUT_TOP_FRACTION = 0.20
EMBARGO_MINUTES = HORIZON_MINUTES + 5
MIN_EXPLORATORY_TRAIN_DAYS = 2
MIN_EXPLORATORY_TRAIN = 50
MIN_EXPLORATORY_HOLDOUT = 30
MODEL_C = 0.25


def asof_features(row: pd.Series) -> dict[str, float]:
    """Only information persisted at admission time is permitted as a feature."""
    features = {
        f"instrument_{row['instrument']}": 1.0,
        f"direction_{row['direction']}": 1.0,
        f"m1_route_{row['route']}": 1.0,
        f"planb_route_{row['planb_route']}": 1.0,
        "planb_paper_admitted": float(row["paper_admitted"] in (True, "true")),
    }
    for code in KNOWN_ADMISSION_REASONS:
        features[f"reason_{code}"] = float(code in row["reason_codes"])
    return features


def rank_holdout(train: pd.DataFrame, holdout: pd.DataFrame) -> np.ndarray:
    """Fit using older rows only; never inspect holdout returns to rank."""
    y = (train["proxy_pips"] > 0).astype(int).to_numpy()
    vectorizer = DictVectorizer(sparse=False)
    train_features = vectorizer.fit_transform([asof_features(row) for _, row in train.iterrows()])
    test_features = vectorizer.transform([asof_features(row) for _, row in holdout.iterrows()])
    model = LogisticRegression(C=MODEL_C, solver="liblinear", random_state=19, max_iter=500)
    model.fit(train_features, y)
    scores = model.predict_proba(test_features)[:, 1]
    return np.argsort(-scores, kind="stable")


def evaluate(cohort: pd.DataFrame, quality: dict) -> dict:
    summary = {
        "version": VERSION,
        "authority": "RESEARCH_ONLY_NO_EXECUTION",
        "model_fitted": False,
        "promotion_allowed": False,
        "broker_orders": 0,
        "actual_broker_net_pnl": False,
        "model_persisted": False,
        "estimated_extra_friction_pips": EXTRA_FRICTION_PIPS,
        "proxy_horizon_minutes": HORIZON_MINUTES,
        "selection_rule": "fixed-top-20-percent-by-heldout-logistic-probability",
        "model": {"kind": "logistic_regression", "C": MODEL_C},
        "embargo_minutes": EMBARGO_MINUTES,
        "data_quality": quality,
        "readiness": "INSUFFICIENT_TEMPORAL_EVIDENCE",
        "train": price_proxy_summary(cohort.iloc[:0]),
        "holdout_all": price_proxy_summary(cohort.iloc[:0]),
        "holdout_planb_admitted": price_proxy_summary(cohort.iloc[:0]),
        "holdout_challenger": price_proxy_summary(cohort.iloc[:0]),
        "holdout_utc_day": None,
        "train_utc_days": 0,
        "holdout_selection_count": 0,
        "notes": (
            "Fixed 15-minute bid/ask price proxy minus estimated extra 1 pip. "
            "Not real broker fills, true commission, swaps, stop/TP paths, "
            "risk-adjusted expectancy, or a validated positive strategy."
        ),
    }
    if cohort.empty:
        return summary
    days = sorted(cohort["decision_time_utc"].dt.date.unique())
    if len(days) < MIN_EXPLORATORY_TRAIN_DAYS + 1:
        return summary
    latest_day = days[-1]
    start = pd.Timestamp(latest_day, tz="UTC")
    train = cohort.loc[cohort["decision_time_utc"] < start - timedelta(minutes=EMBARGO_MINUTES)]
    holdout = cohort.loc[cohort["decision_time_utc"].dt.date == latest_day]
    summary["train"] = price_proxy_summary(train)
    summary["holdout_all"] = price_proxy_summary(holdout)
    summary["holdout_planb_admitted"] = price_proxy_summary(
        holdout.loc[holdout["paper_admitted"].isin((True, "true"))]
    )
    summary["train_utc_days"] = int(train["decision_time_utc"].dt.date.nunique())
    summary["holdout_utc_day"] = latest_day.isoformat()

    if (
        summary["train_utc_days"] < MIN_EXPLORATORY_TRAIN_DAYS
        or len(train) < MIN_EXPLORATORY_TRAIN
        or len(holdout) < MIN_EXPLORATORY_HOLDOUT
    ):
        return summary
    y = (train["proxy_pips"] > 0).astype(int).to_numpy()
    if len(set(y.tolist())) < 2:
        return summary
    k = max(1, math.floor(HOLDOUT_TOP_FRACTION * len(holdout)))
    ranked = rank_holdout(train, holdout)[:k]
    chosen = holdout.iloc[ranked]
    summary["holdout_challenger"] = price_proxy_summary(chosen)
    summary["holdout_selection_count"] = k
    summary["model_fitted"] = True

    # Never auto-promote even if later quote-proxy results happen to look good.
    # At least 12 separate days, purged multi-fold heldouts, all trades
    # including rejects, and true broker commission/SL/TP P&L are needed.
    summary["readiness"] = (
        "EXPLORATORY_INSUFFICIENT_DAYS"
        if quality["utc_days"] < MIN_QUALIFIED_DAYS
        else "REQUIRES_INDEPENDENT_BROKER_NET_VALIDATION"
    )
    return summary


def report_from_csv(path: Path) -> dict:
    cohort, quality = prepare_cohort(pd.read_csv(path))
    return evaluate(cohort, quality)


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only out-of-time Plan B challenger")
    parser.add_argument("--cohort-csv", required=True, type=Path)
    parser.add_argument("--report-json", required=True, type=Path)
    args = parser.parse_args()
    if any(part in {"models", "artifacts", "production"} for part in args.report_json.parts):
        raise ValueError("Research JSON must not be written to an execution/model directory")
    report = report_from_csv(args.cohort_csv)
    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    print(json.dumps({
        "artifact": VERSION,
        "fit": report["model_fitted"],
        "readiness": report["readiness"],
        "holdout_challenger": report["holdout_challenger"],
        "holdout_all": report["holdout_all"],
        "promotion_allowed": False,
        "broker_orders": 0,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
