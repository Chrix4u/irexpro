"""Fixed as-of stage research tests: exactly one snapshot per bar."""

import unittest

import numpy as np
import pandas as pd

from scripts.research_forming_candle_independent_stages import evaluate_stage


class Stub:
    classes_ = np.array([0, 1, 2])

    def predict_proba(self, features):
        return np.tile([[0.10, 0.15, 0.75]], (len(features), 1))


class IndependentStageTests(unittest.TestCase):
    def test_uses_fixed_stage_does_not_count_later_same_bar_snapshots(self):
        rows = []
        for t in range(6):
            for seconds in (15, 30, 45):
                rows.append(
                    dict(
                        instrument="EURUSD",
                        barStart=pd.Timestamp("2026-11-17T15:00:00Z") + pd.Timedelta(minutes=t),
                        timeframe="M1",
                        elapsed_fraction=seconds / 60,
                        partial_body_atr=0.2,
                        spread_atr=0.1,
                        next_color=2,
                        asof_spread_price=0.00002,
                        causal_atr=0.0003,
                        next_signed_price_move=0.0001,
                        f=0.5,
                    )
                )
        d = pd.DataFrame(rows)
        model = {"tf": "M1", "classifier": Stub(), "features": ["f"]}
        early = evaluate_stage(model, d, 1, 15)
        late = evaluate_stage(model, d, 1, 45)
        self.assertEqual(early["independentInstrumentBars"], 6)
        self.assertEqual(late["independentInstrumentBars"], 6)
        self.assertEqual(early["confidentIndependentBars"], 6)
        self.assertEqual(early["nextColorAccuracy"], 1)
        self.assertEqual(early["partialContinuationBaselineAccuracy"], 1)
        self.assertEqual(evaluate_stage(model, d, 1, 20)["independentInstrumentBars"], 0)

    def test_duplicate_same_stage_bar_is_rejected_not_counted_twice(self):
        row = dict(
            instrument="EURUSD",
            barStart=pd.Timestamp("2026-11-17T15:00:00Z"),
            timeframe="M1",
            elapsed_fraction=0.25,
            partial_body_atr=0.2,
            spread_atr=0.1,
            next_color=2,
            asof_spread_price=0.00002,
            causal_atr=0.0003,
            next_signed_price_move=0.0001,
            f=0.5,
        )
        model = {"tf": "M1", "classifier": Stub(), "features": ["f"]}
        with self.assertRaisesRegex(ValueError, "DUPLICATE_STAGE"):
            evaluate_stage(model, pd.DataFrame([row, row]), 1, 15)

    def test_m5_uses_five_minute_elapsed_stage_not_45_second_m1_stage(self):
        row = dict(
            instrument="EURUSD",
            barStart=pd.Timestamp("2026-11-17T15:00:00Z"),
            timeframe="M5",
            elapsed_fraction=285 / 300,
            partial_body_atr=-0.2,
            spread_atr=0.1,
            next_color=0,
            asof_spread_price=0.00002,
            causal_atr=0.0003,
            next_signed_price_move=-0.0001,
            f=0.5,
        )
        model = {"tf": "M5", "classifier": Stub(), "features": ["f"]}
        late = evaluate_stage(model, pd.DataFrame([row]), 1, 285)
        self.assertEqual(late["independentInstrumentBars"], 1)
        self.assertEqual(late["partialContinuationBaselineAccuracy"], 1)
        self.assertEqual(late["nextColorAccuracy"], 0)
        self.assertEqual(
            evaluate_stage(model, pd.DataFrame([row]), 1, 45)["independentInstrumentBars"], 0
        )

    def test_no_broker_methods_or_order_authority(self):
        from scripts import research_forming_candle_independent_stages as m

        self.assertIn(
            "NO_TRADING_AUTHORITY",
            m.evaluate_stage(
                {"tf": "M1", "classifier": Stub(), "features": ["f"]},
                pd.DataFrame(
                    [
                        dict(
                            instrument="EURUSD",
                            barStart=pd.Timestamp("2026-11-17T15:00:00Z"),
                            elapsed_fraction=0.25,
                            partial_body_atr=0.1,
                            spread_atr=0.01,
                            next_color=2,
                            asof_spread_price=0.00002,
                            causal_atr=0.0003,
                            next_signed_price_move=0.0001,
                            f=0.5,
                        )
                    ]
                ),
                1,
                15,
            )["mode"],
        )


if __name__ == "__main__":
    unittest.main()
