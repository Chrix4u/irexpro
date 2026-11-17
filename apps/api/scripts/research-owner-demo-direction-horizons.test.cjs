'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {deduplicateMarketEpisodes, selectCausalM1Mark, priorFeeCostR,
  evaluatePrediction,evaluateDelayedOneMinute,summarizeResearch} = require('./research-owner-demo-direction-horizons.cjs');
const t='2026-11-17T10:00:00.000Z';
const now='2026-11-17T10:15:30.000Z';
const m1=(bucket,bid,ask,opts={})=>({
  bucket_time:'2026-11-17T'+bucket+':00.000Z',
  last_quote_sample_at:'2026-11-17T'+bucket+':58.000Z',
  bid_close:String(bid),ask_close:String(ask),
  source:'ctrader-broker-native',sample_count:24,...opts,
});
const candidate={entry:1.1002,stopLoss:1.0992};
const decision=(time,route='CONFIRMED_REVERSAL',direction='BUY')=>({
  evaluated_at:time,instrument:'EURUSD',direction,
  strategy_route:route,execution_authority:'NONE',
  candidate,pattern_hypothesis:'INSUFFICIENT_MATCHED_HISTORY',
});
test('only complete broker M1 closes up to target, never a future high/low or future quote',()=>{
  const bars=[m1('10:00',1.1004,1.1006),m1('10:01',1.1009,1.1011),
    m1('10:02',1.105,1.1052)];
  const mark=selectCausalM1Mark(bars,t,1,now);
  assert.equal(mark.bid,1.1004);
  assert.equal(mark.closedAtMs,Date.parse('2026-11-17T10:01:00Z'));
  assert.equal(selectCausalM1Mark(bars,t,3,now).bid,1.105);
  // Decision halfway through a minute: a just-before-target 1m bar
  // must NOT substitute for the true 1m horizon after that decision.
  assert.equal(selectCausalM1Mark(bars,'2026-11-17T10:00:30Z',1,now).bid,1.1009);
  assert.equal(selectCausalM1Mark(bars,t,10,'2026-11-17T10:07:00Z'),null);
});
test('reject mid-only historical candles, stale samples, and nonnative bars',()=>{
  const mark=m1('10:00',1.101,1.1012);
  assert.equal(selectCausalM1Mark([{...mark,bid_close:null}],t,1,now),null);
  assert.equal(selectCausalM1Mark([{...mark,source:'demo-provider'}],t,1,now),null);
  assert.equal(selectCausalM1Mark([m1('10:00',1.101,1.1012,
    {last_quote_sample_at:'2026-11-17T10:00:14Z'})],t,1,now),null);
});
test('BUY takes bid exit and SELL ask exit; fee estimate never called realized',()=>{
  const mark={bid:1.1006,ask:1.1008,spread:.0002,closedAtMs:Date.parse(t)+60000};
  const buy=evaluatePrediction(decision(t),mark,{samples:6,p90FeeR:.10});
  assert.ok(Math.abs(buy.directionalR-.4)<1e-8);
  assert.ok(Math.abs(buy.estimatedAfterFeeR-.3)<1e-8);
  const sell=evaluatePrediction({...decision(t),direction:'SELL',
    candidate:{entry:1.1006,stopLoss:1.1016}},mark,{samples:0,p90FeeR:null});
  assert.ok(Math.abs(sell.directionalR+0.2)<1e-8);
  assert.equal(sell.estimatedAfterFeeR,null);
});
test('fee evidence is strict as-of and needs >=5 prior settled fee samples',()=>{
  const time='2026-11-17T10:00:00Z';
  const rows=[1,2,3,4,5].map(n=>({
    closed_at:'2026-11-17T09:'+String(40+n).padStart(2,'0')+':00Z',
    fee_r:.1*n,
  }));
  assert.equal(priorFeeCostR(rows.slice(0,4),time).p90FeeR,null);
  assert.equal(priorFeeCostR([...rows,{closed_at:'2026-11-17T10:01:00Z',fee_r:5}],time).p90FeeR,.5);
});
test('20-minute correlated minute checks count as one independent market episode',()=>{
  const rows=[decision('2026-11-17T10:01:00Z'),
    decision('2026-11-17T10:02:00Z'),
    decision('2026-11-17T10:18:00Z'),
    decision('2026-11-17T10:21:00Z')];
  assert.equal(deduplicateMarketEpisodes(rows).length,2);
});
test('separate blocked versus authorized cohorts; missing cost never a false win',()=>{
  const d=[decision('2026-11-17T10:00:00Z'),
    {...decision('2026-11-17T10:20:00Z'),execution_authority:'BROKER_NATIVE',
      outcome_state:'EXECUTION_SUCCEEDED'}];
  const bars=[m1('10:00',1.1004,1.1006),m1('10:01',1.1005,1.1007)];
  const result=summarizeResearch(d,{EURUSD:bars},{EURUSD:[]},'2026-11-17T10:35:00Z');
  assert.equal(result.rawDecisions,2);
  assert.equal(result.independentMarketEpisodes,2);
  assert.equal(result.byHorizon['1m'].episodes,1);
  assert.equal(result.byHorizon['1m'].estimatedAfterFeeCoverage,0);
  assert.equal(result.byExecutionAuthority.NOT_BROKER_AUTHORIZED['1m'].episodes,1);
  assert.equal(result.byExecutionAuthority.EXECUTION_SUCCEEDED?.['1m']?.episodes ?? 0,0);
  assert.equal(result.oneMinuteConfirmationResearch.byExecutionAuthority
    .EXECUTION_SUCCEEDED?.['3m']?.eligibleEpisodes ?? 0,0);
  assert.equal(result.modifiesExecution,false);
});


