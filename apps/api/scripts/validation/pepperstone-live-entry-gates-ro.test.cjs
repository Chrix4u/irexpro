'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeLiveEntryDecisions,normalizeBlockers,parseSinceArgument}=require('./pepperstone-live-entry-gates-ro.cjs');
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

test('operator query uses configured owner scope, not a hardcoded broker account ID',()=>{
  const fs=require('node:fs');
  const source=fs.readFileSync(require.resolve('./pepperstone-live-entry-gates-ro.cjs'),'utf8');
  assert.match(source,/env\.VPS_FOREX_SCANNER_USER_ID/);
  assert.match(source,/account_type='LIVE' AND user_id=\$1/);
  assert.doesNotMatch(source,/49506270/);
});

test('post-release window requires full UTC timestamp and fails closed beyond two hours',()=>{
  const now=Date.parse('2026-11-24T09:00:00Z');
  assert.equal(parseSinceArgument(['--since=2026-11-24T08:48:22Z'],now).toISOString(),
    '2026-11-24T08:48:22.000Z');
  assert.equal(parseSinceArgument([],now),null);
  for(const args of [
    ['--since=2026-11-24'],
    ['--since=2026-11-24T08:48:22+00:00'],
    ['--since=2026-11-24T06:30:00Z'],
    ['--since=2026-11-24T09:01:00Z'],
    ['--all'],
    ['--since=2026-11-24T08:48:22Z','--all'],
  ])assert.throws(()=>parseSinceArgument(args,now));
});
test('post-release diagnostics distinguish true primary model authority from a mere route name',()=>{
  const a=summarizeLiveEntryDecisions([
    row({plan_b_route:'CONFIRMED_REVERSAL',route:'M1_EARLY_TRANSITION',primary_authority:'BLOCKED'}),
    row({plan_b_route:'CONFIRMED_REVERSAL',route:'M1_EARLY_TRANSITION',primary_authority:'PRIMARY_PLAN_B'}),
    row({plan_b_route:'CONFIRMED_REVERSAL',route:'M1_TREND_CONTINUATION',
      primary_authority:'PRIMARY_PLAN_B',reversal_bridge:'true'}),
  ]);
  assert.equal(a.admittedWithAnyM1Route,3);
  assert.equal(a.exactModelM1RouteMatch,0);
  assert.equal(a.primaryModelAuthorityGranted,2);
  assert.equal(a.primaryReversalTimingBridges,2);
  assert.equal(a.brokerNativeAuthorityGranted,0);
});
