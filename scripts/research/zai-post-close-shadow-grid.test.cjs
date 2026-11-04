'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {shadowReplay,evaluateTrade,summary,atrFromCompletedBars}=require('./zai-post-close-shadow-grid.cjs');

const start=Date.parse('2026-11-03T12:15:00Z');
const bar=(time,{open=1.1002,high=1.1003,low=1.1001,close=1.1002}={})=>({
  bucket_time:new Date(time).toISOString(),
  open,high,low,close,source:'ctrader-broker-native',sample_count:10,
});
const warmup=()=>Array.from({length:15},(_,i)=>bar(start+i*60_000));
const base=()=>({
  accountCurrency:'EUR',strategyRoute:'EARLY_TRANSITION',
  direction:'BUY',entry:1.1000,stopLoss:1.0990,takeProfit:1.1016,
  exitPrice:1.1004,actualExitR:0.4,
  closedAt:'2026-11-03T12:30:30.000Z',
  candles:warmup(),
});

test('price-only original barrier and fixed ATR trail return TP with no lookahead',()=>{
  const t=base();t.candles.push(bar(Date.parse('2026-11-03T12:31:00Z'),
    {open:1.1006,low:1.1005,high:1.1017,close:1.1012}));
  assert.equal(shadowReplay(t).status,'TP_FIRST');
  assert.ok(Math.abs(shadowReplay(t).r-1.6)<1e-9);
  assert.equal(shadowReplay(t,{trailAtrMultiplier:2.5}).status,'TP_FIRST');
  const r=summary([evaluateTrade(t)],{closeFraction:0.5});
  const orig=r.find(x=>x.scenario==='original');
  assert.equal(orig.resolved,1);
  assert.ok(Math.abs(orig.meanDeltaR-0.6)<1e-9);
});

test('adverse opening gap fills at worse open, not optimistic stop',()=>{
  const t=base();
  t.candles.push(bar(Date.parse('2026-11-03T12:31:00Z'),
    {open:1.0988,low:1.0987,high:1.0990,close:1.0989}));
  assert.equal(shadowReplay(t).status,'STOP_FIRST');
  assert.ok(shadowReplay(t).r<-1);
});

test('same M1 candle crossing TP and SL is excluded instead of assuming TP',()=>{
  const t=base();t.candles.push(bar(Date.parse('2026-11-03T12:31:00Z'),
    {open:1.1001,low:1.0988,high:1.1017,close:1.1002}));
  assert.equal(shadowReplay(t).status,'AMBIGUOUS_SAME_M1');
  assert.equal(shadowReplay(t).r,null);
  assert.equal(summary([evaluateTrade(t)])[0].resolved,0);
});

test('missing post-close M1 candle fails closed',()=>{
  const t=base();t.candles.push(bar(Date.parse('2026-11-03T12:33:00Z'),
    {open:1.1005,low:1.1003,high:1.1017,close:1.1012}));
  assert.equal(shadowReplay(t).status,'DATA_GAP');
});

test('ATR-only policy needs 15 continuous fully completed M1 bars',()=>{
  const t=base();t.candles=t.candles.slice(3);
  t.candles.push(bar(Date.parse('2026-11-03T12:31:00Z'),
    {open:1.1006,low:1.1005,high:1.1017,close:1.1012}));
  assert.equal(shadowReplay(t,{trailAtrMultiplier:2.5}).status,'NO_PREEXIT_ATR');
  assert.equal(shadowReplay(t).status,'TP_FIRST');
});

test('exclude not-yet-complete bar when calculating ATR at protected exit',()=>{
  const bars=warmup().map(r=>({time:new Date(r.bucket_time).getTime(),
    open:r.open,high:r.high,low:r.low,close:r.close}));
  const before=Date.parse('2026-11-03T12:30:30Z');
  const original=atrFromCompletedBars(bars,before);
  bars.push({time:Date.parse('2026-11-03T12:30:00Z'),
    open:1.1,high:1.2,low:1.0,close:1.1});
  assert.equal(atrFromCompletedBars(bars,before),original);
});

test('SELL side original take profit directional risk is positive',()=>{
  const t=base();Object.assign(t,{
    direction:'SELL',entry:1.1000,stopLoss:1.1010,takeProfit:1.0984,
    exitPrice:1.0996,actualExitR:0.4});
  t.candles.push(bar(Date.parse('2026-11-03T12:31:00Z'),
    {open:1.0994,high:1.0995,low:1.0983,close:1.0985}));
  assert.equal(shadowReplay(t).status,'TP_FIRST');
  assert.ok(Math.abs(shadowReplay(t).r-1.6)<1e-9);
});

test('target in an M1 bar extending beyond the 4h horizon is not counted',()=>{
  const t=base();
  const first=Date.parse('2026-11-03T12:31:00Z');
  for(let i=0;i<239;i++){
    t.candles.push(bar(first+i*60_000));
  }
  t.candles.push(bar(Date.parse('2026-11-03T16:30:00Z'),
    {open:1.1002,low:1.1001,high:1.1017,close:1.1002}));
  const result=shadowReplay(t);
  assert.equal(result.status,'NEITHER_4H');
});

test('no cross-currency or cross-route aggregation; costs reduce hypothetical advantage',()=>{
  const a=base();a.candles.push(bar(Date.parse('2026-11-03T12:31:00Z'),
    {open:1.1006,low:1.1005,high:1.1017,close:1.1012}));
  const b={...a,accountCurrency:'USD',strategyRoute:'TREND_CONTINUATION'};
  const rows=summary([evaluateTrade(a),evaluateTrade(b)],{
    closeFraction:0.5,additionalCostR:0.1});
  assert.equal(rows.filter(x=>x.scenario==='original').length,2);
  assert.ok(rows.every(x=>x.meanDeltaR===null || x.meanDeltaR<=0.5+1e-8));
});
