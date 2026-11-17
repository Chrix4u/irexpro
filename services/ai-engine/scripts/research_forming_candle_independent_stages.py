"""Fixed-stage, independent-candle validation for shadow-only M1/M5 formation experts.

Exactly one forecast per (instrument, barStart) at each PREDECLARED timestamp:
M1 +15s and +45s, M5 +15s and +285s. No "best" snapshot selection.
The same training-time majority baseline and simple observed partial-body
continuation baseline are evaluated. No broker orders, no model promotion.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from joblib import load
from sklearn.metrics import accuracy_score, balanced_accuracy_score

from scripts.research_forming_candle_learning import global_chronological_split

ARTIFACT="irexpro-forming-candle-independent-stage-evaluation-v1"
STAGES={"M1":{"EARLY_15S":15,"LATE_45S":45},
        "M5":{"EARLY_15S":15,"LATE_285S":285}}
COST_WARNING="Observed spread only; excludes commission, slippage, real fills, stop paths, swaps, funding and margin."

def evaluate_stage(model_bundle, test_frame, train_majority, target_second):
    d=test_frame[np.isclose(test_frame["elapsed_fraction"].to_numpy()
       * (60 if str(model_bundle["tf"])=="M1" else 300), target_second,atol=.05)].copy()
    keys=["instrument","barStart"]
    if d.duplicated(keys).any():
        raise ValueError("DUPLICATE_STAGE_PER_INSTRUMENT_BAR")
    if len(d)==0:
        return {"independentInstrumentBars":0,"nextColorAccuracy":None,
            "partialContinuationBaselineAccuracy":None,
            "trainingMajorityBaselineAccuracy":None,"confidentIndependentBars":0,
            "confidentAfterSpreadPositiveRate":None}
    features=model_bundle["features"]
    probabilities=model_bundle["classifier"].predict_proba(d.loc[:,features])
    labels=np.asarray(model_bundle["classifier"].classes_)
    pred=labels[np.argmax(probabilities,axis=1)]
    conf=np.max(probabilities,axis=1)
    y=d["next_color"].to_numpy()
    # Read the forming candle AS IT WAS, and predict simple continuation.
    # Current candle body above spread threshold => predict same color,
    # otherwise predict flat. No finished-bar information is used.
    partial_body=d["partial_body_atr"].to_numpy()
    partial_spread=d["spread_atr"].to_numpy()
    simple=np.where(partial_body>partial_spread,2,
            np.where(partial_body< -partial_spread,0,1))
    selected=(pred!=1)&(conf>=.65)
    signed=np.where(pred==2,1,-1)
    proxy=(signed*d["next_signed_price_move"].to_numpy()-
           d["asof_spread_price"].to_numpy())/d["causal_atr"].to_numpy()
    return {
        "independentInstrumentBars":len(d),
        "nextColorAccuracy":round(float(accuracy_score(y,pred)),4),
        "nextColorBalancedAccuracy":round(float(balanced_accuracy_score(y,pred)),4),
        "partialContinuationBaselineAccuracy":round(float(accuracy_score(y,simple)),4),
        "trainingMajorityBaselineAccuracy":round(float(accuracy_score(
            y,np.full(len(d),train_majority))),4),
        "confidentIndependentBars":int(selected.sum()),
        "confidentColorHitRate":round(float((y[selected]==pred[selected]).mean()),4)
             if selected.any() else None,
        "confidentAfterSpreadPositiveRate":round(float((proxy[selected]>0).mean()),4)
             if selected.any() else None,
        "confidentMeanSpreadOnlyAtr":round(float(proxy[selected].mean()),4)
             if selected.any() else None,
        "mode":"RESEARCH_ONLY_FIXED_ASOF_STAGE_NO_TRADING_AUTHORITY",
    }

def build_report(dataset, model_root):
    data=pd.read_csv(dataset,parse_dates=["barStart","decisionAt","next_available_at"])
    result={"artifact":ARTIFACT,"at":datetime.now(timezone.utc).isoformat(),
      "researchOnly":True,"modifiesExecution":False,"promotionAllowed":False,
      "noBrokerOrderAuthority":True,"byTimeframe":{},
      "caution":COST_WARNING,
      "interpretation":"Each stage forecasts the NEXT candle; same-bar current-finish forecasts are NOT counted as next-candle success. Early and late samples are separate prospective stage trials and must NOT be summed."}
    for tf,stage_map in STAGES.items():
        subset=data[data["timeframe"]==tf].copy()
        if subset.empty:
            result["byTimeframe"][tf]={"status":"NO_DATA"};continue
        tr,_,te,boundaries=global_chronological_split(subset)
        bundle=load(Path(model_root)/f"forming_candle_{tf.lower()}_RESEARCH_ONLY.joblib")
        if bundle.get("researchOnly") is not True or bundle.get("noBrokerOrderAuthority") is not True or bundle.get("tf")!=tf:
            raise ValueError("MODEL_WITHOUT_RESEARCH_PROVENANCE")
        majority=int(tr["next_color"].value_counts().idxmax())
        result["byTimeframe"][tf]={
          "status":"EVALUATED_NO_PROMOTION",
          "testSnapshotCount":len(te),
          "distinctTestInstrumentBars":te[["instrument","barStart"]].drop_duplicates().shape[0],
          "boundaries":boundaries,
          "stages":{stage:evaluate_stage(bundle,te,majority,seconds)
                    for stage,seconds in stage_map.items()},
        }
    return result

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--dataset",required=True)
    parser.add_argument("--models",required=True)
    parser.add_argument("--out",required=True)
    args=parser.parse_args()
    if not str(Path(args.out).resolve()).startswith("/tmp/"):
        raise ValueError("PRIVATE_TMP_OUTPUT_REQUIRED")
    result=build_report(args.dataset,args.models)
    target=Path(args.out)
    target.write_text(json.dumps(result,indent=2)+"\n",encoding="utf8")
    target.chmod(0o600)
    print(json.dumps(result,indent=2))

if __name__=="__main__":
    main()
