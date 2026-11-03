'use strict';

/**
 * RESEARCH ONLY — no broker, order, risk, runtime, provider, or DB imports.
 *
 * A conditional counterfactual beginning AFTER an actually protected exit:
 * close a fraction at the actual exit R, hypothetically retain the remainder
 * until original TP/SL or a causal ATR-at-exit trailing stop.
 *
 * This is NOT z.ai P1's proposed "scale out at 1R from opening" backtest.
 * It does NOT prove price-path execution, net profitability, or a causal benefit.
 * Broker-native M1 candle OHLC can be ambiguous; those cases are excluded.
 * Caller must provide quotes and R, separated by route and account currency.
 */

const SOURCE = 'ctrader-broker-native';
const HORIZON_MINUTES = 240;
const MINUTE_MS = 60_000;

function number(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBar(row) {
  const time = new Date(row.bucket_time).getTime();
  const open = number(row.open), high = number(row.high);
  const low = number(row.low), close = number(row.close);
  const samples = number(row.sample_count);
  if (!Number.isFinite(time) || open == null || high == null || low == null ||
      close == null || samples == null || samples <= 0 ||
      ![open,close].every(x => x >= low && x <= high) ||
      high < low || row.source !== SOURCE) return null;
  return { time,open,high,low,close };
}

function atrFromCompletedBars(rows, beforeTime, period = 14) {
  const candles = rows.filter(b => b.time + MINUTE_MS <= beforeTime);
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-period-1);
  if (recent.some((bar, i) => i > 0 && bar.time - recent[i-1].time !== MINUTE_MS)) return null;
  let sum = 0;
  for (let i = 1; i < recent.length; i++) {
    const b=recent[i], prev=recent[i-1];
    sum += Math.max(b.high-b.low,Math.abs(b.high-prev.close),Math.abs(b.low-prev.close));
  }
  return sum / period;
}

function hit(direction, bar, stop, target) {
  const isBuy = direction === 'BUY';
  const sl = isBuy ? bar.low <= stop : bar.high >= stop;
  const tp = isBuy ? bar.high >= target : bar.low <= target;
  if (sl && tp) return {status:'AMBIGUOUS_SAME_M1',exitPrice:null};
  if (sl) {
    const gapStop = isBuy ? Math.min(stop,bar.open) : Math.max(stop,bar.open);
    return {status:'STOP_FIRST',exitPrice:gapStop};
  }
  if (tp) return {status:'TP_FIRST',exitPrice:target};
  return null;
}

