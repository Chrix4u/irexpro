'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildDriftCohort,settledLabel}=require('./audit-owner-demo-drift-outcomes.cjs');
const asOf='2026-11-19T20:00:00.000Z';
const stamp=n=>new Date(Date.parse('2026-11-19T16:00:00.000Z')+n*60000).toISOString();
function row(minute,drift,netR,overrides={}) {
  return {
    id:String(minute),instrument:'USDJPY',direction:'BUY',
    m1_route:'M1_EARLY_TRANSITION',strategy_route:'TREND_CONTINUATION',
    bar_time:stamp(minute),drift,
    diagnostics:drift==='NORMAL'?[]:['mtfStrength:HARD_LOW'],
    outcome:{
      artifact:'m1-shadow-outcome-15m-v1',modifiesExecution:false,
      source:'COMPLETED_M1_OHLC',outcome:netR>0?'TP':'SL',
      netRMultiple:netR,observedAt:stamp(minute+15),
      executionCostSource:'BROKER_OBSERVED_P90',
    },...overrides,
  };
}
test('deduplicates adjacent M1 scans into wider episodes before studying drift',()=>{
  const result=buildDriftCohort([
    row(0,'OUT_OF_DISTRIBUTION',-.4),
    row(5,'OUT_OF_DISTRIBUTION',2.5),
    row(25,'NORMAL',.5),
    row(48,'OUT_OF_DISTRIBUTION',-.6),
  ],asOf);
  assert.equal(result.deduplicatedEpisodeCount,3);
  const out=result.byPlanBRouteAndDrift.find(x=>x.key.endsWith('OUT_OF_DISTRIBUTION'));
  assert.equal(out.episodeCount,2);
  assert.equal(out.sumEstimatedNetR,-1);
  assert.equal(result.modifiesExecution,false);
  assert.equal(result.modelTrainingStatus,'NOT_TRAINED');
});
test('excludes lookahead, incomplete M1 and malformed return labels',()=>{
  const first=row(0,'NORMAL',3,{outcome:{
    ...row(0,'NORMAL',3).outcome,observedAt:'2026-11-19T21:00:00.000Z',
  }});
  const second=row(25,'NORMAL',2,{outcome:{
    ...row(25,'NORMAL',2).outcome,source:'UNOBSERVABLE_DATA_GAP',
  }});
  const third=row(50,'NORMAL',2,{outcome:{
    ...row(50,'NORMAL',2).outcome,netRMultiple:'Infinity',
  }});
  const result=buildDriftCohort([first,second,third],asOf);
  assert.equal(result.earlierPeriod.episodeCount,3);
  assert.equal(result.earlierPeriod.observedCompletedM1,0);
  assert.equal(result.earlierPeriod.averageEstimatedNetR,null);
});
test('reports broker-observed costs separately from hypothetical returns',()=>{
  assert.equal(settledLabel(row(0,'NORMAL',1.2),Date.parse(asOf)).netR,1.2);
  const report=buildDriftCohort([row(0,'NORMAL',1.2)],asOf);
  assert.equal(report.byPlanBRouteAndDrift[0].brokerObservedCostRows,1);
  assert.equal(report.grantsTradeAuthority,false);
  assert.match(report.measurement,/not-broker-PnL/);
});
test('BUY and SELL observations are independent tactical episodes',()=>{
  const report=buildDriftCohort([
    row(0,'NORMAL',1),row(0,'NORMAL',-.5,{id:'sell',direction:'SELL'}),
  ],asOf);
  assert.equal(report.deduplicatedEpisodeCount,2);
  assert.equal(report.earlierPeriod.observedCompletedM1,2);
});
test('only completed broker-native outcomes can contribute positive edge',()=>{
  const altered=row(0,'NORMAL',1.2,{outcome:{
    ...row(0,'NORMAL',1.2).outcome,artifact:'unknown',
  }});
  assert.equal(settledLabel(altered,Date.parse(asOf)),null);
});

