'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const {evaluateProposal,compare,SQL,SQL_SESSION,START,END}=require(
 './audit-pepperstone-expert-opposite-challenger.cjs');
const at='2026-11-16T20:08:00.000Z';
function pair(options={}){
 const source={instrument:'USDJPY',direction:'BUY',
  bar_time:new Date('2026-11-16T20:07:00Z'),evaluated_at:new Date(at),
  governance:{
   multimodelEnsemble:{strategyRoute:'CONFIRMED_REVERSAL',paperAdmitted:true},
   multimodelTrainedExpert:{
    state:'CONFIRM',admitted:true,direction:'SELL',allBrokerNative:true,
    longVotes:0,shortVotes:3,ensembleConfidence:0.75,
    meanOpportunityProbability:0.71,decisionTime:'2026-11-16T20:07:00Z',
   },
  },
 };
 const opposite={instrument:'USDJPY',direction:'SELL',
  bar_time:new Date('2026-11-16T20:07:00Z'),evaluated_at:new Date(at),
  route:'M1_EARLY_TRANSITION',
  candidate:{directionQuality:0.7,confidence:0.72,stopDistance:0.08,targetDistance:0.13},
  governance:{
   multimodelEnsemble:{
    strategyRoute:'EARLY_TRANSITION',paperAdmitted:true,
    ensembleScore:0.7,directionQuality:0.69,
   },
   multimodelGovernance:{
    paperExecutionEligible:true,netExpectedR:0.2,
    paperExecutionCostUsable:true,executionSpreadEvidenceValid:true,
    eventRisk:'CLEAR',driftState:'IN_DISTRIBUTION',
   },
  },
 };
 return [Object.assign(source,options.source||{}),
  Object.assign(opposite,options.opposite||{})];
}
test('expert veto with final ABSTAIN does not qualify a SELL',()=>{
 const [source,other]=pair();
 source.governance.multimodelTrainedExpert.state='ABSTAIN';
 source.governance.multimodelTrainedExpert.admitted=false;
 assert.equal(evaluateProposal(source,other).reason,'EXPERT_VOTED_BUT_ABSTAINED');
});
test('opposite direction needs its own qualified reversal or early-transition route',()=>{
 const [source,other]=pair();
 other.governance.multimodelEnsemble.strategyRoute='TREND_CONTINUATION';
 assert.equal(evaluateProposal(source,other).reason,
  'OPPOSITE_ROUTE_IS_NOT_REVERSAL_OR_EARLY');
});
test('opposite direction needs positive after-cost expectancy on its OWN side',()=>{
 const [source,other]=pair();
 other.governance.multimodelGovernance.netExpectedR=-0.12;
 assert.equal(evaluateProposal(source,other).reason,
  'OPPOSITE_NET_EXPECTANCY_OR_MARKET_RISK');
});
test('own-side independent M1 signal quality and risk geometry are mandatory',()=>{
 const [source,other]=pair();
 other.candidate.directionQuality=0.31;
 assert.equal(evaluateProposal(source,other).reason,'OPPOSITE_M1_TIMING_NOT_READY');
 other.candidate.directionQuality=0.75;
 other.candidate.stopDistance=0;
 assert.equal(evaluateProposal(source,other).reason,
  'OPPOSITE_OWN_STOP_TARGET_NOT_VALID');
});
test('no as-of opposite signal is never constructed from an expert vote',()=>{
 const [source,other]=pair();
 assert.equal(evaluateProposal(source,null).reason,
  'OPPOSITE_SAME_BAR_CANDIDATE_MISSING');
 other.evaluated_at=new Date('2026-11-16T20:11:00Z');
 assert.equal(evaluateProposal(source,other).reason,
  'OPPOSITE_CANDIDATE_NOT_ASOF');
});
test('candidate outside frozen trial window is expired, not replayable',()=>{
 const [source,other]=pair();
 source.evaluated_at=new Date('2026-11-16T21:00:00Z');
 assert.equal(evaluateProposal(source,other).reason,
  'EXPERT_OUTSIDE_DECISION_WINDOW');
});
test('qualified research outcome has no broker authority and records independent stops',()=>{
 const [source,other]=pair();
 const r=evaluateProposal(source,other);
 assert.equal(r.eligible,true);
 assert.equal(r.reason,'RESEARCH_QUALIFIED_NO_BROKER_AUTHORITY');
 assert.equal(r.proposedSide,'SELL');
 assert.equal(r.stopDistance,0.08);
 assert.equal(r.targetDistance,0.13);
});
test('same bar matching accepts equal timestamp not identical Date object',()=>{
 const [source,other]=pair();
 const result=compare([source,other]);
 assert.equal(result.totalOpposedAlternates,1);
 assert.equal(result.cases[0].reason,'RESEARCH_QUALIFIED_NO_BROKER_AUTHORITY');
});
test('queries are read-only, exact owner/demo scoped, with frozen trial boundaries',()=>{
 assert.equal(START,'2026-11-16T20:00:00.000Z');
 assert.equal(END,'2026-11-16T21:00:00.000Z');
 assert.match(SQL_SESSION,/s\.user_id=\$1/);
 assert.match(SQL_SESSION,/b\.broker_id='pepperstone-ctrader'/);
 assert.match(SQL_SESSION,/b\.account_type='DEMO'/);
 assert.match(SQL,/d\.broker_connection_id=\$2/);
 assert.match(SQL,/LIMIT 4001/);
 for(const s of [SQL,SQL_SESSION])
  assert.doesNotMatch(s,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
});