test('research re-entry after one confirmed minute uses future ask, not original entry',()=>{
  const original=decision(t);
  const first={bid:1.1004,ask:1.1006,spread:.0002,
    closedAtMs:Date.parse('2026-11-17T10:01:00Z')};
  const later={bid:1.1009,ask:1.1011,spread:.0002,
    closedAtMs:Date.parse('2026-11-17T10:03:00Z')};
  const actual=evaluateDelayedOneMinute(original,first,later,{samples:5,p90FeeR:.2});
  assert.ok(Math.abs(actual.directionalR-.3)<1e-7);
  assert.ok(Math.abs(actual.estimatedAfterFeeR-.1)<1e-7);
  const report=summarizeResearch([original],{EURUSD:[
    m1('10:00',1.1004,1.1006),m1('10:02',1.1009,1.1011),
  ]},{EURUSD:[]},now);
  const g=report.oneMinuteConfirmationResearch.byRoute.CONFIRMED_REVERSAL['3m'];
  assert.equal(g.eligibleEpisodes,1);
  assert.equal(g.confirmedEpisodes,1);
  assert.equal(g.pairedImmediate.episodes,1);
  assert.equal(g.delayedOneMinute.episodes,1);
  assert.ok(g.pairedImmediate.meanDirectionalR>g.delayedOneMinute.meanDirectionalR);
});
test('unconfirmed first minute is observed but never counted as a delayed fill',()=>{
  const report=summarizeResearch([decision(t)],{EURUSD:[
    m1('10:00',1.1000,1.1002),m1('10:02',1.1009,1.1011),
  ]},{EURUSD:[]},now);
  const g=report.oneMinuteConfirmationResearch.byRoute.CONFIRMED_REVERSAL['3m'];
  assert.equal(g.eligibleEpisodes,1);
  assert.equal(g.confirmedEpisodes,0);
  assert.equal(g.skippedEpisodes,1);
  assert.equal(g.delayedOneMinute.episodes,0);
  assert.equal(g.afterUnfavorableFirstMinute.episodes,1);
  assert.equal(g.afterUnfavorableFirstMinute.directionalWinRate,1);
});
