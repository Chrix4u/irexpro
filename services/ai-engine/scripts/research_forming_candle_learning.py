"""Forming M1/M5 candle expert trained on genuine AS-OF broker quote snapshots.

Never reconstruct a partial candle from a finished OHLC bar. Prediction inputs
come exclusively from the archived quote stream and *previous* completed
candles. Completed current and next native candles provide LABELS ONLY.
Research artifacts cannot grant order or stop authority.
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from scripts.research_candle_formation_expert import (
    FOCUS, read_broker_candles,
)

ARTIFACT="irexpro-forming-candle-expert-research-v1"
SNAP_ARTIFACT="irexpro-forming-candle-asof-quote-shadow-v1"
FRAME_MINUTES={"M1":1,"M5":5}
CLASS_NAMES={0:"RED",1:"COST_SMALL_OR_FLAT",2:"GREEN"}
FEATURES=[
    "instrument_id","elapsed_fraction","stage_second","partial_body_atr",
    "partial_range_atr","upper_wick_fraction","lower_wick_fraction",
    "close_location","spread_atr","sample_count_log",
    "samples_per_second","quote_to_previous_close_atr",
    "previous_body_atr","previous_range_atr","previous_momentum3_atr",
    "previous_close_location","atr_over_price","hour_sin","hour_cos",
    "day_of_week",
]


def _finite(v):
    try:
        if v is None or isinstance(v,bool):return None
        f=float(v)
        return f if np.isfinite(f) else None
    except (ValueError,TypeError):
        return None


def read_asof_snapshots(folder: str|Path, since_days: int=10,
                        reference: datetime|None=None) -> pd.DataFrame:
    root=Path(folder)
    now=reference or datetime.now(timezone.utc)
    earliest=pd.Timestamp(now)-pd.Timedelta(days=since_days)
    rows=[]
    for file in sorted(root.glob("????-??-??.jsonl")) if root.exists() else []:
        try:day=pd.Timestamp(file.stem,tz="UTC")
        except (ValueError,TypeError):continue
        if day+pd.Timedelta(days=1)<earliest:continue
        with file.open("r",encoding="utf8") as f:
            for line in f:
                try:x=json.loads(line)
                except (ValueError,TypeError):continue
                if not isinstance(x,dict) or x.get("artifact")!=SNAP_ARTIFACT:
                    continue
                if x.get("modifiesExecution") is not False or x.get("brokerOrderAuthority") is not False:
                    continue
                if x.get("includesNextBarLabel") is not False:
                    continue
                if x.get("instrument") not in FOCUS or x.get("timeframe") not in FRAME_MINUTES:
                    continue
                try:
                    start=pd.Timestamp(x["barStart"]),decision=pd.Timestamp(x["decisionAt"])
                    src=pd.Timestamp(x["lastSourceAt"]),observed=pd.Timestamp(x["lastObservedAt"])
                    first=pd.Timestamp(x["firstSourceAt"])
                    if any(t.tzinfo is None for t in (start,decision,src,observed,first)):
                        continue
                    if decision<start or decision>=start+pd.Timedelta(minutes=FRAME_MINUTES[x["timeframe"]]):
                        continue
                    if not (start<=first<=src<=observed<=decision):
                        continue
                    if (decision-observed).total_seconds()>8.5:
                        continue
                    if (observed-src).total_seconds()>10:
                        continue
                    if first-start>pd.Timedelta(seconds=12):
                        continue
                    if x.get("sourceProvenance")!="ctrader-broker-native-positive-quote-archive":
                        continue
                    o,h,l,c=(_finite(x.get(k)) for k in ("open","high","low","close"))
                    bid,ask=(_finite(x.get(k)) for k in ("lastBid","lastAsk"))
                    spread=_finite(x.get("lastSpread"))
                    if any(z is None for z in (o,h,l,c,bid,ask,spread)):continue
                    if not (o>0 and l>0 and c>0 and h>=max(o,c) and l<=min(o,c)):
                        continue
                    if not (ask>bid>0 and spread>0 and abs((ask-bid)-spread) <= max(.0000001,spread*.05)):
                        continue
                    samples=int(x.get("sampleCount",0))
                    if samples<2:continue
                    rows.append({
                        "instrument":x["instrument"],"timeframe":x["timeframe"],
                        "barStart":start,"decisionAt":decision,
                        "open_asof":o,"high_asof":h,"low_asof":l,"close_asof":c,
                        "lastBid":bid,"lastAsk":ask,"spread":spread,
                        "sampleCount":samples,
                        "elapsedSeconds":float((decision-start).total_seconds()),
                    })
                except (ValueError,TypeError,OverflowError,KeyError):
                    continue
    if not rows:raise ValueError("NO_CAUSAL_ASOF_CANDLE_SNAPSHOTS")
    frame=pd.DataFrame(rows)
    return frame.drop_duplicates(["instrument","timeframe","decisionAt"],keep=False).sort_values(
        ["barStart","instrument","timeframe","decisionAt"]
    ).reset_index(drop=True)


def _per_frame_native_candles(candles:pd.DataFrame,frame:str,instrument:str)->pd.DataFrame:
    x=candles[(candles["instrument"]==instrument)&(candles["timeframe"]==frame)].copy()
    if x.empty:return x
    x=x.sort_values("bucket_time").reset_index(drop=True)
    prev=x["close"].shift(1)
    true_range=pd.concat([
        x["high"]-x["low"],(x["high"]-prev).abs(),(x["low"]-prev).abs()
    ],axis=1).max(axis=1)
    # Shift protects the forming candle: every available feature depends on
    # completed bars strictly preceding the current bar start.
    atr=true_range.rolling(14,min_periods=10).mean().shift(1)
    x["atr_before"]=atr
    x["previous_close"]=prev
    x["previous_body_atr"]=(x["close"].shift(1)-x["open"].shift(1))/atr
    x["previous_range_atr"]=(x["high"].shift(1)-x["low"].shift(1))/atr
    x["previous_momentum3_atr"]=(x["close"].shift(1)-x["close"].shift(4))/atr
    x["previous_close_location"]=(
        (x["close"].shift(1)-x["low"].shift(1))/
        (x["high"].shift(1)-x["low"].shift(1)).clip(lower=1e-10)
    )
    x["previous_start"]=x["bucket_time"].shift(1)
    # Missing/weekend gaps cannot become a false adjacent-bar signal.
    width=pd.Timedelta(minutes=FRAME_MINUTES[frame])
    x["prior_fresh"]=(x["bucket_time"]-x["previous_start"])<=width*2
    return x


def build_labeled_dataset(snapshots:pd.DataFrame,candles:pd.DataFrame)->pd.DataFrame:
    pieces=[]
    for frame,minutes in FRAME_MINUTES.items():
        width=pd.Timedelta(minutes=minutes)
        for inst in FOCUS:
            s=snapshots[(snapshots.instrument==inst)&(snapshots.timeframe==frame)].copy()
            if s.empty:continue
            native=_per_frame_native_candles(candles,frame,inst)
            if native.empty:continue
            # Exact current/next candle index provides future LABELS only.
            lookup=native.set_index("bucket_time",drop=False)
            current_index=pd.DatetimeIndex(s["barStart"])
            next_index=current_index+width
            current=lookup.reindex(current_index).reset_index(drop=True)
            following=lookup.reindex(next_index).reset_index(drop=True)
            valid=s["barStart"].reset_index(drop=True).notna()
            s=s.reset_index(drop=True)
            valid &= current["prior_fresh"].fillna(False)
            valid &= current["atr_before"].gt(0)
            valid &= following["open"].gt(0)&following["close"].gt(0)
            valid &= following["high"].ge(following[["open","close"]].max(axis=1))
            valid &= following["low"].le(following[["open","close"]].min(axis=1))
            # The completed current and next bar MUST be adjacent real
            # provider bars. Never use a future bar as an input.
            valid &= current["bucket_time"].eq(s["barStart"])
            valid &= following["bucket_time"].eq(s["barStart"]+width)
            valid &= s["decisionAt"].lt(s["barStart"]+width)
            valid &= s["decisionAt"].ge(s["barStart"])
            if not valid.any():continue
            s=s.loc[valid].copy().reset_index(drop=True)
            current=current.loc[valid].reset_index(drop=True)
            following=following.loc[valid].reset_index(drop=True)
            atr=current["atr_before"].to_numpy()
            o,h,l,c=(s[k].to_numpy() for k in ("open_asof","high_asof","low_asof","close_asof"))
            rng=np.maximum(h-l,1e-10)
            elapsed=s["elapsedSeconds"].to_numpy()
            when=s["decisionAt"].dt
            cost=np.maximum(s["spread"].to_numpy(),.05*atr)
            next_body=(following["close"]-following["open"]).to_numpy()
            current_final_body=(current["close"]-current["open"]).to_numpy()
            output=pd.DataFrame({
              "instrument":inst,"timeframe":frame,
              "barStart":s["barStart"],"decisionAt":s["decisionAt"],
              "instrument_id":float(FOCUS.index(inst)),
              "elapsed_fraction":elapsed/(minutes*60),
              "stage_second":elapsed%60/60,
              "partial_body_atr":(c-o)/atr,
              "partial_range_atr":(h-l)/atr,
              "upper_wick_fraction":(h-np.maximum(o,c))/rng,
              "lower_wick_fraction":(np.minimum(o,c)-l)/rng,
              "close_location":(c-l)/rng,
              "spread_atr":s["spread"].to_numpy()/atr,
              "sample_count_log":np.log1p(s["sampleCount"].to_numpy()),
              "samples_per_second":s["sampleCount"].to_numpy()/np.maximum(elapsed,1),
              "quote_to_previous_close_atr":(c-current["previous_close"].to_numpy())/atr,
              "previous_body_atr":current["previous_body_atr"],
              "previous_range_atr":current["previous_range_atr"],
              "previous_momentum3_atr":current["previous_momentum3_atr"],
              "previous_close_location":current["previous_close_location"],
              "atr_over_price":atr/c,
              "hour_sin":np.sin(2*np.pi*(when.hour.to_numpy()+when.minute.to_numpy()/60)/24),
              "hour_cos":np.cos(2*np.pi*(when.hour.to_numpy()+when.minute.to_numpy()/60)/24),
              "day_of_week":when.dayofweek.astype(float),
              "next_color":np.select([next_body < -cost,next_body > cost],[0,2],default=1),
              "current_finish_color":np.select([
                  current_final_body < -cost,current_final_body > cost],
                  [0,2],default=1),
              "next_body_abs_atr":np.abs(next_body)/atr,
              "next_range_atr":(following["high"]-following["low"]).to_numpy()/atr,
              "next_signed_price_move":next_body,
              "asof_spread_price":s["spread"].to_numpy(),
              "causal_atr":atr,
              "next_available_at":following["bucket_time"]+width,
              "labels_only_source":"provider-native-finalized-current-and-next-OHLC",
            })
            # Never return a label whose completion predates the as-of
            # prediction or any invalid/nonfinite input/target.
            output=output.replace([np.inf,-np.inf],np.nan)
            output=output.dropna(subset=FEATURES+[
                "next_color","current_finish_color",
                "next_body_abs_atr","next_range_atr"])
            output=output[output.next_available_at>output.decisionAt]
            pieces.append(output)
    if not pieces:raise ValueError("NO_MATURED_NEXT_BAR_LABELS")
    result=pd.concat(pieces,ignore_index=True).sort_values(
        ["barStart","instrument","timeframe","decisionAt"]
    ).reset_index(drop=True)
    return result


def global_chronological_split(d:pd.DataFrame):
    bars=d["barStart"].drop_duplicates().sort_values().reset_index(drop=True)
    if len(bars)<60:raise ValueError("INSUFFICIENT_UNIQUE_BAR_STARTS")
    first=bars.iloc[int(len(bars)*.60)]
    second=bars.iloc[int(len(bars)*.80)]
    embargo=pd.Timedelta(minutes=60)
    tr=d[d.barStart<first-embargo].copy()
    va=d[(d.barStart>first+embargo)&(d.barStart<second-embargo)].copy()
    te=d[d.barStart>second+embargo].copy()
    if min(len(tr),len(va),len(te))<100:
        raise ValueError("INSUFFICIENT_PURGED_CHRONOLOGICAL_FOLDS")
    return tr,va,te,{"firstCutoff":first.isoformat(),
                     "secondCutoff":second.isoformat(),"embargoMinutes":60}


def evaluate_three_class(model,reg_body,reg_range,d,train_majority,features):
    from sklearn.metrics import accuracy_score,balanced_accuracy_score,mean_absolute_error
    X=d.loc[:,features]
    prob=model.predict_proba(X)
    labels=model.classes_
    prediction=labels[np.argmax(prob,axis=1)]
    confidence=np.max(prob,axis=1)
    truth=d["next_color"].to_numpy()
    selected=(prediction!=1)&(confidence>=.65)
    direction=np.where(prediction==2,1,-1)
    # A *spread-only* directional proxy. No guarantee a position could be
    # entered, closed, margin-funded or held through its adverse path.
    move_atr=(direction*d["next_signed_price_move"].to_numpy()-
              d["asof_spread_price"].to_numpy())/d["causal_atr"].to_numpy()
    independent_bars=d[["instrument","barStart"]].drop_duplicates().shape[0]
    by_stage={}
    for name,mask in {
        "FIRST_MINUTE":d["elapsed_fraction"].to_numpy()<=1/(5 if d.timeframe.iloc[0]=="M5" else 1),
        "CANDLE_LAST_MINUTE":d["elapsed_fraction"].to_numpy()>=.80,
    }.items():
        chosen=selected & mask
        by_stage[name]={"snapshots":int(mask.sum()),"confident":int(chosen.sum()),
            "spreadProxyPositiveRate":round(float((move_atr[chosen]>0).mean()),4)
            if chosen.any() else None}
    return {
        "snapshots":len(d),"independentInstrumentBars":independent_bars,
        "nextColorAccuracy":round(float(accuracy_score(truth,prediction)),4),
        "nextColorBalancedAccuracy":round(float(balanced_accuracy_score(truth,prediction)),4),
        "trainMajorityBaselineAccuracy":round(float(accuracy_score(
            truth,np.full(len(d),train_majority))),4),
        "highConfidenceSnapshotCount":int(selected.sum()),
        "highConfidenceUniqueInstrumentBars":int(d.loc[selected,
            ["instrument","barStart"]].drop_duplicates().shape[0]),
        "highConfidenceColorHitRate":round(float((prediction[selected]==truth[selected]).mean()),4)
            if selected.any() else None,
        "highConfidenceSpreadOnlyPositiveRate":round(float((move_atr[selected]>0).mean()),4)
            if selected.any() else None,
        "highConfidenceMeanSpreadOnlyAtr":round(float(move_atr[selected].mean()),4)
            if selected.any() else None,
        "nextBodyAtrMeanAbsError":round(float(mean_absolute_error(
            d["next_body_abs_atr"],np.maximum(reg_body.predict(X),0))),4),
        "nextRangeAtrMeanAbsError":round(float(mean_absolute_error(
            d["next_range_atr"],np.maximum(reg_range.predict(X),0))),4),
        "byStage":by_stage,
        "costCoverage":"SPREAD_ONLY_NOT_REALIZED_NET_PNL",
    }


def train_shadow(d:pd.DataFrame,model_dir:Path|None=None):
    from sklearn.ensemble import HistGradientBoostingClassifier,HistGradientBoostingRegressor
    from joblib import dump
    out={"artifact":ARTIFACT,"mode":"RESEARCH_SHADOW_ONLY",
         "modifiesExecution":False,"promotionAllowed":False,
         "asOf":datetime.now(timezone.utc).isoformat(),"timeframes":{},
         "trainingLimitations":[
           "Partial candle features are as-of native positive-spread quotes; not all broker ticks.",
           "Finalized native candle OHLC appear only as CURRENT/NEXT training labels.",
           "Repeated snapshots from the same bar are dependent; chronological splits use whole bars and inverse-per-bar sample weighting.",
           "Spread-only price move excludes commission, slippage, stop-loss intrabar traversal and fill probability.",
           "Less than five distinct UTC trading days means insufficient regime diversity; no automatic promotion.",
           "Research models have no order authority and cannot alter a broker stop or live session.",
         ]}
    for tf in FRAME_MINUTES:
        sub=d[d.timeframe==tf].copy()
        try:
            tr,va,te,meta=global_chronological_split(sub)
            active=[f for f in FEATURES if tr[f].notna().sum()>=max(40,int(len(tr)*.1))
                and tr[f].nunique(dropna=True)>1]
            if len(active)<12:raise ValueError("INSUFFICIENT_ASOF_TRAIN_FEATURES")
            y=tr["next_color"].astype(int)
            if y.nunique()<3:raise ValueError("INSUFFICIENT_NEXT_CANDLE_CLASSES")
            # 15 M5 partial snapshots of one candle must not represent 15
            # independent examples: give each underlying bar total weight 1.
            keys=tr["instrument"]+"|"+tr["barStart"].astype(str)
            repeats=keys.map(keys.value_counts()).to_numpy()
            weights=1.0/repeats
            model=HistGradientBoostingClassifier(max_iter=65,max_leaf_nodes=11,
                min_samples_leaf=60,l2_regularization=8,
                learning_rate=.045,early_stopping=False,random_state=27)
            model.fit(tr.loc[:,active],y,sample_weight=weights)
            rb=HistGradientBoostingRegressor(max_iter=55,max_leaf_nodes=9,
                min_samples_leaf=60,l2_regularization=8,
                learning_rate=.05,early_stopping=False,random_state=27)
            rr=HistGradientBoostingRegressor(max_iter=55,max_leaf_nodes=9,
                min_samples_leaf=60,l2_regularization=8,
                learning_rate=.05,early_stopping=False,random_state=27)
            rb.fit(tr.loc[:,active],tr["next_body_abs_atr"],sample_weight=weights)
            rr.fit(tr.loc[:,active],tr["next_range_atr"],sample_weight=weights)
            majority=int(y.value_counts().idxmax())
            days=int(sub.barStart.dt.floor("D").nunique())
            report={
                "status":"TRAINED_NOT_PROMOTED",
                "sourceDays":days,"insufficientRegimeHistory":days<5,
                "snapshots":len(sub),
                "uniqueInstrumentBars":int(sub[["instrument","barStart"]].drop_duplicates().shape[0]),
                "trainRows":len(tr),"validationRows":len(va),"testRows":len(te),
                "activeFeatures":active,"boundaries":meta,
                "validation":evaluate_three_class(model,rb,rr,va,majority,active),
                "untouchedTest":evaluate_three_class(model,rb,rr,te,majority,active),
            }
            out["timeframes"][tf]=report
            if model_dir:
                model_dir.mkdir(parents=True,exist_ok=True)
                dest=model_dir/f"forming_candle_{tf.lower()}_RESEARCH_ONLY.joblib"
                dump({"artifact":ARTIFACT,"tf":tf,"classifier":model,
                      "body":rb,"range":rr,"features":active,"researchOnly":True,
                      "noBrokerOrderAuthority":True,"boundaries":meta},dest)
                dest.chmod(0o600)
        except (ValueError,KeyError) as exc:
            out["timeframes"][tf]={"status":"NOT_TRAINED","reason":str(exc)}
    return out


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--snapshots",required=True)
    p.add_argument("--candles",required=True)
    p.add_argument("--dataset",required=True)
    p.add_argument("--report",required=True)
    p.add_argument("--models")
    a=p.parse_args()
    for destination in (a.dataset,a.report,a.models):
        if destination and not str(Path(destination).resolve()).startswith("/tmp/"):
            raise ValueError("PRIVATE_TMP_OUTPUT_REQUIRED")
    snapshots=read_asof_snapshots(a.snapshots)
    candles=read_broker_candles(a.candles)
    data=build_labeled_dataset(snapshots,candles)
    target=Path(a.dataset)
    data.to_csv(target,index=False)
    target.chmod(0o600)
    research=train_shadow(data,Path(a.models) if a.models else None)
    research["inputSnapshotCount"]=len(snapshots)
    research["maturedLabeledSnapshotCount"]=len(data)
    research["datasetPrivatePath"]=str(target)
    out=Path(a.report)
    out.write_text(json.dumps(research,indent=2)+"\n",encoding="utf8")
    out.chmod(0o600)
    print(json.dumps(research,indent=2))


if __name__=="__main__":
    main()
