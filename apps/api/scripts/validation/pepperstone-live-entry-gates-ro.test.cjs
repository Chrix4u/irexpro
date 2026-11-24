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

test('operator query uses configured owner scope, not a hardcoded broker account ID',()=>{
  const fs=require('node:fs');
  const source=fs.readFileSync(require.resolve('./pepperstone-live-entry-gates-ro.cjs'),'utf8');
  assert.match(source,/env\.VPS_FOREX_SCANNER_USER_ID/);
  assert.match(source,/account_type='LIVE' AND user_id=\$1/);
  assert.doesNotMatch(source,/49506270/);
});

test('primary Plan-B reversal M1 early bridge is shown only with model authority',()=>{
  const accepted=summarizeLiveEntryDecisions([
    row({route:'M1_EARLY_TRANSITION',primary_authority_path:'PRIMARY_PLAN_B'}),
  ]);
  assert.equal(accepted.approvedReversalTimingBridges,1);
  assert.equal(accepted.primaryPlanBAuthorityGranted,1);
  assert.equal(accepted.brokerNativeAuthorityGranted,0);
  const rejected=summarizeLiveEntryDecisions([
    row({route:'M1_EARLY_TRANSITION',primary_authority_path:'BLOCKED'}),
  ]);
  assert.equal(rejected.approvedReversalTimingBridges,0);
});
test('M1 continuation bridge requires original explicit same-snapshot reversalTimingBridge proof',()=>{
  const rejected=summarizeLiveEntryDecisions([
    row({route:'M1_TREND_CONTINUATION',primary_authority_path:'PRIMARY_PLAN_B',reversal_timing_bridge:false}),
  ]);
  const accepted=summarizeLiveEntryDecisions([
    row({route:'M1_TREND_CONTINUATION',primary_authority_path:'PRIMARY_PLAN_B',reversal_timing_bridge:true}),
  ]);
  assert.equal(rejected.approvedReversalTimingBridges,0);
  assert.equal(accepted.approvedReversalTimingBridges,1);
});
test('unknown / missing model route never accidentally counts as match',()=>{
  const x=summarizeLiveEntryDecisions([
    row({plan_b_route:'UNKNOWN',route:undefined}),
    row({plan_b_route:null,route:undefined}),
  ]);
  assert.equal(x.exactModelM1RouteMatch,0);
});
test('a BROKER_NATIVE authorized LIVE decision rejected downstream is not reported as a strategy abstention',()=>{
  const x=summarizeLiveEntryDecisions([row({
    route:'M1_TREND_CONTINUATION',plan_b_route:'TREND_CONTINUATION',
    primary_authority_path:'PRIMARY_PLAN_B',execution_authority:'BROKER_NATIVE',
    outcome_state:'SIGNAL_INVALID',outcome_reason:'EXTERNAL_PROVIDER_PAPER_ONLY',
  })]);
  assert.equal(x.brokerAuthorizedButRejected,1);
  assert.equal(x.assessment,'BROKER_AUTHORIZED_DECISION_FAILED_LATER_GATE');
  assert.equal(x.latestByPair[0].outcomeReason,'EXTERNAL_PROVIDER_PAPER_ONLY');
});
