'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
 ARTIFACT,SQL,parseLine,lowerBound,lastAsOf,asOfFeatures,
 afterOpenMark,tradeFromRow,scoreBucket,firstMinuteClass,summarize,analyze,audit,
}=require('./audit-pepperstone-asof-entry-context-net.cjs');
const now=Date.parse('2026-11-18T10:15:00Z');
const id='b0d690b5-5a09-4d7f-a7b9-68f81f6bf615';
const base={
 trade_key:'trade-1',instrument:'EURUSD',direction:'BUY',
 opened_at:new Date(now),closed_at:new Date(now+20*60000),
 intent_at:new Date(now-3000),allocation_at:new Date(now-5000),
 fill_price:'1.10005',stop_loss:'1.09955',take_profit:'1.10085',lot_size:'1.4',
 realised_pnl:'40',commission:'-10',swap:'0',max_favorable_pnl:'90',
 close_reason:'PROFIT_PROTECTION',strategy_route:'EARLY_TRANSITION',
 expected_r:'0.4',plan_b_score:'0.72',
 expert_confidence:'0.73',expert_state:'ABSTAIN',expert_direction:'BUY',
 expert_long_votes:'3',expert_short_votes:'0',
 m1_route:'ABSTAIN',authority_path:'DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE',
 m1_rsi14:'57',extension_atr:'0.2',policy_version:'v6',
 final_risk_at_stop:'70',
};
const q=(delta,bid,observedDelta=delta)=>({
 at:now+delta,observed:now+observedDelta,
 bid,ask:bid+.0001,mid:bid+.00005,spread:.0001,
});
test('SQL enforces exact owner Pepperstone DEMO USD and pre-order metadata',()=>{
 assert.match(SQL,/t.user_id=\$1 AND b.user_id=\$1/);
 assert.match(SQL,/b.broker_id='pepperstone-ctrader'/);
 assert.match(SQL,/b.account_type='DEMO'/);
 assert.match(SQL,/t.account_currency='USD'/);
 assert.match(SQL,/t.status='CLOSED'/);
 assert.match(SQL,/c.created_at<=t.opened_at/);
 assert.match(SQL,/ti.metadata->>'multimodel_governance_net_expected_r'/);
 assert.doesNotMatch(SQL,/UPDATE|INSERT|DELETE/);
});
test('independent quote sample requires receipt time, bid below ask, source plausibility',()=>{
 const a=['2026-11-18T10:10:00Z','2026-11-18T10:10:03Z','EURUSD',1.1,1.1001];
 assert.equal(parseLine(a).observed,Date.parse(a[1]));
 assert.equal(parseLine({...a}),null);
 assert.equal(parseLine([a[0],'2026-11-18T10:09:59Z',a[2],a[3],a[4]]),null);
 assert.equal(parseLine([a[0],'2026-11-18T10:10:11Z',a[2],a[3],a[4]]),null);
 assert.equal(parseLine([a[0],a[1],a[2],1.1003,1.1001]),null);
 assert.equal(parseLine([a[0],a[1],'XAUUSD',a[3],a[4]]),null);
});
test('as-of snapshots never use a quote whose observation arrived after intent',()=>{
 const time=now-3000;
 const quotes=[
  q(-90000,1.09970,-89000),
  q(-66000,1.09982,-65000),
  q(-20000,1.09996,-19000),
  q(-11000,1.10001,-10000),
  q(-4000,1.10000,-3500),
  q(-3300,1.10400,now-time+100), // receives AFTER decision; exclude
 ];
 const t=tradeFromRow(base);
 const r=asOfFeatures(t,quotes);
 assert.equal(r.status,'FRESH_ASOF_BROKER_QUOTE');
 assert.ok(r.aligned60sPips>0);
 assert.ok(r.spreadPips>0);
 assert.equal(r.neverUsesPostIntentQuote,true);
 assert.equal(r.latestObservedAt,new Date(now-3500).toISOString());
});
test('model intent after broker fill is invalid, never introspected as a causal feature',()=>{
 const x=tradeFromRow({...base,intent_at:new Date(now+1000)});
 assert.equal(asOfFeatures(x,[q(-1000,1.1)]).status,'INVALID_INTENT_TIME');
});
test('missing fresh pre-intent quote stays missing, never a neutral vote',()=>{
 const t=tradeFromRow(base);
 assert.equal(asOfFeatures(t,[q(-100000,1.1)]).status,'NO_FRESH_PRE_INTENT_QUOTE');
});
test('one minute backward price strength uses original side direction',()=>{
 const buy=tradeFromRow(base);
 const sell=tradeFromRow({...base,direction:'SELL',fill_price:'1.10005',
  stop_loss:'1.10055',take_profit:'1.09925'});
 const quotes=[
  q(-370000,1.09800),q(-305000,1.09830),q(-70000,1.09980),
  q(-64000,1.09990),q(-4300,1.10000),
 ];
 assert.equal(asOfFeatures(buy,quotes).m1Direction,'AGREES');
 assert.equal(asOfFeatures(sell,quotes).m1Direction,'OPPOSES');
});
test('trade normalization distinguishes broker net and as-of allocation risk',()=>{
 const t=tradeFromRow(base);
 assert.equal(t.status,'VALID');
 assert.equal(t.net,30);
 assert.equal(t.riskAtStop,70);
 assert.equal(t.netRealizedR,0.42857);
 assert.equal(t.expertVotesFor,3);
 assert.equal(t.expertState,'ABSTAIN');
 assert.equal(tradeFromRow({...base,commission:null}).status,
  'INVALID_OR_INCOMPLETE_BROKER_SETTLEMENT');
 assert.equal(tradeFromRow({...base,stop_loss:'1.101'}).status,
  'INVALID_OR_INCOMPLETE_BROKER_SETTLEMENT');
 assert.equal(tradeFromRow({...base,strategy_route:'TREND_CONTINUATION'}).status,
  'INVALID_OR_INCOMPLETE_BROKER_SETTLEMENT');
});
test('missing or post-allocated risk cannot turn into a successful normalized forecast',()=>{
 const t=tradeFromRow({...base,allocation_at:new Date(now+100),final_risk_at_stop:'70'});
 assert.equal(t.status,'VALID');
 assert.equal(t.riskAtStop,null);
 assert.equal(t.netRealizedR,null);
});
test('future market labels are separately marked when the actual position has already closed',()=>{
 const short=tradeFromRow({...base,closed_at:new Date(now+60000)});
 const quotes=[q(180000,1.10040)];
 const p=afterOpenMark(short,quotes,3,new Date(now+20*60000));
 assert.equal(p.status,'SAMPLED_MARK_ONLY');
 assert.equal(p.afterActualExit,true);
 assert.equal(p.directionAtHorizon,'CORRECT');
 assert.equal(afterOpenMark(short,quotes,3,new Date(now+185000)).status,'NOT_MATURED');
});
test('future observations whose receipt is after horizon never leak into horizon labels',()=>{
 const t=tradeFromRow(base);
 const quotes=[q(60000-1000,1.1,60000+5000)];
 assert.equal(afterOpenMark(t,quotes,1,new Date(now+20*60000)).status,
  'NO_FRESH_HORIZON_QUOTE');
});
test('day and forecast group calculations are measured, not rescaled by lot size',()=>{
 const quotes=[
  q(-120000,1.09890),q(-65000,1.09950),q(-10000,1.0999),q(-4000,1.10000),
  q(59000,1.09988),
 ];
 const pair={
  EURUSD:[...quotes],
  AUDUSD:[],USDJPY:[],USDCAD:[],
 };
 const data=analyze([
  base,
  {...base,trade_key:'t2',realised_pnl:'-90',commission:'-10',
   expected_r:'0.15',closed_at:new Date(now+22*60000)},
 ],pair,new Date(now+30*60000));
 assert.equal(data.summary.trades,2);
 assert.equal(data.summary.netBookUsd,-70);
 assert.equal(data.summary.meanSubmittedForecastR,.275);
 assert.equal(data.byPlanBExpectedR['0.4_PLUS'].trades,1);
 assert.equal(data.byPlanBExpectedR['LESS_THAN_0.2'].trades,1);
 assert.equal(data.summary.byHorizon['1m'].directionWrongDuringOpen,2);
 assert.equal(data.byFirstMinuteObservedDirection.WRONG.trades,2);
 assert.equal(data.byRouteAndFirstMinute['EARLY_TRANSITION/WRONG'].trades,2);
 assert.equal(data.modifiesExecution,false);
 assert.equal(data.modifiesLotSizing,false);
});
test('an empty cohort is not misclassified as a qualified forward model',()=>{
 const archive={EURUSD:[],AUDUSD:[],USDJPY:[],USDCAD:[]};
 const x=analyze([],archive,new Date(now));
 assert.equal(x.summary.trades,0);
 assert.equal(x.summary.meanRealizedNetR,null);
 assert.equal(x.assessment,'INSUFFICIENT_INDEPENDENT_FORWARD_DAYS_FOR_MODEL_PROMOTION');
});
test('DB query never silently broadens unknown owner or omits read-only transaction',async()=>{
 let calls=[];
 const c={query:async(sql,params)=>{calls.push({sql,params});
  return {rows:[]};}};
 await assert.rejects(audit(c,'invalid-id',new Date(now-60000),new Date(now)),
  /UNVERIFIED_OWNER/);
 assert.equal(calls.length,0);
 const report=await audit(c,id,new Date(now-60000),new Date(now));
 assert.equal(report.summary.trades,0);
 assert.equal(calls[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1).sql,'COMMIT');
 assert.deepEqual(calls.find(z=>z.sql===SQL).params[0],id);
});
