'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeLiveEntryDecisions,normalizeBlockers}=require('./pepperstone-live-entry-gates-ro.cjs');
const row=(x={})=>({
  instrument:'USDJPY',direction:'SELL',route:'ABSTAIN',
  execution_authority:'NONE',plan_b_admitted:'true',
  m1_reason:'HIGHER_TIMEFRAME_CONFLICT',plan_b_route:'CONFIRMED_REVERSAL',
  blockers:['MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'],
  bar_time:'2026-11-24T07:18:00.000Z',...x
});
test('Plan-B admitted plus M1 conflict is NOT LIVE authority',()=>{
  const r=summarizeLiveEntryDecisions([row()]);
  assert.equal(r.planBAdmitted,1);
  assert.equal(r.m1RouteQualified,0);
  assert.equal(r.brokerNativeAuthorityGranted,0);
  assert.equal(r.assessment,'NO_BROKER_AUTHORIZED_ENTRY_IN_WINDOW');
});
test('M1 route with model admission is still not guaranteed dispatch',()=>{
  const r=summarizeLiveEntryDecisions([row({route:'M1_EARLY_TRANSITION'})]);
  assert.equal(r.admittedWithAnyM1Route,1);assert.equal(r.exactModelM1RouteMatch,0);assert.equal(r.brokerNativeAuthorityGranted,0);
});
test('only genuinely matching strategy routes count as matching',()=>{
  const s=summarizeLiveEntryDecisions([row({route:'M1_CONFIRMED_REVERSAL'})]);
  assert.equal(s.exactModelM1RouteMatch,1);
  assert.equal(s.brokerNativeAuthorityGranted,0);
});
test('broker-authorized with no order warrants an order path investigation',()=>{
  assert.equal(summarizeLiveEntryDecisions([
    row({execution_authority:'BROKER_NATIVE'})]).assessment,
    'AUTHORIZED_DECISION_REQUIRES_ORDER_PATH_REVIEW');
});
test('paper shadow cannot be counted as LIVE authority',()=>{
  const r=summarizeLiveEntryDecisions([row({execution_authority:'PAPER_ONLY_RESEARCH'})]);
  assert.equal(r.paperOnlyResearch,1);assert.equal(r.brokerNativeAuthorityGranted,0);
});
test('malformed blocker strings never grant anything',()=>{
  assert.deepEqual(normalizeBlockers('["A",1,"B"]'),['A','B']);
  assert.deepEqual(normalizeBlockers('bad'),[]);
});
test('an empty 30-minute decision window is distinct from failed execution',()=>{
  assert.equal(summarizeLiveEntryDecisions([]).assessment,'NO_RECENT_LIVE_DECISIONS');
});
