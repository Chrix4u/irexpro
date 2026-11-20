'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const m=require('./owner-demo-preentry-fee-conflict-shadow.cjs');
const st=require('./owner-demo-preentry-fee-conflict-shadow-state.cjs');
const audit=require('./audit-owner-demo-weak-reversal-ceiling-forward.cjs');
const NOW=new Date('2026-11-20T18:45:00Z');
const MARKER_AT='2026-11-20T18:40:00Z';
const opened='2026-11-20T18:44:30Z';
const row=(p={})=>({
 trade_id:'23e1a785-6cd1-4afc-9e3e-dbed8658b701',
 opened_at:opened,status:'OPEN',route:'CONFIRMED_REVERSAL',
 m1_decision_at:'2026-11-20T18:44:00Z',
 m1_decision_created_at:'2026-11-20T18:44:01Z',
 m1_entry_route:'ABSTAIN',trained_expert_state:'ABSTAIN',
 fee_shadow_reason:'AFTER_BROKER_FEES_BELOW_FLOOR',
 fee_shadow_sample_count:'40',fee_shadow_after_fee_expected_r:'0.0521',
 fee_shadow_minimum_after_fee_r:'0.08',
 model_loss_brake_active:'true',model_loss_brake_negative_payoff:'true',
 model_loss_brake_payoff_closed_trades:'8',
 model_loss_brake_recent_closed_trades:'8',
 aligned_h1_at_entry:'-0.55',aligned_m5_at_entry:'-1',...p,
});
const baseMarker={activatedAt:MARKER_AT};
const nominalTrade=(p={})=>({
 tradeId:row().trade_id,openedAt:opened,status:'CLOSED',
 fullySettled:true,settledBrokerNetUsd:-113.27,
 route:'CONFIRMED_REVERSAL',...p,
});
test('strong shadow alert is frozen as-of a genuine OPEN position with prior decision',()=>{
 const a=m.classify(row(),NOW,MARKER_AT);
 assert.equal(a.eligible,true);
 assert.equal(a.label,'FEE_DEFICIT_DOUBLE_ABSTAIN_WITH_INDEPENDENT_CONFLICT');
 assert.equal(a.shadowWouldDiscourageEntry,true);
 assert.equal(a.brokerFeeShortfallVerified,true);
 assert.equal(a.causalNegativePayoffHistory,true);
 assert.equal(a.opposingHigherTimeframeEvidence,true);
 assert.equal(a.noBrokerOrders,true);
 assert.equal(a.noEntryVeto,true);
 assert.equal(a.noLotAmendment,true);
 assert.equal(a.noExitAuthority,true);
 assert.equal(a.noCalibratedProbability,true);
 assert.equal(a.firstCapturedSecondsAfterBrokerFill,30);
 assert.equal(a.warningIssuedBeforeBrokerFill,false);
 assert.equal(a.decisionEvidenceTimestampPredatesFill,true);
 assert.equal(a.predictedPriorToSettlementOnly,true);
});
test('after fee shortfall, independent dual abstain and verified samples all necessary',()=>{
 for(const patch of [
  {fee_shadow_sample_count:'11'},
  {fee_shadow_after_fee_expected_r:'0.12'},
  {fee_shadow_minimum_after_fee_r:null},
  {fee_shadow_reason:'AFTER_BROKER_FEES_ELIGIBLE'},
  {m1_entry_route:'M1_CONFIRMED_REVERSAL'},
  {trained_expert_state:'CONFIRM'},
 ]) {
  const s=m.classify(row(patch),NOW,MARKER_AT);
  assert.equal(s.shadowWouldDiscourageEntry,false,JSON.stringify(patch));
 }
});
test('nearby trade can receive weaker research caution without HTF or payoff conflict',()=>{
 const s=m.classify(row({
  aligned_h1_at_entry:'0.5',aligned_m5_at_entry:'0.01',
  model_loss_brake_active:'false',
  model_loss_brake_negative_payoff:'false',
 }),NOW,MARKER_AT);
 assert.equal(s.label,'FEE_DEFICIT_DOUBLE_ABSTAIN_CAUTION');
 assert.equal(s.shadowWouldDiscourageEntry,true);
 assert.equal(s.opposingHigherTimeframeEvidence,false);
});
test('missing or future-created M1 decision does not become a valid pre-entry prediction',()=>{
 for(const patch of [
  {m1_decision_at:'2026-11-20T18:44:50Z'},
  {m1_decision_created_at:'2026-11-20T18:44:35Z'},
  {m1_decision_at:null},
  {m1_entry_route:null},
 ]) {
  const s=m.classify(row(patch),NOW,MARKER_AT);
  assert.equal(s.eligible,false);
  assert.equal(s.label,'MISSING_CAUSAL_DECISION_BEFORE_FILL');
 }
});
test('no score on postclose or pre-activation even if history already proves a loss',()=>{
 assert.equal(m.classify(row({status:'CLOSED'}),NOW,MARKER_AT).eligible,false);
 assert.equal(m.classify(row({opened_at:'2026-11-20T18:39:50Z'}),NOW,MARKER_AT).eligible,false);
 assert.equal(m.classify(row({opened_at:'2026-11-20T18:47:00Z'}),NOW,MARKER_AT).eligible,false);
});
test('non-reversal control can be counted without an entry veto',()=>{
 const s=m.classify(row({route:'TREND_CONTINUATION'}),NOW,MARKER_AT);
 assert.equal(s.eligible,true);
 assert.equal(s.label,'OTHER_ROUTE_CONTROL');
 assert.equal(s.shadowWouldDiscourageEntry,undefined);
 assert.equal(s.noBrokerOrders,true);
});
test('frozen activation binds to exact hashed owner and DEMO connection and fails on mutation',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-confluence-'));
 const owner='6ed0ae55-4e31-4d22-9074-55c97800397a';
 const conn='dde65a12-70e1-4d6b-97bb-5af2384d8714';
 try{
  const a=st.setup(root,owner,conn,NOW);
  assert.equal(a.accountType,'DEMO');
  assert.equal(a.accountCurrency,'USD');
  assert.equal(a.cannotVetoEntries,true);
  assert.equal(a.cannotChangeProfitProtection,true);
  assert.notEqual(a.ownerHash,owner);
  assert.equal(st.setup(root,owner,conn,new Date(NOW.getTime()+2000)).activatedAt,a.activatedAt);
  assert.throws(()=>st.setup(root,owner,'abc',NOW),/INVALID_ENTRY_SHADOW_ACCOUNT_SCOPE/);
  const p=path.join(root,st.MARKER_FILE);
  fs.writeFileSync(p,JSON.stringify({...a,cannotVetoEntries:false}));
  assert.throws(()=>st.setup(root,owner,conn,new Date(NOW.getTime()+2000)),/INVALID_FROZEN_PREENTRY_CONFLUENCE_MARKER/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('state freezes as-of OPEN, never changes after a close or retrospective feature edit',()=>{
 const state={artifact:st.STATE_ARTIFACT,activatedAt:MARKER_AT,
  ownerHash:'owner',brokerConnectionHash:'broker',observations:{},
  noBrokerOrders:true,noRetrospectiveEntryScoring:true};
 const first=st.freeze([row()],state,baseMarker,NOW);
 assert.equal(first.newCaptures,1);
 const label=first.state.observations[row().trade_id].label;
 const later=st.freeze([row({status:'CLOSED',m1_entry_route:'M1_CONFIRMED_REVERSAL',
 fee_shadow_reason:'AFTER_BROKER_FEES_ELIGIBLE'})],
 first.state,baseMarker,new Date('2026-11-20T19:00:00Z'));
 assert.equal(later.newCaptures,0);
 assert.equal(later.state.observations[row().trade_id].label,label);
 assert.equal(later.state.observations[row().trade_id].noEntryVeto,true);
});
test('fast broker close before first OPEN observation is MISSED, never credited warning',()=>{
 const state={artifact:st.STATE_ARTIFACT,activatedAt:MARKER_AT,
  ownerHash:'owner',brokerConnectionHash:'broker',observations:{},
  noBrokerOrders:true,noRetrospectiveEntryScoring:true};
 const frozen=st.freeze([row({status:'CLOSED'})],state,baseMarker,NOW);
 const saved=frozen.state.observations[row().trade_id];
 assert.equal(saved.label,'MISSED_WHILE_OPEN_NOT_CAPTURED');
 assert.equal(saved.shadowWouldDiscourageEntry,false);
 const s=m.summarize([nominalTrade()],frozen.state.observations,MARKER_AT);
 assert.equal(s.closedBeforeFirstOpenSnapshot,1);
 assert.equal(s.flagged.trades,0);
 assert.equal(s.flagged.losers,0);
});
test('prospective warning also counts mistaken alerts on eventual real winners',()=>{
 const a=m.classify(row(),NOW,MARKER_AT),
  b=m.classify(row({trade_id:'b',fee_shadow_reason:'AFTER_BROKER_FEES_ELIGIBLE'}),NOW,MARKER_AT);
 const events={'a':a,'b':b,'c':a};
 const rows=[
  nominalTrade({tradeId:'a',settledBrokerNetUsd:79}),
  nominalTrade({tradeId:'b',settledBrokerNetUsd:-103}),
  nominalTrade({tradeId:'c',settledBrokerNetUsd:-40}),
 ];
 const s=m.summarize(rows,events,MARKER_AT);
 assert.equal(s.flagged.trades,2);
 assert.equal(s.flagged.winners,1);
 assert.equal(s.flagged.losers,1);
 assert.equal(s.flagged.falseWarningsOnRealWinners,1);
 assert.equal(s.flagged.actualWinnersUsdPotentiallyExcluded,79);
 assert.equal(s.unflaggedControls.losers,1);
 assert.equal(s.noCounterfactualSavedProfitClaims,true);
 assert.equal(s.noAutoPromote,true);
});
test('SQL requires a linked decision recorded and evaluated BEFORE exact demo fill',()=>{
 assert.match(audit.SQL,/z.created_at<=t.opened_at/);
 assert.match(audit.SQL,/z.evaluated_at<=t.opened_at/);
 assert.match(audit.SQL,/z.broker_connection_id=t.broker_connection_id/);
 assert.match(audit.SQL,/b.broker_id='pepperstone-ctrader'/);
 assert.match(audit.SQL,/b.account_type='DEMO'/);
 assert.match(audit.SQL,/b.account_currency='USD'/);
 assert.match(audit.SQL,/LIMIT 501/);
 assert.doesNotMatch(audit.SQL,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
});

test('unflagged healthy winners and other strategies are not labeled false-positive vetoes',()=>{
 const warning=m.classify(row(),NOW,MARKER_AT);
 const clean=m.classify(row({fee_shadow_reason:'AFTER_BROKER_FEES_ELIGIBLE'}),NOW,MARKER_AT);
 const other=m.classify(row({route:'EARLY_TRANSITION'}),NOW,MARKER_AT);
 const rows=[
  nominalTrade({tradeId:'warned',settledBrokerNetUsd:-28}),
  nominalTrade({tradeId:'clean',settledBrokerNetUsd:+38}),
  nominalTrade({tradeId:'other',route:'EARLY_TRANSITION',settledBrokerNetUsd:+66}),
 ];
 const result=m.summarize(rows,{warned:warning,clean,other},MARKER_AT);
 assert.equal(result.flagged.losers,1);
 assert.equal(result.unflaggedControls.winners,1);
 assert.equal(result.unflaggedControls.falseWarningsOnRealWinners,0);
 assert.equal(result.unflaggedControls.actualWinnersUsdPotentiallyExcluded,0);
 assert.equal(result.otherRouteControls.winners,1);
 assert.equal(result.otherRouteControls.falseWarningsOnRealWinners,0);
 assert.equal(result.otherRouteControls.actualBrokerNetUsd,66);
});
