"""Strictly read-only forward-price study of DEMO candidates denied order authority.

Every outcome is independently observed future cTrader bid/ask minus a fixed
extra cost *estimate*, not a broker fill, SL/TP replay, audited commission or
realised net trading P&L. Research can never issue or promote an order/model.
"""

from __future__ import annotations

import argparse
import json
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

VERSION = "demo-unauthorized-entry-forward-proxy-v1"
APPROVED_PAIRS = frozenset(("AUDUSD", "EURUSD", "GBPUSD"))
APPROVED_ROUTES = frozenset(
    ("M1_TREND_CONTINUATION", "M1_CONFIRMED_REVERSAL", "M1_EARLY_TRANSITION")
)
APPROVED_PLANB_ROUTES = frozenset(
    ("TREND_CONTINUATION", "CONFIRMED_REVERSAL", "EARLY_TRANSITION")
)
KNOWN_ADMISSION_REASONS = (
    "EXIT_FEASIBILITY",
    "TRADE_QUALITY",
    "REGIME_TREND_EXTENDED",
    "DIRECTION_QUALITY",
    "META_EXPECTED_VALUE",
    "EXPECTED_R",
    "REGIME_TREND_WEAK",
    "CONFIDENCE_FLOOR",
    "SESSION_QUALITY",
    "PORTFOLIO_CONCENTRATION",
)
REQUIRED = (
    "instrument",
    "direction",
    "route",
    "planb_route",
    "paper_admitted",
    "admission_reasons_json",
    "decision_time_utc",
    "entry_bid",
    "entry_ask",
    "future_bid",
    "future_ask",
    "entry_seen_utc",
    "future_seen_utc",
)
MIN_QUALIFIED_DAYS = 12
HORIZON_MINUTES = 15
EXTRA_FRICTION_PIPS = 1.0


def safe_codes(value: object) -> frozenset[str]:
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        return frozenset()
    if not isinstance(parsed, list):
        return frozenset()
    return frozenset(
        code for code in parsed if isinstance(code, str) and code in KNOWN_ADMISSION_REASONS
    )


