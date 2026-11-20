"""Cheap, offline invariants for the quote-mark forecast/exit research path."""
import unittest
import numpy as np
import pandas as pd
from app.domain.training.demo_pepperstone_two_pair_horizon_audit import (
    enrich, nonoverlap, HORIZONS
)
from app.domain.training.demo_first_touch_horizon_research import first_touch

class BrokerHorizonResearchTests(unittest.TestCase):
    def test_horizon_targets_require_real_completed_future_minutes(self):
        t=pd.date_range('2026-11-11T10:00:00Z',periods=140,freq='min')
        mid=np.array([1.1+i*0.00001 for i in range(140)],dtype=float)
        d=pd.DataFrame({'stamp':t,'bid':mid-0.00001,'ask':mid+0.00001,
                        'open':mid-0.000003,'high':mid+0.000015,
                        'low':mid-0.000015,'close':mid+0.000003})
        a=enrich(d)
        self.assertAlmostEqual(float(a.iloc[70].buy_net_5), -1.1+0.3,places=7)
        self.assertTrue(pd.isna(a.iloc[-1].buy_net_1))
        d=d[d.stamp!=t[79]].copy()
        b=enrich(d)
        ix=int(np.flatnonzero(b.stamp==t[75])[0])
        self.assertTrue(pd.isna(b.iloc[ix].buy_net_5))
        self.assertIn(60,HORIZONS)

    def test_both_barrier_touches_are_pessimistically_stop(self):
        start=pd.Timestamp('2026-11-11T10:00:00Z')
        candles=pd.DataFrame([
            dict(stamp=start,bid=1.10000,ask=1.10002,high=1.10003,low=1.09999),
            dict(stamp=start+pd.Timedelta(minutes=1),bid=1.10000,ask=1.10002,
                 high=1.10100,low=1.09900),
        ])
        self.assertAlmostEqual(first_touch(candles,0,1,2,4,1),-5.1)
        self.assertAlmostEqual(first_touch(candles,0,-1,2,4,1),-5.1)

    def test_no_matured_future_candle_cannot_be_scored(self):
        start=pd.Timestamp('2026-11-11T10:00:00Z')
        frame=pd.DataFrame([
            dict(stamp=start,bid=1.10000,ask=1.10002,high=1.10003,low=1.09999),
            dict(stamp=start+pd.Timedelta(minutes=1),bid=1.10001,ask=1.10003,
                 high=1.10004,low=1.10000),
        ])
        self.assertIsNone(first_touch(frame,0,1,4,6,5))

if __name__=='__main__':
    unittest.main()
