'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  DIRECTION_SCORER_CONTRACT,
  SUPPORTED_INSTRUMENTS,
  MISSING_VALUE_RULES,
  DS1_COLUMNS,
  validateDirectionScorerContract,
  verifyScorerPaths,
  summarizeDirectionScorerContract,
  applyDirectionScorerContract,
} = require('./v2-direction-scorer-contract.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const clone = (contract) => JSON.parse(JSON.stringify(contract));
const scorer = (key) => clone(DIRECTION_SCORER_CONTRACT).scorers.find((s) => s.key === key);

const validInput = () => ({
  instrument: 'EURUSD',
  direction: 'BUY',
  decisionTime: new Date('2026-11-27T10:30:00.000Z'),
  policyVersion: 'v2-ds1-research-v1',
  emaSeparationAtr: 0.32,
  emaSlopeAtr: 0.05,
  momentum1Atr: 0.18,
  momentum3Atr: 0.42,
  momentum5Atr: 0.31,
  m5Momentum1Atr: 0.22,
  m5Momentum3Atr: 0.28,
  m5BodyPressure3: 0.45,
  higherTimeframeAgreement: 0.6,
  'alignment.m5': 0.7,
  'alignment.m15': 0.55,
  'alignment.h1': 0.4,
  'alignment.h4': 0.2,
  closeLocation: 0.62,
  lowerWickRatio: 0.2,
  upperWickRatio: 0.1,
  breakoutAtr: 0.35,
  rsi14: 57.5,
  extensionAtr: 0.8,
  volatilityScore: 0.35,
  atr14: 0.0009,
  price: 1.0852,
  efficiency5: 0.5,
  estimatedExecutionCostR: 0.12,
});

test('the committed contract validates and reconciles with the audit claim of four scorers', () => {
  assert.equal(validateDirectionScorerContract(DIRECTION_SCORER_CONTRACT), true);
  const summary = summarizeDirectionScorerContract(DIRECTION_SCORER_CONTRACT);
  assert.equal(summary.artifact, 'v2-direction-scorer-contract-v1');
  assert.equal(summary.scorers.length, 4);
  assert.equal(summary.missingValueDivergenceCount, 4);
  assert.equal(summary.ds1.name, 'DS-1');
  assert.equal(summary.ds1.columns, DS1_COLUMNS.length);
  assert.equal(summary.ds1.prohibitedInputs.includes('confidence'), true);
  const rules = new Set(summary.scorers.map((s) => s.missingValueRule));
  assert.equal(rules.size, 4, 'four DISTINCT missing-value rules are the P1-1 evidence');
});

test('every mapped scorer source path exists in the repository (drift detector)', () => {
  const result = verifyScorerPaths(DIRECTION_SCORER_CONTRACT, REPO_ROOT);
  assert.equal(result.verified, result.total);
  assert.equal(result.total, 4);
});

test('S1 composite weights pin the nine-term sum of 1.00 with verified lines', () => {
  const s1 = scorer('scorer.s1-m1-tactical');
  const composite = s1.weightGroups.find((g) => g.name === 'directionalComposite');
  assert.deepEqual(
    composite.weights.map((x) => `${x.name}:${x.value}:${x.line}`),
    [
      'emaSeparationAtr:0.19:146', 'emaSlopeAtr:0.1:147', 'momentum3Atr:0.16:148',
      'momentum5Atr:0.1:149', 'higherTimeframeAgreement:0.2:150', 'closePressure:0.08:151',
      'wickPressure:0.05:152', 'rsiBias:0.04:153', 'breakoutAtr:0.08:154',
    ],
  );
  const total = composite.weights.reduce((acc, x) => acc + x.value, 0);
  assert.equal(total, 1);
  const maxConfidence = s1.thresholds.find((t) => t.name === 'maxConfidence');
  assert.deepEqual(maxConfidence, { name: 'maxConfidence', value: 0.738, line: 27 });
});

test('S2 trend-path weights and ensemble weights pin with verified lines', () => {
  const s2 = scorer('scorer.s2-plan-b-multimodel-shadow');
  const trend = s2.weightGroups.find((g) => g.name === 'directionQuality.trend');
  assert.deepEqual(
    trend.weights.map((x) => `${x.name}:${x.value}`),
    ['confidence:0.42', 'emaSeparation:0.25', 'mtfStrength:0.23', 'rsiDirectional:0.1'],
  );
  assert.ok(Math.abs(trend.weights.reduce((a, x) => a + x.value, 0) - 1) < 1e-9);
  const ensemble = s2.weightGroups.find((g) => g.name === 'ensembleScore');
  assert.ok(Math.abs(ensemble.weights.reduce((a, x) => a + x.value, 0) - 1) < 1e-9);
  const floor = s2.thresholds.find((t) => t.name === 'PLAN_B_CANDIDATE_CONFIDENCE_FLOOR');
  assert.deepEqual(floor, { name: 'PLAN_B_CANDIDATE_CONFIDENCE_FLOOR', value: 0.64, line: 50 });
});

test('S3 pins the 29 BASE_WEIGHTS entries and the 0.46 admission threshold', () => {
  const s3 = scorer('scorer.s3-v8-shadow-meta');
  const base = s3.weightGroups.find((g) => g.name === 'BASE_WEIGHTS');
  assert.equal(base.weights.length, 29);
  assert.equal(base.entryCount, 29);
  assert.equal(base.sum, null, 'fitted logistic: weights are not normalized');
  const bias = base.weights[0];
  assert.deepEqual(bias, { name: 'bias', value: -0.11578161968250648, line: 52 });
  const volatility = base.weights[base.weights.length - 1];
  assert.deepEqual(volatility, { name: 'volatility', value: 0.029796295461264378, line: 80 });
  const threshold = s3.thresholds.find((t) => t.name === 'V8_SHADOW_ADMISSION_THRESHOLD');
  assert.deepEqual(threshold, { name: 'V8_SHADOW_ADMISSION_THRESHOLD', value: 0.46, line: 3 });
});

test('S4 pins the ten opportunity weights summing to 1.00 with directionQuality at 0.11', () => {
  const s4 = scorer('scorer.s4-adaptive-opportunity');
  const group = s4.weightGroups[0];
  assert.equal(group.name, 'ADAPTIVE_OPPORTUNITY_WEIGHTS');
  assert.equal(group.weights.length, 10);
  assert.equal(group.weights.reduce((a, x) => a + x.value, 0), 1);
  const dq = group.weights.find((x) => x.name === 'directionQuality');
  assert.deepEqual(dq, { name: 'directionQuality', value: 0.11, line: 10 });
});

test('the four missing-value rules recorded are exactly the observed divergence set', () => {
  const recorded = DIRECTION_SCORER_CONTRACT.scorers.map((s) => s.missingValueRule);
  assert.deepEqual([...recorded].sort(), [...MISSING_VALUE_RULES].sort());
});

test('the contract is deep-frozen: mutation attempts throw', () => {
  assert.throws(() => { DIRECTION_SCORER_CONTRACT.scorers[0].key = 'tampered'; }, TypeError);
  assert.throws(() => {
    DIRECTION_SCORER_CONTRACT.unifiedContract.prohibitedInputs.push('price');
  }, TypeError);
});

test('duplicate scorer keys are a typed refusal', () => {
  const contract = clone(DIRECTION_SCORER_CONTRACT);
  contract.scorers[1].key = contract.scorers[0].key;
  assert.throws(() => validateDirectionScorerContract(contract), /CONTRACT_DUPLICATE_KEY/);
});

test('a tampered weight breaks the declared sum and is refused', () => {
  const contract = clone(DIRECTION_SCORER_CONTRACT);
  const s1 = contract.scorers.find((s) => s.key === 'scorer.s1-m1-tactical');
  const composite = s1.weightGroups.find((g) => g.name === 'directionalComposite');
  composite.weights[0].value = 0.29; // sum becomes 1.10
  assert.throws(() => validateDirectionScorerContract(contract), /CONTRACT_WEIGHT_SUM_MISMATCH/);
});

test('a tampered entryCount is a typed refusal', () => {
  const contract = clone(DIRECTION_SCORER_CONTRACT);
  const s3 = contract.scorers.find((s) => s.key === 'scorer.s3-v8-shadow-meta');
  s3.weightGroups[0].entryCount = 30;
  assert.throws(() => validateDirectionScorerContract(contract), /CONTRACT_COUNT_MISMATCH/);
});

test('collapsing the missing-value divergence is a typed refusal', () => {
  const contract = clone(DIRECTION_SCORER_CONTRACT);
  contract.scorers[3].missingValueRule = contract.scorers[0].missingValueRule;
  assert.throws(() => validateDirectionScorerContract(contract), /CONTRACT_COUNT_MISMATCH/);
});

test('removing confidence from the prohibited inputs is a typed refusal', () => {
  const contract = clone(DIRECTION_SCORER_CONTRACT);
  contract.unifiedContract.prohibitedInputs = [];
  assert.throws(() => validateDirectionScorerContract(contract), /prohibitedInputs/);
});

test('DS-1 accepts a complete record and records absent optionals as null, never zero', () => {
  const result = applyDirectionScorerContract(validInput());
  assert.equal(result.accepted, true);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.instrument, 'EURUSD');
  assert.equal(result.normalized.m5LatestBodyPressure, null);
  assert.equal(result.optionalPresence.m5LatestBodyPressure, false);
  assert.equal(result.optionalPresence.m5BodyExpansionRatio, false);
  assert.equal(result.inputsUsed.includes('m5LatestBodyPressure'), false);
  assert.equal(result.normalized.rsi14, 57.5);
});

