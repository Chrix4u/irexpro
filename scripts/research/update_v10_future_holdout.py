#!/usr/bin/env python3
"""Append closed USDJPY M1 candles to the sealed v10 future holdout.

This utility is collection-only. It never trains, scores, labels, or evaluates the
holdout. Rows at or before the frozen decision boundary are ignored.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, subprocess, tempfile
from datetime import datetime, timezone
from pathlib import Path

BOUNDARY = datetime.fromisoformat('2026-09-27T05:00:00+00:00')
TARGET = 3000
FIELDS = ['timestamp','open','high','low','close','volume','tick_volume','spread_points','price_digits','quote_volume']

def parse_ts(v:str)->datetime:
    return datetime.fromisoformat(v.replace('Z','+00:00')).astimezone(timezone.utc)

def sha256(path:Path)->str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def read_rows(path:Path):
    if not path.exists(): return []
    with path.open(newline='') as f: return list(csv.DictReader(f))

def write_atomic(path:Path, rows:list[dict]):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.tmp')
    fields=list(rows[0].keys()) if rows else FIELDS
    with tmp.open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=fields); w.writeheader(); w.writerows(rows)
    tmp.replace(path)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--repo',default='/home/lightworld/webapps/irexpro-staging')
    ap.add_argument('--holdout',default='/home/lightworld/research/irexpro-usdjpy-v10-future-holdout/rolling/USDJPY_M1.csv')
    ap.add_argument('--cache-dir',default='/home/lightworld/research/dukascopy-raw-cache')
    ap.add_argument('--target-fetch-rows',type=int,default=3000)
    a=ap.parse_args()
    repo=Path(a.repo); holdout=Path(a.holdout)
    ai=repo/'services/ai-engine'; py=ai/'.venv/bin/python'
    counter_path=holdout.with_suffix('.counter.json')
    if counter_path.exists() and holdout.exists():
        previous=json.loads(counter_path.read_text())
        if previous.get('complete'):
            current_hash=sha256(holdout)
            expected_hash=previous.get('holdout_sha256')
            if expected_hash and current_hash != expected_hash:
                raise SystemExit('Completed sealed holdout hash mismatch; refusing to modify it')
            print(json.dumps(previous,sort_keys=True))
            return
    with tempfile.TemporaryDirectory(prefix='irex-v10-holdout-') as td:
        recent=Path(td)/'USDJPY_recent.csv'
        cmd=[str(py),'-m','app.domain.training.collect_dukascopy','--instrument','USDJPY','--target-rows',str(a.target_fetch_rows),'--output',str(recent),'--max-lookback-days','10','--parallelism','2','--max-retries','3','--cache-dir',a.cache_dir,'--skip-unrecoverable-days']
        env={'PYTHONPATH':str(ai)}
        import os
        runenv=os.environ.copy(); runenv.update(env)
        subprocess.run(cmd,cwd=ai,env=runenv,check=True)
        existing=read_rows(holdout)
        recent_rows=read_rows(recent)
        merged={r['timestamp']:r for r in existing}
        new_after_boundary=0
        for r in recent_rows:
            if parse_ts(r['timestamp']) <= BOUNDARY: continue
            if r['timestamp'] not in merged: new_after_boundary += 1
            merged[r['timestamp']]=r
        rows=sorted(merged.values(),key=lambda r:parse_ts(r['timestamp']))
        prefix=[r for r in rows if parse_ts(r['timestamp'])<=BOUNDARY]
        post=[r for r in rows if parse_ts(r['timestamp'])>BOUNDARY]
        previous_post_count=sum(1 for r in existing if parse_ts(r['timestamp'])>BOUNDARY)
        if len(post)>=TARGET:
            post=post[:TARGET]
        rows=prefix+post
        write_atomic(holdout,rows)
        count=len(post)
        rows_added=max(0,count-previous_post_count)
        manifest={
            'manifest_version':2,'purpose':'sealed_v10_future_holdout_collection_only',
            'instrument':'USDJPY','timeframe':'M1','boundary_exclusive':BOUNDARY.isoformat(),
            'target_new_closed_candles':TARGET,'new_closed_candles_collected':count,
            'remaining':max(TARGET-count,0),'complete':count>=TARGET,
            'first_post_boundary':post[0]['timestamp'] if post else None,
            'latest_post_boundary':post[-1]['timestamp'] if post else None,
            'rows_added_this_refresh':rows_added,
            'sealed_at_target':count>=TARGET,
            'holdout_sha256':sha256(holdout),'updated_at':datetime.now(timezone.utc).isoformat(),
            'research_only':True,'consumed_for_training':False,'consumed_for_model_selection':False,
        }
        mp=holdout.with_suffix('.counter.json'); mt=mp.with_suffix(mp.suffix+'.tmp')
        mt.write_text(json.dumps(manifest,indent=2,sort_keys=True)); mt.replace(mp)
        print(json.dumps(manifest,sort_keys=True))
if __name__=='__main__': main()
