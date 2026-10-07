#!/usr/bin/env python3
"""Vectorized executable tick-path labels at M1 decision boundaries."""
from __future__ import annotations
import argparse
from datetime import UTC, datetime
from pathlib import Path
import numpy as np
import pandas as pd

from app.domain.models.quote_microstructure import snapshots_from_dukascopy_ticks
from app.domain.training.collect_dukascopy import (
    INITIAL_FOREX_PRICE_DIGITS, decode_dukascopy_ticks,
)

BARRIERS_BPS=(0.5,1.0,2.0)
HORIZON_SECONDS=300

def parse_hour(path:Path)->datetime:
    year=int(path.parts[-4]); month=int(path.parts[-3])+1
    day=int(path.parts[-2]); hour=int(path.stem.split("h_ticks")[0])
    return datetime(year,month,day,hour,tzinfo=UTC)

def decode_day(paths:list[Path],instrument:str)->pd.DataFrame:
    digits=INITIAL_FOREX_PRICE_DIGITS[instrument]
    records=[]
    for path in sorted(paths):
        hour=parse_hour(path)
        ticks=decode_dukascopy_ticks(path.read_bytes(),hour_start=hour,price_digits=digits)
        for snap in snapshots_from_dukascopy_ticks(ticks):
            records.append((snap.timestamp.replace(microsecond=0),snap.bid,snap.ask))
    if not records:
        return pd.DataFrame(columns=["bid","ask","observed"])
    frame=pd.DataFrame(records,columns=["second","bid","ask"])
    frame=frame.sort_values("second").groupby("second",as_index=False).tail(1)
    frame["observed"]=1.0
    return frame.set_index("second").sort_index()

def _first_hit(values:np.ndarray,valid:np.ndarray,barrier:float):
    rows=np.arange(values.shape[0])
    up=valid & (values>=barrier)
    down=valid & (values<=-barrier)
    up_any=up.any(axis=1); down_any=down.any(axis=1)
    up_pos=np.where(up_any,up.argmax(axis=1),HORIZON_SECONDS+1)
    down_pos=np.where(down_any,down.argmax(axis=1),HORIZON_SECONDS+1)
    outcome=np.where(up_pos<down_pos,1,np.where(down_pos<up_pos,-1,0))
    hit_pos=np.minimum(up_pos,down_pos)
    cumulative=np.cumsum(valid,axis=1)
    seconds=np.full(len(values),np.nan)
    has=outcome!=0
    seconds[has]=cumulative[rows[has],hit_pos[has]]
    return outcome.astype(int),seconds

def label_day_fast(current:pd.DataFrame,following:pd.DataFrame,day_start:pd.Timestamp)->pd.DataFrame:
    end=day_start+pd.Timedelta(days=1,seconds=HORIZON_SECONDS-1)
    index=pd.date_range(day_start,end,freq="1s",tz=UTC)
    merged=pd.concat([current,following]).sort_index()
    merged=merged[~merged.index.duplicated(keep="last")].reindex(index)
    observed=merged["observed"].fillna(0.0).to_numpy(float)
    merged[["bid","ask"]]=merged[["bid","ask"]].ffill(limit=5)
    bid=merged["bid"].to_numpy(float); ask=merged["ask"].to_numpy(float)
    decisions=np.arange(60,86400,60,dtype=int)
    entry_idx=decisions-1
    future_idx=decisions[:,None]+np.arange(HORIZON_SECONDS,dtype=int)[None,:]
    entry_valid=np.isfinite(bid[entry_idx])&np.isfinite(ask[entry_idx])
    fb=bid[future_idx]; fa=ask[future_idx]
    valid=np.isfinite(fb)&np.isfinite(fa)
    enough=valid.sum(axis=1)>=150
    recent=valid[:,-30:].any(axis=1)
    keep=entry_valid&enough&recent
    if not keep.any():
        return pd.DataFrame()

    decisions=decisions[keep]; entry_idx=entry_idx[keep]
    future_idx=future_idx[keep]; fb=fb[keep]; fa=fa[keep]; valid=valid[keep]
    entry_ask=ask[entry_idx][:,None]; entry_bid=bid[entry_idx][:,None]
    lr=np.where(valid,fb/entry_ask-1.0,np.nan)
    sr=np.where(valid,entry_bid/fa-1.0,np.nan)

    last_pos=HORIZON_SECONDS-1-np.argmax(valid[:,::-1],axis=1)
    rows=np.arange(len(decisions))
    data={
        "decision_time":index[decisions],
        "path_quote_seconds":valid.sum(axis=1).astype(int),
        "path_observed_ticks_5m":observed[future_idx].sum(axis=1).astype(int),
        "long_mfe_5m_bps":np.nanmax(lr,axis=1)*10000.0,
        "long_mae_5m_bps":np.nanmin(lr,axis=1)*10000.0,
        "short_mfe_5m_bps":np.nanmax(sr,axis=1)*10000.0,
        "short_mae_5m_bps":np.nanmin(sr,axis=1)*10000.0,
        "long_terminal_5m_bps":lr[rows,last_pos]*10000.0,
        "short_terminal_5m_bps":sr[rows,last_pos]*10000.0,
    }
    for bps in BARRIERS_BPS:
        barrier=bps/10000.0
        lo,ls=_first_hit(lr,valid,barrier)
        so,ss=_first_hit(sr,valid,barrier)
        suffix=str(bps).replace(".","p")
        data[f"long_first_hit_{suffix}bps"]=lo
        data[f"long_first_hit_seconds_{suffix}bps"]=ls
        data[f"short_first_hit_{suffix}bps"]=so
        data[f"short_first_hit_seconds_{suffix}bps"]=ss
    return pd.DataFrame(data)

def main()->None:
    ap=argparse.ArgumentParser()
    ap.add_argument("--instrument",default="USDJPY")
    ap.add_argument("--cache-dir",default="/home/lightworld/research/dukascopy-raw-cache")
    ap.add_argument("--output",required=True)
    args=ap.parse_args()
    instrument=args.instrument.upper()
    root=Path(args.cache_dir)/instrument
    files=sorted(root.rglob("*h_ticks.bi5"))
    by_day={}
    for path in files:
        hour=parse_hour(path)
        day=pd.Timestamp(hour).floor("D")
        by_day.setdefault(day,[]).append(path)
    days=sorted(by_day); chunks=[]; decoded_cache={}
    for idx,day in enumerate(days,start=1):
        current=decoded_cache.pop(day,None)
        if current is None:
            current=decode_day(by_day[day],instrument)
        next_day=day+pd.Timedelta(days=1)
        following=decoded_cache.get(next_day)
        if following is None and next_day in by_day:
            following=decode_day(by_day[next_day],instrument)
            decoded_cache[next_day]=following
        if following is None:
            following=pd.DataFrame(columns=["bid","ask","observed"])
        chunk=label_day_fast(current,following,day)
        if not chunk.empty:
            chunks.append(chunk)
        if idx%10==0:
            print(f"processed_days={idx} rows={sum(len(x) for x in chunks)}",flush=True)
    if not chunks:
        raise SystemExit("No path labels produced")
    frame=pd.concat(chunks,ignore_index=True)
    frame=frame.sort_values("decision_time").drop_duplicates("decision_time",keep="last")
    output=Path(args.output); output.parent.mkdir(parents=True,exist_ok=True)
    frame.to_csv(output,index=False)
    print(f"output={output} rows={len(frame)} start={frame.decision_time.iloc[0]} end={frame.decision_time.iloc[-1]}")

if __name__=="__main__":
    main()
