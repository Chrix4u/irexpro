'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyAbstentionSemantics } = require('./m1-abstention-taxonomy.cjs');

const base = {
  provenance: 'RECORDED_AS_OF',
  policyVersion: 'm1-tactical-v2-m5-lifecycle',
  route: 'ABSTAIN',
  reason: 'DIRECTION_EDGE_TOO_SMALL',
  candidate: {
    directionQuality: 0.61,
    confidence: 0.638,
    score: 0.71,
    scoreEdge: 0.05,
    alignedHigherTimeframeAgreement: 0.2,
  },
  blockers: ['M1_ROUTE_NOT_ELIGIBLE', 'M1_PORTFOLIO_NET_LOSS_BRAKE'],
};

test('six semantic slots are filled separately and never collapse to a scalar', () => {
  const r = classifyAbstentionSemantics(base);
  assert.equal(r.status, 'CLASSIFIED');
  assert.equal(r.scalarAbstentionStrength, null);
  assert.equal(r.scalarScoreFeasible, false);
  assert.equal(r.slots.directionalConfidence.value, 0.638);
  assert.equal(r.slots.directionalConfidence.calibrated, false);
  assert.equal(r.slots.predictiveUncertainty, null);
  assert.equal(r.slots.outcomeProbability, null);
  assert.deepEqual(r.slots.missingEvidence, []);
  // one model-opinion blocker, one policy veto, reported separately
  assert.equal(r.slots.riskRestriction.length, 1);
  assert.equal(r.slots.riskRestriction[0].blocker, 'M1_PORTFOLIO_NET_LOSS_BRAKE');
});

test('threshold distance is exact for single-predicate reasons in original units', () => {
  const edge = classifyAbstentionSemantics(base);
  assert.equal(edge.slots.thresholdDistance.defined, true);
  assert.equal(edge.slots.thresholdDistance.boundary, 0.08);
  assert.equal(edge.slots.thresholdDistance.shortfall, 0.03);
  const htf = classifyAbstentionSemantics({
    ...base,
    reason: 'HIGHER_TIMEFRAME_CONFLICT',
    candidate: { ...base.candidate, alignedHigherTimeframeAgreement: -0.3 },
  });
  assert.equal(htf.slots.thresholdDistance.boundary, -0.12);
  assert.equal(htf.slots.thresholdDistance.shortfall, 0.18);
  // inclusive boundary: equality triggers the veto with zero shortfall
  const equal = classifyAbstentionSemantics({
    ...base,
    reason: 'HIGHER_TIMEFRAME_CONFLICT',
    candidate: { ...base.candidate, alignedHigherTimeframeAgreement: -0.12 },
  });
  assert.equal(equal.slots.thresholdDistance.shortfall, 0);
});

test('compound reasons expose no unique threshold and stay undefined', () => {
  for (const reason of [
    'M5_CONTINUATION_EXHAUSTED',
    'NO_VALID_ROUTE',
    'M5_REVERSAL_NOT_CONFIRMED',
  ]) {
    const r = classifyAbstentionSemantics({ ...base, reason });
    assert.equal(r.slots.thresholdDistance.defined, false);
    assert.equal(r.scalarAbstentionStrength, null);
  }
});

test('missing evidence is detected per-field and never imputed', () => {
  const partial = classifyAbstentionSemantics({
    ...base,
    candidate: { confidence: 0.6 },
    blockers: [],
  });
  assert.equal(partial.status, 'PARTIAL_EVIDENCE');
  assert.equal(partial.slots.directionalConfidence.value, 0.6);
  assert.ok(partial.slots.missingEvidence.includes('directionQuality'));
  assert.ok(partial.slots.missingEvidence.includes('score'));
  assert.ok(partial.slots.missingEvidence.includes('scoreEdge'));
  assert.ok(partial.slots.missingEvidence.includes('blockerVector'));
  assert.ok(partial.slots.missingEvidence.includes('reason') === false);
  assert.equal(partial.slots.directionalConfidence.calibrated, false);
});

test('unverified provenance, unknown policy and non-abstentions are rejected', () => {
  assert.equal(
    classifyAbstentionSemantics({ ...base, provenance: 'RETROSPECTIVE' }).status,
    'UNVERIFIED_DECISION',
  );
  assert.equal(
    classifyAbstentionSemantics({ ...base, policyVersion: 'm3-unknown' }).status,
    'UNVERIFIED_DECISION',
  );
  assert.equal(
    classifyAbstentionSemantics({ ...base, route: 'M1_CONFIRMED_REVERSAL' }).status,
    'UNVERIFIED_DECISION',
  );
  assert.equal(classifyAbstentionSemantics(null).status, 'UNVERIFIED_DECISION');
  for (const bad of ['RETROSPECTIVE', 'm3-unknown', 'M1_CONFIRMED_REVERSAL', null]) {
    const r = classifyAbstentionSemantics(
      bad === null ? null : { ...base, ...(typeof bad === 'object' ? {} : { provenance: bad }) },
    );
    assert.notEqual(r.status, 'CLASSIFIED');
  }
});

test('the taxonomy never assumes a 60 percent or any other numeric threshold', () => {
  const r = classifyAbstentionSemantics(base);
  const serialized = JSON.stringify(r);
  assert.ok(!/threshold.*(60|0\.6)/i.test(serialized));
  assert.equal(r.scalarScoreFeasible, false);
  assert.ok(r.rationale.includes('no 0-100 number is defined'));
});
