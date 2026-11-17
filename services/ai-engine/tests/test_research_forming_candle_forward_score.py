"""No-leakage tests for the prospective, pre-close forming-candle scorer."""
from __future__ import annotations
import json
import tempfile
import unittest
from pathlib import Path

import pandas as pd
import numpy as np

from scripts.research_forming_candle_forward_score import asof_features,score_request,verified_manifest
from scripts.research_forming_candle_learning import build_labeled_dataset

BEGIN=pd.Timestamp("2026-11-17T10:00:00Z")

def bars(n=65,tf="M1"):
    period=1 if tf=="M1" else 5
    rows=[]
    for i in range(n):
        o=1.09+i*.000004
        c=o+((i%7)-3)*.000012
        rows.append(dict(instrument="EURUSD",timeframe=tf,
            bucket_time=BEGIN+pd.Timedelta(minutes=i*period),open=o,
            close=c,high=max(o,c)+.000018,low=min(o,c)-.000018))
    return pd.DataFrame(rows)

def snap_for(frame="M1",index=40,second=15):
    tfminutes=1 if frame=="M1" else 5
    start=BEGIN+pd.Timedelta(minutes=index*tfminutes)
    observation=start+pd.Timedelta(seconds=second)
    open_=1.09+.000004*index+.000002
    close=open_+.000012
    return dict(artifact="irexpro-forming-candle-asof-quote-shadow-v1",
         sourceProvenance="ctrader-broker-native-positive-quote-archive",
         brokerOrderAuthority=False,modifiesExecution=False,
         includesNextBarLabel=False,fromCompletedFutureCandle=False,
         instrument="EURUSD",timeframe=frame,
         barStart=start.isoformat(),decisionAt=observation.isoformat(),
         firstSourceAt=(start+pd.Timedelta(seconds=1)).isoformat(),
         lastSourceAt=(observation-pd.Timedelta(seconds=2)).isoformat(),
         lastObservedAt=(observation-pd.Timedelta(seconds=1)).isoformat(),
         open=open_,high=close+.000009,low=open_-.000006,close=close,
         lastBid=close-.000008,lastAsk=close+.000008,
         lastSpread=.000016,sampleCount=7)

def snapshot_training_row(snap):
    return pd.DataFrame([dict(
        instrument=snap["instrument"],timeframe=snap["timeframe"],
        barStart=pd.Timestamp(snap["barStart"]),
        decisionAt=pd.Timestamp(snap["decisionAt"]),
        open_asof=snap["open"],high_asof=snap["high"],
        low_asof=snap["low"],close_asof=snap["close"],
        lastBid=snap["lastBid"],lastAsk=snap["lastAsk"],
        spread=snap["lastSpread"],sampleCount=snap["sampleCount"],
        elapsedSeconds=(pd.Timestamp(snap["decisionAt"])-
                        pd.Timestamp(snap["barStart"])).total_seconds(),
    )])

