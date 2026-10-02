"""Six-pair quote-microstructure expected-value router.

Pair-specific LONG/SHORT XGBoost regressors predict executable 5-minute path
return in bps. Targets use bid/ask first-hit paths (+/-2 bps, terminal if
neither). Models only see high-quality quote windows and thresholds are chosen
on an internal chronological calibration tail.
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
from typing import Any
import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from app.domain.models.quote_microstructure import QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS
from app.domain.training.validation import iter_purged_walk_forward_time_splits

PAIRS=("AUDUSD","EURUSD","GBPUSD","USDCAD","USDCHF","USDJPY")
FEATURES=[*QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS,"hour_sin","hour_cos","dow_sin","dow_cos"]
HORIZON_BARS=5
BARRIER_BPS=2.0
MIN_TRADES=100

def model(seed:int)->XGBRegressor:
    return XGBRegressor(
        objective="reg:squarederror",eval_metric="rmse",
        n_estimators=700,learning_rate=.02,max_depth=4,min_child_weight=12,
        subsample=.82,colsample_bytree=.8,reg_alpha=.25,reg_lambda=3.0,
        random_state=seed,n_jobs=1,tree_method="hist",early_stopping_rounds=50,
    )

def path_return(hit:pd.Series,terminal:pd.Series)->np.ndarray:
    h=hit.to_numpy(int); t=terminal.to_numpy(float)
    return np.where(h==1,BARRIER_BPS,np.where(h==-1,-BARRIER_BPS,t))

def prepare(root:Path,pair:str)->pd.DataFrame:
    m=pd.read_csv(root/f"{pair}_1S_M1_BOUNDARY.csv")
    y=pd.read_csv(root/f"{pair}_5M_PATH_LABELS.csv")
    for df in (m,y): df["decision_time"]=pd.to_datetime(df["decision_time"],utc=True,errors="raise")
    z=m.merge(y,on="decision_time",how="inner",validate="one_to_one")
    spread75=float(z["quote_spread_mean_bps_60s"].quantile(.75))
    z=z.loc[
        (z["quote_coverage_60s"]>=.50)&
        (z["quote_samples_60s"]>=30)&
        (z["quote_spread_mean_bps_60s"]<=spread75)
    ].copy()
    dt=z["decision_time"]
    hour=dt.dt.hour+dt.dt.minute/60
    dow=dt.dt.dayofweek
    z["hour_sin"]=np.sin(2*np.pi*hour/24); z["hour_cos"]=np.cos(2*np.pi*hour/24)
    z["dow_sin"]=np.sin(2*np.pi*dow/7); z["dow_cos"]=np.cos(2*np.pi*dow/7)
    z["long_return_bps"]=path_return(z["long_first_hit_2p0bps"],z["long_terminal_5m_bps"])
    z["short_return_bps"]=path_return(z["short_first_hit_2p0bps"],z["short_terminal_5m_bps"])
    z["instrument"]=pair
    return z.sort_values("decision_time").reset_index(drop=True)

def split_cal(frame:pd.DataFrame):
    n=len(frame); cut=max(500,int(n*.8))
    if cut>=n-100: cut=n-100
    return frame.iloc[:cut].copy(),frame.iloc[cut:].copy()

def metrics(frame:pd.DataFrame, floor:float)->dict[str,Any]:
    active=frame.loc[frame["pred_ev_bps"]>=floor].sort_values("decision_time")
    if active.empty:
        return {"trades":0,"pf":None,"sharpe":None,"net_bps":0.0,"win_rate":0.0,"median_gap_minutes":None}
    r=active["selected_return_bps"].to_numpy(float)
    gp=float(r[r>0].sum()); gl=float(-r[r<0].sum())
    pf=gp/gl if gl>0 else None
    std=float(r.std(ddof=0)); sharpe=float(r.mean()/std*np.sqrt(len(r))) if std>0 else None
    gaps=active["decision_time"].diff().dropna().dt.total_seconds()/60
    return {
      "trades":int(len(active)),"pf":pf,"sharpe":sharpe,"net_bps":float(r.sum()),
      "mean_bps":float(r.mean()),"win_rate":float((r>0).mean()),
      "median_gap_minutes":float(gaps.median()) if len(gaps) else None,
      "long_trades":int(active["predicted_long"].sum()),
      "short_trades":int((~active["predicted_long"]).sum()),
    }

def score(frame:pd.DataFrame,long_model,short_model)->pd.DataFrame:
    z=frame.copy()
    pl=long_model.predict(z[FEATURES]); ps=short_model.predict(z[FEATURES])
    long=pl>=ps
    z["pred_long_ev_bps"]=pl; z["pred_short_ev_bps"]=ps
    z["predicted_long"]=long
    z["pred_ev_bps"]=np.maximum(pl,ps)
    z["selected_return_bps"]=np.where(long,z["long_return_bps"],z["short_return_bps"])
    return z

def choose_floor(cal:pd.DataFrame):
    candidates=[]
    for floor in np.arange(.05,1.01,.05):
        m=metrics(cal,float(floor))
        eligible=bool(m["trades"]>=MIN_TRADES and m["pf"] is not None and m["pf"]>=1.15 and
                      m["sharpe"] is not None and m["sharpe"]>=1.0 and m["net_bps"]>0 and
                      m["median_gap_minutes"] is not None and m["median_gap_minutes"]<=10)
        candidates.append({"floor_bps":float(round(floor,2)),**m,"eligible":eligible})
    good=[x for x in candidates if x["eligible"]]
    if good:
        return max(good,key=lambda x:(x["pf"],x["sharpe"],x["trades"])),True,candidates
    feasible=[x for x in candidates if x["trades"]>=50 and x["pf"] is not None]
    return (max(feasible,key=lambda x:(x["pf"],x["sharpe"] or -999)) if feasible else candidates[0]),False,candidates

def run(root:Path,output:Path,max_splits:int=3)->dict:
    parts=[prepare(root,p) for p in PAIRS]
    pooled=pd.concat(parts,ignore_index=True).sort_values("decision_time").reset_index(drop=True)
    periods=pooled["decision_time"].nunique()
    splits=list(iter_purged_walk_forward_time_splits(
        pooled,time_column="decision_time",
        min_train_periods=max(500,int(periods*.55)),
        validation_periods=max(200,int(periods*.08)),
        purge_periods=HORIZON_BARS,embargo_periods=HORIZON_BARS,max_splits=max_splits,
    ))
    folds=[]; all_outer=[]
    for fold,(train,valid) in enumerate(splits,1):
        cal_parts=[]; outer_parts=[]
        for ix,pair in enumerate(PAIRS):
            tr=train.loc[train["instrument"]==pair].sort_values("decision_time")
            va=valid.loc[valid["instrument"]==pair].sort_values("decision_time")
            if len(tr)<1000 or va.empty: continue
            fit,cal=split_cal(tr)
            lm=model(7400+fold*100+ix*2); sm=model(7401+fold*100+ix*2)
            lm.fit(fit[FEATURES],fit["long_return_bps"],eval_set=[(cal[FEATURES],cal["long_return_bps"])],verbose=False)
            sm.fit(fit[FEATURES],fit["short_return_bps"],eval_set=[(cal[FEATURES],cal["short_return_bps"])],verbose=False)
            cal_parts.append(score(cal,lm,sm))
            outer_parts.append(score(va,lm,sm))
        calibration=pd.concat(cal_parts,ignore_index=True).sort_values("decision_time")
        chosen,passed,cands=choose_floor(calibration)
        outer=pd.concat(outer_parts,ignore_index=True).sort_values("decision_time")
        om=metrics(outer,chosen["floor_bps"])
        pair_net={}
        for pair in PAIRS:
            q=outer.loc[(outer["instrument"]==pair)&(outer["pred_ev_bps"]>=chosen["floor_bps"])]
            pair_net[pair]=float(q["selected_return_bps"].sum()) if len(q) else 0.0
        positive_pair_fraction=sum(v>0 for v in pair_net.values())/len(PAIRS)
        row={"fold":fold,"calibration_passed":passed,"chosen":chosen,"outer":om,
             "positive_pair_fraction":positive_pair_fraction,"pair_net_bps":pair_net,
             "top_calibration":sorted(cands,key=lambda x:(x["eligible"],x["pf"] or -999),reverse=True)[:10]}
        folds.append(row); outer["fold"]=fold; all_outer.append(outer)
        print(json.dumps(row,indent=2),flush=True)
    combined=pd.concat(all_outer,ignore_index=True)
    floors=[f["chosen"]["floor_bps"] for f in folds]
    report={"experiment":"v74_micro_ev_router","barrier_bps":BARRIER_BPS,
            "quality_policy":"coverage>=0.50,samples>=30,spread<=pair_p75",
            "sealed_future_holdout_touched":False,"folds":folds,
            "fold_floor_bps":floors,"rows_by_pair":{p:int(len(x)) for p,x in zip(PAIRS,parts)}}
    output.parent.mkdir(parents=True,exist_ok=True); output.write_text(json.dumps(report,indent=2))
    return report

if __name__=="__main__":
    ap=argparse.ArgumentParser(); ap.add_argument("--corpus-dir",type=Path,required=True)
    ap.add_argument("--output",type=Path,required=True); ap.add_argument("--max-splits",type=int,default=3)
    a=ap.parse_args(); run(a.corpus_dir,a.output,a.max_splits)
