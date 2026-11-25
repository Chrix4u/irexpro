'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateExpertEvidence } = require('./offline-expert-evaluator.cjs');

const names = ["event_barrier_two_stage","event_barrier_pair_experts","event_barrier_pair_regime_experts"];
const row = (id,outcome,votes)=>({sampleId:id,predictionAt:'2026-01-01T00:00:00Z',labelAt:'2026-01-01T00:05:00Z',outcome,evidence:{schemaVersion:1,artifact:'plan-b-v4-oof-three-expert-consensus-challenger',modifiesExecution:false,experts:names.map((name,i)=>({name,predictedLong:votes[i],directionProbabilityLong:votes[i]?.8:.2,directionConfidence:.8,opportunityProbability:.5}))}});
const input = observations => ({ horizonSeconds: 300, observations });

test('describes resolved predictions and leaves unresolved outcomes unscored', () => {
  const result = evaluateExpertEvidence(input([
    row('1','UP',[true,true,false]), row('2','DOWN',[false,true,false]),
    row('3',null,[true,false,true]),
  ]));
  assert.equal(result.resolved,2);
  assert.equal(result.unresolved,1);
  assert.equal(result.experts[0].accuracy,1);
  assert.equal(result.experts[1].balancedAccuracy,0.5);
  assert.ok(Math.abs(result.experts[0].brierScore - 0.04) < 1e-10);
  assert.equal(result.pairwise[0].agreementRate,0.5);
  assert.equal(result.pairwise[0].errorCorrelation,null);
  assert.equal(result.modifiesExecution,false);
});
test('rejects duplicate observations and inconsistent label horizons', () => {
  const a = row('1','UP',[true,true,false]);
  assert.throws(() => evaluateExpertEvidence(input([a,a])),/duplicate/);
  assert.throws(() => evaluateExpertEvidence(input([{...a,labelAt:a.predictionAt}])),/fixed-horizon/);
});
test('rejects malformed or duplicated expert observations', () => {
  const a = row('1','UP',[true,true,false]);
  a.evidence.experts[0].directionProbabilityLong = NaN;
  assert.throws(() => evaluateExpertEvidence(input([a])),/Invalid individual/);
  const b = row('2','DOWN',[true,true,false]);
  b.evidence.experts[1].name=b.evidence.experts[0].name;
  assert.throws(() => evaluateExpertEvidence(input([b])),/Invalid individual/);
});
test('does not manufacture accuracy or correlations for an empty dataset', () => {
  const result = evaluateExpertEvidence(input([]));
  assert.equal(result.experts[0].accuracy,null);
  assert.equal(result.experts[0].balancedAccuracy,null);
  assert.equal(result.pairwise[0].errorCorrelation,null);
});

test('distinguishes identical errors from complementary errors', () => {
  const observations = [
    row('1','UP',[true,true,false]),
    row('2','DOWN',[true,true,false]),
    row('3','UP',[false,false,true]),
    row('4','DOWN',[false,false,true]),
  ];
  const result = evaluateExpertEvidence(input(observations));
  assert.equal(result.pairwise[0].agreementRate,1);
  assert.equal(result.pairwise[0].bothWrong,2);
  assert.equal(result.pairwise[0].errorCorrelation,1);
  assert.equal(result.pairwise[1].agreementRate,0);
  assert.equal(result.pairwise[1].bothWrong,0);
  assert.equal(result.pairwise[1].errorCorrelation,-1);
});
test('keeps balanced accuracy undefined when one outcome class is absent', () => {
  const result = evaluateExpertEvidence(input([row('1','UP',[true,true,false])]));
  assert.equal(result.experts[0].accuracy,1);
  assert.equal(result.experts[0].balancedAccuracy,null);
  assert.equal(result.experts[0].calibration.reduce((n,bin)=>n+bin.count,0),1);
});
test('calibration covers probability boundaries and never scores unresolved labels', () => {
  const a = row('1','UP',[true,true,false]);
  a.evidence.experts[0].directionProbabilityLong = 1;
  const b = row('2','DOWN',[false,false,true]);
  b.evidence.experts[0].directionProbabilityLong = 0;
  const c = row('3',null,[true,true,true]);
  const result = evaluateExpertEvidence(input([a,b,c]));
  const score = result.experts[0];
  assert.equal(score.brierScore,0);
  assert.equal(score.calibration[0].count,1);
  assert.equal(score.calibration[0].observedUpRate,0);
  assert.equal(score.calibration[4].count,1);
  assert.equal(score.calibration[4].observedUpRate,1);
  assert.equal(result.unresolved,1);
});
