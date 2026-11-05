"""Read-only research on proposed but unauthorized cTrader DEMO entries.

No signal dispatch, broker trades, model serialization, execution approval,
risk changes or automated policy relaxation. Uses independently observed
bid/ask quotes 5 and 15 minutes after each decision, minus an ADDITIONAL
1-pip friction placeholder. This is not actual fill or broker net P&L.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from datetime import timedelta
from pathlib import Path

import pandas as pd

APPROVED_INSTRUMENTS = frozenset(("AUDUSD", "EURUSD", "GBPUSD"))
APPROVED_ROUTES = frozenset(
    ("M1_TREND_CONTINUATION", "M1_EARLY_TRANSITION", "M1_CONFIRMED_REVERSAL")
)
APPROVED_PLAN_B_ROUTES = frozenset(("TREND_CONTINUATION", "EARLY_TRANSITION", "CONFIRMED_REVERSAL"))
KNOWN_BLOCKERS = frozenset(
    (
        "M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED",
        "M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK",
        "MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED",
        "MULTIMODEL_CONTINUATION_TIMING_NOT_READY",
        "M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION",
        "DRIFT_OUT_OF_DISTRIBUTION",
        "PAPER_NET_EXPECTED_R",
        "EVENT_RISK_HIGH_IMPACT_BLOCK",
        "M1_DEMO_BROKER_COMMISSION_NET_EDGE_BELOW_FLOOR",
        "M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE",
    )
)
VALID_DRIFT = frozenset(("NORMAL", "STRESSED", "OUT_OF_DISTRIBUTION"))
REQUIRED = (
    "instrument",
    "direction",
    "m1_route",
    "planb_route",
    "drift_state",
    "chosen_authority_path",
    "blockers_json",
    "decision_time_utc",
    "signal_bar_time_utc",
    "entry_bid",
    "entry_ask",
    "entry_seen_utc",
    "future_bid_5m",
    "future_ask_5m",
    "future_seen_5m_utc",
    "future_bid_15m",
    "future_ask_15m",
    "future_seen_15m_utc",
)
PRICE_FIELDS = (
    "entry_bid",
    "entry_ask",
    "future_bid_5m",
    "future_ask_5m",
    "future_bid_15m",
    "future_ask_15m",
)
TIME_FIELDS = (
    "decision_time_utc",
    "signal_bar_time_utc",
    "entry_seen_utc",
    "future_seen_5m_utc",
    "future_seen_15m_utc",
)
PIP_SIZE = 0.0001  # Only selected non-JPY majors
EXTRA_FRICTION_PIPS = 1.0
INDEPENDENT_WINDOW_MINUTES = 15
MIN_EVALUATION_DAYS = 12
MIN_INDEPENDENT_OPPORTUNITIES = 100
SHADOW_ARTIFACT = "ctrader-demo-near-miss-price-path-v1"


def parse_codes(value: object) -> frozenset[str]:
    try:
        raw = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        return frozenset()
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(code for code in raw if isinstance(code, str) and code in KNOWN_BLOCKERS)


def empty_cohort(records: pd.DataFrame) -> pd.DataFrame:
    """Empty reports need numeric proxy columns, not fake zero outcomes."""
    result = records.head(0).copy()
    for column in ("proxy_5m_pips", "proxy_15m_pips"):
        result[column] = pd.Series(dtype=float)
    result["reason_codes"] = pd.Series(dtype=object)
    result["day_utc"] = pd.Series(dtype=object)
    return result


def clean_cohort(raw: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Reject future-leaked or mismatched quotes; report why rows vanished."""
    missing = sorted(set(REQUIRED) - set(raw.columns))
    if missing:
        raise ValueError(f"Missing expected columns: {', '.join(missing)}")
    records = raw.copy()
    count_before = len(records)
    if records.empty:
        return empty_cohort(records), {"raw": 0, "causally_verified": 0, "excluded": 0}

    for field in TIME_FIELDS:
        records[field] = pd.to_datetime(records[field], errors="coerce", utc=True)
    for field in PRICE_FIELDS:
        records[field] = pd.to_numeric(records[field], errors="coerce")
    eligible = (
        records["instrument"].isin(APPROVED_INSTRUMENTS)
        & records["direction"].isin(("BUY", "SELL"))
        & records["m1_route"].isin(APPROVED_ROUTES)
        & records["planb_route"].isin(APPROVED_PLAN_B_ROUTES)
        & records["drift_state"].isin(VALID_DRIFT)
        & records[list(TIME_FIELDS)].notna().all(axis=1)
        & records[list(PRICE_FIELDS)].notna().all(axis=1)
        & records[list(PRICE_FIELDS)].apply(lambda col: col.map(math.isfinite)).all(axis=1)
        & (records["signal_bar_time_utc"] <= records["decision_time_utc"])
        & (records["entry_seen_utc"] <= records["decision_time_utc"])
        & (records["entry_seen_utc"] >= records["decision_time_utc"] - timedelta(minutes=4))
        & (records["future_seen_5m_utc"] >= records["decision_time_utc"] + timedelta(minutes=5))
        & (records["future_seen_5m_utc"] <= records["decision_time_utc"] + timedelta(minutes=9))
        & (records["future_seen_15m_utc"] >= records["decision_time_utc"] + timedelta(minutes=15))
        & (records["future_seen_15m_utc"] <= records["decision_time_utc"] + timedelta(minutes=19))
        & (records["entry_bid"] > 0)
        & (records["entry_ask"] >= records["entry_bid"])
        & (records["future_bid_5m"] > 0)
        & (records["future_ask_5m"] >= records["future_bid_5m"])
        & (records["future_bid_15m"] > 0)
        & (records["future_ask_15m"] >= records["future_bid_15m"])
    )
    records = records.loc[eligible].copy()
    if records.empty:
        return empty_cohort(records), {
            "raw": count_before,
            "causally_verified": 0,
            "excluded": count_before,
        }

    # Provider bid/ask prices determine the hypothetical quote mark-to-market.
    # Added 1 pip is only a conservative placeholder, NOT audited commission.
    for horizon in ("5m", "15m"):
        records[f"proxy_{horizon}_pips"] = (
            (records[f"future_bid_{horizon}"] - records["entry_ask"]).where(
                records["direction"] == "BUY",
                records["entry_bid"] - records[f"future_ask_{horizon}"],
            )
            / PIP_SIZE
        ) - EXTRA_FRICTION_PIPS
    records["reason_codes"] = records["blockers_json"].map(parse_codes)

    # Mirror the corrected live gate: old decisions marked probation BLOCKED
    # despite having no independently executable fallback. Do not attribute
    # those rejected primaries to the probation veto in historical reports.
    def true_reasons(row: pd.Series) -> frozenset[str]:
        reasons = row["reason_codes"]
        if row["chosen_authority_path"] in ("BLOCKED", "UNKNOWN"):
            return reasons - {"M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION"}
        return reasons

    records["reason_codes"] = records.apply(true_reasons, axis=1)
    records["day_utc"] = records["decision_time_utc"].dt.date
    # One persisted decision/bar/direction even if recorder duplicates it.
    records = (
        records.sort_values("decision_time_utc")
        .drop_duplicates(
            subset=["instrument", "m1_route", "direction", "signal_bar_time_utc"],
            keep="first",
        )
        .reset_index(drop=True)
    )
    return records, {
        "raw": count_before,
        "causally_verified": len(records),
        "excluded": count_before - len(records),
    }