function shadowReplay(trade,{trailAtrMultiplier=null,atrPeriod=14}={}) {
  const {direction,entry,stopLoss,takeProfit,closedAt,exitPrice,actualExitR}=trade;
  const isBuy=direction==='BUY';
  const signed=isBuy?1:-1;
  const risk=signed*(entry-stopLoss);
  const targetR=signed*(takeProfit-entry)/risk;
  const time=new Date(closedAt).getTime();
  if (!['BUY','SELL'].includes(direction) || !Number.isFinite(time) ||
      ![entry,stopLoss,takeProfit,exitPrice,actualExitR].every(Number.isFinite) ||
      risk<=0 || targetR<=0) return {status:'INVALID_TRADE',r:null};
  const rows=(trade.candles??[]).map(toBar).filter(Boolean).sort((a,b)=>a.time-b.time);
  const first=Math.floor(time/MINUTE_MS)*MINUTE_MS+MINUTE_MS;
  const cutoff=time+HORIZON_MINUTES*MINUTE_MS;
  const future=rows.filter(b=>b.time>=first && b.time<=cutoff);
  const staticAtr=trailAtrMultiplier===null?null:atrFromCompletedBars(rows,time,atrPeriod);
  if (trailAtrMultiplier!==null && (!(trailAtrMultiplier>0) || staticAtr===null ||
      !(staticAtr>0))) return {status:'NO_PREEXIT_ATR',r:null};
  let stop=stopLoss;
  if (staticAtr!==null) {
    const proposal=exitPrice-signed*trailAtrMultiplier*staticAtr;
    stop=isBuy?Math.max(stop,proposal):Math.min(stop,proposal);
    // No optimistic stop activation beyond the observable exit fill.
    stop=isBuy?Math.min(stop,exitPrice):Math.max(stop,exitPrice);
  }
  let previous=first-MINUTE_MS;
  for (const bar of future) {
    if (bar.time-previous!==MINUTE_MS) return {status:'DATA_GAP',r:null};
    previous=bar.time;
    const barrier=hit(direction,bar,stop,takeProfit);
    if (barrier) {
      if (barrier.exitPrice===null) return {status:barrier.status,r:null};
      return {status:barrier.status,
        r:signed*(barrier.exitPrice-entry)/risk,
        exitAt:new Date(bar.time).toISOString()};
    }
    // Update only AFTER this minute has fully played out. Static ATR is fixed
    // at time of actual close; this cannot leak future volatility into stops.
    if (staticAtr!==null) {
      const next=bar.close-signed*trailAtrMultiplier*staticAtr;
      stop=isBuy?Math.max(stop,next):Math.min(stop,next);
    }
  }
  const lastCoverageEnd=future.length?future[future.length-1].time+MINUTE_MS:0;
  return lastCoverageEnd<cutoff ?
    {status:'DATA_GAP',r:null} : {status:'NEITHER_4H',r:null};
}

function evaluateTrade(trade) {
  const original=shadowReplay(trade);
  const trail2=shadowReplay(trade,{trailAtrMultiplier:2});
  const trail25=shadowReplay(trade,{trailAtrMultiplier:2.5});
  const trail3=shadowReplay(trade,{trailAtrMultiplier:3});
  return {
    accountCurrency:trade.accountCurrency??'UNKNOWN',
    strategyRoute:trade.strategyRoute??'UNKNOWN',
    actualExitR:trade.actualExitR,
    original,trail2,trail25,trail3,
  };
}

function summary(rows,{closeFraction=0.5,additionalCostR=0}={}) {
  if (!(closeFraction>=0&&closeFraction<=1) || !(additionalCostR>=0)) {
    throw new Error('Invalid scenario values');
  }
  const names=['original','trail2','trail25','trail3'];
  const result=[];
  const cohorts=new Set(rows.map(r=>(r.accountCurrency??'UNKNOWN')+'|'+(r.strategyRoute??'UNKNOWN')));
  for(const cohort of cohorts) {
    const [currency,route]=cohort.split('|');
    const items=rows.filter(r=>(r.accountCurrency??'UNKNOWN')===currency &&
      (r.strategyRoute??'UNKNOWN')===route);
    for (const name of names) {
      const comparable=items.filter(r=>Number.isFinite(r.actualExitR) && Number.isFinite(r[name]?.r));
      const deltas=comparable.map(r=>(1-closeFraction)*
        (r[name].r-r.actualExitR)-additionalCostR);
      result.push({
        accountCurrency:currency,strategyRoute:route,scenario:name,
        closeFraction,additionalCostR,
        total:items.length,resolved:comparable.length,
        ambiguous:items.filter(r=>r[name]?.status==='AMBIGUOUS_SAME_M1').length,
        dataGap:items.filter(r=>r[name]?.status==='DATA_GAP').length,
        noAtr:items.filter(r=>r[name]?.status==='NO_PREEXIT_ATR').length,
        neither:items.filter(r=>r[name]?.status==='NEITHER_4H').length,
        meanDeltaR:deltas.length?deltas.reduce((a,b)=>a+b,0)/deltas.length:null,
        positiveDeltaCount:deltas.filter(d=>d>0).length,
      });
    }
  }
  return result;
}

module.exports={atrFromCompletedBars,shadowReplay,evaluateTrade,summary};
