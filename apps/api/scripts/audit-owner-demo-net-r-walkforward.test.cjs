'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ARTIFACT,SQL,normalize,priorCohort,calibrate,score,summary,analyze,audit,
 prospectiveCalibration,advisoryThresholdImpact}
 =require('./audit-owner-demo-net-r-walkforward.cjs');
const OWNER='b0d690b5-5a09-4d7f-a7b9-68f81f6bf615';
const date=(d,h='10:00')=>d+'T'+h+':00Z';
const row=(d,id,overrides={})=>({
 trade_key:id,instrument:'EURUSD',direction:'BUY',opened_at:date(d),
 closed_at:date(d,'10:10'),realised_pnl:'10',
 commission:'-10',swap:'0',close_reason:'PROFIT_PROTECTION',
 route:'EARLY_TRANSITION',expected_r:'0.3',
 policy_version:'test',authority:'DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE',
 allocated_at:date(d,'09:59'),risk_at_stop:'50',...overrides,
});
test('owner DEMO SQL restricts currency, user, route, and read-only transaction',()=>{
 assert.match(SQL,/t.user_id=\$1 AND b.user_id=\$1/);
 assert.match(SQL,/b.broker_id='pepperstone-ctrader'/);
 assert.match(SQL,/b.account_type='DEMO'/);
 assert.match(SQL,/t.account_currency='USD'/);
 assert.match(SQL,/t.status='CLOSED'/);
 assert.match(SQL,/a.created_at<=t.opened_at/);
 assert.doesNotMatch(SQL,/UPDATE|INSERT|DELETE/);
});
test('net R includes actual signed commissions, swaps, not just gross',()=>{
 const a=normalize(row('2026-11-17','a',{
  realised_pnl:'100',commission:'-12',swap:'-2',risk_at_stop:'50'
 }));
 assert.equal(a.netUsd,86);
 assert.equal(a.actualR,86/50);
 assert.equal(a.errorR,86/50-.3);
 assert.equal(a.day,'2026-11-17');
});
test('missing broker commission, future allocation, negative risk are NEVER normalized',()=>{
 assert.equal(normalize(row('2026-11-17','a',{commission:null})).status,
  'SKIP_INCOMPLETE_OR_INCONSISTENT_BROKER_DATA');
 assert.equal(normalize(row('2026-11-17','a',{risk_at_stop:'0'})).status,
  'SKIP_INCOMPLETE_OR_INCONSISTENT_BROKER_DATA');
 assert.equal(normalize(row('2026-11-17','a',{
  allocated_at:'2026-11-17T10:00:01Z'})).status,
  'SKIP_INCOMPLETE_OR_INCONSISTENT_BROKER_DATA');
 assert.equal(normalize(row('2026-11-17','a',{expected_r:null})).status,
  'SKIP_INCOMPLETE_OR_INCONSISTENT_BROKER_DATA');
 assert.equal(normalize(row('2026-11-17','a',{route:'TREND_CONTINUATION'})).status,
  'SKIP_INCOMPLETE_OR_INCONSISTENT_BROKER_DATA');
});
test('same-day closes cannot leak into current-day score, even hours earlier',()=>{
 const prior=normalize(row('2026-11-17','a',{
  closed_at:date('2026-11-17','10:10')}));
 const target=normalize(row('2026-11-17','b',{
  opened_at:date('2026-11-17','15:00'),
  closed_at:date('2026-11-17','16:00'),allocated_at:date('2026-11-17','14:59')
 }));
 assert.equal(priorCohort([prior,target],target).length,0);
});
test('earlier market day must actually have closed before candidate day began',()=>{
 const p=normalize(row('2026-11-16','prior',{
  closed_at:'2026-11-17T00:00:01Z'}));
 const t=normalize(row('2026-11-17','today'));
 assert.equal(priorCohort([p,t],t).length,0);
 const p2=normalize(row('2026-11-16','prior2',{
  closed_at:'2026-11-16T23:59:59Z'}));
 assert.equal(priorCohort([p2,t],t).length,1);
});
test('no adjustment with one or two prior distinct days regardless of trade count',()=>{
 const a=Array.from({length:25},(_,i)=>({
  ...normalize(row('2026-11-10',String(i))),tradeKey:String(i)}));
 assert.equal(calibrate(a).state,'INSUFFICIENT_CAUSAL_PRIOR_DAYS');
 a.push({...normalize(row('2026-11-11','extra'))});
 assert.equal(calibrate(a).state,'INSUFFICIENT_CAUSAL_PRIOR_DAYS');
 assert.equal(calibrate([]).adjustmentR,null);
});
test('minimum 10 complete trades across 3 prior days produces conservative shrinkage',()=>{
 const days=['2026-11-10','2026-11-11','2026-11-12'];
 const items=Array.from({length:12},(_,i)=>{
  const r=normalize(row(days[i%3],String(i),{realised_pnl:'-40'}));
  return r;
 });
 const c=calibrate(items);
 assert.equal(c.priorTrades,12);
 assert.equal(c.priorDays,3);
 assert.equal(c.state,'HISTORICAL_BIAS_ESTIMATE_SHADOW');
 assert.ok(c.adjustmentR<0);
 assert.ok(c.adjustmentR>-1.1);
 assert.equal(c.changesLotSize,false);
 assert.equal(c.canTrade,false);
});
test('unbounded per-trade loss outlier is clipped and shrunken, never mirrored',()=>{
 const days=['2026-11-10','2026-11-11','2026-11-12'];
 const sample=Array.from({length:12},(_,i)=>({
  ...normalize(row(days[i%3],String(i))),errorR:-100,
 }));
 assert.ok(calibrate(sample).adjustmentR>=-3);
 assert.ok(calibrate(sample).adjustmentR>-3);
});
test('future trades never change an earlier day forecast or calibrator prior cohort',()=>{
 const rows=Array.from({length:12},(_,i)=>row(
  ['2026-11-10','2026-11-11','2026-11-12'][i%3],String(i),{realised_pnl:'-30'}));
 rows.push(row('2026-11-17','holdout'));
 const a=score(rows.map(normalize));
 const b=score([...rows,row('2026-11-18','later',{
  realised_pnl:'9000'})].map(normalize));
 const h=a.find(x=>x.day==='2026-11-17');
 const hh=b.find(x=>x.day==='2026-11-17');
 assert.equal(h.correctionR,hh.correctionR);
 assert.equal(h.adjustedExpectedNetR,hh.adjustedExpectedNetR);
 assert.equal(h.priorHistoricalTrades,12);
});
test('raw vs calibrated comparison uses identical held-out trade cohort',()=>{
 const rows=Array.from({length:12},(_,i)=>row(
  ['2026-11-10','2026-11-11','2026-11-12'][i%3],String(i),{realised_pnl:'-40'}));
 rows.push(row('2026-11-17','holdout',{realised_pnl:'-40'}));
 const r=analyze(rows);
 assert.equal(r.result.evaluatedTrades,13);
 assert.equal(r.result.outOfSampleDayPurgedAdjustedCount,1);
 assert.equal(r.result.insufficientCausalHistoryCount,12);
 assert.equal(r.result.byDay['2026-11-17'].adjustedCount,1);
 assert.equal(r.brokerOrders,0);
 assert.equal(r.liveEligible,false);
 assert.equal(r.modifiesLotSize,false);
 assert.equal(r.changesOrderAuthority,false);
 assert.equal(r.artifact,ARTIFACT);
});
test('current-day shadow correction ignores every same-day closed outcome',()=>{
 const history=Array.from({length:15},(_,i)=>normalize(row(
  ['2026-11-10','2026-11-11','2026-11-12'][i%3],
  String(i),{realised_pnl:'-25'})));
 const now=new Date('2026-11-19T07:30:00Z');
 const base=prospectiveCalibration(history,now);
 const intraday=normalize(row('2026-11-19','today',{
  realised_pnl:'90000',closed_at:'2026-11-19T07:00:00Z',
  opened_at:'2026-11-19T06:00:00Z',
  allocated_at:'2026-11-19T05:59:00Z'}));
 const changed=prospectiveCalibration([...history,intraday],now);
 assert.equal(base.routes.EARLY_TRANSITION.adjustmentR,
  changed.routes.EARLY_TRANSITION.adjustmentR);
 assert.equal(base.routes.EARLY_TRANSITION.priorTrades,15);
 assert.equal(base.routes.CONFIRMED_REVERSAL.adjustmentR,null);
 assert.equal(base.priorOnlyBefore,'2026-11-19T00:00:00.000Z');
 assert.equal(base.modifiesOrders,false);
 assert.equal(base.changesLotSize,false);
});
test('soft forecast screening counts missed real winners, never authorizes a veto',()=>{
 const r=advisoryThresholdImpact([
  {adjustedExpectedNetR:-0.2,actualNetUsd:10},
  {adjustedExpectedNetR:-0.4,actualNetUsd:-30},
  {adjustedExpectedNetR:0.2,actualNetUsd:-12},
  {adjustedExpectedNetR:null,actualNetUsd:100},
 ]);
 assert.equal(r.compared,3);
 assert.equal(r.winningTradesThatWouldBeRejected,1);
 assert.equal(r.losingTradesThatWouldBeRetained,1);
 assert.equal(r.rejectedCohortActualNetUsd,-20);
 assert.equal(r.causalSavingsProven,false);
 assert.equal(r.executionGateQualified,false);
});
test('read-only transaction rejects invalid user ID, retains strict bound and privacy',async()=>{
 let calls=[],data=[];
 const c={query:async(sql,params)=>{
  calls.push({sql,params});if(sql===SQL)return {rows:data};
  return {rows:[]};
 }};
 await assert.rejects(audit(c,'garbage',date('2026-11-10'),new Date(date('2026-11-18'))),
  /INVALID_OWNER_ID/);
 assert.equal(calls.length,0);
 const result=await audit(c,OWNER,date('2026-11-10'),new Date(date('2026-11-18')));
 assert.equal(result.result.evaluatedTrades,0);
 assert.equal(calls[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1).sql,'COMMIT');
 assert.equal(calls.find(x=>x.sql===SQL).params[0],OWNER);
 data=Array.from({length:801},(_,i)=>row('2026-11-17',String(i)));
 calls=[];
 await assert.rejects(audit(c,OWNER,date('2026-11-10'),
  new Date(date('2026-11-18'))),/AUDIT_COHORT_LIMIT/);
 assert.equal(calls.at(-1).sql,'ROLLBACK');
});
