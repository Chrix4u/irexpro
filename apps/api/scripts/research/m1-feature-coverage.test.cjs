'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inventoryFeatures } = require('./m1-feature-coverage.cjs');
const row = {
  caseKey: 'synthetic-one', decision: 'REJECTED', outcome: 'WIN',
  referenceAt: '2026-01-01T10:00:00Z', decisionAt: '2026-01-01T09:59:00Z',
  outcomeAt: '2026-01-01T10:10:00Z', decisionProvenance: 'RECORDED_AS_OF',
  outcomeProvenance: 'BROKER_SETTLED', policyVersion: 'm1-tactical-v2-m5-lifecycle',
  features: { directionQuality: 0.6, confidence: 0.738, score: 0.7, scoreEdge: 0.05,
    alignedHigherTimeframeAgreement: -0.2, alignedMomentum3Atr: -0.1, alignedM5Momentum3Atr: 1 },
};
test('valid recorded values count including zero and negative directional measurements', () => {
  const report = inventoryFeatures([row, { ...row, caseKey: 'synthetic-two', outcome: 'LOSS',
    features: { ...row.features, scoreEdge: 0 } }]);
  for (const field of Object.values(report.fields)) {
    assert.equal(field.valid, 2);
    assert.equal(field.settledWin, 1);
    assert.equal(field.settledLoss, 1);
  }
  assert.equal(report.executionAuthority, 'NONE');
});
test('missing and invalid values are distinct and never imputed', () => {
  const report = inventoryFeatures([{ ...row, features: { directionQuality: null,
    confidence: 0.8, score: Infinity, scoreEdge: '0.05' } }]);
  assert.equal(report.fields.directionQuality.missing, 1);
  assert.equal(report.fields.confidence.invalid, 1);
  assert.equal(report.fields.score.invalid, 1);
  assert.equal(report.fields.scoreEdge.invalid, 1);
  assert.equal(report.fields.alignedMomentum3Atr.missing, 1);
});
test('late or unknown-policy measurements are unverified', () => {
  const report = inventoryFeatures([{ ...row, decisionAt: '2026-01-01T10:00:01Z' },
    { ...row, caseKey: 'synthetic-two', policyVersion: 'unknown' }]);
  assert.equal(report.fields.directionQuality.unverified, 2);
  assert.equal(report.fields.directionQuality.valid, 0);
});
test('valid features with hypothetical outcome remain outcome unknown', () => {
  const report = inventoryFeatures([{ ...row, outcomeProvenance: 'COUNTERFACTUAL' }]);
  assert.equal(report.fields.scoreEdge.valid, 1);
  assert.equal(report.fields.scoreEdge.outcomeUnknown, 1);
  assert.equal(report.fields.scoreEdge.settledWin, 0);
  assert.throws(() => inventoryFeatures([row, row]), /INVALID_OR_DUPLICATE_EVIDENCE/);
});
