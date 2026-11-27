'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  REVERSAL_DEFINITION_CONTRACT,
  REVERSAL_DEFINITIONS,
  DISAGREEMENT_CORPUS,
  CORPUS_CANARY_BASELINE,
  RD1_COLUMNS,
  RD1_PREREGISTERED,
  validateReversalDefinitionContract,
  verifyDefinitionPaths,
  summarizeReversalDefinitionContract,
  buildDisagreementMatrix,
  evaluateCorpusRecord,
  applyReversalDefinitionContract,
} = require('./v2-reversal-definition-contract.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const clone = (contract) => JSON.parse(JSON.stringify(contract));
const definition = (key) => clone(REVERSAL_DEFINITION_CONTRACT).definitions.find((d) => d.key === key);
const record = (id) => clone(REVERSAL_DEFINITION_CONTRACT).corpus.find((r) => r.id === id);

test('the committed contract validates and reconciles with the audit claim of six reversal definitions', () => {
  assert.equal(validateReversalDefinitionContract(REVERSAL_DEFINITION_CONTRACT), true);
  const summary = summarizeReversalDefinitionContract(REVERSAL_DEFINITION_CONTRACT);
  assert.equal(summary.artifact, 'v2-reversal-definition-contract-v1');
  assert.equal(summary.definitions.length, 6);
  assert.equal(summary.corpus.size, 12);
  assert.equal(summary.corpus.disagreementCount, 11);
  assert.equal(summary.corpus.controlCount, 1);
  assert.equal(summary.corpus.distinctPatterns, 12);
  assert.equal(summary.rd1.name, 'RD-1');
  assert.equal(summary.rd1.columns, RD1_COLUMNS.length);
});

test('every mapped definition source path exists in the repository (drift detector)', () => {
  const result = verifyDefinitionPaths(REVERSAL_DEFINITION_CONTRACT, REPO_ROOT);
  assert.equal(result.verified, result.total);
  assert.equal(result.total, 6);
});

test('R1 inventory pins the failed-breakout impulse contract with verified lines', () => {
  const r1 = definition('reversal.r1-m1-tactical-route');
  assert.deepEqual(
    r1.constants.map((x) => `${x.name}:${x.value}:${x.line}`),
    [
      'minDirectionalEdge:0.08:28', 'minReversalQuality:0.6:32', 'minReversalImpulseAtr:0.25:33',
      'momentum5Relaxation:0.5:103', 'established.bodyPressure3:0.08:114',
      'established.m5Momentum3Atr:0.08:115', 'established.m5Momentum1Atr:-0.1:116',
      'decisive.latestBodyPressure:0.6:118', 'decisive.m5Momentum1Atr:0.3:119',
      'decisive.m5Momentum3Atr:-0.1:120',
    ],
  );
  assert.ok(r1.predicate.some((p) => p.includes('l.97-106')));
  assert.ok(r1.predicate.some((p) => p.includes('l.108-122')));
});

test('R2 and R3 inventory pin the floor constellations that diverge (0.64/0.64/0.408284... and 0.18 vs 0.08)', () => {
  const r2 = definition('reversal.r2-plan-b-multimodel-shadow');
  assert.deepEqual(
    r2.constants.map((x) => `${x.name}:${x.value}:${x.line}`),
    [
      'PLAN_B_CANDIDATE_CONFIDENCE_FLOOR:0.64:50', 'PLAN_B_REVERSAL_GROSS_EXPECTED_R_FLOOR:0.18:52',
      'PLAN_B_REVERSAL_MIN_MOMENTUM_ATR:0.5:53', 'maxMomentumAtrCeiling:1.5:54',
      'extensionCeilingAtr:1.15:150', 'volatilityCeiling:0.55:151',
    ],
  );
  const r3 = definition('reversal.r3-paired-direction-reversal');
  assert.deepEqual(
    r3.constants.map((x) => `${x.name}:${x.value}:${x.line}`),
    [
      'PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY:0.64:3',
      'PAIRED_REVERSAL_MIN_ABSOLUTE_PROBABILITY:0.40828402366863903:4',
      'PAIRED_REVERSAL_MIN_ALIGNED_MOMENTUM_ATR:0.15:5',
      'PAIRED_REVERSAL_MIN_RESEARCH_NET_EXPECTED_R:0.08:6',
    ],
  );
  // The economics-floor divergence P1-2 closes: gross 0.18 (R2) vs net 0.08 (R3).
  assert.notEqual(
    r2.constants.find((c) => c.name === 'PLAN_B_REVERSAL_GROSS_EXPECTED_R_FLOOR').value,
    r3.constants.find((c) => c.name === 'PAIRED_REVERSAL_MIN_RESEARCH_NET_EXPECTED_R').value,
  );
});

test('R4/R5/R6 inventory pins the fusion, witness and canary roles', () => {
  const r4 = definition('reversal.r4-m1-reversal-timing-fusion-shadow');
  assert.equal(r4.artifact, 'm1-planb-reversal-dual-impulse-fusion-shadow-v1');
  assert.deepEqual(
    r4.constants.map((x) => `${x.name}:${x.value}:${x.line}`),
    [
      'M1_REVERSAL_TIMING_FUSION_MIN_QUALITY:0.6:6',
      'M1_REVERSAL_TIMING_FUSION_MIN_MOMENTUM:0.25:7',
      'momentum5Relaxation:0.5:93',
    ],
  );
  const r5 = definition('reversal.r5-planb-reversal-m1-continuation-shadow');
  assert.equal(r5.artifact, 'planb-reversal-m1-continuation-asof-shadow-v1');
  assert.equal(r5.constants.find((c) => c.name === 'minNetExpectedRForStudy').value, 0.1);
  const r6 = definition('reversal.r6-confirmed-reversal-cross-sleeve-canary');
  assert.deepEqual(
    r6.constants.map((x) => `${x.name}:${x.value}:${x.line}`),
    [
      'CONFIRMED_REVERSAL_CROSS_SLEEVE_CANARY_LOT_CAP:0.2:14',
      'expertFreshnessCeilingSeconds:120:63', 'expertConfidenceFloor:0.7:66',
      'expertMinTotalVotes:3:79',
    ],
  );
});

test('the frozen corpus verdict matrix matches the committed expectations record for record', () => {
  const matrix = buildDisagreementMatrix(DISAGREEMENT_CORPUS);
  for (const row of matrix.rows) {
    const expected = record(row.id).expected;
    for (const field of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) {
      assert.equal(row[field], expected[field], `${row.id}.${field}`);
    }
    for (const field of ['r1Reason', 'r2Reason', 'r3Reason', 'r4Reason', 'r5Reason', 'r6Reason']) {
      assert.equal(row[field], expected[field], `${row.id}.${field}`);
    }
  }
});

test('RV-D03 is the institutional-disagreement exemplar the audit calls out (A2/F4)', () => {
  const row = evaluateCorpusRecord(record('RV-D03'));
  assert.equal(row.r1, false); // no failed breakout -> no R1 confirmation
  assert.equal(row.r2, true); // Plan-B confirms ...
  assert.equal(row.r4, true); // ... the fusion flags the alternative candidate ...
  assert.equal(row.r5, true); // ... and the mismatch shadow records the disagreement
});

test('RV-D09 demonstrates the 0.08-vs-0.18 economics-floor divergence on one bar', () => {
  const row = evaluateCorpusRecord(record('RV-D09'));
  assert.equal(row.r2Reason, 'GROSS_EXPECTED_R_BELOW_FLOOR'); // 0.17 < 0.18
  assert.equal(row.r3, true); // net 0.119 >= 0.08 — the same bar clears R3's floor
  const r3detail = row.r3Reason;
  assert.equal(r3detail, 'PAIRED_REVERSAL_CANDIDATE');
});

test('RV-D12 is the only canary-admissible record and R5/R6 are disjoint witnesses', () => {
  const matrix = buildDisagreementMatrix(DISAGREEMENT_CORPUS);
  assert.equal(matrix.confirmations.r6, 1);
  const d12 = evaluateCorpusRecord(record('RV-D12'));
  assert.equal(d12.r6, true);
  assert.equal(d12.r5, false); // EARLY_TRANSITION label vs CONTINUATION label — disjoint by construction
  const d06 = evaluateCorpusRecord(record('RV-D06'));
  assert.equal([d06.r1, d06.r2, d06.r3, d06.r4, d06.r5, d06.r6].every((v) => v === false), true);
});

test('tampering with corpus inputs is a typed verdict-mismatch refusal', () => {
  const tampered = clone(REVERSAL_DEFINITION_CONTRACT);
  tampered.corpus[0].failedBreakoutAgainstDirection = false; // RV-D01 would stop confirming
  assert.throws(() => validateReversalDefinitionContract(tampered), /CONTRACT_VERDICT_MISMATCH/);
});

test('tampering with corpus expectations is a typed verdict-mismatch refusal', () => {
  const tampered = clone(REVERSAL_DEFINITION_CONTRACT);
  tampered.corpus[1].expected.r2 = true; // RV-D02 R2 actually rejects TREND_EXTENDED
  assert.throws(() => validateReversalDefinitionContract(tampered), /CONTRACT_VERDICT_MISMATCH/);
});

test('dropping a corpus record is a typed count-mismatch refusal', () => {
  const tampered = clone(REVERSAL_DEFINITION_CONTRACT);
  tampered.corpus.pop();
  assert.throws(() => validateReversalDefinitionContract(tampered), /CONTRACT_COUNT_MISMATCH/);
});

test('adding a seventh definition is a typed count-mismatch refusal', () => {
  const tampered = clone(REVERSAL_DEFINITION_CONTRACT);
  tampered.definitions.push(clone(tampered.definitions[0]));
  assert.throws(() => validateReversalDefinitionContract(tampered), /CONTRACT_COUNT_MISMATCH/);
});

const rd1Input = () => ({
  instrument: 'EURUSD',
  direction: 'SELL',
  decisionTime: new Date('2026-11-27T10:30:00.000Z'),
  policyVersion: 'v2-rd1-research-v1',
  m5BodyPressure3: 0.12,
  m5Momentum1Atr: 0.1,
  m5Momentum3Atr: 0.1,
  m5LatestBodyPressure: 0.2,
  momentum1Atr: 0.3,
  momentum3Atr: 0.3,
  momentum5Atr: 0.2,
  emaSlopeAtr: 0.1,
  failedBreakoutAgainstDirection: false,
  calibratedProbability: 0.72,
  regime: 'TREND_WEAK',
  netExpectedR: 0.25,
  estimatedExecutionCostR: 0.05,
  htfAgreement: 0.1,
  scoreEdge: 0.25,
});

test('RD-1 confirms without a failed breakout when all five gates pass (the R1-only discriminator retired)', () => {
  const result = applyReversalDefinitionContract(rd1Input());
  assert.equal(result.reversalState, 'CONFIRMED');
  assert.equal(result.turnType, 'ESTABLISHED');
  assert.deepEqual(result.gatesPassed, {
    completedTurn: true, impulseCorroboration: true, conviction: true,
    economics: true, regimeSupport: true,
  });
  assert.equal(result.failedBreakoutAgainstDirection, false); // recorded, never required
  assert.equal(result.executionAuthority, 'NONE');
});

test('RD-1 typed refusals are fail-closed', () => {
  assert.throws(() => applyReversalDefinitionContract({ ...rd1Input(), instrument: 'XAUUSD' }),
    /REVERSAL_UNSUPPORTED_INSTRUMENT/);
  assert.throws(() => applyReversalDefinitionContract({ ...rd1Input(), m5BodyPressure3: undefined }),
    /REVERSAL_INPUT_REQUIRED: m5BodyPressure3/);
  assert.throws(() => applyReversalDefinitionContract({ ...rd1Input(), calibratedProbability: 1.2 }),
    /REVERSAL_INPUT_OUT_OF_RANGE: calibratedProbability/);
  assert.throws(() => applyReversalDefinitionContract({ ...rd1Input(), regime: 'RISK_OFF' }),
    /REVERSAL_INPUT_OUT_OF_RANGE: regime/);
  const missingSlope = { ...rd1Input(), emaSlopeAtr: NaN };
  assert.throws(() => applyReversalDefinitionContract(missingSlope), /REVERSAL_INPUT_REQUIRED: emaSlopeAtr/);
});

test('RD-1 optional columns are recorded null with presence flags, never defaulted', () => {
  const input = rd1Input();
  delete input.m5LatestBodyPressure;
  delete input.scoreEdge;
  const result = applyReversalDefinitionContract(input);
  assert.equal(result.reversalState, 'CONFIRMED'); // established turn survives without the latest bar
  assert.equal(result.optionalPresence.m5LatestBodyPressure, false);
  assert.equal(result.optionalPresence.scoreEdge, false);
});

test('RD-1 gate attribution identifies the failing gate on a NOT_CONFIRMED record', () => {
  const result = applyReversalDefinitionContract({ ...rd1Input(), netExpectedR: 0.179 });
  assert.equal(result.reversalState, 'NOT_CONFIRMED');
  assert.equal(result.gatesPassed.economics, false); // 0.179 < the pre-registered 0.18 floor
  assert.equal(result.gatesPassed.conviction, true);
  assert.equal(RD1_PREREGISTERED.netExpectedRFloor, 0.18);
});