test('DS-1 present-but-non-finite optionals are refused, not defaulted', () => {
  const input = validInput();
  input.m5LatestBodyPressure = Number.NaN;
  assert.throws(() => applyDirectionScorerContract(input), /SCORER_INPUT_REQUIRED: m5LatestBodyPressure/);
});

test('DS-1 missing required columns are a typed refusal (fail-closed)', () => {
  const input = validInput();
  delete input.emaSeparationAtr;
  assert.throws(() => applyDirectionScorerContract(input), /SCORER_INPUT_REQUIRED: emaSeparationAtr/);
  const nullInput = validInput();
  nullInput.momentum3Atr = null;
  assert.throws(() => applyDirectionScorerContract(nullInput), /SCORER_INPUT_REQUIRED: momentum3Atr/);
  const nanInput = validInput();
  nanInput.rsi14 = Number.NaN;
  assert.throws(() => applyDirectionScorerContract(nanInput), /SCORER_INPUT_REQUIRED: rsi14/);
});

test('DS-1 refuses unsupported instruments instead of scoring them', () => {
  const input = validInput();
  input.instrument = 'EURGBP';
  assert.throws(() => applyDirectionScorerContract(input), /SCORER_UNSUPPORTED_INSTRUMENT/);
  assert.equal(SUPPORTED_INSTRUMENTS.includes('EURGBP'), false);
});

test('DS-1 refuses out-of-range values instead of clamping them into range', () => {
  const input = validInput();
  input.rsi14 = 118;
  assert.throws(() => applyDirectionScorerContract(input), /SCORER_INPUT_OUT_OF_RANGE: rsi14/);
  const wick = validInput();
  wick.lowerWickRatio = 1.4;
  assert.throws(() => applyDirectionScorerContract(wick), /SCORER_INPUT_OUT_OF_RANGE: lowerWickRatio/);
  const direction = validInput();
  direction.direction = 'LONG';
  assert.throws(() => applyDirectionScorerContract(direction), /SCORER_INPUT_OUT_OF_RANGE: direction/);
});
