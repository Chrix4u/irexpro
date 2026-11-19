'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {auditEntryStarvation}=require('./audit-owner-demo-entry-starvation.cjs');
const AT='2026-11-19T20:00:00.000Z';
const d=(minutes)=>new Date(Date.parse(AT)-minutes*60_000).toISOString();
function cand(min,overrides={}){
  return {
    instrument:'USDJPY',direction:'BUY',
    route:'M1_EARLY_TRANSITION',plan_b_route:'TREND_CONTINUATION',
    drift:'OUT_OF_DISTRIBUTION',evaluated_at:d(min),
    execution_authority:'NONE',
    blockers:['MULTIMODEL_PLAN_B_NOT_ADMITTED','DRIFT_OUT_OF_DISTRIBUTION'],
    demo_continuation_pause:{enabled:false,blocked:false,reason:'DISABLED'},
    primary_only_probation:{enabled:true,blocked:false},
    multimodel_authority:{authorityPath:'BLOCKED'},
    ...overrides,
  };
}
test('finds ongoing scanner activity despite zero broker trades',()=>{
  const result=auditEntryStarvation([
    cand(1),cand(2,{direction:'SELL',route:'ABSTAIN'}),
    cand(7,{instrument:'EURUSD',drift:'NORMAL',blockers:['ENSEMBLE_NOT_PAPER_ADMITTED']}),
  ],[{instrument:'USDCAD',opened_at:d(150),status:'CLOSED'}],AT,120);
  assert.equal(result.sampledDecisions,3);
  assert.equal(result.m1NonAbstainCandidates,2);
  assert.equal(result.m1Abstentions,1);
  assert.equal(result.nonAbstainNoBrokerAuthority,2);
  assert.equal(result.ordersOpenedInWindow,0);
  assert.equal(result.minutesSinceLatestDecision,1);
  assert.equal(result.minutesSinceLastOrder,150);
  assert.equal(result.brokerNativeAuthorizedDecisions,0);
  assert.equal(result.grantsTradeAuthority,false);
});
test('the separate configured continuation pause remains visible when AI is started',()=>{
  const result=auditEntryStarvation([
    cand(1,{
      demo_continuation_pause:{enabled:true,blocked:true,reason:'CONTINUATION_PAUSED'},
      blockers:['M1_PEPPERSTONE_DEMO_TREND_CONTINUATION_PAUSED'],
    }),
    cand(2,{
      demo_continuation_pause:{enabled:true,blocked:false,reason:'OTHER_ROUTE'},
    }),
  ],[],AT);
  assert.equal(result.continuationPause.observedConfiguredEnabled,true);
  assert.equal(result.continuationPause.currentEnvironmentEnabled,null);
  assert.equal(result.continuationPause.configurationRequiresDirectVpsCheck,true);
  assert.equal(result.continuationPause.observedEnabledCandidates,2);
  assert.equal(result.continuationPause.observedActuallyBlocked,1);
  assert.equal(result.continuationPause.latestObservedReason,'CONTINUATION_PAUSED');
  assert.equal(result.blockedReasonCountsNonExclusive.find(x =>
    x.name === 'M1_PEPPERSTONE_DEMO_TREND_CONTINUATION_PAUSED')?.count,1);
});
test('blocker counts are non-exclusive, not assumed to be sole cause',()=>{
  const result=auditEntryStarvation([
    cand(1),cand(2),
    cand(3,{blockers:['ENSEMBLE_NOT_PAPER_ADMITTED']}),
  ],[],AT);
  const counts=Object.fromEntries(
    result.blockedReasonCountsNonExclusive.map(x=>[x.name,x.count]));
  assert.equal(counts.MULTIMODEL_PLAN_B_NOT_ADMITTED,2);
  assert.equal(counts.DRIFT_OUT_OF_DISTRIBUTION,2);
  assert.equal(counts.ENSEMBLE_NOT_PAPER_ADMITTED,1);
  assert.equal(result.modelAuthorityPathCounts[0].name,'BLOCKED');
});
test('reports broker-native authority separately from confirmed broker orders',()=>{
  const result=auditEntryStarvation([
    cand(1,{execution_authority:'BROKER_NATIVE',blockers:[]}),
  ],[],AT);
  assert.equal(result.brokerNativeAuthorizedDecisions,1);
  assert.equal(result.ordersOpenedInWindow,0);
  assert.equal(result.nonAbstainNoBrokerAuthority,0);
});
test('does not invent an offline scanner diagnosis from empty data',()=>{
  const result=auditEntryStarvation([],[],AT);
  assert.equal(result.latestDecisionAt,null);
  assert.equal(result.minutesSinceLatestDecision,null);
  assert.equal(result.lastOrderOpenedAt,null);
  assert.equal(result.continuationPause.observedConfiguredEnabled,null);
  assert.equal(result.m1NonAbstainCandidates,0);
  assert.equal(result.sampledDecisions,0);
});
test('ignores future and out-of-window decision records',()=>{
  const result=auditEntryStarvation([cand(-5),cand(121),cand(20)],[],AT);
  assert.equal(result.sampledDecisions,1);
  assert.equal(result.minutesSinceLatestDecision,20);
});
test('rejects invalid lookback without initiating any database action',()=>{
  for(const bad of [0,7.5,500,-1]){
    assert.throws(()=>auditEntryStarvation([],[],AT,bad));
  }
});

test('an inactive pause check does not prove the VPS environment flag is disabled',()=>{
  const result=auditEntryStarvation([
    cand(1,{
      demo_continuation_pause:{enabled:false,blocked:false,reason:'DISABLED'},
      blockers:['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
    }),
  ],[],AT);
  assert.equal(result.continuationPause.observedConfiguredEnabled,null);
  assert.equal(result.continuationPause.currentEnvironmentEnabled,null);
  assert.equal(result.continuationPause.observedEnabledCandidates,0);
  assert.equal(result.continuationPause.latestObservedReason,'DISABLED');
});
