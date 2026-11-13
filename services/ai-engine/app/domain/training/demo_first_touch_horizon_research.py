"""Read-only first-touch TP/SL study on completed broker M1 OHLC.

Conservative: ambiguous same-minute TP+SL is counted as STOP. M1 OHLC
cannot replicate tick-order first-touch, fills, gaps or stop slippage.
Never calls any execution service.
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
import numpy as np
import pandas as pd
from app.domain.training.demo_pepperstone_two_pair_horizon_audit import enrich,summarize,PIP

COST_PIPS=1.1   # $9 / standard lot + 0.2 pips slippage, USD account
CONFIGS=(
    (2.0,4.0,10),
    (4.0,6.0,30),
    (6.0,8.0,60),
)

def first_touch(frame:pd.DataFrame, ix:int, side:int, tp:float, sl:float, minutes:int):
    entry=frame.iloc[ix]
    price=float(entry.ask if side==1 else entry.bid)
    timestamp=entry.stamp
    for j in range(ix+1,min(ix+minutes+1,len(frame))):
        future=frame.iloc[j]
        if future.stamp-timestamp!=pd.Timedelta(minutes=j-ix):
            return None
        # Candle OHLC lacks bid/ask extremes. Reserve HALF the next observed
        # quoted spread against the trade; this is still only an approximation.
        halfspread=max(float(future.ask-future.bid)/2,0.000005)
        bid_high=float(future.high)-halfspread
        bid_low=float(future.low)-halfspread
        ask_high=float(future.high)+halfspread
        ask_low=float(future.low)+halfspread
        if side==1:
            hit_stop=bid_low<=price-sl*PIP
            hit_take=bid_high>=price+tp*PIP
        else:
            hit_stop=ask_high>=price+sl*PIP
            hit_take=ask_low<=price-tp*PIP
        if hit_stop:
            return -sl-COST_PIPS
        if hit_take:
            return tp-COST_PIPS
    if ix+minutes>=len(frame):
        return None
    exitrow=frame.iloc[ix+minutes]
    gross=((float(exitrow.bid)-price) if side==1 else
           (price-float(exitrow.ask)))/PIP
    return gross-COST_PIPS

def audit(path:Path)->dict:
    raw=pd.read_csv(path,parse_dates=['stamp'])
    for c in ('bid','ask','open','high','low','close'):
        raw[c]=pd.to_numeric(raw[c],errors='coerce')
    raw=raw.dropna(subset=['stamp','bid','ask','open','high','low','close'])
    raw=raw[(raw.bid>0)&(raw.ask>=raw.bid)]
    report={'artifact':'irexpro-four-red-first-touch-research-v1',
        'executionAuthority':'NONE','ordersSubmitted':0,
        'assumptions':{'commissionPlusSlippagePips':COST_PIPS,
                       'ambiguousBothHit':'STOP_FIRST',
                       'quoteExtremes':'HALF_SPREAD_CONSERVATIVE_PROXY'},
        'results':[]}
    for instrument,quotes in raw.groupby('instrument'):
        df=enrich(quotes).reset_index(drop=True)
        days=sorted(df.stamp.dt.date.unique())
        if len(days)<7:continue
        start=pd.Timestamp(str(days[-3]),tz='UTC')
        for label,side in [('fourRedRebound',1),('fourRedContinuation',-1),
                           ('fourGreenReversal',-1),('fourGreenContinuation',1)]:
            trigger=(df.red4==1) if label.startswith('fourRed') else (df.green4==1)
            for tp,sl,hold in CONFIGS:
                entries=[]
                by_day={}
                next_eligible=pd.Timestamp('2000-01-01',tz='UTC')
                for ix in np.flatnonzero(trigger.to_numpy()):
                    r=df.iloc[int(ix)]
                    if r.stamp < start or r.stamp < next_eligible:continue
                    value=first_touch(df,int(ix),side,tp,sl,hold)
                    if value is None:continue
                    entries.append(value)
                    by_day.setdefault(str(r.stamp.date()),[]).append(value)
                    next_eligible=r.stamp+pd.Timedelta(minutes=hold)
                report['results'].append({
                    'instrument':instrument,'pattern':label,
                    'takeProfitPips':tp,'stopLossPips':sl,'maxHoldMinutes':hold,
                    'holdoutDays':[str(x) for x in days[-3:]],
                    'overall':summarize(entries),
                    'daily':{day:summarize(values) for day,values in sorted(by_day.items())},
                })
    return report

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--csv',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    if args.csv.parent!=Path('/tmp') or args.out.parent!=Path('/tmp') or args.out.exists():
        raise ValueError('Require fresh /tmp artifacts')
    result=audit(args.csv)
    args.out.write_text(json.dumps(result,indent=2))
    args.out.chmod(0o600)
    print(json.dumps({'artifact':result['artifact'],
                      'results':result['results']},indent=2))
if __name__=='__main__':main()
