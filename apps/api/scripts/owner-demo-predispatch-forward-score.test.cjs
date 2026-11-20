'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('./owner-demo-predispatch-forward-score.cjs');
const audit=require('./audit-owner-demo-weak-reversal-ceiling-forward.cjs');
const decision={
 artifact:p.ARTIFACT,
 evaluationPhase:p.PHASE,
 ownerDemoScopeVerified:true,selectedForDispatch:true,
 researchOnly:true,
 decisionEvaluatedAt:'2026-11-20T19:05:00.000Z',
 strategyRoute:'CONFIRMED_REVERSAL',
 label:'FEE_DEFICIT_DOUBLE_ABSTAIN_WITH_INDEPENDENT_CONFLICT',
 researchEligible:true,
 wouldDiscourageEntryIfEverValidated:true,
 brokerFeeShortfallVerified:true,
 m1TimingAbstained:true,trainedExpertAbstained:true,
 feeShadowExpectedR:.052116,feeRequiredFloorR:.08,
 noOrderBlock:true,noNewExecutionGate:true,noLotSizingChange:true,
 noBrokerOrders:true,noStopChange:true,noExitAuthority:true,
 noLivePromotion:true,
};
const row=(parts={})=>({
 opened_at:'2026-11-20T19:05:18.000Z',
 m1_decision_created_at:'2026-11-20T19:05:04.000Z',
 m1_decision_at:'2026-11-20T19:05:00.000Z',
 route:'CONFIRMED_REVERSAL',pre_dispatch_shadow:decision,...parts,
});
const finished=(tradeId,net,pre,route='CONFIRMED_REVERSAL')=>({
 tradeId,openedAt:'2026-11-20T19:05:18.000Z',
 route,status:'CLOSED',fullySettled:true,settledBrokerNetUsd:net,
 preDispatch:pre,
});
test('genuinely pre-dispatch warning required to be persisted before the broker fill',()=>{
 const x=p.provenance(row());
 assert.equal(x.state,'VERIFIED_CAUSAL_WARNING_PRE_DISPATCH');
 assert.equal(x.warned,true);
 assert.equal(x.eligible,true);
 assert.equal(x.recordLeadMs,14000);
 assert.equal(x.researchedAfterCostsR,.052116);
 assert.equal(x.noAutoEntryVeto,true);
 assert.equal(x.cannotClaimMoneySaved,true);
});
test('no SQL prefill proof means no prediction success can be credited',()=>{
 for(const patch of [
  {m1_decision_created_at:'2026-11-20T19:05:20.000Z'},
  {m1_decision_created_at:null},
  {m1_decision_at:'2026-11-20T19:05:17.000Z',
   m1_decision_created_at:'2026-11-20T19:05:15.000Z'},
  {pre_dispatch_shadow:{...decision,decisionEvaluatedAt:'2026-11-20T19:06:00Z'}},
 ]) {
  const x=p.provenance(row(patch));
  assert.equal(x.eligible,false,JSON.stringify(patch));
  assert.equal(x.warned,false);
 }
});
test('old trades lacking new research artifact do not count as forward predictions',()=>{
 const x=p.provenance(row({pre_dispatch_shadow:null}));
 assert.equal(x.eligible,false);
 assert.equal(x.state,'NOT_INSTRUMENTED_BEFORE_RESEARCH_DEPLOYMENT');
 const summary=p.summarize([finished('old',-119,x)]);
 assert.equal(summary.decisionsWithCausalBrokerFill,0);
 assert.equal(summary.warned.settled,0);
 assert.equal(summary.missingOrInvalidProvenance,1);
});
test('no broker account/owner authority means no valid warning provenance',()=>{
 for(const patch of [
  {ownerDemoScopeVerified:false},
  {selectedForDispatch:false},
  {researchOnly:false},
  {noOrderBlock:false},
  {noLotSizingChange:false},
  {noNewExecutionGate:false},
  {noBrokerOrders:false},
  {noStopChange:false},
  {noExitAuthority:false},
  {noLivePromotion:false},
  {artifact:'different-rule'},
  {evaluationPhase:'AFTER_ORDER_DISPATCH'},
 ]) {
  const x=p.provenance(row({pre_dispatch_shadow:{...decision,...patch}}));
  assert.equal(x.eligible,false,JSON.stringify(patch));
 }
});
test('clean reversal control cannot become a warning from an ambiguous label',()=>{
 const clean={...decision,label:'NO_CONFLUENT_ENTRY_WARNING',
  researchEligible:true,wouldDiscourageEntryIfEverValidated:false,
  brokerFeeShortfallVerified:false,
  m1TimingAbstained:false,trainedExpertAbstained:false};
 const s=p.provenance(row({pre_dispatch_shadow:clean}));
 assert.equal(s.state,'VERIFIED_CAUSAL_REVERSAL_CONTROL_PRE_DISPATCH');
 assert.equal(s.control,true);
 assert.equal(s.warned,false);
});
test('other route controls cannot contaminate warned reversal cohort',()=>{
 const control={...decision,strategyRoute:'TREND_CONTINUATION',
  label:'OTHER_EXECUTABLE_ROUTE_CONTROL',
  researchEligible:false,wouldDiscourageEntryIfEverValidated:false};
 const x=p.provenance(row({route:'TREND_CONTINUATION',pre_dispatch_shadow:control}));
 assert.equal(x.state,'VERIFIED_CAUSAL_OTHER_ROUTE_CONTROL_PRE_DISPATCH');
 const out=p.summarize([finished('a',43,x,'TREND_CONTINUATION')]);
 assert.equal(out.warned.tradeIds,0);
 assert.equal(out.otherStrategyControls.winners,1);
 assert.equal(out.otherStrategyControls.actualAfterCostNetUsd,43);
});
test('after-cost actual warned winners are false positives: never hidden',()=>{
 const flagged=p.provenance(row());
 const clean=p.provenance(row({pre_dispatch_shadow:{
  ...decision,label:'NO_CONFLUENT_ENTRY_WARNING',
  researchEligible:true,wouldDiscourageEntryIfEverValidated:false}}));
 const mixed=p.summarize([
  finished('loser',-119.25,flagged),
  finished('winner',69.84,flagged),
  finished('control',54.12,clean),
  {tradeId:'open',openedAt:'2026-11-20T19:05:18Z',
   route:'CONFIRMED_REVERSAL',status:'OPEN',
   fullySettled:false,settledBrokerNetUsd:null,preDispatch:flagged},
 ]);
 assert.equal(mixed.warned.tradeIds,3);
 assert.equal(mixed.warned.open,1);
 assert.equal(mixed.warned.settled,2);
 assert.equal(mixed.warned.winners,1);
 assert.equal(mixed.warned.losers,1);
 assert.equal(mixed.falseWarningsOnActualWinningTrades,1);
 assert.equal(mixed.actualWinningUsdThatWarningWouldExclude,69.84);
 assert.equal(mixed.confirmedReversalUnwarned.actualAfterCostNetUsd,54.12);
 assert.equal(mixed.brokerOrderCount,0);
 assert.equal(mixed.autoVeto,false);
 assert.equal(mixed.insufficientForLivePromotion,true);
});
test('rows with incomplete broker economics are not counted as a win',()=>{
 const x=p.provenance(row());
 const summary=p.summarize([
  finished('gross-only',null,x),
  finished('settled',-55.11,x),
 ]);
 assert.equal(summary.warned.tradeIds,2);
 assert.equal(summary.warned.settled,1);
 assert.equal(summary.warned.winners,0);
 assert.equal(summary.warned.actualAfterCostNetUsd,-55.11);
});
test('read-only SQL includes exact causal governance evidence and owner scope',()=>{
 assert.match(audit.SQL,/ownerDemoPreDispatchFeeConfluenceShadow/);
 assert.match(audit.SQL,/z.created_at<=t.opened_at/);
 assert.match(audit.SQL,/z.evaluated_at<=t.opened_at/);
 assert.match(audit.SQL,/b.broker_id='pepperstone-ctrader'/);
 assert.match(audit.SQL,/b.account_type='DEMO'/);
 assert.match(audit.SQL,/b.account_currency='USD'/);
 assert.match(audit.SQL,/t.user_id=\$1/);
 assert.match(audit.SQL,/t.broker_connection_id=\$2/);
 assert.doesNotMatch(audit.SQL,/\b(?:DELETE|UPDATE|INSERT|TRUNCATE)\b/i);
});
