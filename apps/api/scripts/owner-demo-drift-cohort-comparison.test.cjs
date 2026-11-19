'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {compareMatchedDriftDays}=require('./owner-demo-drift-cohort-comparison.cjs');

const asOfMs=Date.parse('2026-11-19T21:00:00.000Z');
function example(drift,minute,netR,other={}) {
  return {
    id: drift+'-'+minute,
    bar_time:new Date(Date.parse('2026-11-19T16:00:00Z')+minute*60000).toISOString(),
    instrument:'USDJPY',direction:'BUY',
    strategy_route:'TREND_CONTINUATION',
    m1_route:'M1_TREND_CONTINUATION',
    drift,
    outcome:netR==null?null:{netR,costSource:'BROKER_OBSERVED_P90'},...other,
  };
}
const labelOf = row => row.outcome;
const opts = {
  minSettledPerStateStratum:2,
  minQualifiedStrata:1,
  minQualifiedDays:1,
  minQualifiedTotalPerState:2,
};
test('compares only genuinely matched instrument, side, strategy, M1 route and UTC day',()=>{
  const rows=[
    example('NORMAL',0,.1),example('NORMAL',20,.3),
    example('OUT_OF_DISTRIBUTION',40,.6),example('OUT_OF_DISTRIBUTION',60,.8),
    example('OUT_OF_DISTRIBUTION',80,9,{direction:'SELL'}),
    example('NORMAL',100,-9,{instrument:'EURUSD'}),
  ];
  const result=compareMatchedDriftDays(rows,labelOf,asOfMs,opts);
  assert.equal(result.comparableStrata,1);
  assert.equal(result.bothDriftStatesPresentStrata,1);
  assert.equal(result.comparableNormalLabels,2);
  assert.equal(result.comparableOutOfDistributionLabels,2);
  assert.equal(result.balancedOodMinusNormalMeanEstimatedNetR,.5);
  assert.equal(result.status,'DESCRIPTIVE_ONLY_NO_POLICY_AUTHORITY');
  assert.equal(result.executionAuthority,'NONE');
  assert.equal(result.modifiesExecution,false);
  assert.equal(result.modelTrainingStatus,'NOT_TRAINED');
});
test('never compares across days or directions, even when the route matches',()=>{
  const rows=[
    example('NORMAL',0,.1),example('NORMAL',20,.1),
    example('OUT_OF_DISTRIBUTION',40,.7,{direction:'SELL'}),
    example('OUT_OF_DISTRIBUTION',60,.7,{direction:'SELL'}),
    example('OUT_OF_DISTRIBUTION',80,.7,{
      bar_time:'2026-11-18T17:20:00Z',
    }),
  ];
  const result=compareMatchedDriftDays(rows,labelOf,asOfMs,opts);
  assert.equal(result.comparableStrata,0);
  assert.equal(result.status,'NO_COMPARABLE_SETTLED_STRATA');
  assert.equal(result.balancedOodMinusNormalMeanEstimatedNetR,null);
});
test('does not conclude a winning OOD pattern from missing normal outcome labels',()=>{
  const rows=[
    example('NORMAL',0,null),example('NORMAL',20,null),
    example('OUT_OF_DISTRIBUTION',40,2),example('OUT_OF_DISTRIBUTION',60,1),
  ];
  const result=compareMatchedDriftDays(rows,labelOf,asOfMs,opts);
  assert.equal(result.bothDriftStatesPresentStrata,1);
  assert.equal(result.comparableStrata,0);
  assert.equal(result.matchedStrata[0].normal.missingLabels,2);
  assert.equal(result.balancedOodMinusNormalMeanEstimatedNetR,null);
});
test('highly selected label coverage prevents a research qualification',()=>{
  const rows=[
    example('NORMAL',0,.1),example('NORMAL',20,.1),
    example('NORMAL',25,null),example('NORMAL',30,null),
    example('OUT_OF_DISTRIBUTION',40,.8),example('OUT_OF_DISTRIBUTION',60,.8),
    example('OUT_OF_DISTRIBUTION',80,null),example('OUT_OF_DISTRIBUTION',100,null),
  ];
  const result=compareMatchedDriftDays(rows,labelOf,asOfMs,{
    ...opts,minCoverage:.65,
  });
  assert.equal(result.comparableStrata,1);
  assert.equal(result.normalCoverageInComparableStrata,.5);
  assert.equal(result.outOfDistributionCoverageInComparableStrata,.5);
  assert.equal(result.status,'LOW_OUTCOME_COVERAGE');
});
test('small sample and truncated scan stay explicitly unqualified',()=>{
  const rows=[
    example('NORMAL',0,.1),example('NORMAL',20,.1),
    example('OUT_OF_DISTRIBUTION',40,.8),example('OUT_OF_DISTRIBUTION',60,.8),
  ];
  const small=compareMatchedDriftDays(rows,labelOf,asOfMs);
  assert.equal(small.status,'INSUFFICIENT_INDEPENDENT_MARKET_EVIDENCE');
  const truncated=compareMatchedDriftDays(rows,labelOf,asOfMs,{
    ...opts,sourceTruncated:true,
  });
  assert.equal(truncated.status,'SOURCE_TRUNCATED');
  assert.equal(truncated.executionAuthority,'NONE');
});

test('does not treat simulated spread costs as broker-quality evidence',()=>{
  const rows=[
    example('NORMAL',0,.1),example('NORMAL',20,.1),
    example('OUT_OF_DISTRIBUTION',40,2,{
      outcome:{netR:2,costSource:'PAPER_SIMULATION_SPREAD'},
    }),
    example('OUT_OF_DISTRIBUTION',60,1,{
      outcome:{netR:1,costSource:'STATIC_DIAGNOSTIC_FALLBACK'},
    }),
  ];
  const result=compareMatchedDriftDays(rows,labelOf,asOfMs,opts);
  assert.equal(result.bothDriftStatesPresentStrata,1);
  assert.equal(result.comparableStrata,0);
  assert.equal(result.matchedStrata[0].outOfDistribution.observedQuoteLabels,2);
  assert.equal(result.matchedStrata[0].outOfDistribution.unverifiedCostLabels,2);
  assert.equal(result.matchedStrata[0].outOfDistribution.completedLabels,0);
  assert.equal(result.balancedOodMinusNormalMeanEstimatedNetR,null);
  assert.equal(result.comparableCostEvidence,'BROKER_OBSERVED_P90_ONLY');
});
