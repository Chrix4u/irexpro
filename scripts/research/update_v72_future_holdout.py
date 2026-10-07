#!/usr/bin/env python3
"""Append closed USDJPY M1 candles to the sealed v72 future holdout.

This utility is collection-only. It never trains, scores, labels, or evaluates the
holdout. Rows at or before the frozen decision boundary are ignored.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, subprocess, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

BOUNDARY = datetime.fromisoformat('2026-09-30T21:00:00+00:00')
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

def read_cached_contiguous_rows(
    *,
    cache_dir: Path,
    start_after: datetime,
    observed_now: datetime,
) -> list[dict]:
    """Read only verified cached M1 rows contiguous with the sealed frontier.

    The scan advances hour-by-hour and stops at the first open-market hour
    without a decodable raw cache file. It never jumps a data gap.
    """
    from app.domain.training.collect_dukascopy import (
        _is_forex_market_closed_hour,
        _raw_cache_path,
        aggregate_ticks_to_m1,
        decode_dukascopy_ticks,
    )

    start_after = start_after.astimezone(timezone.utc)
    observed_now = observed_now.astimezone(timezone.utc)
    hour = start_after.replace(minute=0, second=0, microsecond=0)
    if start_after.minute == 59:
        hour += timedelta(hours=1)
    last_closed_hour = (
        observed_now.replace(minute=0, second=0, microsecond=0)
        - timedelta(hours=1)
    )

    recovered: list[dict] = []
    frontier = start_after
    while hour <= last_closed_hour:
        if _is_forex_market_closed_hour(hour):
            hour += timedelta(hours=1)
            continue

        raw_path = _raw_cache_path(cache_dir, 'USDJPY', hour)
        if not raw_path.is_file():
            break

        try:
            payload = raw_path.read_bytes()
            ticks = decode_dukascopy_ticks(
                payload,
                hour_start=hour,
                price_digits=3,
            )
            rows = aggregate_ticks_to_m1(ticks, price_digits=3)
        except Exception:
            break

        for row in rows:
            if parse_ts(str(row['timestamp'])) > frontier:
                recovered.append({field: row[field] for field in FIELDS})
        if rows:
            frontier = max(frontier, max(parse_ts(str(row['timestamp'])) for row in rows))
        hour += timedelta(hours=1)

    return recovered

def fill_forward_cache(
    *,
    cache_dir: Path,
    start_after: datetime,
    observed_now: datetime,
    max_new_rows: int,
    timeout_seconds: float,
    max_retries: int,
) -> dict:
    from app.domain.training.collect_dukascopy import (
        _fetch_hour,
        _is_forex_market_closed_hour,
    )
    start_after = start_after.astimezone(timezone.utc)
    observed_now = observed_now.astimezone(timezone.utc)
    hour = start_after.replace(minute=0, second=0, microsecond=0)
    if start_after.minute == 59:
        hour += timedelta(hours=1)
    last_closed_hour = observed_now.replace(
        minute=0, second=0, microsecond=0
    ) - timedelta(hours=1)
    fetched_rows = 0
    attempted_hours = 0
    network_downloads = 0
    stopped_at = None
    stop_error = None
    while hour <= last_closed_hour and fetched_rows < max_new_rows:
        if _is_forex_market_closed_hour(hour):
            hour += timedelta(hours=1)
            continue
        attempted_hours += 1
        telemetry: dict = {}
        try:
            _hour, rows, _payload_bytes, missing = _fetch_hour(
                instrument='USDJPY',
                hour=hour,
                price_digits=3,
                timeout_seconds=timeout_seconds,
                max_retries=max_retries,
                cache_dir=cache_dir,
                telemetry=telemetry,
            )
        except Exception as exc:
            stopped_at = hour.isoformat()
            stop_error = type(exc).__name__
            break
        if missing:
            stopped_at = hour.isoformat()
            stop_error = 'provider_missing_open_hour'
            break
        fetched_rows += sum(
            1 for row in rows if parse_ts(str(row['timestamp'])) > start_after
        )
        if telemetry.get('network_download'):
            network_downloads += 1
            time.sleep(1.5)
        hour += timedelta(hours=1)
    return {
        'frontier_attempted_hours': attempted_hours,
        'frontier_network_downloads': network_downloads,
        'frontier_rows_seen': fetched_rows,
        'frontier_stopped_at': stopped_at,
        'frontier_stop_error': stop_error,
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--repo',default='/home/lightworld/webapps/irexpro-staging')
    ap.add_argument('--holdout',default='/home/lightworld/research/irexpro-usdjpy-v72-future-holdout/rolling/USDJPY_M1.csv')
    ap.add_argument('--cache-dir',default='/home/lightworld/research/dukascopy-raw-cache')
    ap.add_argument('--target-fetch-rows',type=int,default=3000)
    ap.add_argument('--frontier-timeout-seconds',type=float,default=20.0)
    ap.add_argument('--frontier-max-retries',type=int,default=3)
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
    existing=read_rows(holdout)
    existing_post_times=[
        parse_ts(r['timestamp'])
        for r in existing
        if parse_ts(r['timestamp']) > BOUNDARY
    ]
    frontier=max(existing_post_times) if existing_post_times else BOUNDARY
    recent_rows=[]
    frontier_fetch={}
    observed_now=datetime.now(timezone.utc)

    if existing_post_times:
        frontier_fetch=fill_forward_cache(
            cache_dir=Path(a.cache_dir),
            start_after=frontier,
            observed_now=observed_now,
            max_new_rows=max(TARGET-len(existing_post_times),0),
            timeout_seconds=a.frontier_timeout_seconds,
            max_retries=a.frontier_max_retries,
        )
    else:
        with tempfile.TemporaryDirectory(prefix='irex-v72-holdout-') as td:
            recent=Path(td)/'USDJPY_recent.csv'
            cmd=[str(py),'-m','app.domain.training.collect_dukascopy','--instrument','USDJPY','--target-rows',str(a.target_fetch_rows),'--output',str(recent),'--max-lookback-days','10','--parallelism','2','--max-retries','3','--cache-dir',a.cache_dir,'--skip-unrecoverable-days']
            env={'PYTHONPATH':str(ai)}
            import os
            runenv=os.environ.copy(); runenv.update(env)
            subprocess.run(cmd,cwd=ai,env=runenv,check=True)
            recent_rows=read_rows(recent)

    cached_prefix_rows=read_cached_contiguous_rows(
        cache_dir=Path(a.cache_dir),
        start_after=frontier,
        observed_now=observed_now,
    )
    merged={r['timestamp']:r for r in existing}
    new_after_boundary=0
    for r in [*recent_rows, *cached_prefix_rows]:
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
        'manifest_version':2,'purpose':'sealed_v72_future_holdout_collection_only',
        'instrument':'USDJPY','timeframe':'M1','boundary_exclusive':BOUNDARY.isoformat(),
        'target_new_closed_candles':TARGET,'new_closed_candles_collected':count,
        'remaining':max(TARGET-count,0),'complete':count>=TARGET,
        'first_post_boundary':post[0]['timestamp'] if post else None,
        'latest_post_boundary':post[-1]['timestamp'] if post else None,
        'rows_added_this_refresh':rows_added,
        'cached_contiguous_rows_discovered':len(cached_prefix_rows),
        **frontier_fetch,
        'sealed_at_target':count>=TARGET,
        'holdout_sha256':sha256(holdout),'updated_at':datetime.now(timezone.utc).isoformat(),
        'research_only':True,'consumed_for_training':False,'consumed_for_model_selection':False,
    }
    mp=holdout.with_suffix('.counter.json'); mt=mp.with_suffix(mp.suffix+'.tmp')
    mt.write_text(json.dumps(manifest,indent=2,sort_keys=True)); mt.replace(mp)
    print(json.dumps(manifest,sort_keys=True))
if __name__=='__main__': main()
