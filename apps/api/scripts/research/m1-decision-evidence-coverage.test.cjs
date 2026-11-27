'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeEvidence } = require('./m1-decision-evidence-coverage.cjs');

const base = {
  caseKey: 'synthetic-1',
  decision: 'REJECTED',
  outcome: 'WIN',
  referenceAt: '2026-01-01T10:00:00Z',
  decisionAt: '2026-01-01T09:59:00Z',
  outcomeAt: '2026-01-01T10:10:00Z',
  decisionProvenance: 'RECORDED_AS_OF',
  outcomeProvenance: 'BROKER_SETTLED',
  blockerAttribution: 'M1_ONLY',
};
test('keeps four observed cohorts and other blockers distinct', () => {
  const report = summarizeEvidence([
    base,
    { ...base, caseKey: 'synthetic-2', outcome: 'LOSS', blockerAttribution: 'M1_AND_OTHER' },
    { ...base, caseKey: 'synthetic-3', decision: 'APPROVED' },
    { ...base, caseKey: 'synthetic-4', decision: 'APPROVED', outcome: 'LOSS' },
  ]);
  assert.equal(report.counts.REJECTED.WIN, 1);
  assert.equal(report.counts.REJECTED.LOSS, 1);
  assert.equal(report.counts.APPROVED.WIN, 1);
  assert.equal(report.counts.APPROVED.LOSS, 1);
  assert.deepEqual(report.rejectedAttribution, { timingOnly: 1, additionalBlockers: 1, unattributedRejections: 0 });
  assert.equal(report.executionAuthority, 'NONE');
});
test('late, missing and retrospective decision evidence is unknown', () => {
  const report = summarizeEvidence([
    { ...base, decisionAt: '2026-01-01T10:00:01Z' },
    { ...base, caseKey: 'synthetic-2', decisionProvenance: 'RETROSPECTIVE' },
    { ...base, caseKey: 'synthetic-3', decisionAt: null },
    { ...base, caseKey: 'synthetic-4', decisionAt: '2026-02-30T09:59:00Z' },
  ]);
  assert.equal(report.incompleteDecisionEvidence, 4);
  assert.equal(report.counts.UNKNOWN.WIN, 4);
  assert.equal(report.counts.REJECTED.WIN, 0);
});
test('unfilled and counterfactual cases never become broker outcomes', () => {
  const report = summarizeEvidence([
    { ...base, outcome: 'UNOBSERVED', outcomeAt: null },
    { ...base, caseKey: 'synthetic-2', outcomeProvenance: 'COUNTERFACTUAL' },
    { ...base, caseKey: 'synthetic-3', outcomeAt: base.referenceAt },
  ]);
  assert.equal(report.counts.REJECTED.UNOBSERVED, 3);
  assert.equal(report.incompleteOutcomeEvidence, 3);
  assert.equal(report.counts.REJECTED.WIN, 0);
});
test('rejects duplicate and malformed evidence; empty evidence cannot prove qualification', () => {
  assert.throws(() => summarizeEvidence([base, base]), /INVALID_OR_DUPLICATE_EVIDENCE/);
  assert.throws(() => summarizeEvidence([{ ...base, outcome: 'PROFITABLE_MAYBE' }]), /INVALID_OR_DUPLICATE_EVIDENCE/);
  assert.equal(summarizeEvidence([]).qualificationEvidence, false);
});
