"""Causal next-candle baseline research tests. No broker or model deployment."""
from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from scripts.research_candle_formation_expert import (
    read_broker_candles, build_next_candle_dataset, chronological_splits,
    _frame_features, train_expert, FOCUS,
)


def make_rows(symbol="EURUSD", tf="M1", count=700, start="2026-11-10T00:00:00Z"):
    minutes={"M1":1,"M5":5,"M15":15,"H1":60,"H4":240}[tf]
    start=pd.Timestamp(start)
    rows=[]
    for i in range(count):
        p=1.10+i*.000002
        bias=.00005*math.sin(i*.83)+.00009*math.cos(i*.19)
        o=p
        c=p+bias
        w=.000025+.000006*(i%4)
        h=max(o,c)+w
        l=min(o,c)-w
        rows.append(dict(instrument=symbol,timeframe=tf,
            bucket_time=(start+pd.Timedelta(minutes=i*minutes)).isoformat(),
            open=o,high=h,low=l,close=c,
            bid_close=c-.000006,ask_close=c+.000006,
            spread_close=.000012,sample_count=7,positive_quote_sample_count=7))
    return rows


def demo_frames(base=700):
    rows=[]
    for symbol in FOCUS:
        for tf,n in (("M1",base),("M5",max(100,base//5)),
                     ("M15",max(20,base//15)),
                     ("H1",max(16,base//60)),("H4",16)):
            rows+=make_rows(symbol,tf,n)
    return pd.DataFrame(rows)


class CausalCandleTests(unittest.TestCase):
    def test_lookahead_protection_in_context(self):
        d=demo_frames(700)
        clean=build_next_candle_dataset(d,"M1")
        at=pd.Timestamp("2026-11-10T00:30:00Z")
        before=clean[(clean.instrument=="EURUSD") &
                     (clean.available_at==at)]
        self.assertEqual(len(before),1)
        initial=before.iloc[0]
        # Mutate a completed H1 bar whose availability begins at 01:00;
        # at 00:30 it MUST be invisible to the features.
        m=(d.instrument=="EURUSD")&(d.timeframe=="H1")&(
            pd.to_datetime(d.bucket_time,utc=True)==pd.Timestamp("2026-11-10T00:00:00Z"))
        self.assertEqual(int(m.sum()),1)
        d.loc[m,"close"]=1.3
        d.loc[m,"high"]=1.301
        changed=build_next_candle_dataset(d,"M1")
        same=changed[(changed.instrument=="EURUSD")&(changed.available_at==at)].iloc[0]
        for col in ("ctx_h1_body_atr","ctx_h1_momentum3","body_atr",
                    "ctx_m5_body_atr","ctx_m15_body_atr"):
            a,b=initial[col],same[col]
            if pd.isna(a):
                self.assertTrue(pd.isna(b),col)
            else:
                self.assertAlmostEqual(float(a),float(b),places=10,msg=col)

    def test_next_bar_must_be_adjacent_real_bar(self):
        d=demo_frames(700)
        mask=(d.instrument=="EURUSD")&(d.timeframe=="M1")&(
            pd.to_datetime(d.bucket_time,utc=True)==pd.Timestamp("2026-11-10T01:01:00Z"))
        d=d[~mask].copy()
        out=build_next_candle_dataset(d,"M1")
        prior=out[(out.instrument=="EURUSD")&(
            out.available_at==pd.Timestamp("2026-11-10T01:01:00Z"))]
        self.assertEqual(len(prior),0)
        self.assertTrue((out.available_at<=out.bucket_time+pd.Timedelta(minutes=1)).all())

    def test_rolling_features_never_read_future_rows(self):
        a=demo_frames(700)
        candles=a[(a.instrument=="EURUSD")&(a.timeframe=="M1")].copy()
        f1=_frame_features(candles)
        candles.loc[candles.index[-2],"close"]+=.002
        candles.loc[candles.index[-2],"high"]+=.002
        f2=_frame_features(candles)
        np.testing.assert_allclose(
            f1.loc[:100,["body_atr","upper_wick_fraction","momentum5_atr"]],
            f2.loc[:100,["body_atr","upper_wick_fraction","momentum5_atr"]],
            equal_nan=True,
        )

    def test_reject_bad_candle_geometry_and_account_symbols(self):
        with tempfile.TemporaryDirectory() as td:
            d=demo_frames(700)
            d.loc[d.index[1],"high"]=0
            f=Path(td)/"x.csv";d.to_csv(f,index=False)
            loaded=read_broker_candles(f)
            self.assertEqual(len(loaded),len(d)-1)
            d.loc[d.index[5],"instrument"]="GBPUSD"
            d.to_csv(f,index=False)
            with self.assertRaisesRegex(ValueError,"UNAPPROVED"):
                read_broker_candles(f)

    def test_native_m5_without_bidask_is_kept_with_prior_m1_quote_costs(self):
        with tempfile.TemporaryDirectory() as td:
            d=demo_frames(1400)
            higher=d["timeframe"]!="M1"
            for col in ("bid_close","ask_close","spread_close"):
                d.loc[higher,col]=np.nan
            d.loc[higher,"positive_quote_sample_count"]=0
            p=Path(td)/"native.csv"
            d.to_csv(p,index=False)
            clean=read_broker_candles(p)
            self.assertGreater(len(clean[clean.timeframe=="M5"]),200)
            m5=build_next_candle_dataset(clean,"M5")
            self.assertGreater(len(m5),200)
            self.assertTrue(m5["next_spread_at_entry"].gt(0).all())
            self.assertTrue(m5["conservative_spread_budget"].gt(0).all())

    def test_chronological_split_global_time_and_four_hour_embargo(self):
        d=demo_frames(1200)
        result=build_next_candle_dataset(d,"M1")
        tr,val,te,bounds=chronological_splits(result,"M1")
        self.assertLess(tr.available_at.max(),val.available_at.min())
        self.assertLess(val.available_at.max(),te.available_at.min())
        self.assertGreaterEqual((val.available_at.min()-tr.available_at.max()).total_seconds(),2*3600)
        self.assertEqual(bounds["embargoHours"],1)

    def test_training_artifact_never_grants_execution_authority(self):
        with tempfile.TemporaryDirectory() as td:
            d=demo_frames(1600)
            corpus=Path(td)/"candles.csv"
            d.to_csv(corpus,index=False)
            out=Path("/tmp/irexpro-candle-test-artifact.json")
            try:
                result=train_expert(corpus,out)
                self.assertTrue(result["notActiveTradingAuthority"])
                self.assertFalse(result["modifiesExecution"])
                self.assertFalse(result["formingCandlePredictionsAvailable"])
                self.assertIn(result["timeframes"]["M1"]["status"],
                              ["TRAINED_RESEARCH_NOT_PROMOTED","NOT_TRAINED"])
            finally:
                if out.exists():
                    out.unlink()


if __name__=="__main__":
    unittest.main()
