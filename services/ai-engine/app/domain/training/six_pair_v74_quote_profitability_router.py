from __future__ import annotations
import argparse, json
from pathlib import Path
import numpy as np, pandas as pd
from xgboost import XGBClassifier
from app.domain.models.quote_microstructure import QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS
from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN, SHORT_NET_RETURN_COLUMN,
    MULTITIMEFRAME_FEATURE_COLUMNS, load_and_prepare_corpora,
    _split_internal_early_stopping_tail, _xgboost_n_jobs,
)
from app.domain.training.model_qualification import _summarize_predictions
from app.domain.training.validation import iter_purged_walk_forward_time_splits

PAIRS=("AUDUSD","EURUSD","GBPUSD","USDCAD","USDCHF","USDJPY")
H=5; EXTRA_SLIPPAGE_BPS=.25; MIN_NET_BPS=.25
CTX=[c for c in MULTITIMEFRAME_FEATURE_COLUMNS if c in {
    "m1_simple_return","m1_atr_pct_14","m1_rsi_14","m1_momentum_3",
    "m1_breakout_strength_20","m1_range_compression_5_20",
    "m5_price_vs_ma20","m5_atr_pct_14","m5_momentum_3",
    "m15_price_vs_ma20","m15_atr_pct_14","h1_price_vs_ma20",
    "h1_atr_pct_14","h4_price_vs_ma20","h4_atr_pct_14",
    "higher_timeframe_trend_score","spread_to_atr_ratio"
}]
FEATURES=[*QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS,*CTX]
def model(seed):
    return XGBClassifier(objective="binary:logistic",eval_metric="logloss",
        n_estimators=450,learning_rate=.025,max_depth=4,min_child_weight=10,
        subsample=.82,colsample_bytree=.8,reg_alpha=.25,reg_lambda=3.0,
        random_state=seed,n_jobs=_xgboost_n_jobs(),tree_method="hist",
        early_stopping_rounds=40)
def weights(y):
    y=np.asarray(y,int); c=np.bincount(y,minlength=2).astype(float)
    w=np.sqrt(len(y)/(2*np.maximum(c,1)))[y]
    w=np.clip(w,.5,2.5); return w/w.mean()
def attach(frame):
    z=frame.copy(); floor=MIN_NET_BPS/10000
    z["_long_y"]=(z[LONG_NET_RETURN_COLUMN].astype(float)>=floor).astype(int)
    z["_short_y"]=(z[SHORT_NET_RETURN_COLUMN].astype(float)>=floor).astype(int)
    return z
def fit_pair(train,seed):
    train=attach(train)
    fit,cal=_split_internal_early_stopping_tail(train,horizon_bars=H)
    mods={}
    for j,(side,target) in enumerate((("long","_long_y"),("short","_short_y"))):
        m=model(seed+j); y=fit[target].to_numpy(int); ey=cal[target].to_numpy(int)
        if len(np.unique(y))<2 or len(np.unique(ey))<2: raise ValueError("single class")
        m.fit(fit[FEATURES],y,sample_weight=weights(y),
              eval_set=[(cal[FEATURES],ey)],sample_weight_eval_set=[weights(ey)],
              verbose=False); mods[side]=m
    return mods,cal
def score(frame,mods):
    z=attach(frame)
    pl=mods["long"].predict_proba(z[FEATURES])[:,1]
    ps=mods["short"].predict_proba(z[FEATURES])[:,1]
    z["_pl"]=pl; z["_ps"]=ps; z["_best"]=np.maximum(pl,ps)
    z["_margin"]=np.abs(pl-ps); z["predicted_long"]=pl>=ps
    z["selected_net_return"]=np.where(z["predicted_long"],
        z[LONG_NET_RETURN_COLUMN],z[SHORT_NET_RETURN_COLUMN])
    z["positive_probability"]=np.where(z["predicted_long"],pl,1-ps)
    z["raw_positive_probability"]=z["positive_probability"]
    z["direction_confidence"]=np.maximum(z["positive_probability"],1-z["positive_probability"])
    z["opportunity_probability"]=z["_best"]; z["confidence"]=z["_best"]
    return z
def apply(z,pfloor,mfloor,cov_floor,spread_cap):
    x=z.copy()
    active=(x["_best"]>=pfloor)&(x["_margin"]>=mfloor)&(
        x["quote_coverage_60s"]>=cov_floor)&(x["quote_spread_mean_bps_60s"]<=spread_cap)
    x["active_trade"]=active; x["predicted_opportunity"]=active
    x["decision_threshold"]=.5; x["confidence_floor"]=pfloor; x["fold"]=0
    return x
def density(x):
    a=x[x.active_trade.astype(bool)].sort_values("decision_time")
    if len(a)>1:
        g=pd.to_datetime(a.decision_time,utc=True).diff().dropna().dt.total_seconds()/60
        med=float(g.median())
    else: med=None
    return {"rows":len(x),"trades":len(a),"density":len(a)/len(x) if len(x) else 0,
            "median_gap_minutes":med}
