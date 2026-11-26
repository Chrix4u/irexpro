'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDecisionRecord, SLOT_NAMES } = require('./v2-decision-record-contract.cjs');

function validRecord(over) {
  return {
    confidence: { value: 0.61, calibration: 'CALIBRATED', calibrationVersion: 'iso-2026-11' },
    scalarAbstentionStrength: null,
    uncertaintySlots: {
      directionalConfidence: { value: 0.61, semantics: 'calibrated P(win)' },
      predictiveUncertainty: { ensembleSpread: 0.12 },
      thresholdDistance: { marginToDecisionBoundary: 0.04 },
      outcomeProbability: { pUnfavorable: 0.42, horizon: '15m' },
      missingEvidence: null,
      mandatoryRiskRestriction: null,
    },
    evidenceProvenance: { recordedBeforeOutcome: true, supersedeCount: 0, reconstructed: false, asOf: '2026-11-27T10:00:00Z' },
    afterCostEconomics: { expectedNetR: 0.18, costModelVersion: 'costmodel-v2-a', includesCommission: true },
    executionIntent: 'EXECUTE',
    driftState: 'NORMAL',
    policyVersionSha: 'policy-v2-sha-1',
    ...over,
  };
}

test('a contract-conforming decision record passes with zero findings', () => {
  const r = validateDecisionRecord(validRecord());
  assert.deepEqual(r.findings, []);
  assert.equal(r.contract, 'V2_DECISION_RECORD_V1');
});

test('C1: multiple confidence fields are rejected (V1 had five)', () => {
  const r = validateDecisionRecord(validRecord({ ensembleConfidence: { value: 0.7, calibration: 'UNKNOWN' } }));
  assert.ok(r.findings.some((f) => f.code === 'C1_CONFIDENCE_CARDINALITY'));
});

test('C1: uncalibrated confidence can never drive an executable decision', () => {
  const uncal = validateDecisionRecord(validRecord({ confidence: { value: 0.7, calibration: 'UNCALIBRATED' } }));
  assert.ok(uncal.findings.some((f) => f.code === 'C1_UNCALIBRATED_CONFIDENCE_CANNOT_SIZE'));
  const unknown = validateDecisionRecord(validRecord({ confidence: { value: 0.7, calibration: 'UNKNOWN' } }));
  assert.ok(unknown.findings.some((f) => f.code === 'C1_UNCALIBRATED_CONFIDENCE_CANNOT_SIZE'));
  // but uncalibrated confidence is fine as provenance on a non-executable decision
  const abstain = validateDecisionRecord(validRecord({
    confidence: { value: 0.7, calibration: 'UNCALIBRATED' }, executionIntent: 'ABSTAIN',
  }));
  assert.ok(!abstain.findings.some((f) => f.code === 'C1_UNCALIBRATED_CONFIDENCE_CANNOT_SIZE'));
});

test('C2: the 0-100 scalar abstention strength is rejected; slots must stay separate', () => {
  const r = validateDecisionRecord(validRecord({ scalarAbstentionStrength: 72 }));
  assert.ok(r.findings.some((f) => f.code === 'C2_SCALAR_COLLAPSE_REJECTED'));
  const { outcomeProbability, ...slotsWithoutOutcome } = validRecord().uncertaintySlots;
  const missingSlot = validateDecisionRecord(validRecord({ uncertaintySlots: slotsWithoutOutcome }));
  assert.ok(missingSlot.findings.some((f) => f.code === 'C2_SLOT_INCOMPLETE'));
  const scalarSlot = validateDecisionRecord(validRecord({ uncertaintySlots: { ...validRecord().uncertaintySlots, predictiveUncertainty: 0.5 } }));
  assert.ok(scalarSlot.findings.some((f) => f.code === 'C2_SLOT_IS_SCALAR'));
  // null slots are legal: "unknown" is an explicit, recorded state
  const nullSlot = validateDecisionRecord(validRecord());
  assert.ok(!nullSlot.findings.some((f) => f.code === 'C2_SLOT_IS_SCALAR'));
  assert.equal(SLOT_NAMES.length, 6);
});

test('C3: supersede counting is mandatory (V1 first-write-wins defect) and reconstruction is flagged', () => {
  const noCount = validateDecisionRecord(validRecord({ evidenceProvenance: { recordedBeforeOutcome: true, reconstructed: false } }));
  assert.ok(noCount.findings.some((f) => f.code === 'C3_SUPERSEDE_COUNT_REQUIRED'));
  const late = validateDecisionRecord(validRecord({ evidenceProvenance: { recordedBeforeOutcome: false, supersedeCount: 0, reconstructed: false } }));
  assert.ok(late.findings.some((f) => f.code === 'C3_NOT_AS_OF'));
  const retro = validateDecisionRecord(validRecord({ evidenceProvenance: { recordedBeforeOutcome: true, supersedeCount: 2, reconstructed: true } }));
  assert.ok(retro.findings.some((f) => f.code === 'C3_RETROSPECTIVE_RECONSTRUCTION'));
});

test('C4: executable decisions require commission-inclusive after-cost economics', () => {
  const absent = validateDecisionRecord(validRecord({ afterCostEconomics: undefined }));
  assert.ok(absent.findings.some((f) => f.code === 'C4_AFTER_COST_ECONOMICS_REQUIRED'));
  const spreadOnly = validateDecisionRecord(validRecord({ afterCostEconomics: { expectedNetR: 0.2, costModelVersion: 'v', includesCommission: false } }));
  assert.ok(spreadOnly.findings.some((f) => f.code === 'C4_COMMISSION_MUST_BE_INCLUDED'));
  const noVersion = validateDecisionRecord(validRecord({ afterCostEconomics: { expectedNetR: 0.2, includesCommission: true } }));
  assert.ok(noVersion.findings.some((f) => f.code === 'C4_COST_MODEL_VERSION_REQUIRED'));
  // ABSTAIN decisions do not need economics
  const abstain = validateDecisionRecord(validRecord({ afterCostEconomics: undefined, executionIntent: 'ABSTAIN' }));
  assert.ok(!abstain.findings.some((f) => f.code === 'C4_AFTER_COST_ECONOMICS_REQUIRED'));
});

test('C5: drift state is explicit; OOD execution is flagged, never silently relabelled', () => {
  const missing = validateDecisionRecord(validRecord({ driftState: undefined }));
  assert.ok(missing.findings.some((f) => f.code === 'C5_DRIFT_STATE_REQUIRED'));
  const ood = validateDecisionRecord(validRecord({ driftState: 'OUT_OF_DISTRIBUTION' }));
  assert.ok(ood.findings.some((f) => f.code === 'C5_OOD_EXECUTION_FLAGGED'));
  const stressed = validateDecisionRecord(validRecord({ driftState: 'STRESSED' }));
  assert.ok(!stressed.findings.some((f) => f.code === 'C5_OOD_EXECUTION_FLAGGED'));
});

test('C6: inline owner/account/lot carve-outs are rejected in the record', () => {
  const r = validateDecisionRecord(validRecord({ ownerId: 'u-123', lotCeiling: 7 }));
  assert.ok(r.findings.some((f) => f.code === 'C6_INLINE_PERMISSION_DETECTED' && /ownerId/.test(f.detail)));
  assert.ok(r.findings.some((f) => f.code === 'C6_INLINE_PERMISSION_DETECTED' && /lotCeiling/.test(f.detail)));
  const noPolicy = validateDecisionRecord(validRecord({ policyVersionSha: '' }));
  assert.ok(noPolicy.findings.some((f) => f.code === 'C6_POLICY_VERSION_REQUIRED'));
});
