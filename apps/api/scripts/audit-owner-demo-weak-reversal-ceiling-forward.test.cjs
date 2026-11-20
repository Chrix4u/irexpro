'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const audit=require('./audit-owner-demo-weak-reversal-ceiling-forward.cjs');
const start='2026-11-20T17:38:00.000Z';
const at='2026-11-20T18:08:00.000Z';
const original=Object.freeze({
 trade_id:'a',instrument:'USDJPY',direction:'BUY',
 opened_at:start,closed_at:null,status:'OPEN',
 close_reason:null,lot_size:'4.0000',realised_pnl:null,commission:null,swap:null,
 max_favorable_pnl:'15.71',profit_giveback:'35.27',
 route:'CONFIRMED_REVERSAL',
 cap_artifact:audit.RULE,cap_applied:'true',
 cap_reason:'WEAK_CONFIRMATION_PLUS_INDEPENDENT_COST_OR_LOSS_WARNING',
 cap_before:'7',cap_after:'4',cap_fee_warning:'true',
 cap_loss_warning:'false',quality_fraction:'0.35',
 seven_lot_artifact:'owner-pepperstone-usd-demo-ongoing-seven-lot-20261120-v1',
 broker_prescreen_cap:'4',
});
const row=(p={})=>({...original,...p});
const settled=(id,net,closed='2026-11-20T17:40:00Z',more={})=>
 row({trade_id:id,status:'CLOSED',closed_at:closed,
  realised_pnl:(net+24).toFixed(2),commission:'-24',swap:'0',...more});
