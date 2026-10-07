from __future__ import annotations
import argparse, json
from datetime import UTC, datetime, timedelta
from pathlib import Path
import numpy as np
import pandas as pd

from app.domain.models.quote_microstructure import QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS
from app.domain.training.collect_dukascopy import (
    INITIAL_FOREX_PRICE_DIGITS,
    decode_dukascopy_ticks,
)

PAIRS=("AUDUSD","EURUSD","GBPUSD","USDCAD","USDCHF","USDJPY")

def hour_from_path(path:Path)->datetime:
    # .../<PAIR>/<year>/<zero-based-month>/<day>/<HH>h_ticks.bi5
    year=int(path.parts[-4]); month=int(path.parts[-3])+1
    day=int(path.parts[-2]); hour=int(path.stem.split("h_ticks")[0])
    return datetime(year,month,day,hour,tzinfo=UTC)

def files_for_pair(cache_root:Path,pair:str)->list[Path]:
    return sorted(
        p for p in (cache_root/pair).glob("*/*/*/*h_ticks.bi5")
        if "/m1/" not in str(p)
    )
def features_for_hour(ticks,hour:datetime):
    records=[(t,(a+b)/2.0,(a-b)/((a+b)/2.0)*10000.0) for t,a,b,*_ in ticks]
    frame=pd.DataFrame(records,columns=["timestamp","mid","spread_bps"]).sort_values("timestamp")
    frame["second"]=pd.to_datetime(frame["timestamp"],utc=True).dt.floor("s")
    frame=frame.groupby("second",as_index=False).tail(1).set_index("second")
    idx=pd.date_range(hour,hour+timedelta(hours=1)-timedelta(seconds=1),freq="1s",tz=UTC)
    sampled=frame.reindex(idx)
    observed=sampled["mid"].notna()
    rows=[]
    for minute in range(1,61):
        raw_block=sampled.iloc[(minute-1)*60:minute*60].copy()
        obs=int(observed.iloc[(minute-1)*60:minute*60].sum())
        raw_block[["mid","spread_bps"]]=raw_block[["mid","spread_bps"]].ffill()
        block=raw_block.dropna(subset=["mid","spread_bps"])
        if len(block)<5: continue
        mid=block["mid"].astype(float); spread=block["spread_bps"].astype(float); ret=mid.pct_change().dropna()
        def lr(sec):
            if len(mid)<=sec:return 0.0
            return float(mid.iloc[-1]/mid.iloc[-1-sec]-1.0)
        directional=np.sign(ret.to_numpy(float)); directional=directional[directional!=0]
        rows.append({"decision_time":hour+timedelta(minutes=minute),"quote_samples_60s":float(obs),"quote_coverage_60s":float(obs/60.0),"quote_mid_return_5s":lr(5),"quote_mid_return_15s":lr(15),"quote_mid_return_30s":lr(30),"quote_mid_return_60s":lr(min(59,len(mid)-1)),"quote_realized_vol_60s":float(ret.std(ddof=0)) if len(ret) else 0.0,"quote_mid_range_bps_60s":float((mid.max()-mid.min())/abs(mid.iloc[-1])*10000.0),"quote_spread_last_bps":float(spread.iloc[-1]),"quote_spread_mean_bps_60s":float(spread.mean()),"quote_spread_max_bps_60s":float(spread.max()),"quote_spread_change_15s":float(spread.iloc[-1]-spread.iloc[-16]) if len(spread)>=16 else 0.0,"quote_direction_imbalance_60s":float(directional.mean()) if len(directional) else 0.0,"quote_max_abs_1s_return_bps_60s":float(ret.abs().max()*10000.0) if len(ret) else 0.0})
    return rows

def build_pair(cache_root:Path,pair:str,out_dir:Path,max_hours:int|None=None,sample_hours:int|None=None)->dict:
    digits=INITIAL_FOREX_PRICE_DIGITS[pair]
    files=files_for_pair(cache_root,pair)
    if sample_hours is not None and 0 < sample_hours < len(files):
        indices=np.linspace(0,len(files)-1,sample_hours,dtype=int)
        files=[files[int(i)] for i in indices]
    if max_hours is not None:
        files=files[:max_hours]
    rows=[]
    decoded_hours=0
    skipped_hours=0
    for idx,path in enumerate(files,1):
        hour=hour_from_path(path)
        try:
            ticks=decode_dukascopy_ticks(
                path.read_bytes(),hour_start=hour,price_digits=digits
            )
        except Exception:
            skipped_hours+=1
            continue
        if not ticks:
            skipped_hours+=1
            continue
        hour_rows=features_for_hour(ticks,hour)
        if not hour_rows:
            skipped_hours+=1
            continue
        decoded_hours+=1
        for row in hour_rows:
            decision=row.pop("decision_time")
            rows.append({"decision_time":decision.isoformat(),"instrument":pair,**row})
        if idx % 100 == 0:
            print(json.dumps({
                "pair":pair,"hours_processed":idx,
                "rows":len(rows),"decoded_hours":decoded_hours,
                "skipped_hours":skipped_hours,
            }),flush=True)
    frame=pd.DataFrame(rows)
    if not frame.empty:
        frame["decision_time"]=pd.to_datetime(frame["decision_time"],utc=True)
        frame=frame.drop_duplicates("decision_time").sort_values("decision_time")
    out_dir.mkdir(parents=True,exist_ok=True)
    csv_path=out_dir/f"{pair}_1S_M1_BOUNDARY.csv"
    frame.to_csv(csv_path,index=False)
    report={
        "instrument":pair,
        "source":"dukascopy_raw_bi5_cache",
        "source_hours":len(files),
        "decoded_hours":decoded_hours,
        "skipped_hours":skipped_hours,
        "row_count":int(len(frame)),
        "start":None if frame.empty else frame["decision_time"].min().isoformat(),
        "end":None if frame.empty else frame["decision_time"].max().isoformat(),
        "features":list(QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS),
        "output":str(csv_path),
    }
    if not frame.empty:
        q=frame["quote_coverage_60s"].quantile([.01,.1,.5,.9,.99])
        report["coverage_quantiles"]={str(k):float(v) for k,v in q.items()}
        s=frame["quote_spread_mean_bps_60s"].quantile([.01,.1,.5,.9,.99])
        report["spread_mean_bps_quantiles"]={str(k):float(v) for k,v in s.items()}
    (out_dir/f"{pair}_manifest.json").write_text(
        json.dumps(report,indent=2),encoding="utf-8"
    )
    print(json.dumps(report,indent=2),flush=True)
    return report

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--cache-root",type=Path,required=True)
    ap.add_argument("--output-dir",type=Path,required=True)
    ap.add_argument("--pairs",default=",".join(PAIRS))
    ap.add_argument("--max-hours",type=int,default=None)
    ap.add_argument("--sample-hours",type=int,default=None)
    args=ap.parse_args()
    reports=[]
    for pair in [x.strip().upper() for x in args.pairs.split(",") if x.strip()]:
        if pair not in PAIRS:
            raise ValueError(f"Unsupported pair: {pair}")
        reports.append(build_pair(args.cache_root,pair,args.output_dir,args.max_hours,args.sample_hours))
    (args.output_dir/"summary.json").write_text(
        json.dumps(reports,indent=2),encoding="utf-8"
    )

if __name__=="__main__":
    main()
