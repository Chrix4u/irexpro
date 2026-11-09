"""Regression checks for execution-inert Plan B regime near-miss research."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pandas as pd
import pytest

from app.domain.training.planb_extended_nearmiss_shadow import (
    build_report,
    non_overlapping,
    prepare,
)


def example(
    decision_time: datetime | None = None,
    *,
    instrument: str = "EURUSD",
    direction: str = "BUY",
) -> dict:
    t = decision_time or datetime(2026, 11, 9, 8, 2, tzinfo=UTC)
    data = {
        "instrument": instrument,
        "direction": direction,
        "route": "M1_TREND_CONTINUATION",
        "plan_b_regime": "TREND_EXTENDED",
        "plan_b_paper_admitted": "false",
        "decision_time_utc": t.isoformat(),
        "decision_available_at_utc": (t + timedelta(seconds=50)).isoformat(),
        "entry_quote_at": (t + timedelta(seconds=57)).isoformat(),
        "future_quote_at": (t + timedelta(minutes=15, seconds=58)).isoformat(),
        "entry_quote_source": "ctrader-broker-native",
        "future_quote_source": "ctrader-broker-native",
        "proposed_entry": 1.11728,
        "stop_loss": 1.11678,
        "take_profit": 1.11808,
        "entry_bid": 1.11742,
        "entry_ask": 1.11742,
        "future_bid": 1.11771,
        "future_ask": 1.11772,
        "decision_spread": 0.000019,
        "possible_low": 1.11721,
        "possible_high": 1.11788,
        "path_m1_bars": 15,
        "first_target_close_at": (t + timedelta(minutes=21)).isoformat(),
        "first_stop_close_at": None,
        "first_possible_mid_stop_at": None,
        "last_observed_m1_bar_at": (t + timedelta(minutes=25)).isoformat(),
        "aligned_m5": 1,
        "aligned_m15": 1,
        "aligned_h1": -0.33481167,
        "aligned_h4": -0.785178,
    }
    if direction == "SELL":
        data.update(
            {
                "stop_loss": 1.11778,
                "take_profit": 1.11648,
                "future_bid": 1.11700,
                "future_ask": 1.11702,
                "possible_high": 1.11755,
                "possible_low": 1.11695,
            }
        )
    return data


def test_case_matches_802_missed_buy_without_ever_authorizing_execution() -> None:
    report = build_report(
        pd.DataFrame([example()]),
        inspect_at="2026-11-09T08:02:00Z",
    )
    case = report["inspection"]
    assert case is not None
    assert case["entry_signal"] == pytest.approx(1.11728)
    assert case["conservative_entry_quote_proxy"] == pytest.approx(1.117439)
    assert case["decision_available_at_utc"] == "2026-11-09T08:02:50+00:00"
    assert case["future_bid_quote"] == pytest.approx(1.11771)
    assert case["fifteen_min_proxy_pips"] == pytest.approx(1.71)
    assert case["possible_stop_touch_midpoint_only"] is False
    assert case["possible_target_touch_midpoint_only"] is False
    assert case["first_target_bidask_quote_close_at"] == "2026-11-09T08:23:00+00:00"
    assert case["target_before_stop_quote_close"] is True
    assert case["full_60_minute_observation"] is False
    assert report["model_fitted"] is False
    assert report["execution_allowed"] is False
    assert report["promotion_allowed"] is False
    assert report["authority"] == "NONE"
    assert report["broker_net_pnl_verified"] is False


def test_sell_uses_bid_entry_and_conservative_future_ask() -> None:
    row = example(direction="SELL")
    row["first_target_close_at"] = None
    verified, quality = prepare(pd.DataFrame([row]))
    assert quality["causally_qualified_rows"] == 1
    assert verified.iloc[0]["proxy_entry"] == pytest.approx(1.11728)
    assert verified.iloc[0]["proxy_exit"] == pytest.approx(1.11702)
    assert verified.iloc[0]["fifteen_min_proxy_pips"] == pytest.approx(1.6)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("entry_quote_source", "synthetic-midpoint"),
        ("future_quote_source", "metaapi-rpc-sampled"),
        ("path_m1_bars", 12),
        ("decision_spread", -0.0001),
        ("entry_quote_at", "2026-11-09T08:02:20Z"),
        ("decision_available_at_utc", "2026-11-09T08:03:59Z"),
        ("future_quote_at", "2026-11-09T08:11:00Z"),
        ("future_bid", 0),
        ("stop_loss", 1.1185),
        ("proposed_entry", 1.11),
        ("plan_b_regime", "ROLLOVER_RISK"),
        ("instrument", "USDJPY"),
    ],
)
def test_invalid_or_noncausal_quotes_cannot_enter_outcome_report(
    field: str, value: object
) -> None:
    row = example()
    row[field] = value
    report = build_report(pd.DataFrame([row]))
    assert report["data_quality"]["causally_qualified_rows"] == 0
    assert report["independent_episodes"] == 0
    assert report["inspection"] is None


def test_cohort_cooldown_de_duplicates_across_sides_and_regimes() -> None:
    t = datetime(2026, 11, 9, 8, 2, tzinfo=UTC)
    first = example(t)
    ten_minutes_later = example(t + timedelta(minutes=10), direction="SELL")
    thirty_minutes_later = example(t + timedelta(minutes=31))
    second_pair = example(t + timedelta(minutes=12), instrument="GBPUSD")
    data, _ = prepare(
        pd.DataFrame([first, ten_minutes_later, thirty_minutes_later, second_pair])
    )
    independent = non_overlapping(data)
    assert len(independent) == 3
    assert independent["instrument"].tolist().count("EURUSD") == 2
    assert independent["instrument"].tolist().count("GBPUSD") == 1


def test_earlier_possible_stop_makes_later_target_quote_close_ambiguous() -> None:
    row = example()
    row["first_possible_mid_stop_at"] = "2026-11-09T08:07:00Z"
    report = build_report(pd.DataFrame([row]), inspect_at="2026-11-09T08:02:00Z")
    assert report["inspection"]["target_before_stop_quote_close"] is False
    assert report["overall"]["target_before_stop_quote_closes"] == 0
    assert report["broker_net_pnl_verified"] is False


def test_same_minute_midpoint_stop_touch_never_counts_as_certain_target_first() -> None:
    row = example()
    row["first_possible_mid_stop_at"] = row["first_target_close_at"]
    report = build_report(pd.DataFrame([row]), inspect_at="2026-11-09T08:02:00Z")
    assert report["inspection"]["target_before_stop_quote_close"] is False
    assert report["overall"]["target_before_stop_quote_closes"] == 0
    assert report["execution_allowed"] is False


def test_midpoint_stop_or_target_touches_are_not_misreported_as_fills() -> None:
    row = example()
    row["possible_low"] = 1.1167
    row["possible_high"] = 1.1182
    report = build_report(pd.DataFrame([row]))
    assert report["overall"]["possible_stop_touches"] == 1
    assert report["overall"]["possible_target_touches"] == 1
    assert report["broker_net_pnl_verified"] is False
    assert "possible" in report["limitations"]
    assert report["execution_allowed"] is False