test('first prospectively capped OPEN trade is not counted as winner or loser',()=>{
 const p=audit.decode(original,at);
 assert.equal(p.group,'WEAK_CONFIRMED_REVERSAL_CAPPED');
 assert.equal(p.actualFilledLots,4);
 assert.equal(p.requestedCapBefore,7);
 assert.equal(p.requestedCapAfter,4);
 assert.equal(p.capApplied,true);
 assert.equal(p.settledBrokerNetUsd,null);
 const score=audit.analyze([original],at);
 assert.equal(score.byGroup.weakConfirmedReversalCapped.totalTrades,1);
 assert.equal(score.byGroup.weakConfirmedReversalCapped.openPositions,1);
 assert.equal(score.byGroup.weakConfirmedReversalCapped.settled,0);
 assert.equal(score.byGroup.weakConfirmedReversalCapped.bookedNetUsd,0);
 assert.equal(score.autoPromote,false);
 assert.equal(score.promotableToLive,false);
 assert.equal(score.noCounterfactualPnLOrClaimedSavings,true);
});
test('existing trend trade is unaffected even when commission-warning metadata is true',()=>{
 const p=audit.decode(row({trade_id:'b',route:'TREND_CONTINUATION',
  cap_applied:'false',cap_before:'0.2',cap_after:'0.2',lot_size:'0.2',
  cap_reason:'NOT_EXACT_OWNER_DEMO_CONTINUOUS_REVERSAL_UNCHANGED',
  quality_fraction:null,seven_lot_artifact:null}),at);
 assert.equal(p.group,'OTHER_ROUTE_UNCHANGED');
 assert.equal(p.capApplied,false);
 assert.equal(p.afterCommissionWarning,true);
});
test('actual after-commission outcomes, warnings and winners counted once',()=>{
 const b=settled('b',-122.4);
 const c=settled('c',78.8,'2026-11-20T17:43:00Z',{
  cap_applied:'false',cap_before:'7',cap_after:'7',
  quality_fraction:'0.7',cap_reason:'NO_INDEPENDENT_COST_OR_LOSS_WARNING',
 });
 const d=settled('d',23.12,'2026-11-20T17:46:00Z');
 const report=audit.analyze([b,c,d,original],at);
 assert.equal(report.all.settled,3);
 assert.equal(report.all.openPositions,1);
 assert.equal(report.all.winners,2);
 assert.equal(report.all.losers,1);
 assert.equal(report.all.bookedNetUsd,-20.48);
 assert.equal(report.byGroup.weakConfirmedReversalCapped.settled,2);
 assert.equal(report.byGroup.weakConfirmedReversalCapped.winners,1);
 assert.equal(report.byGroup.weakConfirmedReversalCapped.losers,1);
 assert.equal(report.byGroup.weakConfirmedReversalCapped.bookedNetUsd,-99.28);
 assert.equal(report.byGroup.confirmedReversalUnchanged.settled,1);
 assert.equal(report.byGroup.confirmedReversalUnchanged.bookedNetUsd,78.8);
 assert.equal(report.byGroup.weakConfirmedReversalCapped.grossPeakToAfterFeeLossTrades,1);
 assert.equal(report.sampleSizeInsufficientForPromotion,true);
});
test('missing actual commission stays unknown even when broker gross looks profitable',()=>{
 const incomplete=settled('missing',20,'2026-11-20T17:41:00Z',
  {commission:null});
 const r=audit.analyze([incomplete],at);
 assert.equal(r.all.settled,0);
 assert.equal(r.all.closedWithMissingBrokerEconomics,1);
 assert.equal(r.all.winners,0);
});
test('missing or invalid cap provenance is not silently called uncapped',()=>{
 for(const patch of [
  {cap_artifact:null}, {cap_applied:null}, {cap_after:'8'},
  {cap_before:'3'}, {cap_fee_warning:null},
  {cap_loss_warning:null}, {cap_applied:'true',route:'EARLY_TRANSITION'},
  {cap_applied:'true',quality_fraction:'0.9'},
  {cap_applied:'true',cap_reason:'RANDOM'},
  {cap_applied:'true',cap_fee_warning:'false',cap_loss_warning:'false'},
 ]) {
  const result=audit.decode(row(patch),at);
  assert.equal(result.provenanceValid,false,JSON.stringify(patch));
  assert.equal(result.group,'PROVENANCE_INCOMPLETE_OR_INVALID');
 }
});
test('as-of activation never imports earlier trades or future unseen settlements',()=>{
 assert.throws(()=>audit.decode(row({
  opened_at:'2026-11-20T17:36:59Z'}),at),/INVALID_POST_RELEASE_EXACT_DEMO_TRADE/);
 assert.throws(()=>audit.decode(row({
  opened_at:'2026-11-20T19:00:00Z'}),at),/INVALID_POST_RELEASE_EXACT_DEMO_TRADE/);
 assert.throws(()=>audit.decode(settled('c',50,'2026-11-20T19:00:00Z'),at),
  /INVALID_BROKER_SETTLEMENT_CLOCK/);
});
test('fee-compensated actual net is not falsely positive when gross is positive',()=>{
 const r=audit.decode(settled('fee_loss',-8,'2026-11-20T17:42:00Z',
  {max_favorable_pnl:'38.20'}),at);
 assert.equal(r.settledBrokerNetUsd,-8);
 assert.equal(r.actualAfterCostLosingTrade,true);
 assert.equal(r.actualAfterCostWinningTrade,false);
 assert.equal(r.observedGrossPeakUsd,38.2);
});
test('three net losses in twenty minutes are reported without executing pause',()=>{
 const trades=[
  settled('a',-70,'2026-11-20T17:44:00Z'),
  settled('b',-85,'2026-11-20T17:47:00Z'),
  settled('c',-95,'2026-11-20T17:53:00Z'),
  settled('d',+18,'2026-11-20T18:01:00Z'),
 ];
 const x=audit.analyze(trades,at);
 assert.equal(x.lossClusterObservations.longestConsecutiveLosses,3);
 assert.equal(x.lossClusterObservations.threeLossesWithin20MinCount,1);
 assert.equal(x.lossClusterObservations.episodes[0].bookedNetUsd,-250);
 assert.equal(x.lossClusterObservations.noAutomaticTradingPause,true);
});
test('read-only SQL is strictly account-scoped and bounded',()=>{
 assert.match(audit.SQL,/t.user_id=\$1/);
 assert.match(audit.SQL,/t.broker_connection_id=\$2/);
 assert.match(audit.SQL,/b.broker_id='pepperstone-ctrader'/);
 assert.match(audit.SQL,/b.account_type='DEMO'/);
 assert.match(audit.SQL,/b.account_currency='USD'/);
 assert.match(audit.SQL,/t.opened_at>=\$3::timestamptz/);
 assert.match(audit.SQL,/LIMIT 501/);
 assert.doesNotMatch(audit.SQL,/\b(?:UPDATE|INSERT|DELETE|TRUNCATE|CALL|SELECT INTO)\b/i);
 assert.equal(audit.ACTIVATED_AT,'2026-11-20T17:37:18.000Z');
});
