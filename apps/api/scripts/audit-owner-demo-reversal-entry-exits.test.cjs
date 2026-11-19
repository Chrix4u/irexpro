'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {
 ARTIFACT,SQL,peakGate,analyze,summary,grouping,audit
}=require('./audit-owner-demo-reversal-entry-exits.cjs');
const CUT='2026-11-18T21:39:43.892Z';
const OWNER='fbf0cacb-c1be-4cd9-818d-7648b503ebef';
const AUD={
 trade_id:'6a64fbdb-84e1-4d86-9459-608809753aa0',
 opened_at:'2026-11-19T01:08:52.840Z',
 closed_at:'2026-11-19T01:14:00.813Z',
 instrument:'AUDUSD',direction:'BUY',lot_size:'1.72',
 realised_pnl:'-29.24',commission:'-10.32',swap:'0',
 close_reason:'AI_CLOSE_SIGNAL',status:'CLOSED',
 max_favorable_pnl:'25.80',max_adverse_pnl:'-41.28',
 path_observation_count:49,
 metadata:{multimodel_plan_b_route:'CONFIRMED_REVERSAL',
  multimodel_execution_authority_path:'DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE'},
 sizing_inputs:{finalRiskAtStop:'86',
  demoExecutionRiskEnvelope:{historicalFeePerLot:'6'}},
 m1_route:'ABSTAIN',blockers:['MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'],
 evaluated_at:'2026-11-19T01:08:00Z',
 candidate:{alignedM5LatestBodyPressure:-.22,alignedH1:-.634,alignedH4:-1},
 governance:{multimodelTrainedExpert:{state:'ABSTAIN'}},
};
test('AUDUSD true broker settlement shows a sub-0.50R peak but only a research 0.25R possibility',()=>{
 const r=analyze(AUD,CUT);
 assert.equal(r.pnl.net,-39.56);
 assert.equal(r.pnl.peakBrokerNet,25.8);
 assert.equal(r.profitStudy.initialStopRisk,86);
 assert.equal(r.profitStudy.observedPeakR,.3);
 assert.equal(r.profitStudy.entryKnownConservativeReserve,10.32);
 assert.equal(r.profitStudy.currentPeak50PercentGate.reached,false);
 assert.equal(r.profitStudy.researchPeak25PercentGate.reached,true);
 assert.equal(r.profitStudy.lowerThresholdOnly,true);
 assert.equal(r.profitStudy.actionableFillDemonstrated,false);
 assert.equal(r.profitStudy.estimatedSavedProfit,null);
 assert.equal(r.entry.reversalTimingUnconfirmed,true);
 assert.equal(r.entry.expertState,'ABSTAIN');
});
test('profit-lock comparison does not assume fees or risk when missing',()=>{
 assert.equal(peakGate({peak:25,risk:86,fee:null,fraction:.25}).state,
  'NO_CAUSAL_FEE_OR_RISK');
 const r=analyze({...AUD,sizing_inputs:{finalRiskAtStop:'86'}},CUT);
 assert.equal(r.profitStudy.lowerThresholdOnly,false);
 assert.equal(r.profitStudy.researchPeak25PercentGate.reached,false);
 assert.equal(r.profitStudy.entryKnownConservativeReserve,null);
});
test('USDCAD 0.154R cannot be called a missed 0.25R profit lock',()=>{
 const r=analyze({...AUD,instrument:'USDCAD',lot_size:'1.4',
  max_favorable_pnl:'7.52',commission:'-8.40',
  sizing_inputs:{finalRiskAtStop:'48.84',
   demoExecutionRiskEnvelope:{historicalFeePerLot:'6'}}},CUT);
 assert.equal(r.profitStudy.researchPeak25PercentGate.reached,false);
 assert.equal(r.profitStudy.lowerThresholdOnly,false);
});
test('peak above current 0.50R threshold is not a newly claimed 0.25R missed trade',()=>{
 const r=analyze({...AUD,max_favorable_pnl:'58.74',
  sizing_inputs:{finalRiskAtStop:'89',
   demoExecutionRiskEnvelope:{historicalFeePerLot:'6'}}},CUT);
 assert.equal(r.profitStudy.currentPeak50PercentGate.reached,true);
 assert.equal(r.profitStudy.lowerThresholdOnly,false);
});
test('frozen baseline and prospective dates are kept separate',()=>{
 assert.equal(analyze({...AUD,opened_at:'2026-11-17T01:00:00Z'},CUT).cohort,
  'PRE_ACTIVATION_HISTORICAL');
 assert.equal(analyze(AUD,CUT).cohort,'FROZEN_FORWARD');
});
test('observed fee reserve and peak never become an alleged broker fill',()=>{
 for(const peak of [0,21.5,25.8,70]){
  const r=analyze({...AUD,max_favorable_pnl:peak},CUT);
  assert.equal(r.profitStudy.actionableFillDemonstrated,false);
  assert.equal(r.profitStudy.estimatedSavedProfit,null);
 }
});
test('summary counts wins losses and observed giveback without claiming independence',()=>{
 const win=analyze({...AUD,trade_id:'other',realised_pnl:'45',
  max_favorable_pnl:'58.74'},CUT);
 const lose=analyze(AUD,CUT);
 const x=summary([win,lose]);
 assert.equal(x.trades,2);assert.equal(x.winners,1);assert.equal(x.losers,1);
 assert.equal(x.netUsd,round(45-10.32-29.24-10.32));
 assert.equal(x.independentUtcDays,1);
 assert.equal(x.favorablePeakThenSettledLoss,1);
 assert.deepEqual(Object.keys(grouping([win,lose],x=>x.route)),['CONFIRMED_REVERSAL']);
 function round(n){return Math.round(n*100)/100;}
});
test('audit runs READ ONLY, filters owner-scoped SQL, refuses invalid owner',async()=>{
 const seen=[];
 const db={query:async(q,args)=>{
  seen.push([q,args]);
  if(q===SQL)return {rows:[AUD]};
  return {rows:[]};
 }};
 await assert.rejects(audit(db,{owner:'not-owner',since:'2026-11-17T00:00:00Z',
  through:'2026-11-19T02:00:00Z',activatedAt:CUT}),/INVALID_OWNER/);
 const report=await audit(db,{owner:OWNER,
  since:'2026-11-17T00:00:00Z',
  through:'2026-11-19T02:00:00Z',activatedAt:CUT});
 assert.equal(report.artifact,ARTIFACT);
 assert.equal(report.researchOnly,true);assert.equal(report.brokerOrders,0);
 assert.equal(report.modifiesExecution,false);
 assert.equal(report.forward.trades,1);
 assert.ok(SQL.includes("b.broker_id='pepperstone-ctrader'"));
 assert.ok(SQL.includes("b.account_type='DEMO'"));
 assert.ok(SQL.includes("b.account_currency='USD'"));
 assert.ok(seen[0][0].includes('READ ONLY'));
 assert.ok(seen.some(([q])=>q===SQL));
 assert.equal(report.latestTrades[0].profitStudy.estimatedSavedProfit,null);
});
test('truncated historical cohort fails rather than producing false statistics',async()=>{
 const db={query:async(q)=>({rows:q===SQL?Array(501).fill(AUD):[]})};
 await assert.rejects(audit(db,{owner:OWNER,since:'2026-11-17T00:00:00Z',
  through:'2026-11-19T02:00:00Z',activatedAt:CUT}),/COHORT_TRUNCATED/);
});
