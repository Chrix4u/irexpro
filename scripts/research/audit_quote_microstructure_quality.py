#!/usr/bin/env python3
"""Audit six-pair quote microstructure corpus quality and freeze hashes."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import pandas as pd

PAIRS=("AUDUSD","EURUSD","GBPUSD","USDCAD","USDCHF","USDJPY")

def sha256(path:Path)->str:
    h=hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda:f.read(1024*1024),b""):
            h.update(block)
    return h.hexdigest()

def audit(path:Path)->dict:
    df=pd.read_csv(path)
    df["decision_time"]=pd.to_datetime(df["decision_time"],utc=True,errors="raise")
    coverage=pd.to_numeric(df["quote_coverage_60s"],errors="raise")
    samples=pd.to_numeric(df["quote_samples_60s"],errors="raise")
    spread=pd.to_numeric(df["quote_spread_mean_bps_60s"],errors="raise")
    spread_p75=float(spread.quantile(.75))
    spread_p90=float(spread.quantile(.90))
    high=(coverage>=.50)&(samples>=30)&(spread<=spread_p75)
    usable=(coverage>=.25)&(samples>=15)&(spread<=spread_p90)
    return {
        "rows":int(len(df)),
        "start":str(df["decision_time"].min()),
        "end":str(df["decision_time"].max()),
        "sha256":sha256(path),
        "coverage_p10":float(coverage.quantile(.10)),
        "coverage_p50":float(coverage.quantile(.50)),
        "coverage_p90":float(coverage.quantile(.90)),
        "spread_mean_bps_p50":float(spread.quantile(.50)),
        "spread_mean_bps_p75":spread_p75,
        "spread_mean_bps_p90":spread_p90,
        "high_quality_rows":int(high.sum()),
        "high_quality_fraction":float(high.mean()),
        "usable_rows":int(usable.sum()),
        "usable_fraction":float(usable.mean()),
    }

def main()->None:
    ap=argparse.ArgumentParser()
    ap.add_argument("--corpus-dir",type=Path,required=True)
    ap.add_argument("--output",type=Path,required=True)
    args=ap.parse_args()
    report={
        "version":"six-pair-quote-microstructure-quality-v1",
        "high_quality_policy":"coverage>=0.50,samples>=30,spread<=pair_p75",
        "usable_policy":"coverage>=0.25,samples>=15,spread<=pair_p90",
        "pairs":{},
    }
    for pair in PAIRS:
        source=args.corpus_dir/f"{pair}_1S_M1_BOUNDARY.csv"
        if not source.is_file():
            raise FileNotFoundError(source)
        report["pairs"][pair]=audit(source)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps(report,indent=2))

if __name__=="__main__":
    main()
