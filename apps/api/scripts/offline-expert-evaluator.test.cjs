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