def choose(cal):
    spread_cap=float(cal["quote_spread_mean_bps_60s"].quantile(.90))
    rows=[]
    for cov in (.25,.4,.55,.7):
      for p in np.round(np.arange(.50,.711,.03),2):
       for margin in (0,.03,.06,.10):
        x=apply(cal,float(p),float(margin),float(cov),spread_cap)
        den=density(x); s=_summarize_predictions(x,horizon_bars=H,confidence_threshold=.60)["trading"]
        pf=s["profit_factor"]
        eligible=bool(den["trades"]>=80 and den["density"]>=.01 and den["density"]<=.25
          and den["median_gap_minutes"] is not None and den["median_gap_minutes"]<=10
          and pf is not None and np.isfinite(pf) and pf>=1.15
          and s["sharpe_ratio"] is not None and s["sharpe_ratio"]>=1
          and s["total_return"]>0)
        rows.append({"p":float(p),"margin":float(margin),"coverage":float(cov),
          "spread_cap":spread_cap,**den,"pf":pf,"sharpe":s["sharpe_ratio"],
          "return":s["total_return"],"eligible":eligible})
    good=[r for r in rows if r["eligible"]]
    return (max(good,key=lambda r:(r["pf"],r["density"])) if good else
            max([r for r in rows if r["pf"] is not None],key=lambda r:r["pf"])),bool(good),rows
def pair_pf(x):
    a=x[x.active_trade.astype(bool)]
    if a.empty:return {}
    out={}
    for p,g in a.groupby("instrument"):
        r=g.selected_net_return.astype(float); gp=r[r>0].sum(); gl=-r[r<0].sum()
        out[p]={"n":len(g),"pf":float(gp/gl) if gl>0 else None,"return":float(r.sum())}
    return out
def run(corpus_dir,quote_dirs,output,max_splits=1):
    datasets={p:corpus_dir/f"{p}_MTF.csv" for p in PAIRS}
    pool,_=load_and_prepare_corpora(datasets,horizon_bars=H,min_net_return_bps=0,
        commission_bps=0,slippage_bps=EXTRA_SLIPPAGE_BPS)
    q=[]
    for p in PAIRS:
        root=quote_dirs[0] if p in ("AUDUSD","EURUSD","GBPUSD") else quote_dirs[1]
        z=pd.read_csv(root/f"{p}_1S_M1_BOUNDARY.csv")
        z["decision_time"]=pd.to_datetime(z.decision_time,utc=True); q.append(z)
    quotes=pd.concat(q,ignore_index=True)
    pool["decision_time"]=pd.to_datetime(pool.decision_time,utc=True)
    joined=pool.merge(quotes,on=["decision_time","instrument"],how="inner",validate="one_to_one")
    joined=joined.dropna(subset=FEATURES).sort_values("decision_time").reset_index(drop=True)
    periods=joined.decision_time.nunique()
    splits=list(iter_purged_walk_forward_time_splits(joined,time_column="decision_time",
      min_train_periods=max(400,int(periods*.6)),validation_periods=max(150,int(periods*.12)),
      purge_periods=H,embargo_periods=H,max_splits=max_splits))
    folds=[]; allpred=[]
    for fi,(train,valid) in enumerate(splits,1):
      cals=[]; mods={}
      for ix,p in enumerate(PAIRS):
        tr=train[train.instrument==p].sort_values("decision_time")
        m,cal=fit_pair(tr,7400+fi*100+ix*10); mods[p]=m
        cals.append(score(cal,m))
      cal=pd.concat(cals).sort_values("decision_time")
      chosen,passed,candidates=choose(cal)
      vs=[]
      for p in PAIRS:
        v=valid[valid.instrument==p].sort_values("decision_time")
        if len(v): vs.append(score(v,mods[p]))
      base=pd.concat(vs).sort_values("decision_time")
      pred=apply(base,chosen["p"],chosen["margin"],chosen["coverage"],chosen["spread_cap"])
      summ=_summarize_predictions(pred,horizon_bars=H,confidence_threshold=.60)
      row={"fold":fi,"calibration_passed":passed,"chosen":chosen,
           "density":density(pred),"pair_results":pair_pf(pred),
           "classification":summ["classification"],"trading":summ["trading"],
           "top_calibration":sorted(candidates,key=lambda r:(r["eligible"],r["pf"] or -99),reverse=True)[:12]}
      print(json.dumps(row,indent=2),flush=True); folds.append(row); allpred.append(pred)
    combined=pd.concat(allpred,ignore_index=True)
    overall=_summarize_predictions(combined,horizon_bars=H,confidence_threshold=.60)
    report={"experiment":"v74_quote_profitability_router","rows":len(joined),
      "features":FEATURES,"sealed_future_holdout_touched":False,
      "extra_slippage_bps":EXTRA_SLIPPAGE_BPS,"folds":folds,
      "density":density(combined),"pair_results":pair_pf(combined),"overall":overall}
    output.parent.mkdir(parents=True,exist_ok=True); output.write_text(json.dumps(report,indent=2,default=str))
    return report
if __name__=="__main__":
    ap=argparse.ArgumentParser(); ap.add_argument("--corpus-dir",type=Path,required=True)
    ap.add_argument("--quote-a",type=Path,required=True); ap.add_argument("--quote-b",type=Path,required=True)
    ap.add_argument("--output",type=Path,required=True); ap.add_argument("--max-splits",type=int,default=1)
    a=ap.parse_args(); r=run(a.corpus_dir,(a.quote_a,a.quote_b),a.output,a.max_splits)
    print(json.dumps({"density":r["density"],"pair_results":r["pair_results"],
      "trading":r["overall"]["trading"]},indent=2,default=str))
