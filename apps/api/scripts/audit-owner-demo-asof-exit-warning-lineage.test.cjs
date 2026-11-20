'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {QUERY,verifiedEvent,tradeOutcome,evaluateTrade,report}=require('./audit-owner-demo-asof-exit-warning-lineage.cjs');
const started=Date.parse('2026-11-20T04:00:00Z');
const iso=ms=>new Date(ms).toISOString();
const position=(o={})=>({
 trade_id:'one',instrument:'AUDUSD',direction:'SELL',
 opened_at:iso(started),closed_at:iso(started+12*60000),
 status:'CLOSED',close_reason:'BROKER_CLOSE',
 realised_pnl:'-50',commission:'-12',swap:'0',max_favorable_pnl:'20',
 route:'CONFIRMED_REVERSAL',observation_id:null,recorded_at:null,
 observed_at:null,recommendation:null,current_broker_reported_pnl:null,
 current_r:null,peak_r:null,...o
});
const observation=(minute,recommendation='DETERIORATION_REVIEW_NOW',pnl='-3',r='-.05',more={})=>position({
 observation_id:'obs-'+minute,
 observed_at:iso(started+minute*60000),
 recorded_at:iso(started+minute*60000+2000),
 recommendation,reason:recommendation==='DETERIORATION_REVIEW_NOW'?
  'REPEATED_ADVERSE_BROKER_M1_AND_GIVEBACK':'PEAK_BELOW_0_25R',
 current_broker_reported_pnl:pnl,current_r:r,peak_r:'0.12',
 ...more
});
test('strict exact owner DEMO USD and correct resource-bound read-only SQL',()=>{
 for(const part of [
  't.user_id=$1','b.user_id=$1',"b.broker_id='pepperstone-ctrader'",
  "b.account_type='DEMO'","b.account_currency='USD'",
  "t.account_currency='USD'","a.actor_user_id=t.user_id",
  "a.resource_id=t.id::text","a.action='DEMO_POSITION_EXIT_INTELLIGENCE_SHADOW'",
  "AND t.opened_at>=$2::timestamptz"
 ])assert.ok(QUERY.includes(part),part);
 assert.ok(!/\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/.test(QUERY));
});
test('causal observation time and persisted time must both predate settled close',()=>{
 const trade=position();
 assert.ok(verifiedEvent(observation(3),started,started+12*60000));
 for(const broken of [
  observation(14),
  observation(3,undefined,undefined,undefined,{
   recorded_at:iso(started+12*60000+3000)}),
  observation(3,undefined,undefined,undefined,{
   observed_at:iso(started+3*60000+10000)}),
  observation(3,undefined,undefined,undefined,{
   recorded_at:iso(started+3*60000+32000)}),
  observation(3,undefined,undefined,undefined,{current_r:'not-a-r'}),
  observation(3,undefined,undefined,undefined,{peak_r:null}),
  observation(3,undefined,undefined,undefined,{current_broker_reported_pnl:null}),
 ])assert.equal(verifiedEvent(broken,started,started+12*60000),null);
 assert.equal(trade.status,'CLOSED');
});
test('two recent consecutive adverse warnings AFTER a positive mark are scored as a research flag only',()=>{
 const r=evaluateTrade([
  observation(1,'NOT_MEANINGFUL_PROFIT','5','.2'),
  observation(2,'DETERIORATION_REVIEW_NOW','-1','-.01'),
  observation(3,'DETERIORATION_REVIEW_NOW','-4','-.1'),
 ],started+15*60000);
 assert.equal(r.validObservations,3);
 assert.equal(r.loser,true);
 assert.equal(r.flaggedAsOf.anyPositiveBrokerReported,true);
 assert.equal(r.flaggedAsOf.afterPositiveDeterioration,true);
 assert.equal(r.flaggedAsOf.afterPositiveTwoDeteriorationWithinThreeMinutes,true);
 assert.equal(r.timeFromTwoWarningFlagToExitMin,8.97);
});
test('two warnings only after the positive mark: warning before profit does not count',()=>{
 const r=evaluateTrade([
  observation(1,'DETERIORATION_REVIEW_NOW','-2','-.04'),
  observation(2,'DETERIORATION_REVIEW_NOW','3','.01'),
 ]);
 assert.equal(r.flaggedAsOf.afterPositiveTwoDeteriorationWithinThreeMinutes,false);
 assert.equal(r.flaggedAsOf.afterPositiveDeterioration,true);
});
test('a gap longer than three minutes or intervening healthy state breaks warning pair',()=>{
 const gap=evaluateTrade([
  observation(1,'NOT_MEANINGFUL_PROFIT','7','.2'),
  observation(2,'DETERIORATION_REVIEW_NOW','-1','-.05'),
  observation(6,'DETERIORATION_REVIEW_NOW','-4','-.08'),
 ]);
 assert.equal(gap.flaggedAsOf.afterPositiveTwoDeteriorationWithinThreeMinutes,false);
 const intervening=evaluateTrade([
  observation(1,'NOT_MEANINGFUL_PROFIT','7','.2'),
  observation(2,'DETERIORATION_REVIEW_NOW','-1','-.05'),
  observation(3,'HEALTHY_CONTINUATION_RESEARCH','1','.02'),
  observation(4,'DETERIORATION_REVIEW_NOW','-2','-.03'),
 ]);
 assert.equal(intervening.flaggedAsOf.afterPositiveTwoDeteriorationWithinThreeMinutes,false);
});
test('a historical positive maximum alone does not create an as-of positive mark',()=>{
 const x=evaluateTrade([position({max_favorable_pnl:'50'})]);
 assert.equal(x.postHocPeakAboveFinalFeesBeforeLoss,true);
 assert.equal(x.validObservations,0);
 assert.equal(x.flaggedAsOf.anyPositiveBrokerReported,false);
 assert.equal(x.flaggedAsOf.afterPositiveDeterioration,false);
});
test('missing commission is excluded from settled net economics',()=>{
 const x=tradeOutcome(position({commission:null}));
 assert.equal(x.settled,false);
 assert.equal(x.netUsd,null);
 assert.equal(x.winner,false);
 assert.equal(x.loser,false);
});
test('winning positions can also trigger two warnings: false positives must be counted',()=>{
 const r=report([
  observation(1,'NOT_MEANINGFUL_PROFIT','6','.3',{trade_id:'win',realised_pnl:'40'}),
  observation(2,'DETERIORATION_REVIEW_NOW','-1','-.01',{trade_id:'win',realised_pnl:'40'}),
  observation(3,'DETERIORATION_REVIEW_NOW','-3','-.03',{trade_id:'win',realised_pnl:'40'}),
  observation(1,'NOT_MEANINGFUL_PROFIT','5','.2',{trade_id:'loss'}),
  observation(2,'DETERIORATION_REVIEW_NOW','-1','-.03',{trade_id:'loss'}),
  observation(3,'DETERIORATION_REVIEW_NOW','-5','-.09',{trade_id:'loss'}),
  position({trade_id:'noMonitor',realised_pnl:'-10',max_favorable_pnl:'5'}),
 ],new Date(started+25*60000));
 const cohort=r.flags.afterPositiveTwoDeteriorationWithinThreeMinutes;
 assert.equal(r.all.settled,3);
 assert.equal(r.all.coveredByAsOfMinuteAudit,2);
 assert.equal(r.all.noVerifiedMinuteObservation,1);
 assert.equal(cohort.flagged.settled,2);
 assert.equal(cohort.flaggedWinnersThatHypotheticalVetoWouldAlsoRemove,1);
 assert.equal(cohort.flaggedLosersThatHypotheticalVetoWouldTarget,1);
 assert.equal(cohort.researchOnlyNoAction,true);
 assert.equal(r.tradeAuthority,'NONE');
 assert.equal(r.modifiesExecution,false);
 assert.equal(r.noSqlWrites,true);
});
test('a late audit event cannot borrow an earlier position price or later settlement',()=>{
 const x=evaluateTrade([
  observation(1,'NOT_MEANINGFUL_PROFIT','5','.2'),
  observation(2,'DETERIORATION_REVIEW_NOW','-1','-.02'),
  observation(3,'DETERIORATION_REVIEW_NOW','-3','-.03',{
   recorded_at:iso(started+13*60000)}),
 ]);
 assert.equal(x.validObservations,2);
 assert.equal(x.ignoredObservations,1);
 assert.equal(x.flaggedAsOf.afterPositiveTwoDeteriorationWithinThreeMinutes,false);
});
test('opposite open position is never assigned a later winning or losing final settlement',()=>{
 const r=report([position({status:'OPEN',closed_at:null,realised_pnl:null,commission:null,swap:null}),
  observation(2,'NOT_MEANINGFUL_PROFIT','4','.15',{
   status:'OPEN',closed_at:null,realised_pnl:null,commission:null,swap:null})],
  new Date(started+4*60000));
 assert.equal(r.all.trades,1);
 assert.equal(r.all.settled,0);
 assert.equal(r.all.openOrUnsettled,1);
 assert.equal(r.all.netUsd,0);
});