def prepare_cohort(raw: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    missing = sorted(set(REQUIRED) - set(raw.columns))
    if missing:
        raise ValueError(f"Missing fields: {', '.join(missing)}")
    rows = raw.copy()
    before = len(rows)
    for key in ("decision_time_utc", "entry_seen_utc", "future_seen_utc"):
        rows[key] = pd.to_datetime(rows[key], errors="coerce", utc=True)
    for key in ("entry_bid", "entry_ask", "future_bid", "future_ask"):
        rows[key] = pd.to_numeric(rows[key], errors="coerce")
    valid = (
        rows["instrument"].isin(APPROVED_PAIRS)
        & rows["direction"].isin(("BUY", "SELL"))
        & rows["route"].isin(APPROVED_ROUTES)
        & rows["planb_route"].isin(APPROVED_PLANB_ROUTES)
        & rows["paper_admitted"].isin((True, False, "true", "false"))
        & rows[["decision_time_utc", "entry_seen_utc", "future_seen_utc"]].notna().all(axis=1)
        & rows[["entry_bid", "entry_ask", "future_bid", "future_ask"]]
        .notna()
        .all(axis=1)
        & (rows["entry_bid"] > 0)
        & (rows["entry_ask"] >= rows["entry_bid"])
        & (rows["future_bid"] > 0)
        & (rows["future_ask"] >= rows["future_bid"])
        & (rows["entry_seen_utc"] <= rows["decision_time_utc"])
        & (rows["entry_seen_utc"] >= rows["decision_time_utc"] - timedelta(minutes=4))
        & (
            rows["future_seen_utc"]
            >= rows["decision_time_utc"] + timedelta(minutes=HORIZON_MINUTES)
        )
        & (
            rows["future_seen_utc"]
            <= rows["decision_time_utc"] + timedelta(minutes=HORIZON_MINUTES + 4)
        )
    )
    rows = rows.loc[valid].copy()
    rows = rows.replace([np.inf, -np.inf], np.nan).dropna(
        subset=["entry_bid", "entry_ask", "future_bid", "future_ask"]
    )
    rows["proxy_pips"] = (
        (
            rows["future_bid"] - rows["entry_ask"]
        ).where(
            rows["direction"] == "BUY",
            rows["entry_bid"] - rows["future_ask"],
        )
        / 0.0001
        - EXTRA_FRICTION_PIPS
    )
    rows["reason_codes"] = rows["admission_reasons_json"].map(safe_codes)
    rows = rows.sort_values(
        ["decision_time_utc", "instrument", "direction", "route"], kind="stable"
    ).drop_duplicates(
        ["decision_time_utc", "instrument", "direction", "route"], keep="first"
    )
    # Sample selection never depends on returns, labels, admission or blocker.
    last_by_pair: dict[str, pd.Timestamp] = {}
    chosen = []
    for index, item in rows.iterrows():
        prior = last_by_pair.get(item["instrument"])
        when = item["decision_time_utc"]
        if prior is not None and when <= prior + timedelta(minutes=HORIZON_MINUTES):
            continue
        chosen.append(index)
        last_by_pair[item["instrument"]] = when
    independent = rows.loc[chosen].copy()
    return independent, {
        "raw_count": int(before),
        "causally_valid_before_deoverlap": int(len(rows)),
        "independent_opportunities": int(len(independent)),
        "utc_days": int(independent["decision_time_utc"].dt.date.nunique()),
        "earliest_utc": (
            independent["decision_time_utc"].min().isoformat() if not independent.empty else None
        ),
        "latest_utc": (
            independent["decision_time_utc"].max().isoformat() if not independent.empty else None
        ),
    }


def price_proxy_summary(rows: pd.DataFrame) -> dict:
    if rows.empty:
        return {"n": 0, "mean_proxy_pips": None, "positive_fraction": None}
    return {
        "n": int(len(rows)),
        "mean_proxy_pips": round(float(rows["proxy_pips"].mean()), 3),
        "positive_fraction": round(float((rows["proxy_pips"] > 0).mean()), 3),
    }


def report_from_csv(source: Path) -> dict:
    cohort, quality = prepare_cohort(pd.read_csv(source))
    report = {
        "version": VERSION,
        "authority": "RESEARCH_ONLY_NO_EXECUTION",
        "model_fitted": False,
        "promotion_allowed": False,
        "broker_orders": 0,
        "cost_model": "observed bid/ask plus an estimated extra 1 pip",
        "actual_broker_net_pnl": False,
        "horizon_minutes": HORIZON_MINUTES,
        "sampling": "earliest per pair over disjoint >15m windows, across both sides/routes",
        "data_quality": quality,
        "overall": price_proxy_summary(cohort),
        "planb_routes": [
            {"route": route, **price_proxy_summary(group)}
            for route, group in cohort.groupby("planb_route", sort=True)
        ],
        "admission_reasons": [
            {
                "reason": reason,
                "utc_days": int(group["decision_time_utc"].dt.date.nunique()),
                **price_proxy_summary(group),
            }
            for reason in KNOWN_ADMISSION_REASONS
            if not (
                group := cohort.loc[cohort["reason_codes"].map(lambda codes: reason in codes)]
            ).empty
        ],
        "notes": (
            "Reasons overlap and cannot be summed. Provider price marks are not actual fills, "
            "SL/TP, broker commission or independent statistics across correlated pairs."
        ),
        "readiness": (
            "EXPLORATORY_INSUFFICIENT_DAYS"
            if quality["utc_days"] < MIN_QUALIFIED_DAYS
            else "EXPLORATORY_MATURE_ENOUGH_FOR_SEPARATE_VALIDATION"
        ),
    }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only DEMO rejected-admission price study")
    parser.add_argument("--cohort-csv", type=Path, required=True)
    parser.add_argument("--report-json", type=Path, required=True)
    args = parser.parse_args()
    if any(x in ("models", "artifacts", "production") for x in args.report_json.parts):
        raise ValueError("Never write research report into execution model directory")
    report = report_from_csv(args.cohort_csv)
    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "readiness": report["readiness"],
                "independent_opportunities": report["data_quality"]["independent_opportunities"],
                "utc_days": report["data_quality"]["utc_days"],
                "model_fitted": False,
                "promotion_allowed": False,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
