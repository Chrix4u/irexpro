"""Strict causal, overlapping and non-promoting near-miss entry shadow audits."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest

from app.domain.training.demo_entry_near_miss_shadow import (
    clean_cohort,
    independent_events,
    make_report,
)


def example(
    *,
    minute: int = 0,
    instrument: str = "GBPUSD",
    direction: str = "BUY",
    primary: bool = True,
) -> dict:
    t = datetime(2026, 11, 5, 13, 40, tzinfo=UTC) + timedelta(minutes=minute)
    return {
        "instrument": instrument,
        "direction": direction,
        "m1_route": "M1_EARLY_TRANSITION",
        "planb_route": "EARLY_TRANSITION",
        "drift_state": "NORMAL",
        "chosen_authority_path": "PRIMARY_PLAN_B" if primary else "BLOCKED",
        "blockers_json": json.dumps(
            ["M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED", "UNKNOWN_UNSAFE"]
        ),
        "decision_time_utc": t.isoformat(),
        "signal_bar_time_utc": (t - timedelta(minutes=1)).isoformat(),
        "entry_seen_utc": (t - timedelta(seconds=12)).isoformat(),
        "future_seen_5m_utc": (t + timedelta(minutes=5, seconds=30)).isoformat(),
        "future_seen_15m_utc": (t + timedelta(minutes=15, seconds=30)).isoformat(),
        "entry_bid": 1.1000,
        "entry_ask": 1.1002,
        "future_bid_5m": 1.1004,
        "future_ask_5m": 1.1006,
        "future_bid_15m": 1.1006,
        "future_ask_15m": 1.1008,
    }


def test_buy_sell_spread_included_and_extra_friction_applied() -> None:
    records, quality = clean_cohort(pd.DataFrame([example(), example(minute=20, direction="SELL")]))
    assert quality["causally_verified"] == 2
    assert records["proxy_5m_pips"].tolist() == pytest.approx([1, -7])
    assert records["proxy_15m_pips"].tolist() == pytest.approx([3, -9])


@pytest.mark.parametrize(
    "field,value",
    [
        ("entry_seen_utc", "2026-11-05T13:40:01+00:00"),
        ("future_seen_5m_utc", "2026-11-05T13:43:01+00:00"),
        ("future_seen_15m_utc", "2026-11-05T13:49:01+00:00"),
        ("signal_bar_time_utc", "2026-11-05T13:41:00+00:00"),
        ("entry_ask", 1.0999),
        ("future_bid_5m", -1),
        ("future_ask_15m", "NaN"),
        ("instrument", "USDJPY"),
        ("direction", "UNKNOWN"),
    ],
)
def test_unusable_quote_timestamps_spreads_and_unapproved_market_excluded(
    field: str, value: object
) -> None:
    row = example()
    row[field] = value
    result, quality = clean_cohort(pd.DataFrame([row]))
    assert result.empty
    assert quality["excluded"] == 1


def test_dedupe_one_per_pair_per_15m_across_both_sides() -> None:
    rows = [
        example(minute=0, direction="BUY"),
        example(minute=2, direction="SELL", primary=False),
        example(minute=16, direction="SELL"),
        example(minute=2, instrument="EURUSD", direction="BUY"),
    ]
    data, _ = clean_cohort(pd.DataFrame(rows))
    events = independent_events(data)
    assert len(events) == 3
    assert list(events["instrument"]).count("GBPUSD") == 2
    assert len(independent_events(data.loc[data["chosen_authority_path"] == "PRIMARY_PLAN_B"])) == 3


def test_duplicate_same_bar_is_not_counted_twice() -> None:
    records, quality = clean_cohort(pd.DataFrame([example(), example()]))
    assert len(records) == 1
    assert quality["excluded"] == 1


def test_empty_cohort_fails_safe_without_false_profit_claim() -> None:
    report = make_report(pd.DataFrame(columns=list(example())))
    assert report["data_quality"]["independent_opportunities"] == 0
    assert report["readiness"] == "INSUFFICIENT_INDEPENDENT_HISTORY"
    assert report["promotion_allowed"] is False
    assert report["model_fitted"] is False
    assert report["broker_net_pnl_verified"] is False
    assert report["all_proposed_but_unauthorized"]["15m"]["mean_proxy_pips"] is None


def test_primary_subset_does_not_disappear_when_prior_blocked_signal_overlaps() -> None:
    records = [
        example(minute=0, primary=False),
        example(minute=2, primary=True),
        example(minute=20, primary=False),
    ]
    report = make_report(pd.DataFrame(records))
    assert report["data_quality"]["independent_opportunities"] == 2
    assert report["fully_primary_admitted_but_vetoed"]["n"] == 1
    assert report["fully_primary_admitted_but_vetoed"]["15m"]["positive_count"] == 1
    assert report["leading_overlapping_blockers"] == [
        {"code": "M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED", "n": 2}
    ]


def test_prior_false_probation_code_is_excluded_when_no_executable_path() -> None:
    row = example(primary=False)
    row["blockers_json"] = json.dumps(
        ["M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION", "MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED"]
    )
    report = make_report(pd.DataFrame([row]))
    assert report["leading_overlapping_blockers"] == [
        {"code": "MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED", "n": 1}
    ]


def test_even_large_synthetic_multi_day_positive_cohort_never_promotes() -> None:
    rows = []
    for day in range(12):
        start = datetime(2026, 10, 5, 12, 0, tzinfo=UTC) + timedelta(days=day)
        for j in range(10):
            instrument = ("AUDUSD", "EURUSD", "GBPUSD")[j % 3]
            item = example(minute=0, instrument=instrument)
            moment = start + timedelta(minutes=j * 16)
            item["decision_time_utc"] = moment.isoformat()
            item["signal_bar_time_utc"] = (moment - timedelta(minutes=1)).isoformat()
            item["entry_seen_utc"] = (moment - timedelta(seconds=10)).isoformat()
            item["future_seen_5m_utc"] = (moment + timedelta(minutes=5, seconds=30)).isoformat()
            item["future_seen_15m_utc"] = (moment + timedelta(minutes=15, seconds=30)).isoformat()
            rows.append(item)
    report = make_report(pd.DataFrame(rows))
    assert report["data_quality"]["independent_opportunities"] == 120
    assert report["data_quality"]["distinct_utc_days"] == 12
    assert report["readiness"] == "RESEARCH_COHORT_MATURE_NOT_AUTOPROMOTABLE"
    assert report["promotion_allowed"] is False
    assert report["model_fitted"] is False
    assert report["changes_live_entry_gate"] is False
    assert report["broker_order_writes"] is False


def test_sql_and_existing_scheduled_runner_are_private_readonly_scoped() -> None:
    root = Path(__file__).resolve().parents[3]
    query = (
        root / "services/ai-engine/app/domain/training/demo_entry_near_miss_readonly.sql"
    ).read_text()
    runner = (root / "scripts/research/run_ood_shadow_training.sh").read_text()
    assert "d.user_id::text = :'scanner_user'" in query
    assert "bc.account_type = 'DEMO'" in query
    assert "bc.broker_id = 'ctrader'" in query
    assert "d.execution_authority = 'NONE'" in query
    assert "paperAdmitted" in query
    assert "'ABSTAIN'" not in query
    assert "q.source = 'ctrader-broker-native'" in query
    assert "q.last_quote_sample_at <= c.evaluated_at" in query
    assert "c.evaluated_at + INTERVAL '5 minutes'" in query
    assert "c.evaluated_at + INTERVAL '15 minutes'" in query
    output_columns = query.split("SELECT\n  c.instrument", 1)[1].split("FROM cohort c", 1)[0]
    assert "user_id" not in output_columns
    assert "broker_connection_id" not in output_columns
    assert "external_order" not in output_columns
    assert "INSERT INTO" not in query.upper()
    assert "UPDATE trading" not in query
    assert "DELETE FROM" not in query
    assert "demo_entry_near_miss_readonly.sql" in runner
    assert "demo_entry_near_miss_shadow" in runner
    assert "latest-near-miss-report.json" in runner
