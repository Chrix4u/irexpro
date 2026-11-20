"""Read-only, broker-quote M1 multi-horizon demo opportunity audit.

Uses completed, as-of candle features and strictly later broker bid/ask marks.
Never submits orders and never promotes the forecasting model.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

HORIZONS = (1, 2, 3, 5, 10, 30, 60)
PIP = 0.0001
# USD account: conservative round-trip per-lot commission ($9) plus
# 0.20 pip extra slippage. Raw bid/ask entry/exit already charge spread.
COMMISSION_PIPS = 0.9
SLIPPAGE_PIPS = 0.2
FIXED_MIN_PREDICTED_MID_MOVE_PIPS = 1.5
FEATURES = (
    "r1","r2","r3","r4","r5","r10","r20","r30",
    "ema5_ema20","ema20_ema50","vol10","vol30",
    "range5","range20","red4","green4","spread_pips",
    "hour_sin","hour_cos",
)

def enrich(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw.sort_values("stamp").drop_duplicates("stamp").copy()
    df["mid"] = (df.bid + df.ask) / 2
    df["spread_pips"] = (df.ask - df.bid) / PIP
    df["delta1"] = df.mid.diff() / PIP
    for k in (1,2,3,4,5,10,20,30):
        prior = df.mid.shift(k)
        continuous = (df.stamp - df.stamp.shift(k)) == pd.Timedelta(minutes=k)
        df[f"r{k}"] = ((df.mid - prior) / PIP).where(continuous)
    e5=df.mid.ewm(span=5,adjust=False).mean()
    e20=df.mid.ewm(span=20,adjust=False).mean()
    e50=df.mid.ewm(span=50,adjust=False).mean()
    df["ema5_ema20"]=(e5-e20)/PIP
    df["ema20_ema50"]=(e20-e50)/PIP
    for k in (10,30):
        df[f"vol{k}"]=df.delta1.rolling(k).std()
    for k in (5,20):
        df[f"range{k}"]=(df.high.rolling(k).max()-df.low.rolling(k).min())/PIP
    # Four consecutive candle bodies, not four downward close-to-close gaps.
    red = (df.close < df.open).astype(int)
    green=(df.close > df.open).astype(int)
    df["red4"]=(red.rolling(4).sum()==4).astype(int)
    df["green4"]=(green.rolling(4).sum()==4).astype(int)
    hour = df.stamp.dt.hour + df.stamp.dt.minute/60
    df["hour_sin"]=np.sin(2*np.pi*hour/24)
    df["hour_cos"]=np.cos(2*np.pi*hour/24)
    # EMA and rolling features are invalid across a market-data gap.
    contiguous = (df.stamp - df.stamp.shift(50)) == pd.Timedelta(minutes=50)
    df.loc[~contiguous,list(FEATURES)]=np.nan
    for h in HORIZONS:
        future = df.shift(-h)
        valid=(future.stamp-df.stamp)==pd.Timedelta(minutes=h)
        df[f"midmove_{h}"]=((future.mid-df.mid)/PIP).where(valid)
        df[f"buy_net_{h}"]=((future.bid-df.ask)/PIP-COMMISSION_PIPS-SLIPPAGE_PIPS).where(valid)
        df[f"sell_net_{h}"]=((df.bid-future.ask)/PIP-COMMISSION_PIPS-SLIPPAGE_PIPS).where(valid)
    return df

def summarize(entries: list[float]) -> dict:
    if not entries:
        return {"trades":0,"winRate":None,"netPipsOneLot":0,"meanNetPips":None,"profitFactor":None}
    x=np.array(entries)
    wins=x[x>0].sum(); losses=-x[x<0].sum()
    return {
        "trades":len(entries),
        "winRate":round(float((x>0).mean()),3),
        "netPipsOneLot":round(float(x.sum()),2),
        "meanNetPips":round(float(x.mean()),3),
        "profitFactor":round(float(wins/losses),3) if losses>0 else None,
    }

def nonoverlap(rows:pd.DataFrame, horizon:int, side:np.ndarray)->list[float]:
    chosen=[]
    next_eligible=pd.Timestamp("2000-01-01",tz="UTC")
    for r,side_value in zip(rows.itertuples(),side):
        if side_value==0 or r.stamp<next_eligible:
            continue
        name=f"buy_net_{horizon}" if side_value==1 else f"sell_net_{horizon}"
        pnl=getattr(r,name)
        if np.isfinite(pnl):
            chosen.append(float(pnl))
            next_eligible=r.stamp+pd.Timedelta(minutes=horizon)
    return chosen

def run(csv:Path)->dict:
    raw=pd.read_csv(csv,parse_dates=["stamp"])
    for c in ("bid","ask","open","high","low","close"):
        raw[c]=pd.to_numeric(raw[c],errors="coerce")
    raw=raw.dropna(subset=["stamp","bid","ask","open","high","low","close"])
    raw=raw[(raw.bid>0)&(raw.ask>=raw.bid)]
    report={"artifact":"irexpro-pepperstone-two-pair-bidask-horizon-audit-v1",
            "authority":"RESEARCH_ONLY_NO_BROKER_ORDERS",
            "horizonsMinutes":list(HORIZONS),
            "costAssumptions":{"commissionPips":COMMISSION_PIPS,"extraSlippagePips":SLIPPAGE_PIPS,
            "brokerBidAskSpreadAlreadyIncluded":True},
            "results":[],"limitations":[
                "No real fills or stop-loss first-touch simulation",
                "Last chronological UTC day may be partial",
                "Limited independent training/holdout days on the current broker",
                "No strategy has execution authority as a result of this audit",
            ]}
    for instrument,g in raw.groupby("instrument"):
        df=enrich(g)
        usable=df.dropna(subset=list(FEATURES)).copy()
        dates=sorted(usable.stamp.dt.date.unique())
        if len(dates)<3:
            report["results"].append({"instrument":instrument,"reason":"NEED_THREE_UTC_DAYS"})
            continue
        # Keep three latest UTC dates strictly untouched. Earlier cTrader
        # history can help fit signals, but Pepperstone alone is the holdout.
        holdout_dates=dates[-3:] if len(dates)>=7 else dates[-1:]
        holdout_date=holdout_dates[-1]
        cutoff=pd.Timestamp(str(holdout_dates[0]),tz="UTC")
        train_cutoff=cutoff-pd.Timedelta(minutes=max(HORIZONS)+1)
        for horizon in HORIZONS:
            label=f"midmove_{horizon}"
            selected=usable.dropna(subset=[label,f"buy_net_{horizon}",f"sell_net_{horizon}"])
            train=selected[selected.stamp<train_cutoff]
            holdout=selected[selected.stamp>=cutoff]
            if len(train)<200 or len(holdout)<60:
                report["results"].append({"instrument":instrument,"horizon":horizon,"reason":"INSUFFICIENT_ROWS","trainingRows":len(train),"holdoutRows":len(holdout)})
                continue
            model=make_pipeline(StandardScaler(),Ridge(alpha=100))
            model.fit(train[list(FEATURES)],train[label])
            predicted=model.predict(holdout[list(FEATURES)])
            decisions=np.where(predicted>FIXED_MIN_PREDICTED_MID_MOVE_PIPS,1,np.where(predicted< -FIXED_MIN_PREDICTED_MID_MOVE_PIPS,-1,0))
            baseline_red=holdout.red4.to_numpy()==1
            red_rebound=np.where(baseline_red,1,0)
            red_continue=np.where(baseline_red,-1,0)
            outcomes={
                "model":summarize(nonoverlap(holdout,horizon,decisions)),
                "fourRedRebound":summarize(nonoverlap(holdout,horizon,red_rebound)),
                "fourRedContinuation":summarize(nonoverlap(holdout,horizon,red_continue)),
            }
            report["results"].append({
                "instrument":instrument,"horizon":horizon,"trainingRows":len(train),
                "trainingDates":len(train.stamp.dt.date.unique()),
                "holdoutDateUTC":str(holdout_date),"holdoutDatesUTC":[str(d) for d in holdout_dates],"holdoutRows":len(holdout),
                "predictedBuyBars":int((decisions==1).sum()),
                "predictedSellBars":int((decisions==-1).sum()),
                "noEdgeBars":int((decisions==0).sum()),
                "fourRedBars":int(baseline_red.sum()),
                "directionalAccuracyAllBars":round(float(((predicted>0)==(holdout[label].to_numpy()>0)).mean()),3),
                "selectionPipThreshold":FIXED_MIN_PREDICTED_MID_MOVE_PIPS,
                **outcomes,
            })
    return report

def main()->None:
    p=argparse.ArgumentParser()
    p.add_argument("--csv",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    if a.csv.parent!=Path("/tmp") or a.out.parent!=Path("/tmp") or a.out.exists():
        raise ValueError("Only fresh private /tmp files permitted")
    report=run(a.csv)
    a.out.write_text(json.dumps(report,indent=2))
    a.out.chmod(0o600)
    print(json.dumps(report,indent=2))

if __name__=="__main__":
    main()
