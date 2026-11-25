'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {scenario,reportLadder}=require('./research-owner-demo-lot-ladder.cjs');
const t={
  instrument:'EURUSD',direction:'BUY',status:'CLOSED',account_currency:'USD',
  strategy_route:'EARLY_TRANSITION',lot_size:'1.70',realised_pnl:'46.00',
  commission:'-10.20',swap:'0',initial_risk:'88.00',
  max_favorable_pnl:'51.00',profit_giveback:'9.00',
};
test('4 to 7 lots scale both commission and losses, not the model win rate',()=>{
  const x=scenario(t,7,120.16);
  assert.equal(x.status,'EXCEEDS_STOP_RISK_CAP');
  assert.equal(x.targetLots,7);
  assert.equal(x.hypotheticalCommissionUsd,-42);
  assert.equal(x.hypotheticalFeeOutlayUsd,42);
  assert.equal(x.hypotheticalNetUsd,147.41);
  assert.equal(x.hypotheticalStopRiskUsd,362.35);
  assert.equal(x.riskBudgetPass,false);
});
test('preserves negative net result on amplified losing trade',()=>{
  const x=scenario({...t,realised_pnl:'-64.00'},5,120.16);
  assert.equal(x.hypotheticalNetUsd,-218.24);
  assert.ok(x.hypotheticalCommissionUsd<0);
});
test('does not convert missing financial settlement into zero-cost profit',()=>{
  assert.equal(scenario({...t,commission:null},4,120.16).status,'INCOMPLETE_SETTLED_BROKER_EVIDENCE');
  assert.equal(scenario({...t,swap:null},4,120.16).status,'INCOMPLETE_SETTLED_BROKER_EVIDENCE');
});
test('missing stop-risk evidence is NOT treated as permission to open a higher lot',()=>{
  const x=scenario({...t,initial_risk:null},4,120.16);
  assert.equal(x.status,'STOP_RISK_UNVERIFIED');
  assert.equal(x.riskBudgetPass,null);
});
test('small-lot or excessive extrapolation cannot fabricate reliable large-lot results',()=>{
  assert.equal(scenario({...t,lot_size:'0.01'},7,120.16).status,'EXTRAPOLATION_NOT_COMPARABLE');
  assert.equal(scenario({...t,lot_size:'1'},7,120.16).status,'EXTRAPOLATION_NOT_COMPARABLE');
});
test('a risk budget pass remains expressly not an executable broker order',()=>{
  const x=scenario({...t,initial_risk:'20'},7,120.16);
  assert.equal(x.status,'WITHIN_STOP_RISK_CAP_OTHER_GATES_UNVERIFIED');
  assert.equal(x.hypotheticalStopRiskUsd,82.35);
  assert.equal(x.classification,'SAME_SETTLED_PRICE_PATH_LINEAR_SCALING_ONLY');
});
test('normalizes positions only on exact settled DEMO USD instruments',()=>{
  for(const x of [
    {...t,status:'OPEN'}, {...t,account_currency:'EUR'},
    {...t,instrument:'GBPUSD'}, {...t,commission:'5.10'},
  ]) assert.equal(scenario(x,4,120.16).status,'INCOMPLETE_SETTLED_BROKER_EVIDENCE');
});
test('reports each lot size and route with costs and all risk exemptions separate',()=>{
  const result=reportLadder([t,{...t,direction:'SELL',strategy_route:'CONFIRMED_REVERSAL',
    realised_pnl:'-64.00',commission:'-10.20',initial_risk:'20'},
    {...t,commission:null}],{equityUsd:48064,riskPercent:.25});
  assert.equal(result.riskLimitUsd,120.16);
  assert.equal(result.researchOnly,true);
  assert.equal(result.modifiesExecution,false);
  const s=result.resultByLot['7lots'];
  assert.equal(s.settledComparableTrades,2);
  assert.equal(s.riskBudgetExceedances,1);
  assert.equal(s.riskBudgetPasses,1);
  assert.equal(s.states.INCOMPLETE_SETTLED_BROKER_EVIDENCE,1);
  assert.equal(s.byRoute.EARLY_TRANSITION.hypotheticalCommissionUsd,-42);
  assert.equal(s.byRoute.CONFIRMED_REVERSAL.hypotheticalNetUsd,-305.53);
});
test('rejects invalid equity and attempts to override conservative stop-loss budget',()=>{
  assert.throws(()=>reportLadder([t],{equityUsd:0,riskPercent:.25}),/REQUIRED/);
  assert.throws(()=>reportLadder([t],{equityUsd:48064,riskPercent:2}),/REQUIRED/);
});

test('swap credits are not reported as commission charges',()=>{
  const x=scenario({...t,swap:'15.00'},7,120.16);
  assert.equal(x.hypotheticalFeeOutlayUsd,42);
  assert.equal(x.hypotheticalSwapUsd,61.76);
});
