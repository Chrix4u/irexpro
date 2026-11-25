'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {QUERY,summarize}=require('./audit-owner-demo-profit-protection-postexit.cjs');
const stage=(o={})=>({
 status:'COMPLETE_SAMPLED_PATH',samples:30,
 additionalPipsAtLastSample:1.5,bestAdditionalPips:2,
 worstAdditionalPips:-.3,sampledOriginalStop:false,
 sampledOriginalTarget:true,firstSeenOriginalBarrier:'TARGET',
 ...o,
});
const trade=(pips=1.5,route='CONFIRMED_REVERSAL',state='COMPLETE_SAMPLED_PATH')=>({
 status:'BROKER_SETTLED',instrument:'AUDUSD',direction:'BUY',
 route,exitNetUsd:20,stages:{
 '1m':stage({additionalPipsAtLastSample:pips,status:state}),
 '3m':stage({additionalPipsAtLastSample:pips,status:state}),
 '5m':stage({additionalPipsAtLastSample:pips,status:state}),
 '10m':stage({additionalPipsAtLastSample:pips,status:state}),
 '20m':stage({additionalPipsAtLastSample:pips,status:state}),
 '30m':stage({additionalPipsAtLastSample:pips,status:state}),
 }
});
test('SQL is broker-settled profit protection ONLY, original intent barriers and owner-specific USD DEMO',()=>{
 for(const s of [
 't.user_id=$1','b.user_id=$1',"b.broker_id='pepperstone-ctrader'",
 "b.account_type='DEMO'","b.account_currency='USD'",
 "t.account_currency='USD'","t.status='CLOSED'",
 "t.close_reason='PROFIT_PROTECTION'",
 'ti.stop_loss','ti.take_profit',
 'AND ti.broker_connection_id=t.broker_connection_id'
 ])assert.ok(QUERY.includes(s),s);
 assert.ok(!/\bUPDATE\b|\bINSERT\b|\bDELETE\b/.test(QUERY));
});
test('1/3/5/10/20/30-minute horizons count better worse and flat quotes only for complete coverage',()=>{
 const rows=[trade(1.5),trade(-2.3,'EARLY_TRANSITION'),trade(0)];
 const r=summarize(rows,{files:4,accepted:10,rejected:2},'2026-11-17T00:00:00Z');
 for(const k of ['1m','3m','5m','10m','20m','30m']){
  const h=r.horizons[k];
  assert.equal(h.completeSampledPaths,3);
  assert.equal(h.betterQuoteAtHorizon,1);
  assert.equal(h.worseQuoteAtHorizon,1);
  assert.equal(h.sameQuoteAtHorizon,1);
  assert.equal(h.sampledOriginalTarget,3);
  assert.equal(h.sampledOriginalStop,0);
  assert.equal(h.hypotheticalDelayedBrokerNetUsd,null);
  assert.equal(h.byRoute.CONFIRMED_REVERSAL.completeSampledPaths,2);
 }
 assert.equal(r.actualExitNetUsd,60);
 assert.equal(r.brokerSettledProfitProtectedExits,3);
 assert.equal(r.noSqlWrites,true);
 assert.equal(r.changedStopOrProfitProtection,false);
});
test('maturing, incomplete and unsupported quotes cannot be guessed into wins',()=>{
 const mature=trade(1.5),unclear=trade(-.5,'EARLY_TRANSITION','INCOMPLETE_SAMPLED_PATH'),
  pending=trade(-.5,'CONFIRMED_REVERSAL','NOT_MATURE');
 const r=summarize([mature,unclear,pending,{status:'INVALID_BROKER_TRADE'}],
  {files:2,accepted:100,rejected:20},'2026-11-17T00:00:00Z');
 assert.equal(r.brokerSettledProfitProtectedExits,3);
 assert.equal(r.unsupportedSettledRows,1);
 const h=r.horizons['5m'];
 assert.equal(h.completeSampledPaths,1);
 assert.equal(h.incompleteOrMissingQuotePath,1);
 assert.equal(h.noMatureQuotePath,1);
 assert.equal(h.actualNetUsdForCoveredExits,20);
 assert.equal(h.hypotheticalDelayedBrokerNetUsd,null);
});
test('first seen target is sampled order, not proven broker stop precedence',()=>{
 const x=trade(2);x.stages['5m']=stage({
  sampledOriginalStop:true,sampledOriginalTarget:true,
  firstSeenOriginalBarrier:'STOP'});
 const r=summarize([x],{files:1,accepted:10,rejected:0},'2026-11-20T00:00:00Z');
 const h=r.horizons['5m'];
 assert.equal(h.sampledOriginalTarget,1);
 assert.equal(h.sampledOriginalStop,1);
 assert.equal(h.firstSampledBarrierStop,1);
 assert.equal(h.firstSampledBarrierTarget,0);
 assert.equal(h.noExecutableQuoteOrFillClaim,true);
});
test('report has strictly no trading, model, stop or account mutation',()=>{
 const r=summarize([],{files:0,accepted:0,rejected:0},'2026-11-17T00:00:00Z');
 assert.equal(r.brokerOrders,false);
 assert.equal(r.modifiesExecution,false);
 assert.equal(r.researchOnly,true);
 assert.equal(r.noSqlWrites,true);
 assert.equal(r.horizons['5m'].meanAdditionalPipsAtHorizon,null);
 assert.equal(r.horizons['5m'].medianAdditionalPipsAtHorizon,null);
});
