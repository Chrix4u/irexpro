'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SQL,summarize}=require('./audit-owner-demo-broker-stop-readiness.cjs');
function row(patch={}){
 return {
  resource_id:'trade-id',created_at:new Date('2026-11-20T09:37:00Z'),
  instrument:'USDJPY',direction:'SELL',strategy_route:'CONFIRMED_REVERSAL',
  recommendation:'HEALTHY_CONTINUATION_RESEARCH',
  preflight:'BROKER_VALIDATION_REQUIRED',
  ready_runner:'true',runner_reason:'REQUIRES_BROKER_TICK_MIN_STOP_AND_AMENDMENT_VERIFICATION',
  proposed_raw:'158.95226853',proposed_rounded:null,
  native_distance:null,native_distance_unit:null,
  stop_reason:'MIN_STOP_DISTANCE_UNAVAILABLE',
  native_verified:'false',headroom:null,
  no_trade_authority:'true',stop_amendments:'0',
  ...patch,
 };
}
test('read-only owner broker audit query cannot write or look at LIVE accounts',()=>{
 for(const clause of [
   "t.user_id=$1","b.user_id=$1","a.actor_user_id=$1",
   "b.broker_id='pepperstone-ctrader'","b.account_type='DEMO'",
   "b.account_currency='USD'","t.account_currency='USD'",
   'LIMIT 3001'
 ])assert.ok(SQL.includes(clause),clause);
 assert.equal(/\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER)\b/.test(SQL),false);
});
test('missing broker stop metadata cannot be misreported as ready or amending',()=>{
 const x=summarize([row()],new Date('2026-11-20T09:38:00Z'));
 assert.equal(x.runnerCandidates,1);
 assert.equal(x.runnerCandidatePositions,1);
 assert.equal(x.nativeProofPassedPositions,0);
 assert.deepEqual(x.nativeByReason,{MIN_STOP_DISTANCE_UNAVAILABLE:1});
 assert.equal(x.anyBrokerAmendmentsRecorded,false);
 assert.equal(x.brokerOrdersSentByThisAudit,0);
 assert.equal(x.noTradingAuthority,true);
});
test('same position seen repeatedly is one distinct eligible position',()=>{
 const first=row({native_distance:'0',native_distance_unit:'POINTS',
  stop_reason:'BROKER_MIN_STOP_POINTS_PASSED_REQUIRES_PROVIDER_ACK_AND_READBACK',
  native_verified:'true',proposed_rounded:'158.953'});
 const x=summarize([first,{...first,created_at:new Date('2026-11-20T09:38:00Z')}]);
 assert.equal(x.runnerCandidates,2);
 assert.equal(x.runnerCandidatePositions,1);
 assert.equal(x.nativeProofPassedObservations,2);
 assert.equal(x.nativeProofPassedPositions,1);
 assert.deepEqual(x.providerPublishedDistance,{'0':2});
 assert.equal(x.rawStopOffGridResolved,2);
 assert.equal(x.topRecentCandidateEvidence[0].tickRoundedStop,158.953);
});
test('mixed eligible, missing and unqualified observations remain separate',()=>{
 const rows=[
  row(),row({resource_id:'other',ready_runner:'false',stop_reason:null}),
  row({resource_id:'third',native_distance:'22',
   native_distance_unit:'POINTS',
   stop_reason:'STOP_TOO_CLOSE_TO_BROKER_MARKET',native_verified:'false',
   proposed_rounded:'158.953'}),
 ];
 const x=summarize(rows);
 assert.equal(x.sampledExitIntelligenceObservations,3);
 assert.equal(x.sampledPositions,3);
 assert.equal(x.runnerCandidatePositions,2);
 assert.equal(x.nativeProofPassedPositions,0);
 assert.equal(x.missingNativeStopDistanceObservations,1);
 assert.deepEqual(x.nativeByReason,{
  MIN_STOP_DISTANCE_UNAVAILABLE:1,STOP_TOO_CLOSE_TO_BROKER_MARKET:1});
});
test('empty report does not invent broker confirmations or a zero-minute fill',()=>{
 const x=summarize([]);
 assert.equal(x.runnerCandidates,0);
 assert.equal(x.nativeProofPassedPositions,0);
 assert.equal(x.sampledPositions,0);
 assert.deepEqual(x.nativeByReason,{});
 assert.equal(x.anyBrokerAmendmentsRecorded,false);
});
