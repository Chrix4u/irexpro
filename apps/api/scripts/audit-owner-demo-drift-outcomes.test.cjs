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
