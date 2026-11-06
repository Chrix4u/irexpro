"""Causal, unexecuted cTrader DEMO first-hit research; no broker writes."""
import json
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd

from app.domain.training.demo_rejected_first_hit_shadow import (
    evaluate_decision,
    report_from_csv,
    valid_decision,
)


def fixture(direction="SELL", stop_distance=0.0005, target_distance=0.0008):
    when = datetime(2026, 11, 5, 14, 29, tzinfo=UTC)
    entry_bid = 1.1000
    entry_ask = 1.10002
    bars = []
    for minute in range(31):
        at = when + timedelta(minutes=minute)
        bars.append({
            "minute": at.isoformat(),
            "first_seen": at.isoformat(),
            "last_seen": (at + timedelta(seconds=50)).isoformat(),
            "mid_high": 1.10008,
            "mid_low": 1.09995,
            "bid_close": 1.1000,
            "ask_close": 1.10002,
            "spread_close": 0.00002,
            "sample_count": 50,
        })
    return {
        "instrument": "AUDUSD",
        "direction": direction,
        "route": "M1_TREND_CONTINUATION",
        "planb_route": "TREND_CONTINUATION",
        "paper_admitted": "true",
        "decision_time_utc": when.isoformat(),
        "stop_distance": str(stop_distance),
        "target_distance": str(target_distance),
        "entry_bid": str(entry_bid),
        "entry_ask": str(entry_ask),
        "entry_seen_utc": (when - timedelta(seconds=5)).isoformat(),
        "minute_path_json": json.dumps(bars),
    }


def modify_bar(row, index, **kwargs):
    bars = json.loads(row["minute_path_json"])
    bars[index].update(kwargs)
    row["minute_path_json"] = json.dumps(bars)
    return row


class RejectedFirstHitTests(unittest.TestCase):
    def test_tp_first_quote_close_without_possible_earlier_stop(self):
        row = modify_bar(fixture(), 4, mid_high=1.0999,
                         mid_low=1.0988, bid_close=1.0990, ask_close=1.09902)
        out = evaluate_decision(row)
        self.assertEqual(out["status"], "TP_FIRST_QUOTE_CLOSE_PROXY")
        self.assertFalse(out["contains_possible_intrabar_adverse_touch"])
        self.assertEqual(out["bars_evaluated"], 5)
        self.assertEqual(out["gross_r_if_target"], 1.6)
        self.assertFalse(out.get("broker_fill_confirmed", False))

    def test_stop_first_quote_close(self):
        row = modify_bar(fixture(), 2, mid_high=1.1008,
                         mid_low=1.1003, bid_close=1.1006, ask_close=1.10062)
        out = evaluate_decision(row)
        self.assertEqual(out["status"], "SL_FIRST_QUOTE_CLOSE_PROXY")
        self.assertEqual(out["bars_evaluated"], 3)

    def test_possible_earlier_stop_wick_makes_later_tp_ambiguous(self):
        row = modify_bar(fixture(), 1, mid_high=1.10060,
                         mid_low=1.09990, bid_close=1.1000, ask_close=1.10002)
        row = modify_bar(row, 4, mid_high=1.0999, mid_low=1.0988,
                         bid_close=1.0990, ask_close=1.09902)
        out = evaluate_decision(row)
        self.assertEqual(out["status"], "AMBIGUOUS_POSSIBLE_SL_BEFORE_TP")
        self.assertTrue(out["contains_possible_intrabar_adverse_touch"])

    def test_missing_first_minute_prevents_claimed_tp(self):
        row = fixture()
        bars = json.loads(row["minute_path_json"])
        row["minute_path_json"] = json.dumps(bars[1:])
        self.assertEqual(evaluate_decision(row)["status"], "UNOBSERVABLE_PRICE_PATH")

    def test_decision_mid_minute_must_not_consume_predecision_wick(self):
        row = fixture()
        row["decision_time_utc"] = "2026-11-05T14:29:30+00:00"
        self.assertTrue(valid_decision(row))
        self.assertEqual(evaluate_decision(row)["status"], "UNOBSERVABLE_ENTRY_BAR")

    def test_no_hit_is_not_called_profitable(self):
        self.assertEqual(evaluate_decision(fixture())["status"], "NO_QUOTE_CLOSE_BARRIER_30M")

    def test_order_and_entry_filter_are_independent_of_future_returns(self):
        with TemporaryDirectory() as path:
            first = fixture()
            first["decision_time_utc"] = "2026-11-05T14:29:00+00:00"
            second = fixture()
            second["decision_time_utc"] = "2026-11-05T14:30:00+00:00"
            second = modify_bar(second, 3, mid_high=1.0999, mid_low=1.0988,
                                bid_close=1.0990, ask_close=1.09902)
            source = Path(path) / "report.csv"
            pd.DataFrame([first, second]).to_csv(source, index=False)
            report = report_from_csv(source)
            self.assertEqual(report["independent_candidates"], 1)
            self.assertEqual(report["broker_orders"], 0)
            self.assertFalse(report["promotion_allowed"])
            self.assertFalse(report["actual_fills_or_verified_commissions"])

    def test_readonly_sql_and_runner_are_pinned_and_bounded(self):
        repo = Path(__file__).resolve().parents[5]
        sql = (repo / "services/ai-engine/app/domain/training/demo_rejected_first_hit_readonly.sql").read_text()
        runner = (repo / "scripts/research/run_demo_admission_rejected_shadow.sh").read_text()
        for marker in (
            "d.user_id::text=:'scanner_user'",
            "d.broker_connection_id::text=:'source_id'",
            "b.account_type='DEMO'",
            "d.execution_authority='NONE'",
            "ORDER BY evaluated_at DESC",
            "q.last_quote_sample_at <= c.evaluated_at",
            "q.first_sample_at",
            "LIMIT 4500",
        ):
            self.assertIn(marker, sql)
        self.assertNotIn("INSERT INTO", sql)
        self.assertNotIn("UPDATE trading.", sql)
        self.assertNotIn("DELETE FROM", sql)
        self.assertIn("default_transaction_read_only=on", runner)
        self.assertIn("demo_rejected_first_hit_shadow", runner)
        self.assertIn("latest-first-hit-report.json", runner)
        self.assertNotIn("createTrade(", runner)

    def test_rejects_wrong_pair_or_stale_entry(self):
        bad = fixture()
        bad["instrument"] = "USDJPY"
        self.assertFalse(valid_decision(bad))
        bad = fixture()
        bad["entry_seen_utc"] = "2026-11-05T14:20:00+00:00"
        self.assertFalse(valid_decision(bad))


if __name__ == "__main__":
    unittest.main()
