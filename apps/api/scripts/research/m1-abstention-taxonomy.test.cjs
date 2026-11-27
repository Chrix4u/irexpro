'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyAbstentionSemantics: classify } = require('./m1-abstention-taxonomy.cjs');
const base = {
  provenance: 'RECORDED_AS_OF', policyVersion: 'm1-tactical-v2-m5-lifecycle',
  route: 'ABSTAIN', reason: 'DIRECTION_EDGE_TOO_SMALL', scoreEdge: 0.05,
  candidate: { directionQuality: 0.61, confidence: 0.638, score: 0.71 },
  blockers: ['M1_ROUTE_NOT_ELIGIBLE', 'UNREVIEWED_CODE'],
};
test('canonical margin and unclassified blockers remain separate', () => {
  const r = classify(base);
  assert.equal(r.status, 'CLASSIFIED');
  assert.equal(r.scalarAbstentionStrength, null);
  assert.equal(r.executionAuthority, 'NONE');
  assert.equal(r.slots.directionalConfidence.calibrated, false);
  assert.equal(r.slots.thresholdDistance.measurements[0].shortfall, 0.03);
  assert.equal(r.slots.riskRestriction, null);
  assert.deepEqual(r.unclassifiedBlockers, ['UNREVIEWED_CODE']);
  assert.equal(r.slots.outcomeProbability, null);
});
test('reads persisted route decision without candidate-local edge', () => {
  const { scoreEdge, ...record } = base;
  const r = classify({ ...record, governance: { routeDecision: {
    route: record.route, reason: record.reason, policyVersion: record.policyVersion, scoreEdge,
  } } });
  assert.equal(r.slots.thresholdDistance.measurements[0].shortfall, 0.03);
});
test('conflicting or inconsistent edges fail closed', () => {
  assert.equal(classify({ ...base, candidate: { ...base.candidate, scoreEdge: 0.01 } }).status, 'UNVERIFIED_DECISION');
  assert.equal(classify({ ...base, scoreEdge: 0.09 }).status, 'UNVERIFIED_DECISION');
  assert.equal(classify({ ...base, governance: { routeDecision: { route: 'M1_EARLY_TRANSITION' } } }).status, 'UNVERIFIED_DECISION');
});
test('does not use legacy candidate edge as evidence', () => {
  const { scoreEdge, ...record } = base;
  const r = classify({ ...record, candidate: { ...base.candidate, scoreEdge } });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.slots.missingEvidence.includes('scoreEdge'));
  assert.equal(r.slots.thresholdDistance.status, 'MISSING_MEASUREMENT');
});
test('higher timeframe inclusive boundary is measured by shared helper', () => {
  const r = classify({ ...base, reason: 'HIGHER_TIMEFRAME_CONFLICT',
    candidate: { ...base.candidate, alignedHigherTimeframeAgreement: -0.12 } });
  assert.equal(r.slots.thresholdDistance.measurements[0].shortfall, 0);
});
test('M5 alternatives are retained without an aggregate scalar', () => {
  const r = classify({ ...base, reason: 'M5_REVERSAL_NOT_CONFIRMED',
    candidate: { ...base.candidate, alignedM5BodyPressure3: 0.07,
      alignedM5Momentum3Atr: 0.1, alignedM5Momentum1Atr: 0.1,
      alignedM5LatestBodyPressure: 0.59 } });
  assert.equal(r.slots.thresholdDistance.status, 'MEASURED');
  assert.equal(r.slots.thresholdDistance.alternatives.establishedTurn[0].shortfall, 0.01);
  assert.equal(r.scalarAbstentionStrength, null);
});
test('invalid confidence and malformed blockers differ from an empty vector', () => {
  const r = classify({ ...base, candidate: { ...base.candidate, confidence: 1 }, blockers: [null] });
  assert.equal(r.slots.directionalConfidence, null);
  assert.ok(r.slots.missingEvidence.includes('blockerVector'));
  assert.equal(classify({ ...base, blockers: [] }).status, 'CLASSIFIED');
  assert.deepEqual(classify({ ...base, blockers: [] }).unclassifiedBlockers, []);
});
test('invalid provenance, unknown policy, invalid snapshot and non-abstention remain unverified', () => {
  for (const r of [null, { ...base, provenance: 'RETROSPECTIVE' },
    { ...base, policyVersion: 'unknown' }, { ...base, reason: 'INVALID_COUNTERFACTUAL_PAIR' },
    { ...base, route: 'M1_EARLY_TRANSITION' }]) {
    assert.equal(classify(r).status, 'UNVERIFIED_DECISION');
  }
});
