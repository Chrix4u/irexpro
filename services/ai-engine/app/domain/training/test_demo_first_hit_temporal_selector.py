"""Synthetic first-hit chronology and no-execution guarantees."""
import json
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd

from app.domain.training.demo_first_hit_temporal_selector import (
    SL,
    TP,
    asof_features,
    evaluate,
    rank_holdout,
    report_from_csv,
    summarize,
)


def episode(day: int, k: int, status: str) -> dict:
    when = pd.Timestamp("2026-11-03T00:30:00Z") + timedelta(days=day, minutes=16 * k)
    side = "BUY" if k % 3 == 0 else "SELL"
    row = {
        "instrument": ("AUDUSD", "EURUSD", "GBPUSD")[k % 3],
        "direction": side,
        "route": "M1_TREND_CONTINUATION" if k % 3 else "M1_EARLY_TRANSITION",
        "planb_route": "TREND_CONTINUATION",
        "regime_asof": "TREND_HEALTHY" if k % 2 else "TREND_WEAK",
        "drift_state_asof": "NORMAL",
        "paper_admitted": "true" if k % 4 == 0 else "false",
        "predicted_net_r": str(0.05 + (k % 7) * 0.01),
        "estimated_cost_r_asof": "0.03",
        "target_distance": "0.0008",
        "stop_distance": "0.0005",
        "admission_reasons_json": json.dumps(["DIRECTION_QUALITY"] if k % 3 else []),
        "blockers_json": json.dumps(["PAPER_NET_EXPECTED_R"] if k % 3 else []),
        "decision_time_utc": when.isoformat(),
    }
    return {
        "decision_at": when,
        "asof": row,
        "status": status,
        "reward_r": 1.6,
        "cost_r": 0.2,
    }


def cohort(days=4, candidates_per_full_day=80):
    rows = []
    for day in range(days):
        n = 8 if day == 3 else candidates_per_full_day
        for k in range(n):
            status = (TP, SL, "UNRESOLVED_WICK_AMBIGUITY")[k % 3]
            rows.append(episode(day, k, status))
    return rows


def quality(rows):
    return {"independent_episodes": len(rows), "source_utc_days": 4}


class TemporalSelectorTests(unittest.TestCase):
    def test_model_features_do_not_use_forward_quotes_or_labels(self):
        row = episode(0, 3, TP)["asof"]
        features = asof_features(row)
        for forbidden in (
            "status", "future_bid", "future_ask", "minute_path_json",
            "future_seen_utc", "first_quote_close_at_utc", "entry_seen_utc",
        ):
            self.assertNotIn(forbidden, features)
        changed = dict(row)
        changed.update({
            "future_bid": "0.0",
            "future_ask": "500.0",
            "status": SL,
            "first_quote_close_at_utc": "2026-11-03T04:00:00Z",
        })
        self.assertEqual(features, asof_features(changed))

    def test_holdout_labels_cannot_change_rankings(self):
        episodes = cohort()
        train = [x for x in episodes if x["decision_at"].date().isoformat() < "2026-11-05"]
        holdout = [x for x in episodes if x["decision_at"].date().isoformat() == "2026-11-05"]
        original_rank, original_expected_r = rank_holdout(train, holdout)
        revised = [{**x, "status": SL if x["status"] == TP else TP} for x in holdout]
        next_rank, next_expected_r = rank_holdout(train, revised)
        self.assertEqual(original_rank.tolist(), next_rank.tolist())
        self.assertEqual(original_expected_r.tolist(), next_expected_r.tolist())

    def test_partial_current_day_excluded_and_no_promotions(self):
        rows = cohort()
        report = evaluate(
            rows, as_of=datetime(2026, 11, 6, 1, 12, tzinfo=UTC), quality=quality(rows)
        )
        self.assertTrue(report["model_fitted"])
        self.assertEqual(report["holdout_utc_day"], "2026-11-05")
        self.assertEqual(report["train_days"], 2)
        self.assertEqual(report["holdout_all"]["candidates"], 80)
        self.assertEqual(report["holdout_challenger"]["candidates"], 16)
        self.assertEqual(report["broker_orders"], 0)
        self.assertFalse(report["model_persisted"])
        self.assertFalse(report["promotion_allowed"])
        self.assertFalse(report["real_broker_fill_or_commission_replay"])

    def test_unresolved_label_is_censored_and_bounds_include_worst(self):
        rows = [episode(0, 1, TP), episode(0, 2, SL), episode(0, 3, "UNOBSERVABLE_PRICE_PATH")]
        outcome = summarize(rows)
        self.assertEqual(outcome["quote_close_tp_first"], 1)
        self.assertEqual(outcome["quote_close_sl_first"], 1)
        self.assertEqual(outcome["censored_or_ambiguous"], 1)
        self.assertLess(
            outcome["pessimistic_mean_r_if_all_censored_sl"],
            outcome["optimistic_mean_r_if_all_censored_tp"],
        )

    def test_insufficient_days_prevent_model_fit(self):
        rows = cohort(days=2)
        outcome = evaluate(
            rows, as_of=datetime(2026, 11, 6, tzinfo=UTC), quality=quality(rows)
        )
        self.assertFalse(outcome["model_fitted"])
        self.assertEqual(outcome["readiness"], "INSUFFICIENT_TEMPORAL_EVIDENCE")
        self.assertFalse(outcome["promotion_allowed"])

    def test_output_summary_is_aggregate_only(self):
        rows = cohort()
        report = evaluate(
            rows, as_of=datetime(2026, 11, 6, 1, tzinfo=UTC), quality=quality(rows)
        )
        encoded = json.dumps(report)
        for sensitive in ("broker_connection_id", "user_id", "trade_intent_id", "account_id"):
            self.assertNotIn(sensitive, encoded)
        self.assertNotIn("2026-11-05T14:29:00", encoded)

    def test_first_hit_csv_input_requires_asof_feature_columns(self):
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / "cohort.csv"
            pd.DataFrame([{
                "instrument": "EURUSD", "direction": "BUY",
                "route": "M1_TREND_CONTINUATION",
            }]).to_csv(source, index=False)
            with self.assertRaisesRegex(ValueError, "as-of"):
                report_from_csv(source, as_of=datetime(2026, 11, 6, tzinfo=UTC))

    def test_only_pinned_demo_readonly_sql_and_private_json(self):
        repo = Path(__file__).resolve().parents[5]
        sql = (repo / "services/ai-engine/app/domain/training/demo_rejected_first_hit_readonly.sql").read_text()
        runner = (repo / "scripts/research/run_demo_admission_rejected_shadow.sh").read_text()
        for field in (
            "regime_asof", "drift_state_asof", "estimated_cost_r_asof",
            "d.user_id::text=:'scanner_user'",
            "d.broker_connection_id::text=:'source_id'",
            "d.execution_authority='NONE'",
        ):
            self.assertIn(field, sql)
        self.assertIn("default_transaction_read_only=on", runner)
        self.assertIn("demo_first_hit_temporal_selector", runner)
        self.assertIn("latest-first-hit-selector-report.json", runner)
        self.assertNotIn("INSERT INTO", sql)
        self.assertNotIn("UPDATE trading.", sql)


if __name__ == "__main__":
    unittest.main()
