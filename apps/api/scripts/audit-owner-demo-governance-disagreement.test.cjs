'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SQL,classify,aggregate,run}=require('./audit-owner-demo-governance-disagreement.cjs');
function row(override={}){
 return {
  trade_id:'abc',instrument:'EURUSD',direction:'SELL',
  opened_at:'2026-11-18T16:40:00Z',closed_at:'2026-11-18T17:00:00Z',
  decision_at:'2026-11-18T16:39:00Z',
  strategy:'EARLY_TRANSITION',planb_expected_r:'0.287',
  realised_pnl:'-92.22',commission:'-10.44',swap:'0',
  governance:{genericGovernance:{netExpectedR:-0.283,paperExecutionEligible:false,
   driftState:'STRESSED',netExpectedRPassed:false,
   predictedCostShadow:{paperWouldHaveBlocked:true}},
   multimodelTrainedExpert:{state:'ABSTAIN'},
   multimodelEnsemble:{paperAdmitted:true,admitted:false}},
  ...override,
 };
}
test('scoped read only query requires authorized Pepperstone owner USD DEMO',()=>{
 assert.match(SQL,/t\.user_id=\$1 AND b\.user_id=\$1/);
 assert.match(SQL,/b\.broker_id='pepperstone-ctrader'/);
 assert.match(SQL,/b\.account_type='DEMO'/);
 assert.match(SQL,/t\.account_currency='USD'/);
 assert.match(SQL,/d\.evaluated_at<=t\.opened_at/);
 assert.doesNotMatch(SQL,/\b(?:UPDATE|DELETE|INSERT)\b/i);
});
test('gross, signed commission and swap yield exact after-fee net',()=>{
 const x=classify(row());
 assert.equal(x.netUsd,-102.66);
 assert.equal(x.signals.planBPositiveGenericNegative,true);
 assert.equal(x.signals.genericPaperRejected,true);
 assert.equal(x.signals.driftDisturbed,true);
 assert.equal(x.signals.genericExpectancyFailed,true);
 assert.equal(x.signals.genericPredictedCostShadowBlocked,true);
 assert.equal(x.decisionPresentAndAsOf,true);
});
test('missing governance evidence is unknown, never implicitly a false flag',()=>{
 const x=classify(row({governance:{}}));
 assert.equal(x.signals.planBPositiveGenericNegative,null);
 assert.equal(x.signals.genericNetRNegative,null);
 assert.equal(x.signals.genericPaperRejected,null);
 assert.equal(x.signals.driftDisturbed,null);
});
test('some rejected trade shapes are winners, not proof of a valid veto',()=>{
 const x=classify(row({trade_id:'a'}));
 const y=classify(row({trade_id:'b',realised_pnl:'35.0'}));
 const o=aggregate([x,y]);
 assert.equal(o.ALL.patterns.planBPositiveGenericNegative.flagged.trades,2);
 assert.equal(o.ALL.patterns.planBPositiveGenericNegative.flagged.wins,1);
 assert.equal(o.ALL.patterns.planBPositiveGenericNegative.flagged.losses,1);
 assert.equal(o.ALL.patterns.planBPositiveGenericNegative.wouldRejectSomeWinners,true);
 assert.equal(o.ALL.patterns.planBPositiveGenericNegative.exploratoryOnly,true);
});
test('future or missing entry decision is not promoted to valid as-of',()=>{
 const x=classify(row({decision_at:'2026-11-18T16:41:00Z'}));
 assert.equal(x.decisionPresentAndAsOf,false);
});
test('readOnly query wraps repeatable-read transaction and returns no order action',async()=>{
 let calls=[];
 const fake={query:async(q,params)=>{calls.push(q);if(q===SQL)return {rows:[row()]};return {rows:[]}}};
 const x=await run(fake,'75e15b70-2e9b-4a29-9002-ea4ef8bb1bcd');
 assert.equal(calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1),'COMMIT');
 assert.equal(x.report.modifiesExecution,false);
 assert.equal(x.report.brokerOrders,0);
 assert.equal(x.report.trades,1);
});
