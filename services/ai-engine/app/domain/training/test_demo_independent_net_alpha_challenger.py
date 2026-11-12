"""Causal and no-execution contract tests for independent net-alpha challenger."""
import unittest
import numpy as np
import pandas as pd

from app.domain.training.demo_pepperstone_two_pair_horizon_audit import enrich
from app.domain.training.demo_independent_net_alpha_challenger import (
    ARTIFACT, HORIZONS, choose_forecast_side,
    generate_causal_targets, results_for_signals, run,
    assess_challenger_qualification,
)


def quote_frame(n=180):
    stamp = pd.date_range("2026-11-10T08:00:00Z", periods=n, freq="min")
    mid = 1.10 + np.arange(n, dtype=float) * .00001
    raw = pd.DataFrame({
        "instrument": "EURUSD", "stamp": stamp,
        "bid": mid - .00001, "ask": mid + .00001,
        "open": mid - .000003, "high": mid + .000014,
        "low": mid - .000014, "close": mid + .000003,
    })
    return enrich(raw).reset_index(drop=True)


class IndependentNetAlphaSafetyTests(unittest.TestCase):
    def test_target_entry_is_one_completed_minute_after_feature_bar(self):
        frame = quote_frame(200)
        scored = generate_causal_targets(frame, 10)
        row = scored.iloc[90]
        self.assertEqual(
            row.entry_next_at,
            frame.iloc[91].stamp,
        )
        self.assertEqual(row.future_at, frame.iloc[101].stamp)
        expected = (frame.iloc[101].bid - frame.iloc[91].ask) / .0001 - 1.1
        self.assertAlmostEqual(float(row.buy_after_cost_pips), expected)
        self.assertTrue(np.isnan(scored.iloc[-3].buy_after_cost_pips))

    def test_missing_m1_bar_invalidates_future_labels(self):
        raw = quote_frame(190)
        raw = raw.loc[raw.stamp != raw.iloc[104].stamp].reset_index(drop=True)
        scored = generate_causal_targets(raw, 10)
        i = int(np.where(scored.stamp == pd.Timestamp("2026-11-10T09:40:00Z"))[0][0])
        self.assertTrue(np.isnan(scored.iloc[i].buy_after_cost_pips))
        self.assertTrue(np.isnan(scored.iloc[i].sell_after_cost_pips))

    def test_signed_prediction_abstains_without_after_cost_edge(self):
        self.assertEqual(choose_forecast_side(3.2, .67, .9), 1)
        self.assertEqual(choose_forecast_side(-3.2, .25, .9), -1)
        self.assertEqual(choose_forecast_side(1.2, .8, .9), 0)
        self.assertEqual(choose_forecast_side(3.2, .49, .9), 0)
        self.assertEqual(choose_forecast_side(float("nan"), .77, .9), 0)
        self.assertEqual(choose_forecast_side(3.2, .77, -0.1), 0)

    def test_stop_first_first_touch_never_uses_unobserved_future(self):
        frame = quote_frame(170)
        scored = generate_causal_targets(frame, 3)
        holdout = scored.iloc[140:165].copy()
        side = np.zeros(len(holdout), dtype=int)
        side[0] = 1
        result = results_for_signals(holdout, side, 3, history=frame)
        self.assertEqual(result["fixedHold"]["trades"], 1)
        self.assertEqual(result["firstTouchStopFirst"]["trades"], 1)
        self.assertEqual(result["firstTouchProxyTpSlPips"],
                         {"takeProfit": 2., "stopLoss": 4.})

    def test_sample_profit_does_not_override_required_prospective_evidence(self):
        convincing_paper_results = {
            "results": [
                {"instrument": "AUDUSD", "horizonMinutes": 60,
                 "status": "WALKFORWARD_RESEARCH_ONLY",
                 "holdoutSource": "pepperstone-ctrader",
                 "holdoutDayCompletedUTC": True,
                 "selected": {"firstTouchStopFirst": {
                     "trades": 80, "netPipsOneLot": 900,
                 }}},
            ],
        }
        qualification = assess_challenger_qualification(convincing_paper_results)
        self.assertEqual(qualification["reviewStatus"], "NOT_QUALIFIED_FOR_DEMO_EXECUTION")
        self.assertFalse(qualification["paperPromotionEligible"])
        self.assertFalse(qualification["livePromotionEligible"])
        self.assertEqual(qualification["executionAuthority"], "NONE")
        matched = [
            item for item in qualification["candidates"]
            if item["instrument"] == "AUDUSD" and item["horizonMinutes"] == 60
        ]
        self.assertEqual(matched[0]["completedPepperstoneHoldoutDays"], 1)
        self.assertFalse(matched[0]["maturedResearchDayFloorMet"])

    def test_explicit_non_promoting_artifact_and_supported_horizons(self):
        self.assertIn("walkforward", ARTIFACT)
        self.assertEqual(HORIZONS, (1, 3, 5, 10, 30, 60))


if __name__ == "__main__":
    unittest.main()