def independent_events(records: pd.DataFrame) -> pd.DataFrame:
    """One eligible observation per instrument per 15m, across BOTH sides.

    This prevents a cluster of overlapping one-minute predictions from
    masquerading as independent, simultaneously executable opportunities.
    """
    if records.empty:
        return records.copy()
    chosen = []
    last_seen = {}
    for index, row in records.sort_values("decision_time_utc").iterrows():
        pair = row["instrument"]
        t = row["decision_time_utc"]
        if pair in last_seen and t - last_seen[pair] < timedelta(
            minutes=INDEPENDENT_WINDOW_MINUTES
        ):
            continue
        last_seen[pair] = t
        chosen.append(index)
    return records.loc[chosen].reset_index(drop=True)


def metrics(frame: pd.DataFrame) -> dict:
    result = {"n": len(frame)}
    for horizon in ("5m", "15m"):
        values = frame[f"proxy_{horizon}_pips"]
        result[horizon] = {
            "mean_proxy_pips": round(float(values.mean()), 3) if len(values) else None,
            "positive_proxy_fraction": round(float((values > 0).mean()), 3)
            if len(values)
            else None,
            "positive_count": int((values > 0).sum()),
        }
    return result


def make_report(raw: pd.DataFrame) -> dict:
    records, quality = clean_cohort(raw)
    independent = independent_events(records)
    days = int(independent["day_utc"].nunique()) if len(independent) else 0

    def bucketed(column: str) -> list[dict]:
        if independent.empty:
            return []
        result = []
        for key, frame in independent.groupby(column):
            result.append({"group": str(key), **metrics(frame)})
        return sorted(result, key=lambda item: (-item["n"], item["group"]))

    veto_counts = (
        Counter(code for codes in independent["reason_codes"] for code in codes)
        if len(independent)
        else Counter()
    )
    # Independently de-overlap primary proposals WITHIN that precise cohort,
    # rather than losing primary near misses to earlier non-primary proposals
    # on the same pair. Both cohorts are separately non-independent of each
    # other, and must never be added as if they were distinct.
    primary = independent_events(records.loc[records["chosen_authority_path"] == "PRIMARY_PLAN_B"])
    primary_veto_counts = (
        Counter(code for codes in primary["reason_codes"] for code in codes)
        if len(primary)
        else Counter()
    )
    report = {
        "artifact": SHADOW_ARTIFACT,
        "mode": "READ_ONLY_COUNTERFACTUAL_RESEARCH",
        "broker_order_writes": False,
        "model_fitted": False,
        "promotion_allowed": False,
        "changes_live_entry_gate": False,
        "broker_net_pnl_verified": False,
        "label_horizons_minutes": [5, 15],
        "price_return": "pre-decision bid/ask to future bid/ask",
        "extra_cost_placeholder_pips": EXTRA_FRICTION_PIPS,
        "overlap_control": "earliest observed decision per pair per 15m",
        "data_quality": {
            **quality,
            "independent_opportunities": len(independent),
            "distinct_utc_days": days,
            "last_observed_utc": (
                independent["decision_time_utc"].max().isoformat() if len(independent) else None
            ),
        },
        "all_proposed_but_unauthorized": metrics(independent),
        "fully_primary_admitted_but_vetoed": metrics(primary),
        "primary_veto_reasons": [
            {"code": key, "n": int(value)} for key, value in primary_veto_counts.most_common(12)
        ],
        "by_planb_route": bucketed("planb_route"),
        "by_m1_route": bucketed("m1_route"),
        "by_drift": bucketed("drift_state"),
        "by_instrument": bucketed("instrument"),
        "leading_overlapping_blockers": [
            {"code": key, "n": int(value)} for key, value in veto_counts.most_common(12)
        ],
        "readiness": (
            "RESEARCH_COHORT_MATURE_NOT_AUTOPROMOTABLE"
            if days >= MIN_EVALUATION_DAYS and len(independent) >= MIN_INDEPENDENT_OPPORTUNITIES
            else "INSUFFICIENT_INDEPENDENT_HISTORY"
        ),
    }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only DEMO counterfactual gate audit")
    parser.add_argument("--cohort-csv", required=True, type=Path)
    parser.add_argument("--report-json", required=True, type=Path)
    args = parser.parse_args()
    if any(part in ("models", "artifacts", "production") for part in args.report_json.parts):
        raise ValueError("Refusing to write a near-miss report into a model-serving path")
    report = make_report(pd.read_csv(args.cohort_csv))
    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(
        "NEAR_MISS_READ_ONLY=TRUE "
        f"verified={report['data_quality']['causally_verified']} "
        f"independent={report['data_quality']['independent_opportunities']} "
        f"days={report['data_quality']['distinct_utc_days']} "
        f"readiness={report['readiness']} "
        "model_fitted=FALSE promotion_allowed=FALSE"
    )


if __name__ == "__main__":
    main()
