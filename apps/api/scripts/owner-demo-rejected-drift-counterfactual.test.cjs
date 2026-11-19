'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  driftCounterfactualLabel,
  summarizeRejectedDriftCounterfactuals,
} = require('./owner-demo-rejected-drift-counterfactual.cjs');

const AS_OF='2026-11-19T20:00:00.000Z';
function row(id, drift, net, changes={}) {
  return {
    id, instrument:'USDJPY',direction:'SELL',
    strategy_route:'TREND_CONTINUATION',m1_route:'M1_EARLY_TRANSITION',
    bar_time:'2026-11-19T18:00:00.000Z',drift,
    multimodel_cost_source:'BROKER_OBSERVED_P90',
    generic_cost_source:'STATIC_DIAGNOSTIC_FALLBACK',
    drift_outcome:{
      artifact:'m1-drift-counterfactual-15m-v1',
      source:'COMPLETED_M1_OHLC',horizonBars:15,
      modifiesExecution:false,
      selectionPolicy:'FIXED_UTC_16M_EPISODE_RESEARCH',
      outcome:net>0?'TP':'SL',
      driftEvidenceSource:'MULTIMODEL',
      driftStateAtDecision:drift,
      entryBarOpenTime:'2026-11-19T18:01:00.000Z',
      observedAt:'2026-11-19T18:16:00.000Z',
      grossRMultiple:net+0.12,
      estimatedExecutionCostR:0.12,
      netRMultiple:net,
      nonDriftBlockersAtDecision:['ENSEMBLE_NOT_PAPER_ADMITTED'],
      driftWasOnlySubstantiveBlocker:false,
    }, ...changes,
  };
}
test('validates rejected-drift quote evidence separately from normal M1 shadow labels',()=>{
  const rejected=row('one','OUT_OF_DISTRIBUTION',-.4);
  assert.equal(driftCounterfactualLabel(rejected,Date.parse(AS_OF)).netR,-.4);
  const normal=row('two','NORMAL',1);
  assert.equal(driftCounterfactualLabel(normal,Date.parse(AS_OF)),null);
  const summary=summarizeRejectedDriftCounterfactuals([rejected,normal],AS_OF);
  assert.equal(summary.rejectedDirectionalDecisions,1);
  assert.equal(summary.validCounterfactualQuoteLabels,1);
  assert.equal(summary.quoteLabelsWithOtherBlockers,1);
  assert.equal(summary.groups[0].brokerObservedP90CostLabels,1);
  assert.equal(summary.comparisonToNormalShadow,'NOT_COMPARABLE_SELECTION_POLICY');
  assert.equal(summary.grantsTradeAuthority,false);
});
test('does not turn future quotes, ambiguous barriers or wrong drift into evidence',()=>{
  const base=row('a','OUT_OF_DISTRIBUTION',.5);
  for(const patch of [
    {observedAt:'2026-11-19T20:10:00.000Z'},
    {entryBarOpenTime:'2026-11-19T17:59:00.000Z'},
    {outcome:'AMBIGUOUS'},
    {driftStateAtDecision:'NORMAL'},
    {source:'UNOBSERVABLE_DATA_GAP'},
    {horizonBars:60},
    {selectionPolicy:'SOME_OTHER_SELECTION'},
    {estimatedExecutionCostR:NaN},
    {grossRMultiple:10},
    {netRMultiple:'Infinity'},
    {nonDriftBlockersAtDecision:null},
  ]) {
    assert.equal(driftCounterfactualLabel(
      {...base,drift_outcome:{...base.drift_outcome,...patch}},
      Date.parse(AS_OF)),null);
  }
});
test('separates drift-only hypotheticals from candidates rejected by other gates',()=>{
  const a=row('a','OUT_OF_DISTRIBUTION',.8,{
    drift_outcome:{
      ...row('a','OUT_OF_DISTRIBUTION',.8).drift_outcome,
      driftWasOnlySubstantiveBlocker:true,
      nonDriftBlockersAtDecision:[],
    },
  });
  const b=row('b','STRESSED',-.3,{
    drift_outcome:{
      ...row('b','STRESSED',-.3).drift_outcome,
      driftEvidenceSource:'GENERIC',
      driftWasOnlySubstantiveBlocker:false,
    },
  });
  const summary=summarizeRejectedDriftCounterfactuals([a,b],AS_OF);
  assert.equal(summary.driftOnlyQuoteLabels,1);
  assert.equal(summary.quoteLabelsWithOtherBlockers,1);
  assert.equal(summary.groups.length,2);
  assert.equal(summary.groups.find(g=>g.key.includes('STRESSED')).otherCostLabels,1);
  assert.equal(summary.groups.find(g=>g.key.includes('OUT_OF_DISTRIBUTION')).brokerObservedP90CostLabels,1);
});
test('records missing and invalid labels instead of silently excluding rejected decisions',()=>{
  const a=row('a','OUT_OF_DISTRIBUTION',.2,{drift_outcome:null});
  const b=row('b','OUT_OF_DISTRIBUTION',.2,{
    drift_outcome:{...row('b','OUT_OF_DISTRIBUTION',.2).drift_outcome,source:'UNOBSERVABLE_DATA_GAP'},
  });
  const report=summarizeRejectedDriftCounterfactuals([a,b],AS_OF);
  assert.equal(report.rejectedDirectionalDecisions,2);
  assert.equal(report.withCounterfactualArtifact,1);
  assert.equal(report.validCounterfactualQuoteLabels,0);
  assert.equal(report.unverifiedCounterfactualLabels,1);
  assert.equal(report.unselectedOrUnsettledDecisions,1);
  assert.equal(report.groups.length,0);
});
