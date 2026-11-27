'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { measureAbstention } = require('./m1-abstention-margin.cjs');
const record = {
  provenance: 'RECORDED_AS_OF',
  policyVersion: 'm1-tactical-v2-m5-lifecycle',
  route: 'ABSTAIN',
  reason: 'DIRECTION_EDGE_TOO_SMALL',
};
test('records exact directional shortfall and never invents a calibrated probability', () => {
  const close = measureAbstention({ ...record, scoreEdge: 0.079 });
  const distant = measureAbstention({ ...record, scoreEdge: 0.01 });
  assert.equal(close.measurements[0].shortfall, 0.001);
  assert.equal(distant.measurements[0].shortfall, 0.07);
  assert.equal(close.abstentionStrength, null);
  assert.equal(distant.calibratedProbability, null);
  assert.equal(close.executionAuthority, 'NONE');
});
test('rejects inconsistent and missing directional evidence', () => {
  assert.equal(measureAbstention({ ...record, scoreEdge: 0.08 }).status, 'INCONSISTENT_EVIDENCE');
  assert.equal(measureAbstention({ ...record, scoreEdge: NaN }).status, 'MISSING_MEASUREMENT');
  assert.equal(measureAbstention({ ...record, scoreEdge: '0.01' }).status, 'MISSING_MEASUREMENT');
});
test('higher timeframe conflict retains its own alignment units and exact boundary', () => {
  const conflict = { ...record, reason: 'HIGHER_TIMEFRAME_CONFLICT' };
  assert.equal(measureAbstention({ ...conflict, candidate: { alignedHigherTimeframeAgreement: -0.12 } }).measurements[0].shortfall, 0);
  assert.equal(measureAbstention({ ...conflict, candidate: { alignedHigherTimeframeAgreement: -0.5 } }).measurements[0].shortfall, 0.38);
  assert.equal(measureAbstention({ ...conflict, candidate: { alignedHigherTimeframeAgreement: 0.1 } }).status, 'INCONSISTENT_EVIDENCE');
});
test('M5 reversal records both alternative paths in their original units', () => {
  const r = { ...record, reason: 'M5_REVERSAL_NOT_CONFIRMED',
    candidate: { alignedM5BodyPressure3: 0.07, alignedM5Momentum3Atr: 0.1,
      alignedM5Momentum1Atr: 0.1, alignedM5LatestBodyPressure: 0.59 } };
  const result = measureAbstention(r);
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.alternatives.establishedTurn[0].shortfall, 0.01);
  assert.equal(result.alternatives.decisiveFreshTurn[0].shortfall, 0.01);
  assert.equal(result.alternatives.decisiveFreshTurn[1].shortfall, 0.2);
  assert.equal(measureAbstention({ ...r, candidate: { ...r.candidate, alignedM5BodyPressure3: 0.08 } }).status, 'INCONSISTENT_EVIDENCE');
});
test('missing data, invalid pairs and unsupported compound reasons remain unscored', () => {
  for (const reason of ['INVALID_COUNTERFACTUAL_PAIR', 'NO_VALID_ROUTE', 'M5_CONTINUATION_EXHAUSTED']) {
    const result = measureAbstention({ ...record, reason });
    assert.equal(result.abstentionStrength, null);
    assert.notEqual(result.status, 'MEASURED');
  }
  assert.equal(measureAbstention({ ...record, provenance: 'RETROSPECTIVE', scoreEdge: 0.01 }).status, 'UNVERIFIED_DECISION');
  assert.equal(measureAbstention({ ...record, policyVersion: 'unknown', scoreEdge: 0.01 }).status, 'UNVERIFIED_DECISION');
});