test('reports earlier and later matched drift outcomes separately without training on future days',()=>{
  const rows=[];
  const baseDay=Date.parse('2026-11-16T16:00:00.000Z');
  for(let day=0;day<4;day++){
    for(const [minute,drift,netR] of [
      [0,'NORMAL',-.2],[20,'NORMAL',-.3],
      [40,'OUT_OF_DISTRIBUTION',.4],[60,'OUT_OF_DISTRIBUTION',.2],
    ]){
      const time=new Date(baseDay+day*86400000+minute*60000).toISOString();
      const observedAt=new Date(baseDay+day*86400000+(minute+15)*60000).toISOString();
      rows.push(row(minute,drift,netR,{
        id:[day,minute,drift].join('-'),bar_time:time,
        outcome:{...row(minute,drift,netR).outcome,observedAt},
      }));
    }
  }
  const report=buildDriftCohort(rows,asOf);
  assert.equal(report.chronologicalSplitDay,'2026-11-19');
  assert.equal(report.chronologicalMatchedDriftDays.splitDay,'2026-11-19');
  assert.equal(report.chronologicalMatchedDriftDays.earlier.comparableStrata,3);
  assert.equal(report.chronologicalMatchedDriftDays.later.comparableStrata,1);
  assert.equal(report.chronologicalMatchedDriftDays.retrained,false);
  assert.equal(report.chronologicalMatchedDriftDays.promoteThresholds,false);
  assert.equal(report.chronologicalMatchedDriftDays.grantsTradeAuthority,false);
  assert.equal(report.chronologicalMatchedDriftDays.status,'RETROSPECTIVE_TIME_SPLIT_ONLY');
});
test('makes missing independent day holdout explicit',()=>{
  const report=buildDriftCohort([row(0,'NORMAL',1)],asOf);
  assert.equal(report.chronologicalMatchedDriftDays.splitDay,null);
  assert.equal(report.chronologicalMatchedDriftDays.later,null);
  assert.equal(report.chronologicalMatchedDriftDays.status,'NO_SEPARATE_DAY_HOLDOUT');
});

test('rejected-drift counterfactuals are reported, not substituted for normal M1 labels',()=>{
  const ordinary=row(0,'NORMAL',-.4);
  const candidate=row(25,'OUT_OF_DISTRIBUTION',.8,{
    outcome:null,
    multimodel_cost_source:'BROKER_OBSERVED_P90',
    drift_outcome:{
      artifact:'m1-drift-counterfactual-15m-v1',
      source:'COMPLETED_M1_OHLC',
      horizonBars:15,
      modifiesExecution:false,
      outcome:'TP',
      selectionPolicy:'FIXED_UTC_16M_EPISODE_RESEARCH',
      driftEvidenceSource:'MULTIMODEL',
      driftStateAtDecision:'OUT_OF_DISTRIBUTION',
      entryBarOpenTime:stamp(26),
      observedAt:stamp(41),
      grossRMultiple:.95,
      estimatedExecutionCostR:.15,
      netRMultiple:.8,
      nonDriftBlockersAtDecision:['ENSEMBLE_NOT_PAPER_ADMITTED'],
      driftWasOnlySubstantiveBlocker:false,
    },
  });
  const report=buildDriftCohort([ordinary,candidate],asOf);
  assert.equal(report.rejectedDriftCounterfactuals.validCounterfactualQuoteLabels,1);
  assert.equal(report.rejectedDriftCounterfactuals.quoteLabelsWithOtherBlockers,1);
  assert.equal(report.rejectedDriftCounterfactuals.comparisonToNormalShadow,
    'NOT_COMPARABLE_SELECTION_POLICY');
  const ood=report.byPlanBRouteAndDrift.find(g=>g.key.endsWith('OUT_OF_DISTRIBUTION'));
  assert.equal(ood.observedCompletedM1,0);
  assert.equal(report.matchedDriftDays.comparableStrata,0);
  assert.equal(report.grantsTradeAuthority,false);
});
