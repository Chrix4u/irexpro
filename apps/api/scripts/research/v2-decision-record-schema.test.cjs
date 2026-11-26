'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadSchema, validateDecisionRecordFull, SCHEMA_VERSION,
} = require('./v2-decision-record-schema.cjs');

function canonicalRecord(over = {}) {
  return {
    decisionRecordSchema: 'V2_DECISION_RECORD_V1',
    decisionId: 'dec-0001',
    instrument: 'EURUSD',
    decisionAt: '2026-11-27T10:00:00Z',
    confidence: { value: 0.61, calibration: 'CALIBRATED', calibrationVersion: 'iso-frozen-2026-11-27' },
    uncertaintySlots: {
      directionalConfidence: { value: 0.61, semantics: 'calibrated P(win)' },
      predictiveUncertainty: { ensembleSpread: 0.12 },
      thresholdDistance: { marginToDecisionBoundary: 0.04 },
      outcomeProbability: { pUnfavorable: 0.42, horizon: '15m' },
      missingEvidence: null,
      mandatoryRiskRestriction: null,
    },
    evidenceProvenance: {
      recordedBeforeOutcome: true, supersedeCount: 0, reconstructed: false, asOf: '2026-11-27T10:00:00Z',
    },
    afterCostEconomics: { expectedNetR: 0.18, costModelVersion: 'costmodel-v2-a', includesCommission: true },
    executionIntent: 'EXECUTE',
    driftState: 'NORMAL',
    policyVersionSha: 'policy-v2-sha-0001',
    ...over,
  };
}

test('the schema artifact loads, declares the frozen version, and its canonical hash is stable', () => {
  const a = loadSchema();
  const b = loadSchema();
  assert.equal(a.version, SCHEMA_VERSION);
  assert.match(a.schemaSha256, /^[0-9a-f]{64}$/);
  assert.equal(a.schemaSha256, b.schemaSha256); // canonicalization removes formatting nondeterminism
  assert.equal(a.schema.required.length, 8);
});

test('a canonical record passes BOTH the JSON schema and the semantic contract with zero findings', () => {
  const r = validateDecisionRecordFull(canonicalRecord());
  assert.deepEqual(r.findings, []);
  assert.equal(r.schema, SCHEMA_VERSION);
  assert.equal(r.contract, 'V2_DECISION_RECORD_V1');
});

test('C1 structural encoding: a second confidence-named key is rejected by additionalProperties:false', () => {
  const r = validateDecisionRecordFull(canonicalRecord({ ensembleConfidence: { value: 0.7, calibration: 'UNKNOWN' } }));
  const hit = r.findings.find((f) => f.code === 'SCHEMA_ADDITIONALPROPERTIES' && /ensembleConfidence/.test(f.detail));
  assert.ok(hit, `expected ensembleConfidence rejection, got ${JSON.stringify(r.findings)}`);
});

test('C2: a missing uncertainty slot is a required-property violation naming the slot', () => {
  const { uncertaintySlots } = canonicalRecord();
  const { missingEvidence, ...slots } = uncertaintySlots;
  const r = validateDecisionRecordFull(canonicalRecord({ uncertaintySlots: slots }));
  const hit = r.findings.find((f) => f.code === 'SCHEMA_REQUIRED' && /missingEvidence/.test(f.detail));
  assert.ok(hit);
});

test('C2: an undeclared seventh slot is rejected (the six-slot taxonomy is closed)', () => {
  const r = validateDecisionRecordFull(canonicalRecord({
    uncertaintySlots: { ...canonicalRecord().uncertaintySlots, strengthScalar: { v: 1 } },
  }));
  const hit = r.findings.find((f) => f.code === 'SCHEMA_ADDITIONALPROPERTIES' && /strengthScalar/.test(f.detail));
  assert.ok(hit);
});

test('C1: an invalid calibration state fails the enum; a probability above 1 fails the bound', () => {
  const badState = validateDecisionRecordFull(canonicalRecord({ confidence: { value: 0.5, calibration: 'MAYBE', calibrationVersion: 'x' } }));
  assert.ok(badState.findings.some((f) => f.code === 'SCHEMA_ENUM'));
  const overOne = validateDecisionRecordFull(canonicalRecord({ confidence: { value: 1.4, calibration: 'CALIBRATED', calibrationVersion: 'x' } }));
  assert.ok(overOne.findings.some((f) => f.code === 'SCHEMA_MAXIMUM' && /confidence\.value/.test(f.detail)));
});

test('numbers must be finite JSON numbers: NaN is refused by the number type check', () => {
  const r = validateDecisionRecordFull(canonicalRecord({ confidence: { value: NaN, calibration: 'CALIBRATED', calibrationVersion: 'x' } }));
  assert.ok(r.findings.some((f) => f.code === 'SCHEMA_TYPE'));
});

test('C3: supersedeCount is a non-negative integer; non-integer values are refused', () => {
  const r = validateDecisionRecordFull(canonicalRecord({
    evidenceProvenance: { recordedBeforeOutcome: true, supersedeCount: 1.5, reconstructed: false, asOf: '2026-11-27T10:00:00Z' },
  }));
  assert.ok(r.findings.some((f) => f.code === 'SCHEMA_TYPE' && /supersedeCount/.test(f.detail)));
});

test('C3: recordedBeforeOutcome is const true; false fails the const check', () => {
  const r = validateDecisionRecordFull(canonicalRecord({
    evidenceProvenance: { recordedBeforeOutcome: false, supersedeCount: 0, reconstructed: false, asOf: '2026-11-27T10:00:00Z' },
  }));
  assert.ok(r.findings.some((f) => f.code === 'SCHEMA_CONST' && /recordedBeforeOutcome/.test(f.detail)));
});

test('C4: ABSTAIN records may carry afterCostEconomics:null and still pass both validators', () => {
  const r = validateDecisionRecordFull(canonicalRecord({ executionIntent: 'ABSTAIN', afterCostEconomics: null }));
  assert.deepEqual(r.findings, []);
});

test('C4: includesCommission:false violates the const constraint inside the economics object', () => {
  const r = validateDecisionRecordFull(canonicalRecord({
    afterCostEconomics: { expectedNetR: 0.2, costModelVersion: 'v', includesCommission: false },
  }));
  assert.ok(r.findings.some((f) => f.code === 'SCHEMA_CONST' && /includesCommission/.test(f.detail)));
});

test('C6: an undeclared top-level permission-looking field is refused by the closed record form', () => {
  const r = validateDecisionRecordFull(canonicalRecord({ ownerId: 'u-123' }));
  assert.ok(r.findings.some((f) => f.code === 'SCHEMA_ADDITIONALPROPERTIES' && /ownerId/.test(f.detail)));
});

test('the record must self-declare the exact schema version; mismatches are const violations', () => {
  const r = validateDecisionRecordFull(canonicalRecord({ decisionRecordSchema: 'V2_DECISION_RECORD_V0' }));
  assert.ok(r.findings.some((f) => f.code === 'SCHEMA_CONST' && /decisionRecordSchema/.test(f.detail)));
});

test('schema validation composes with the semantic contract: every finding carries a location', () => {
  const r = validateDecisionRecordFull(canonicalRecord({ policyVersionSha: '' }));
  const hits = r.findings.filter((f) => /policyVersionSha|minLength/.test(f.detail));
  assert.ok(hits.length >= 1);
  for (const f of hits) assert.ok(f.detail.includes('$.'), 'findings carry an instance path');
});
