"""Forming-candle leakage and chronological split tests. Pure synthetic data."""

import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from scripts.research_forming_candle_learning import (
    FEATURES,
    SNAP_ARTIFACT,
    build_labeled_dataset,
    global_chronological_split,
    read_asof_snapshots,
    train_shadow,
)


def corpus(count=180):
    begin = pd.Timestamp("2026-11-16T19:00:00Z")
    rows = []
    for i in range(count):
        o = 1.1 + i * 0.000002
        c = o + 0.00004 * math.sin(i * 0.45) + 0.00002 * math.cos(i * 0.12)
        rows.append(
            dict(
                instrument="EURUSD",
                timeframe="M1",
                bucket_time=begin + pd.Timedelta(minutes=i),
                open=o,
                high=max(o, c) + 0.00003,
                low=min(o, c) - 0.00003,
                close=c,
            )
        )
    return pd.DataFrame(rows)


def partial(c, limit=None):
    rows = []
    for i, r in c.iterrows():
        if limit is not None and i >= limit:
            break
        for sec in (15, 30, 45):
            o = float(r.open) + 0.000004
            close = o + 0.000006 * (1 if i % 2 else -1)
            rows.append(
                dict(
                    instrument="EURUSD",
                    timeframe="M1",
                    barStart=r.bucket_time,
                    decisionAt=r.bucket_time + pd.Timedelta(seconds=sec),
                    open_asof=o,
                    high_asof=max(o, close) + 0.000003,
                    low_asof=min(o, close) - 0.000003,
                    close_asof=close,
                    lastBid=close - 0.00001,
                    lastAsk=close + 0.00001,
                    spread=0.00002,
                    sampleCount=max(2, sec // 2),
                    elapsedSeconds=sec,
                )
            )
    return pd.DataFrame(rows)


class FormingResearchTests(unittest.TestCase):
    def test_only_genuine_next_completed_candle_is_used_as_label(self):
        bars = corpus(180)
        result = build_labeled_dataset(partial(bars), bars)
        self.assertGreater(len(result), 200)
        self.assertTrue((result.next_available_at > result.decisionAt).all())
        self.assertTrue((result.decisionAt < result.barStart + pd.Timedelta(minutes=1)).all())
        self.assertNotIn("next_color", FEATURES)

    def test_changing_future_current_next_candle_cannot_change_asof_features(self):
        bars = corpus(170)
        asof = partial(bars, limit=80)
        before = build_labeled_dataset(asof, bars)
        edited = bars.copy()
        edited.loc[edited.index[45], "close"] += 0.0004
        edited.loc[edited.index[45], "high"] += 0.0004
        edited.loc[edited.index[46], "close"] -= 0.0004
        edited.loc[edited.index[46], "low"] -= 0.0004
        after = build_labeled_dataset(asof, edited)
        key = pd.Timestamp("2026-11-16T19:45:00Z")
        x = before[before.barStart == key].reset_index(drop=True)
        y = after[after.barStart == key].reset_index(drop=True)
        self.assertEqual(len(x), 3)
        self.assertEqual(len(y), 3)
        np.testing.assert_allclose(x.loc[:, FEATURES], y.loc[:, FEATURES], equal_nan=True)
        self.assertFalse((x.next_color == y.next_color).all())

    def test_missing_adjacent_next_bar_does_not_relabel_with_later_bar(self):
        bars = corpus(180)
        target = pd.Timestamp("2026-11-16T20:01:00Z")
        missing = bars[bars.bucket_time != target].reset_index(drop=True)
        d = build_labeled_dataset(partial(missing), missing)
        self.assertFalse((d.barStart == pd.Timestamp("2026-11-16T20:00:00Z")).any())

    def test_source_archive_rejects_future_observed_and_invalid_spread(self):
        t = pd.Timestamp("2026-11-16T19:20:00Z")
        valid = dict(
            artifact=SNAP_ARTIFACT,
            instrument="EURUSD",
            timeframe="M1",
            modifiesExecution=False,
            brokerOrderAuthority=False,
            includesNextBarLabel=False,
            sourceProvenance="ctrader-broker-native-positive-quote-archive",
            barStart=t.isoformat(),
            decisionAt=(t + pd.Timedelta(seconds=30)).isoformat(),
            firstSourceAt=(t + pd.Timedelta(seconds=2)).isoformat(),
            lastSourceAt=(t + pd.Timedelta(seconds=23)).isoformat(),
            lastObservedAt=(t + pd.Timedelta(seconds=24)).isoformat(),
            open=1.1,
            high=1.1002,
            low=1.0999,
            close=1.1001,
            lastBid=1.10009,
            lastAsk=1.10011,
            lastSpread=0.00002,
            sampleCount=7,
        )
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "2026-11-16.jsonl"
            late = {**valid, "lastObservedAt": (t + pd.Timedelta(seconds=33)).isoformat()}
            zero = {**valid, "lastAsk": 1.10009}
            p.write_text("\n".join(json.dumps(x) for x in [valid, late, zero]) + "\n")
            r = read_asof_snapshots(
                td, reference=pd.Timestamp("2026-11-17T00:00:00Z").to_pydatetime()
            )
            self.assertEqual(len(r), 1)

    def test_split_keeps_same_bar_together_and_embargoes_boundaries(self):
        bars = corpus(1400)
        d = build_labeled_dataset(partial(bars), bars)
        tr, va, te, meta = global_chronological_split(d)
        self.assertTrue(set(tr.barStart).isdisjoint(set(va.barStart)))
        self.assertTrue(set(va.barStart).isdisjoint(set(te.barStart)))
        self.assertGreater((va.barStart.min() - tr.barStart.max()).total_seconds(), 7200)
        self.assertEqual(meta["embargoMinutes"], 60)

    def test_short_history_does_not_receive_trading_authority(self):
        bars = corpus(90)
        result = train_shadow(build_labeled_dataset(partial(bars), bars))
        self.assertFalse(result["promotionAllowed"])
        self.assertFalse(result["modifiesExecution"])
        self.assertEqual(result["timeframes"]["M1"]["status"], "NOT_TRAINED")


if __name__ == "__main__":
    unittest.main()