class ProspectiveAsOfTests(unittest.TestCase):
    def test_live_features_equal_training_features_for_same_asof_input(self):
        for tf,index,sec in (("M1",40,15),("M1",40,45),("M5",25,15),("M5",25,285)):
            with self.subTest(tf=tf,sec=sec):
                c=bars(65,tf)
                snap=snap_for(tf,index,sec)
                earlier=c[c.bucket_time<pd.Timestamp(snap["barStart"])]
                x=asof_features(snap,earlier.to_dict("records"))
                full=build_labeled_dataset(snapshot_training_row(snap),c)
                self.assertEqual(len(full),1)
                for key,val in x.items():
                    self.assertAlmostEqual(val,float(full.iloc[0][key]),places=9,msg=key)
    def test_future_or_current_native_bar_is_rejected_not_used_as_input(self):
        c=bars()
        s=snap_for()
        earlier=c[c.bucket_time<pd.Timestamp(s["barStart"])]
        self.assertGreater(len(earlier),20)
        with self.assertRaisesRegex(ValueError,"NATIVE_CURRENT_OR_FUTURE"):
            asof_features(s,c.to_dict("records"))
    def test_no_unclosed_or_offstage_forecast(self):
        c=bars()
        earlier=c[c.bucket_time<BEGIN+pd.Timedelta(minutes=40)].to_dict("records")
        snap=snap_for()
        snap["decisionAt"]=(BEGIN+pd.Timedelta(minutes=40,seconds=30)).isoformat()
        with self.assertRaisesRegex(ValueError,"PREDECLARED"):
            asof_features(snap,earlier)
    def test_stale_quote_and_untrusted_research_flag_rejected(self):
        c=bars()
        earlier=c[c.bucket_time<BEGIN+pd.Timedelta(minutes=40)].to_dict("records")
        snap=snap_for()
        snap["lastSourceAt"]=(BEGIN+pd.Timedelta(minutes=40,seconds=4)).isoformat()
        snap["lastObservedAt"]=(BEGIN+pd.Timedelta(minutes=40,seconds=5)).isoformat()
        with self.assertRaisesRegex(ValueError,"STALE"):
            asof_features(snap,earlier)
        snap=snap_for()
        snap["brokerOrderAuthority"]=True
        with self.assertRaisesRegex(ValueError,"NO_TRADE_AUTHORITY"):
            asof_features(snap,earlier)
    def test_sparse_previous_bars_do_not_fabricate_rolling_history(self):
        c=bars()
        s=snap_for()
        with self.assertRaisesRegex(ValueError,"INSUFFICIENT_COMPLETED"):
            asof_features(s,c.iloc[30:40].to_dict("records"))
    def test_rejects_model_inference_if_after_valid_stage_deadline(self):
        s=snap_for()
        t=pd.Timestamp(s["decisionAt"])
        req={"mode":"RESEARCH_ONLY","brokerOrderAuthority":False,
             "decisionAt":s["decisionAt"],"snapshots":[s],"priorBars":{}}
        with self.assertRaisesRegex(ValueError,"NOT_PROSPECTIVE"):
            score_request(req,"/tmp/unused","/tmp/unused",now=t+pd.Timedelta(seconds=16))
    def test_persisted_model_manifest_is_checked_against_file_sha_and_permissions(self):
        import hashlib
        from datetime import datetime,timezone,timedelta
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/"models";root.mkdir(mode=0o700)
            digest={}
            for tf in ("M1","M5"):
                f=root/f"forming_candle_{tf.lower()}_RESEARCH_ONLY.joblib"
                data=(tf+" frozen test research").encode()
                f.write_bytes(data);f.chmod(0o600)
                digest[tf]=hashlib.sha256(data).hexdigest()
            manifest={
                "artifact":"irexpro-forming-candle-expert-research-v1",
                "promotionAllowed":False,
                "manifestKind":"FROZEN_RESEARCH_MODEL_ARTIFACT_RECOVERY_V1",
                "researchOnly":True,"noBrokerOrderAuthority":True,
                "modelSha256":digest,
                "asOf":(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat(),
            }
            verified_manifest(manifest,root)
            f=root/"forming_candle_m5_RESEARCH_ONLY.joblib"
            f.write_bytes(b"different but local");f.chmod(0o600)
            with self.assertRaisesRegex(ValueError,"DIGEST_MISMATCH"):
                verified_manifest(manifest,root)
            f.write_bytes(b"M5 frozen test research");f.chmod(0o644)
            with self.assertRaisesRegex(ValueError,"PERMISSIONS_UNSAFE"):
                verified_manifest(manifest,root)

    def test_rejects_attempt_to_attach_live_order_authority(self):
        s=snap_for()
        req={"mode":"RESEARCH_ONLY","brokerOrderAuthority":True,
             "decisionAt":s["decisionAt"],"snapshots":[s],"priorBars":{}}
        with self.assertRaisesRegex(ValueError,"NO_TRADING_AUTHORITY"):
            score_request(req,"/tmp/unused","/tmp/unused",now=pd.Timestamp(s["decisionAt"])+pd.Timedelta(seconds=6))

if __name__=="__main__": unittest.main()
