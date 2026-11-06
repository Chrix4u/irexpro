"""Synthetic, deterministic checks; never uses broker connections or writable DB."""
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd

from app.domain.training.demo_planb_temporal_challenger import (
    asof_features,
    evaluate,
    rank_holdout,
    report_from_csv,
)
from app.domain.training.demo_rejected_entry_outcomes_shadow import prepare_cohort


def synthetic_rows(days=3, per_day=65):
    rows = []
    start = datetime(2026, 11, 3, tzinfo=UTC)
    pairs = ("AUDUSD", "EURUSD", "GBPUSD")
    for day in range(days):
        for k in range(per_day):
            at = start + timedelta(days=day, minutes=k * 17)
            instrument = pairs[k % 3]
            close = 1.2 + k * 0.000001
            future = close + (0.0004 if k % 3 else -0.0004)
            rows.append({
                "instrument": instrument,
                "direction": "BUY",
                "route": "M1_TREND_CONTINUATION",
                "planb_route": "TREND_CONTINUATION",
                "paper_admitted": "true" if k % 4 == 0 else "false",
                "admission_reasons_json": '["DIRECTION_QUALITY"]' if k % 3 == 0 else '[]',
                "decision_time_utc": at.isoformat(),
                "entry_bid": close - 0.00001,
                "entry_ask": close + 0.00001,
                "future_bid": future,
                "future_ask": future + 0.00001,
                "entry_seen_utc": (at - timedelta(seconds=3)).isoformat(),
                "future_seen_utc": (at + timedelta(minutes=16)).isoformat(),
            })
    return pd.DataFrame(rows)


class TemporalChallengerTests(unittest.TestCase):
    def test_future_marks_and_dates_never_enter_model_features(self):
        cohort, _ = prepare_cohort(synthetic_rows())
        row = cohort.iloc[0].copy()
        original = asof_features(row)
        for forbidden in ("proxy_pips", "future_bid", "future_ask", "future_seen_utc",
                          "decision_time_utc", "entry_bid", "entry_ask"):
            self.assertNotIn(forbidden, original)
        row["future_bid"] = 90.0
        row["future_ask"] = 90.0
        row["proxy_pips"] = 9000
        self.assertEqual(original, asof_features(row))

    def test_exploratory_fit_does_not_promote_even_when_holdout_is_positive(self):
        cohort, quality = prepare_cohort(synthetic_rows())
        outcome = evaluate(cohort, quality)
        self.assertTrue(outcome["model_fitted"])
        self.assertEqual(outcome["train_utc_days"], 2)
        self.assertEqual(outcome["holdout_utc_day"], "2026-11-05")
        self.assertGreaterEqual(outcome["holdout_selection_count"], 1)
        self.assertFalse(outcome["promotion_allowed"])
        self.assertFalse(outcome["actual_broker_net_pnl"])
        self.assertFalse(outcome["model_persisted"])
        self.assertEqual(outcome["broker_orders"], 0)

    def test_holdout_labels_cannot_change_fit_or_candidate_selection(self):
        original, quality = prepare_cohort(synthetic_rows())
        revised = original.copy()
        last = max(revised["decision_time_utc"].dt.date)
        mask = revised["decision_time_utc"].dt.date == last
        revised.loc[mask, "proxy_pips"] *= -1
        start = pd.Timestamp(last, tz="UTC")
        train = original.loc[original["decision_time_utc"] < start - timedelta(minutes=20)]
        held = original.loc[mask]
        revised_held = revised.loc[mask]
        self.assertEqual(
            rank_holdout(train, held).tolist(),
            rank_holdout(train, revised_held).tolist(),
        )
        left = evaluate(original, quality)
        right = evaluate(revised, quality)
        self.assertEqual(left["train"], right["train"])
        self.assertEqual(left["holdout_selection_count"], right["holdout_selection_count"])
        self.assertEqual(left["model_fitted"], right["model_fitted"])
        self.assertNotEqual(left["holdout_all"], right["holdout_all"])
        self.assertFalse(right["promotion_allowed"])

    def test_even_twelve_days_cannot_authorize_orders_or_model_publication(self):
        cohort, quality = prepare_cohort(synthetic_rows(days=12, per_day=65))
        report = evaluate(cohort, quality)
        self.assertGreaterEqual(quality["utc_days"], 12)
        self.assertTrue(report["model_fitted"])
        self.assertFalse(report["promotion_allowed"])
        self.assertFalse(report["model_persisted"])
        self.assertEqual(report["broker_orders"], 0)

    def test_insufficient_days_remain_without_fit(self):
        cohort, quality = prepare_cohort(synthetic_rows(days=2))
        result = evaluate(cohort, quality)
        self.assertFalse(result["model_fitted"])
        self.assertEqual(result["readiness"], "INSUFFICIENT_TEMPORAL_EVIDENCE")
        self.assertFalse(result["promotion_allowed"])

    def test_research_report_on_fresh_csv_is_writable_only_outside_model_directories(self):
        with TemporaryDirectory() as tmp:
            source = Path(tmp, "cohort.csv")
            synthetic_rows().to_csv(source, index=False)
            result = report_from_csv(source)
            self.assertTrue(result["model_fitted"])
            self.assertEqual(result["broker_orders"], 0)


if __name__ == "__main__":
    unittest.main()
