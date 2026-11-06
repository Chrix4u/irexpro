"""Research-only first-barrier *quote-close* audit for unexecuted DEMO decisions.

Causally linked broker quote-sampled M1 candles permit historical side-specific
quote-close barrier observations, NOT exact first-tick fills. Midpoint OHLC
and an intentionally conservative spread envelope flag possible earlier
intrabar adverse touches as ambiguous. No execution, prediction or promotion.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from datetime import timedelta
from pathlib import Path

import pandas as pd

VERSION = "demo-rejected-first-hit-quote-close-v1"
PAIRS = frozenset(("AUDUSD", "EURUSD", "GBPUSD"))
ROUTES = frozenset(("M1_TREND_CONTINUATION", "M1_EARLY_TRANSITION", "M1_CONFIRMED_REVERSAL"))
PIP = 0.0001
EXTRA_FRICTION_PIPS = 1.0
HORIZON_MINUTES = 30
DEOVERLAP_MINUTES = 15
MAX_ENTRY_AGE_SECONDS = 180
MAX_SPREAD = 0.002


def timestamp(value: object) -> pd.Timestamp:
    return pd.to_datetime(value, errors="raise", utc=True)


def nonnegative_float(value: object) -> float:
    v = float(value)
    if not math.isfinite(v) or v < 0:
        raise ValueError("Invalid price/geometry")
    return v


def valid_decision(row: dict) -> bool:
    return (
        row.get("instrument") in PAIRS
        and row.get("direction") in ("BUY", "SELL")
        and row.get("route") in ROUTES
        and row.get("paper_admitted") in (True, False, "true", "false")
        and timestamp(row["entry_seen_utc"]) <= timestamp(row["decision_time_utc"])
        and timedelta(0) <= timestamp(row["decision_time_utc"]) - timestamp(row["entry_seen_utc"]) <= timedelta(seconds=MAX_ENTRY_AGE_SECONDS)
        and 0 < nonnegative_float(row["entry_bid"]) <= nonnegative_float(row["entry_ask"])
        and 0 < nonnegative_float(row["stop_distance"]) <= 0.02
        and 0 < nonnegative_float(row["target_distance"]) <= 0.04
    )


def evaluate_decision(row: dict) -> dict:
    decision = timestamp(row["decision_time_utc"])
    entry_bid = nonnegative_float(row["entry_bid"])
    entry_ask = nonnegative_float(row["entry_ask"])
    stop_distance = nonnegative_float(row["stop_distance"])
    target_distance = nonnegative_float(row["target_distance"])
    direction = row["direction"]
    entry = entry_ask if direction == "BUY" else entry_bid
    stop = entry - stop_distance if direction == "BUY" else entry + stop_distance
    target = entry + target_distance if direction == "BUY" else entry - target_distance
    result = {
        "instrument": row["instrument"],
        "direction": direction,
        "route": row["route"],
        "planb_route": row.get("planb_route"),
        "paper_admitted": row["paper_admitted"] in (True, "true"),
        "decision_time_utc": decision.isoformat(),
        "entry_price": round(entry, 7),
        "stop_price": round(stop, 7),
        "target_price": round(target, 7),
        "status": "UNOBSERVABLE_PRICE_PATH",
        "first_quote_close_at_utc": None,
        "gross_r_if_target": round(target_distance / stop_distance, 3),
        "illustrative_target_r_after_extra_one_pip": round(
            (target_distance - EXTRA_FRICTION_PIPS * PIP) / stop_distance, 3
        ),
        "contains_possible_intrabar_adverse_touch": False,
        "bars_evaluated": 0,
    }
    if target <= 0 or stop <= 0 or entry <= 0:
        return result
    raw = row.get("minute_path_json", "[]")
    bars = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(bars, list):
        return result
    bars = sorted(bars, key=lambda item: str(item.get("minute", "")) if isinstance(item, dict) else "")
    start_minute = decision.floor("min")
    prior_tp_wick = False
    prior_sl_wick = False
    entry_spread = entry_ask - entry_bid
    if not 0 <= entry_spread <= MAX_SPREAD:
        return result
    for index in range(HORIZON_MINUTES + 1):
        if index >= len(bars) or not isinstance(bars[index], dict):
            result["status"] = "UNOBSERVABLE_PRICE_PATH"
            return result
        bar = bars[index]
        minute = timestamp(bar["minute"])
        if minute != start_minute + timedelta(minutes=index):
            result["status"] = "UNOBSERVABLE_PRICE_PATH"
            return result
        if index == 0 and timestamp(bar["first_seen"]) < decision:
            result["status"] = "UNOBSERVABLE_ENTRY_BAR"
            return result
        seen = timestamp(bar["last_seen"])
        if not (minute <= seen < minute + timedelta(minutes=1)):
            result["status"] = "UNOBSERVABLE_PRICE_PATH"
            return result
        mid_high = nonnegative_float(bar["mid_high"])
        mid_low = nonnegative_float(bar["mid_low"])
        bid = nonnegative_float(bar["bid_close"])
        ask = nonnegative_float(bar["ask_close"])
        spread = nonnegative_float(bar["spread_close"])
        if not (0 < mid_low <= mid_high and 0 < bid <= ask and spread <= MAX_SPREAD):
            result["status"] = "UNOBSERVABLE_PRICE_PATH"
            return result
        # Mid OHLC is not bid/ask tick OHLC. The 2x spread plus 1 pip
        # deliberately OVER-approximates possible wick hits, never proves
        # a wick touched. Stable *quote closes* are treated separately.
        spread_buffer = 2 * max(entry_spread, spread) + PIP
        if direction == "BUY":
            tp_close = bid >= target
            sl_close = bid <= stop
            tp_wick_possible = mid_high + spread_buffer >= target
            sl_wick_possible = mid_low - spread_buffer <= stop
        else:
            tp_close = ask <= target
            sl_close = ask >= stop
            tp_wick_possible = mid_low - spread_buffer <= target
            sl_wick_possible = mid_high + spread_buffer >= stop

        result["bars_evaluated"] = index + 1
        prior_tp_wick = prior_tp_wick or tp_wick_possible
        prior_sl_wick = prior_sl_wick or sl_wick_possible
        result["contains_possible_intrabar_adverse_touch"] = prior_sl_wick

        if tp_close and sl_close:
            result["status"] = "AMBIGUOUS_SAME_BAR"
            result["first_quote_close_at_utc"] = seen.isoformat()
            return result
        if tp_close:
            result["status"] = (
                "AMBIGUOUS_POSSIBLE_SL_BEFORE_TP"
                if prior_sl_wick
                else "TP_FIRST_QUOTE_CLOSE_PROXY"
            )
            result["first_quote_close_at_utc"] = seen.isoformat()
            return result
        if sl_close:
            result["status"] = (
                "AMBIGUOUS_POSSIBLE_TP_BEFORE_SL"
                if prior_tp_wick
                else "SL_FIRST_QUOTE_CLOSE_PROXY"
            )
            result["first_quote_close_at_utc"] = seen.isoformat()
            return result

    result["status"] = (
        "UNRESOLVED_WICK_AMBIGUITY"
        if prior_tp_wick or prior_sl_wick
        else "NO_QUOTE_CLOSE_BARRIER_30M"
    )
    return result


def report_from_csv(path: Path) -> dict:
    source = pd.read_csv(path, dtype=str)
    required = {
        "instrument", "direction", "route", "paper_admitted",
        "decision_time_utc", "stop_distance", "target_distance",
        "entry_bid", "entry_ask", "entry_seen_utc", "minute_path_json",
    }
    if not required.issubset(set(source.columns)):
        raise ValueError("Missing required source fields")
    records = []
    discarded = 0
    for row in source.to_dict(orient="records"):
        try:
            if not valid_decision(row):
                discarded += 1
                continue
            records.append(row)
        except (ValueError, TypeError, KeyError, OverflowError):
            discarded += 1
    records.sort(key=lambda row: (timestamp(row["decision_time_utc"]), row["instrument"], row["direction"], row["route"]))
    # Admission, return or result NEVER influences chronological sampling.
    independent = []
    last_by_pair: dict[str, pd.Timestamp] = {}
    for row in records:
        at = timestamp(row["decision_time_utc"])
        last = last_by_pair.get(row["instrument"])
        if last is not None and at <= last + timedelta(minutes=DEOVERLAP_MINUTES):
            continue
        independent.append(row)
        last_by_pair[row["instrument"]] = at

    evaluated = []
    for row in independent:
        try:
            evaluated.append(evaluate_decision(row))
        except (ValueError, TypeError, KeyError, OverflowError):
            evaluated.append({
                "instrument": row["instrument"], "direction": row["direction"],
                "route": row["route"], "decision_time_utc": timestamp(row["decision_time_utc"]).isoformat(),
                "status": "UNOBSERVABLE_PRICE_PATH",
            })

    counts = Counter(outcome["status"] for outcome in evaluated)
    def grouped_status(field: str) -> dict[str, dict[str, int]]:
        return {
            name: dict(sorted(Counter(o["status"] for o in evaluated if str(o.get(field)) == name).items()))
            for name in sorted({str(o.get(field)) for o in evaluated})
        }
    post_start = [
        o for o in evaluated
        if o["decision_time_utc"] >= "2026-11-05T13:05:33+00:00"
    ]
    # The user-highlighted example may overlap an earlier independent
    # episode and thus MUST be audited separately without adding it to totals.
    target_case = next((
        row for row in records
        if row["instrument"] == "AUDUSD"
        and row["direction"] == "SELL"
        and timestamp(row["decision_time_utc"]) == pd.Timestamp("2026-11-05T14:29:00Z")
    ), None)
    example = evaluate_decision(target_case) if target_case is not None else None
    return {
        "version": VERSION,
        "execution_authority": "RESEARCH_ONLY_NO_BROKER_ORDERS",
        "model_fitted": False,
        "promotion_allowed": False,
        "broker_orders": 0,
        "actual_fills_or_verified_commissions": False,
        "cost_model": "quoted bid/ask entry; original stop/target; estimated 1 pip additional friction only",
        "outcome_limitations": "side-specific closing quote and MIDPOINT sampled wicks; not complete tick high/low; ambiguous first hits and gaps remain unresolved",
        "source_rows": int(len(source)),
        "invalid_source_rows": discarded,
        "independent_candidates": len(evaluated),
        "covered_utc_days": len({o["decision_time_utc"][:10] for o in evaluated}),
        "first_quote_close_statuses": dict(sorted(counts.items())),
        "status_by_instrument": grouped_status("instrument"),
        "status_by_m1_route": grouped_status("route"),
        "status_by_paper_admitted": grouped_status("paper_admitted"),
        "nov5_session_reference_subset": {
            "count": len(post_start),
            "status_counts": dict(sorted(Counter(o["status"] for o in post_start).items())),
        },
        "audusd_nov5_1429": example,
        "case_examples": (
            [
                {key: value for key, value in o.items()
                 if key in ("instrument","direction","route","decision_time_utc","status","first_quote_close_at_utc")}
                for o in evaluated if o["status"] == "TP_FIRST_QUOTE_CLOSE_PROXY"
            ][:8]
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Strict read-only first-hit quote-close shadow audit")
    parser.add_argument("--cohort-csv", type=Path, required=True)
    parser.add_argument("--report-json", type=Path, required=True)
    args = parser.parse_args()
    if any(part in ("models", "artifacts", "production") for part in args.report_json.parts):
        raise ValueError("Research report cannot be written into model/execution directories")
    report = report_from_csv(args.cohort_csv)
    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    print(json.dumps({
        "version": VERSION,
        "sample": report["independent_candidates"],
        "outcomes": report["first_quote_close_statuses"],
        "example": report["audusd_nov5_1429"],
        "promotion_allowed": False,
        "broker_orders": 0,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
