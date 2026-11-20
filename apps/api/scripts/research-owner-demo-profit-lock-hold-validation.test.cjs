'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateShadowRow:validate,summarize}=require('./research-owner-demo-profit-lock-hold-validation.cjs');

const observedAt='2026-11-17T10:00:40Z';
const closedAt='2026-11-17T10:00:47Z';
const quoteTimes={15:'2026-11-17T10:16:00Z',30:'2026-11-17T10:31:00Z',60:'2026-11-17T11:01:00Z'};
const snap=(n,state,delta=null,extra={})=>({
  completedBars:n,state,quoteAt:state==='OPEN_AT_HORIZON'?quoteTimes[n]:null,
  ...(state==='OPEN_AT_HORIZON'?{
    actualNetPnl:48,indicativeNetPnl:48+delta,deltaVsActualClose:delta,
  }:{}),...extra,
});
const row=(decision='HOLD_CANDIDATE')=>({
  account_currency:'USD',status:'CLOSED',close_reason:'PROFIT_PROTECTION',
  closed_at:closedAt,instrument:'EURUSD',strategy_route:'CONFIRMED_REVERSAL',
  realised_pnl:'60.00',commission:'-12.00',swap:'0',
  max_favorable_pnl:'85.00',profit_giveback:'25.00',
  audit:{
    mode:'SHADOW_ONLY',noTradeAuthority:true,
    recommendation:decision,observedAt,
    originalCloseReason:'PROFIT_PROTECTION',
    protectedGraceShadow:{wouldConsiderBrokerProtectedGrace:true},
    runnerShadow:{eligibleForFurtherResearch:false},
  },
  response:{
    artifact:'exit-alternatives-verified-m1-v2',
    mode:'SHADOW_ONLY',modifiesExecution:false,brokerFillCertified:false,
    snapshotAt:observedAt,originalNetPnl:48,
    holdHorizonSnapshots:[
      snap(15,'OPEN_AT_HORIZON',12),
      snap(30,'OPEN_AT_HORIZON',-8),
      snap(60,'POSSIBLE_STOP_FIRST'),
    ],
  },
});
test('valid prospective HOLD with positive 15m outcome and negative 30m outcome',()=>{
  const r=validate(row());
  assert.equal(r.status,'VALID');
  assert.equal(r.route,'CONFIRMED_REVERSAL');
  assert.equal(r.actualNetUsd,48);
  assert.equal(r.commissionUsd,-12);
  assert.equal(r.horizons['15m'].deltaUsd,12);
  assert.equal(r.horizons['30m'].deltaUsd,-8);
  assert.equal(r.horizons['60m'].deltaUsd,null);
  assert.equal(r.patienceRecommendation,true);
});
test('does not confuse eventual quote improvement with a completed fill',()=>{
  const r=summarize([row(),row('CLOSE_CANDIDATE')]);
  const x=r.byRoute.CONFIRMED_REVERSAL.HOLD_CANDIDATE.outcomes;
  assert.equal(x['15m'].quoteVerifiedBarrierFreeCohort,1);
  assert.equal(x['15m'].proxyImprovedCount,1);
  assert.equal(x['30m'].proxyWorsenedCount,1);
  assert.equal(x['60m'].censorReasons.POSSIBLE_STOP_FIRST,1);
  assert.equal(r.promotable,false);
  assert.equal(r.modifiesExecution,false);
});
test('strictly rejects a research hold recommendation logged after the actual exit',()=>{
  const x=row();x.audit.observedAt='2026-11-17T10:02:00Z';
  assert.equal(validate(x).status,'DECISION_OUTCOME_TIME_MISMATCH');
});
test('stale or unpaired research audit does not masquerade as confirmed prospective HOLD',()=>{
  const x=row();x.audit=null;
  assert.equal(validate(x).status,'AS_OF_PROSPECTIVE_DECISION_MISSING');
  const y=row();y.audit.observedAt='2026-11-17T10:00:55Z';
  assert.equal(validate(y).status,'DECISION_OUTCOME_TIME_MISMATCH');
  const z=row();z.audit.mode='BROKER_TRADE_AUTHORIZED';
  assert.equal(validate(z).status,'AS_OF_PROSPECTIVE_DECISION_MISSING');
});
test('incomplete or inconsistently settled commission is not a plausible after-fee result',()=>{
  const x=row();x.commission=null;
  assert.equal(validate(x).status,'INCOMPLETE_FINANCIAL_SETTLEMENT');
  const y=row();y.response.originalNetPnl=60;
  assert.equal(validate(y).status,'SETTLED_NET_DISAGREES_WITH_SHADOW');
});
test('wrong broker account scope and actual exit cause remain out of study',()=>{
  const x=row();x.account_currency='EUR';
  assert.equal(validate(x).status,'WRONG_SCOPE');
  const y=row();y.close_reason='AI_CLOSE_SIGNAL';
  assert.equal(validate(y).status,'WRONG_SCOPE');
});
test('invalid prospective HOLD cannot replace actual profit protection',()=>{
  const x=row();x.response.modifiesExecution=true;
  assert.equal(validate(x).status,'MISSING_VERIFIED_SHADOW');
  const y=row();y.response.brokerFillCertified=true;
  assert.equal(validate(y).status,'MISSING_VERIFIED_SHADOW');
  const z=row();z.audit.noTradeAuthority=false;
  assert.equal(validate(z).status,'AS_OF_PROSPECTIVE_DECISION_MISSING');
});
test('uncertain M1 barrier censoring is excluded from the outcome denominator',()=>{
  const x=row();x.response.holdHorizonSnapshots[0]=snap(15,'SAME_BAR_AMBIGUITY');
  const y=row();y.response.holdHorizonSnapshots[0]=snap(15,'DATA_GAP');
  const report=summarize([x,y]);
  const bucket=report.allRecommendations.HOLD_CANDIDATE.outcomes['15m'];
  assert.equal(bucket.quoteVerifiedBarrierFreeCohort,0);
  assert.equal(bucket.improvementRateOnlyOnUncensoredMarks,null);
  assert.equal(bucket.censorReasons.SAME_BAR_AMBIGUITY,1);
  assert.equal(bucket.censorReasons.DATA_GAP,1);
});
test('future quote beyond the evaluated horizon and mismatched net do not create a win',()=>{
  const x=row();x.response.holdHorizonSnapshots[0].quoteAt='2026-11-17T11:15:00Z';
  assert.equal(validate(x).horizons['15m'].state,'UNRECONCILED_HORIZON');
  const y=row();y.response.holdHorizonSnapshots[0].indicativeNetPnl=300;
  assert.equal(validate(y).horizons['15m'].state,'UNRECONCILED_HORIZON');
});
test('does not invent improvement if no valid examples exist',()=>{
  const report=summarize([null,{account_currency:'EUR'}]);
  assert.equal(report.validProspectiveComparisons,0);
  assert.equal(report.allRecommendations.HOLD_CANDIDATE.outcomes['30m'].meanProxyDeltaUsd,null);
  assert.equal(report.allRecommendations.HOLD_CANDIDATE.prospectiveDecisions,0);
});
test('separates actual costs and 15/30/60 trade outcome cohorts by route',()=>{
  const a=row(),b=row('CLOSE_CANDIDATE');b.strategy_route='EARLY_TRANSITION';
  b.response.holdHorizonSnapshots[0]=snap(15,'OPEN_AT_HORIZON',-20);
  const report=summarize([a,b]);
  assert.equal(report.inputRows,2);
  assert.equal(report.validProspectiveComparisons,2);
  assert.equal(report.byRoute.EARLY_TRANSITION.CLOSE_CANDIDATE.recordedActualNetUsd,48);
  assert.equal(report.byRoute.EARLY_TRANSITION.CLOSE_CANDIDATE.outcomes['15m'].proxyWorsenedCount,1);
  assert.equal(report.byRoute.CONFIRMED_REVERSAL.HOLD_CANDIDATE.outcomes['15m'].meanProxyDeltaUsd,12);
});
