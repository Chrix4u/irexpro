'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const m=require('./owner-demo-entry-candlestick-context.cjs');
const decision='2026-11-19T09:00:00Z';
const mk=(extra={})=>({
 timeframe:'M1',bucket_time:'2026-11-19T08:58:00Z',
 open:1.13,high:1.132,low:1.1298,close:1.1303,
 source:'ctrader-broker-native',sample_count:10,positive_quote_sample_count:8,
 last_sample_at:'2026-11-19T08:58:59Z',
 created_at:'2026-11-19T08:58:02Z',
 updated_at:'2026-11-19T08:58:59Z',
 ...extra,
});
test('completed broker-native candle captures the rejection wick before decision',()=>{
 const x=m.parseAsOfCandle(mk(),decision);
 assert.equal(x.candleLabel,'LONG_UPPER_REJECTION_WICK');
 assert.equal(x.independentlyCompletedBeforeDecision,true);
 assert(x.upperWickRatio>.57);
});
test('reject forming, synthetic, backfilled or after-decision revised candles',()=>{
 const bad=[
  {bucket_time:'2026-11-19T09:00:00Z'},
  {source:'simulated'},
  {last_sample_at:'2026-11-19T09:00:02Z'},
  {created_at:'2026-11-19T09:00:02Z'},
  {updated_at:'2026-11-19T09:00:02Z'},
  {positive_quote_sample_count:0},
  {high:1.129},
 ];
 for(const sample of bad){
  assert.equal(m.parseAsOfCandle(mk(sample),decision),null,
   'reject '+JSON.stringify(sample));
 }
});
test('frozen context has verified M1 and M5 formations, never target labels',()=>{
 const m5=mk({timeframe:'M5',bucket_time:'2026-11-19T08:50:00Z',
  open:1.132,high:1.1323,low:1.1298,close:1.1300,
  created_at:'2026-11-19T08:50:02Z',
  last_sample_at:'2026-11-19T08:54:59Z',
  updated_at:'2026-11-19T08:54:59Z'});
 const context=m.buildPreEntryCandleContext([mk(),m5],decision);
 assert.equal(context.M1.state,'VERIFIED_COMPLETED_AS_OF_ENTRY');
 assert.equal(context.M5.state,'VERIFIED_COMPLETED_AS_OF_ENTRY');
 assert.equal(context.M5.latestCandle,'BEAR_WIDE_BODY');
 assert.equal(context.noTradingAuthority,true);
 assert.equal(Object.hasOwn(context,'netPnlUsd'),false);
 assert.equal(Object.hasOwn(context,'eventualWin'),false);
});
test('stale and missing context remains unavailable, never invented',()=>{
 const old=mk({bucket_time:'2026-11-19T08:40:00Z',
  created_at:'2026-11-19T08:40:02Z',
  last_sample_at:'2026-11-19T08:40:59Z',
  updated_at:'2026-11-19T08:40:59Z'});
 const context=m.buildPreEntryCandleContext([old],decision);
 assert.equal(context.M1.state,'STALE_COMPLETED_CANDLES');
 assert.equal(context.M5.state,'NO_VERIFIED_AS_OF_CANDLES');
 assert.equal(context.M1.candles.length,0);
});
test('database query uses predecision timestamp and read-only source',async()=>{
 const calls=[],db={query:async (sql,args)=>{
  calls.push({sql,args});return {rows:[mk()]};
 }};
 const row={broker_connection_id:'example-connection',instrument:'EURUSD',
  decision_at:decision};
 const result=await m.fetchForOpenDecision(db,row);
 assert.equal(calls.length,1);
 assert.equal(calls[0].args[2],decision);
 assert.match(calls[0].sql,/last_sample_at<=\$3::timestamptz/);
 assert.match(calls[0].sql,/updated_at<=\$3::timestamptz/);
 assert.match(calls[0].sql,/source='ctrader-broker-native'/);
 assert.doesNotMatch(calls[0].sql,/\b(?:INSERT|UPDATE|DELETE)\b/i);
 assert.equal(result.M1.candles.length,1);
});
