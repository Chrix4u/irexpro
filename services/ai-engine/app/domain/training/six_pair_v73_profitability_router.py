"""Six-pair H10 side-profitability router research.

Train independent LONG/SHORT net-profitability experts per pair. Thresholds are
selected only on an internal chronological calibration tail; outer validation
and the future holdout are never used for model/threshold selection.
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
from typing import Any
import numpy as np
import pandas as pd
from xgboost import XGBClassifier

from app.domain.training.model_qualification import _summarize_predictions
from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN, SHORT_NET_RETURN_COLUMN,
    MULTITIMEFRAME_FEATURE_COLUMNS, _split_internal_early_stopping_tail,
    _xgboost_n_jobs, load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "v73_h10_six_pair_side_profitability_router"
HORIZON_BARS = 10
MIN_NET_BPS = 0.50
EXTRA_SLIPPAGE_BPS = 0.25
SUMMARY_CONFIDENCE = 0.60
INSTRUMENTS = ("AUDUSD","EURUSD","GBPUSD","USDCAD","USDCHF","USDJPY")
FEATURES = [c for c in MULTITIMEFRAME_FEATURE_COLUMNS if not c.startswith("instrument_")]
def _model(seed:int)->XGBClassifier:
    return XGBClassifier(
        objective="binary:logistic", eval_metric="logloss",
        n_estimators=500, learning_rate=0.025, max_depth=4,
        min_child_weight=10.0, subsample=.82, colsample_bytree=.78,
        reg_alpha=.25, reg_lambda=3.0, random_state=seed,
        n_jobs=_xgboost_n_jobs(), tree_method="hist", early_stopping_rounds=45,
    )

def _weights(y:np.ndarray)->np.ndarray:
    y=np.asarray(y,dtype=int)
    counts=np.bincount(y,minlength=2).astype(float)
    if (counts<=0).any():
        raise ValueError(f"target lacks both classes: {counts.tolist()}")
    w=np.sqrt(len(y)/(2.0*counts))[y]
    w=np.clip(w,.5,2.5)
    return w/w.mean()

def _labels(frame:pd.DataFrame)->pd.DataFrame:
    out=frame.copy()
    floor=MIN_NET_BPS/10_000.0
    out["_long_profitable"]=(out[LONG_NET_RETURN_COLUMN].astype(float)>=floor).astype(int)
    out["_short_profitable"]=(out[SHORT_NET_RETURN_COLUMN].astype(float)>=floor).astype(int)
    return out

def _fit_pair(frame:pd.DataFrame, seed:int):
    fit,cal=_split_internal_early_stopping_tail(_labels(frame),horizon_bars=HORIZON_BARS)
    models={}
    for idx,(side,target) in enumerate((("long","_long_profitable"),("short","_short_profitable"))):
        m=_model(seed+idx)
        y=fit[target].to_numpy(int)
        m.fit(
            fit[FEATURES],y,sample_weight=_weights(y),
            eval_set=[(cal[FEATURES],cal[target].to_numpy(int))],
            sample_weight_eval_set=[_weights(cal[target].to_numpy(int))],
            verbose=False,
        )
        models[side]=m
    return models,cal

def _score(frame:pd.DataFrame, models:dict[str,XGBClassifier])->pd.DataFrame:
    z=_labels(frame).copy()
    pl=models["long"].predict_proba(z[FEATURES])[:,1]
    ps=models["short"].predict_proba(z[FEATURES])[:,1]
    pred_long=pl>=ps
    z["_p_long"]=pl; z["_p_short"]=ps
    z["_best_p"]=np.maximum(pl,ps)
    z["_margin"]=np.abs(pl-ps)
    z["predicted_long"]=pred_long
    z["selected_net_return"]=np.where(
        pred_long,
        z[LONG_NET_RETURN_COLUMN].to_numpy(float),
        z[SHORT_NET_RETURN_COLUMN].to_numpy(float),
    )
    z["positive_probability"]=np.where(pred_long,pl,1.0-ps)
    z["raw_positive_probability"]=z["positive_probability"]
    z["direction_confidence"]=np.maximum(z["positive_probability"],1-z["positive_probability"])
    z["opportunity_probability"]=z["_best_p"]
    z["confidence"]=z["_best_p"]
    return z

def _apply(base:pd.DataFrame, prob_floor:float, margin_floor:float)->pd.DataFrame:
    out=base.copy()
    active=(out["_best_p"]>=prob_floor)&(out["_margin"]>=margin_floor)
    out["active_trade"]=active
    out["predicted_opportunity"]=active
    out["decision_threshold"]=0.5
    out["confidence_floor"]=prob_floor
    out["fold"]=0
    out["experiment"]=EXPERIMENT
    out["model_variant"]="pair_specific_long_short_profitability"
    out["calibration_method"]="nested_chronological_profitability_floor"
    return out

def _density(frame:pd.DataFrame)->dict[str,Any]:
    a=frame.loc[frame["active_trade"].astype(bool)].sort_values("decision_time")
    if len(a)>1:
        gaps=pd.to_datetime(a["decision_time"],utc=True).diff().dropna().dt.total_seconds()/60
        med=float(gaps.median()); mean=float(gaps.mean())
    else:
        med=mean=None
    return {
        "rows":int(len(frame)),"trades":int(len(a)),
        "trade_density":float(len(a)/len(frame)) if len(frame) else 0.0,
        "median_gap_minutes":med,"mean_gap_minutes":mean,
        "long_trades":int(a["predicted_long"].astype(bool).sum()) if len(a) else 0,
        "short_trades":int((~a["predicted_long"].astype(bool)).sum()) if len(a) else 0,
    }

def _pair_fraction(frame:pd.DataFrame)->float:
    a=frame.loc[frame["active_trade"].astype(bool)]
    if a.empty:return 0.0
    by=a.groupby("instrument")["selected_net_return"].sum()
    return float(sum(by.get(i,0.0)>0 for i in INSTRUMENTS)/len(INSTRUMENTS))

def _choose(cal:pd.DataFrame):
    rows=[]
    for prob in np.round(np.arange(.52,.751,.02),2):
        for margin in (0.0,.02,.04,.06,.08,.10,.15):
            p=_apply(cal,float(prob),float(margin))
            den=_density(p)
            summ=_summarize_predictions(p,horizon_bars=HORIZON_BARS,confidence_threshold=SUMMARY_CONFIDENCE)
            tr=summ["trading"]; pf=tr["profit_factor"]
            pair_fraction=_pair_fraction(p)
            eligible=bool(
                den["trades"]>=100 and den["trade_density"]>=.005
                and den["trade_density"]<=.20
                and den["median_gap_minutes"] is not None and den["median_gap_minutes"]<=10
                and pf is not None and np.isfinite(pf) and pf>=1.15
                and tr["sharpe_ratio"] is not None and tr["sharpe_ratio"]>=1.0
                and tr["total_return"]>0 and pair_fraction>=4/6
            )
            rows.append({
                "prob_floor":float(prob),"margin_floor":float(margin),
                **den,"pf":pf,"sharpe":tr["sharpe_ratio"],
                "return":tr["total_return"],"positive_pair_fraction":pair_fraction,
                "eligible":eligible,
            })
    good=[r for r in rows if r["eligible"]]
    if good:
        chosen=max(good,key=lambda r:(r["positive_pair_fraction"],r["pf"],r["trade_density"]))
        return chosen,True,rows
    feasible=[r for r in rows if r["trades"]>=50 and r["pf"] is not None and np.isfinite(r["pf"])]
    chosen=max(feasible,key=lambda r:(r["pf"],r["sharpe"] or -999)) if feasible else None
    return chosen,False,rows

def run(datasets:dict[str,Path], output:Path, max_splits:int=3)->dict[str,Any]:
    pooled,manifest=load_and_prepare_corpora(
        datasets,horizon_bars=HORIZON_BARS,min_net_return_bps=0.0,
        commission_bps=0.0,slippage_bps=EXTRA_SLIPPAGE_BPS,
    )
    periods=int(pooled["decision_time"].nunique())
    splits=list(iter_purged_walk_forward_time_splits(
        pooled,time_column="decision_time",
        min_train_periods=max(500,int(periods*.55)),
        validation_periods=max(200,int(periods*.08)),
        purge_periods=HORIZON_BARS,embargo_periods=HORIZON_BARS,
        max_splits=max_splits,
    ))
    output.parent.mkdir(parents=True,exist_ok=True)
    folds=[]; all_pred=[]
    for fold,(train,valid) in enumerate(splits,1):
        cal_parts=[]; models={}
        for ix,inst in enumerate(INSTRUMENTS):
            pair_train=train.loc[train["instrument"]==inst].sort_values("decision_time")
            if len(pair_train)<1000: raise ValueError(f"insufficient {inst} training rows")
            pair_models,cal=_fit_pair(pair_train,7300+fold*100+ix*10)
            models[inst]=pair_models
            scored=_score(cal,pair_models); scored["instrument"]=inst
            cal_parts.append(scored)
        calibration=pd.concat(cal_parts,ignore_index=True).sort_values("decision_time")
        chosen,cal_pass,candidates=_choose(calibration)
        if chosen is None: raise ValueError(f"fold {fold}: no evaluable calibration candidate")
        valid_parts=[]
        for inst in INSTRUMENTS:
            pv=valid.loc[valid["instrument"]==inst].sort_values("decision_time")
            if pv.empty: continue
            scored=_score(pv,models[inst]); scored["instrument"]=inst
            valid_parts.append(scored)
        base=pd.concat(valid_parts,ignore_index=True).sort_values("decision_time")
        pred=_apply(base,chosen["prob_floor"],chosen["margin_floor"]); pred["fold"]=fold
        summ=_summarize_predictions(pred,horizon_bars=HORIZON_BARS,confidence_threshold=SUMMARY_CONFIDENCE)
        row={
            "fold":fold,"calibration_passed":cal_pass,"chosen":chosen,
            "calibration_top":sorted(candidates,key=lambda r:(r["eligible"],r["pf"] if r["pf"] is not None else -999),reverse=True)[:12],
            "density":_density(pred),"positive_pair_fraction":_pair_fraction(pred),
            "classification":summ["classification"],"trading":summ["trading"],
        }
        folds.append(row); all_pred.append(pred)
        print(json.dumps(row,indent=2,default=str),flush=True)
    combined=pd.concat(all_pred,ignore_index=True)
    overall=_summarize_predictions(combined,horizon_bars=HORIZON_BARS,confidence_threshold=SUMMARY_CONFIDENCE)
    positive_fold_fraction=sum(f["trading"]["total_return"]>0 for f in folds)/max(1,len(folds))
    report={
        "experiment":EXPERIMENT,"horizon_bars":HORIZON_BARS,
        "min_net_bps":MIN_NET_BPS,"extra_slippage_bps":EXTRA_SLIPPAGE_BPS,
        "dataset_manifest":manifest,"sealed_future_holdout_touched":False,
        "feature_contract":"causal MTF broker features only",
        "folds":folds,"density":_density(combined),
        "positive_pair_fraction":_pair_fraction(combined),
        "positive_fold_fraction":positive_fold_fraction,
        "overall":overall,
    }
    output.write_text(json.dumps(report,indent=2,default=str))
    return report

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--corpus-dir",type=Path,required=True)
    ap.add_argument("--output",type=Path,required=True)
    ap.add_argument("--max-splits",type=int,default=3)
    a=ap.parse_args()
    datasets={i:a.corpus_dir/f"{i}_MTF.csv" for i in INSTRUMENTS}
    result=run(datasets,a.output,a.max_splits)
    print(json.dumps({
        "density":result["density"],
        "positive_pair_fraction":result["positive_pair_fraction"],
        "positive_fold_fraction":result["positive_fold_fraction"],
        "trading":result["overall"]["trading"],
    },indent=2,default=str))
