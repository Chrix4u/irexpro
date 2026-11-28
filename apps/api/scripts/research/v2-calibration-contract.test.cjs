#!/usr/bin/env node
'use strict';
/**
 * P1-4 calibration consolidation contract — regression suite.
 * Verifies: inventory reconciliation, path/constant drift detection,
 * faithful mirror behaviour against hand-computed scenarios, the frozen
 * CL corpus verdicts, CAL-2 scoreboard rules and typed refusals, and
 * tampering detection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  CONTRACT_ARTIFACT,
  REFUSALS,
  CALIBRATION_CONTRACT,
  CORPUS,
  CALIBRATION_LAYER_COUNT,
  PREDICTION_FAMILY_COUNT,
  CAL1,
  SCOREBOARD_FAMILIES,
  SCOREBOARD_EXCLUDED_FAMILIES,
  SCOREBOARD_FIELDS,
  mirrorC1,
  mirrorC2,
  mirrorC3,
  mirrorC4,
  mirrorC5,
  mirrorC6,
  mirrorA1,
  mirrorP5,
  validatePredictionRegistration,
  registerPrediction,
  validateCalibrationContract,
  verifyCalibrationPaths,
  verifyAuxiliaryAnchors,
  buildCalibrationMatrix,
  summarizeCalibrationContract,
} = require('./v2-calibration-contract.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const clone = (value) => JSON.parse(JSON.stringify(value));
const D = (id) => clone(CORPUS.find((record) => record.id === id));

test('the committed contract validates and reconciles with the audit claim of six calibration layers plus two auxiliaries', () => {
  assert.equal(validateCalibrationContract(CALIBRATION_CONTRACT), true);
  const summary = summarizeCalibrationContract();
  assert.equal(summary.artifact, CONTRACT_ARTIFACT);
  assert.equal(summary.calibrationLayers, 8); // 6 layers + 2 auxiliaries (map v1 §4)
  assert.equal(CALIBRATION_LAYER_COUNT, 8);
  assert.equal(summary.predictionFamilies, 5); // map v1 §6
  assert.equal(PREDICTION_FAMILY_COUNT, 5);
  assert.equal(summary.corpus.size, 12);
  assert.equal(summary.corpus.disagreementCount, 10);
  assert.equal(summary.corpus.controlCount, 2);
  assert.equal(summary.corpus.dispositionConflictCount, 7);
  assert.equal(summary.corpus.withinLayerSplitCount, 2);
  assert.equal(summary.corpus.distinctPatterns, 12);
  assert.equal(summary.cal1Tiers, 4);
  assert.equal(summary.scoreboardFamilies, 4);
  assert.equal(summary.excludedFamilies, 1);
});

test('every mapped file exists and still carries its pinned constants (drift detector)', () => {
  const result = verifyCalibrationPaths(REPO_ROOT);
  assert.equal(result.verified, result.total);
  assert.equal(result.total, 13);
  const auxiliary = verifyAuxiliaryAnchors(REPO_ROOT);
  assert.equal(auxiliary.verified, auxiliary.total);
});

test('the C2 layer inventory pins the strength-normalized blending constants', () => {
  const c2 = clone(CALIBRATION_CONTRACT.calibrationLayers.find((l) => l.key === 'C2'));
  assert.deepEqual(
    c2.constants.map((c) => [c.name, c.value, c.line]),
    [
      ['ADAPTIVE_EDGE_MATURE_MIN_SAMPLES', 20, 7],
      ['ADAPTIVE_EDGE_MIN_WINS', 5, 8],
      ['ADAPTIVE_EDGE_MIN_LOSSES', 5, 9],
    ],
  );
});

test('mirrorC1 refuses out-of-range confidence and invalid timestamps', () => {
  const request = { instrument: 'EURUSD', direction: 'BUY', session: 'LONDON', state: 'TREND_HEALTHY', strategyRoute: 'plan-b-trend', evaluatedAt: '2026-11-27T10:00:00.000Z', rawConfidence: 1.4, rawNetExpectedR: 0.2 };
  const decision = mirrorC1([], request);
  assert.equal(decision.refusal, REFUSALS.INPUT_OUT_OF_RANGE);
  const badTime = mirrorC1([], { ...request, rawConfidence: 0.6, evaluatedAt: 'not-a-time' });
  assert.equal(badTime.refusal, REFUSALS.INPUT_REQUIRED);
});

test('mirrorC1 reproduces the Bayesian blend, maturity and rescue on the D06 cell', () => {
  const record = D('CL-D06');
  const decision = mirrorC1(record.inputs.c1Rows, { instrument: 'EURUSD', direction: 'BUY', session: 'LONDON', state: 'TREND_HEALTHY', strategyRoute: 'plan-b-trend', evaluatedAt: '2026-11-27T10:00:00.000Z', rawConfidence: 0.62, rawNetExpectedR: 0.2 });
  assert.equal(decision.authoritative, true);
  assert.equal(decision.maturity, 'MATURE');
  assert.equal(decision.samples, 20);
  assert.equal(decision.wins, 12);
  assert.equal(decision.losses, 8);
  assert.equal(decision.calibratedWinProbability, 0.605714);
  assert.equal(decision.calibratedNetExpectedR, 0.128571);
  assert.equal(decision.profitFactor, 2.25);
  assert.equal(decision.blockRecommended, false);
  assert.equal(decision.rescueEligible, true);
  assert.equal(decision.reason, 'MATURE_POSITIVE_CALIBRATED_EDGE');
});

test('mirrorC1 keeps a sparse cell non-authoritative and passes raw values through', () => {
  const record = D('CL-D02');
  const decision = mirrorC1(record.inputs.c1Rows, { instrument: 'EURUSD', direction: 'BUY', session: 'LONDON', state: 'TREND_HEALTHY', strategyRoute: 'plan-b-trend', evaluatedAt: '2026-11-27T10:00:00.000Z', rawConfidence: 0.62, rawNetExpectedR: 0.2 });
  assert.equal(decision.authoritative, false);
  assert.equal(decision.available, true);
  assert.equal(decision.maturity, 'SPARSE');
  assert.equal(decision.calibratedWinProbability, 0.62);
  assert.equal(decision.reason, 'CALIBRATION_EVIDENCE_SPARSE');
});

test('mirrorC1 degrades to a stance without authority at ROUTE level (CL-D10)', () => {
  const record = D('CL-D10');
  const decision = mirrorC1(record.inputs.c1Rows, { instrument: 'EURUSD', direction: 'BUY', session: 'LONDON', state: 'TREND_HEALTHY', strategyRoute: 'plan-b-trend', evaluatedAt: '2026-11-27T10:00:00.000Z', rawConfidence: 0.62, rawNetExpectedR: 0.2 });
  assert.equal(decision.sourceLevel, 'ROUTE');
  assert.equal(decision.authoritative, true);
  assert.equal(decision.maturity, 'DEGRADED');
  assert.equal(decision.blockRecommended, false);
  assert.equal(decision.stanceWouldBlock, true);
});

test('mirrorC2 reproduces the blending ladder and the upsize verdict on the D10 cell', () => {
  const record = D('CL-D10');
  const evidence = mirrorC2(record.inputs.c2Rows, { instrument: 'EURUSD', direction: 'BUY', session: 'LONDON', state: 'TREND_HEALTHY', strategyRoute: 'plan-b-trend', evaluatedAt: '2026-11-27T10:00:00.000Z', decisionPolicyVersion: 'dp-v1' });
  assert.equal(evidence.exactRows, 20);
  assert.equal(evidence.maturity, 'MATURE');
  assert.equal(evidence.smoothedExpectedR, 0.22);
  assert.equal(evidence.maxDrawdown, 0.04);
  assert.equal(evidence.canUpsize, true);
});

test('mirrorC2 flags drawdown-driven degradation with a stable recent-8 (CL-D08)', () => {
  const record = D('CL-D08');
  const evidence = mirrorC2(record.inputs.c2Rows, { instrument: 'EURUSD', direction: 'BUY', session: 'LONDON', state: 'TREND_HEALTHY', strategyRoute: 'plan-b-trend', evaluatedAt: '2026-11-27T10:00:00.000Z', decisionPolicyVersion: 'dp-v1' });
  assert.equal(evidence.maturity, 'DEGRADED');
  assert.equal(evidence.recentDegradation, true);
  assert.ok(evidence.maxDrawdown > 0.12);
  assert.equal(evidence.canUpsize, false);
  assert.equal(evidence.reason, 'RECENT_EDGE_DEGRADED');
});

test('mirrorC3 computes the decayed pulse and abstains below 4 outcomes per side', () => {
  const record = D('CL-D03');
  const supported = mirrorC3(record.inputs.pulseOutcomes, 'BUY', '2026-11-27T10:00:00.000Z');
  assert.equal(supported.status, 'SUPPORTED');
  assert.equal(supported.advantageR, 0.65);
  assert.equal(supported.quality, 0.6625);
  const record12 = D('CL-D12');
  const insufficient = mirrorC3(record12.inputs.pulseOutcomes, 'BUY', '2026-11-27T10:00:00.000Z');
  assert.equal(insufficient.status, 'INSUFFICIENT');
  assert.equal(insufficient.quality, 0.5);
  const bad = mirrorC3([], 'LONG', '2026-11-27T10:00:00.000Z');
  assert.equal(bad.refusal, REFUSALS.INPUT_REQUIRED);
});

test('mirrorC4 crosses the 100-sample boundary and enforces the 0.25 fixed floor', () => {
  const record = D('CL-D04');
  const sparse = mirrorC4(record.inputs.c4Sparse);
  assert.equal(sparse.reason, 'SPARSE_HISTORY_FIXED_FALLBACK');
  assert.equal(sparse.calibratedCostR, 0.0625);
  const calibrated = mirrorC4(record.inputs.c4Calibrated);
  assert.equal(calibrated.reason, 'CALIBRATED_P95_WITH_FLOOR');
  assert.equal(calibrated.calibratedCostR, 0.03125);
  const floored = mirrorC4({ instrument: 'EURUSD', fixedSpreadPrice: 0.0002, stopDistancePrice: 0.004, history: { sampleCount: 200, p95SpreadPrice: 0.00002 } });
  assert.equal(floored.calibratedSpreadPrice, 0.00005); // p95 lifted to the 0.25 floor
  assert.equal(floored.calibratedCostR, 0.015625); // between p95-only (0.03125/2) and fixed (0.0625)
  const invalid = mirrorC4({ instrument: 'EURUSD', fixedSpreadPrice: 0, stopDistancePrice: 0.004, history: { sampleCount: 200, p95SpreadPrice: 0.0001 } });
  assert.equal(invalid.refusal, REFUSALS.INPUT_OUT_OF_RANGE);
});

test('mirrorC5 subtracts the p90 fee additively and refuses insufficient evidence', () => {
  const record = D('CL-D05');
  const ready = mirrorC5(record.inputs.c5);
  assert.equal(ready.reason, 'CAUSAL_FEE_EVIDENCE_READY');
  assert.equal(ready.estimatedNetAfterFeeR, -0.05);
  assert.equal(ready.hypotheticalNetFloorPassed, false);
  const sparse = mirrorC5({ ...record.inputs.c5, evidence: { sampleCount: 4, p90FeeR: 0.35 } });
  assert.equal(sparse.reason, 'INSUFFICIENT_PRIOR_CLOSED_TRADES');
  assert.equal(sparse.hypotheticalNetFloorPassed, null);
  const failed = mirrorC5({ ...record.inputs.c5, lookupFailed: true });
  assert.equal(failed.reason, 'FEE_LOOKUP_UNAVAILABLE');
});

test('mirrorC6 stress-views the candidate and refuses unsupported pairs', () => {
  const record = D('CL-D06');
  const stressed = mirrorC6(record.inputs.c6);
  assert.equal(stressed.state, 'ESTIMABLE_STRESS_ONLY');
  assert.equal(stressed.stressedCostAdjustedR, -0.1);
  const positive = mirrorC6(D('CL-D11').inputs.c6);
  assert.equal(positive.stressedCostAdjustedR, 0.18);
  const jpy = mirrorC6({ ...record.inputs.c6, instrument: 'USDJPY', stopDistance: 0.04 });
  assert.equal(jpy.state, 'ESTIMABLE_STRESS_ONLY');
  assert.equal(jpy.slippageStressR, 0.125); // (0.01 pip * 0.5) / 0.04 — JPY pip is 100x
  assert.equal(stressed.slippageStressR, 0.0125); // (0.0001 * 0.5) / 0.004
  const unsupported = mirrorC6({ ...record.inputs.c6, instrument: 'XAUUSD' });
  assert.equal(unsupported.refusal, REFUSALS.UNSUPPORTED_SURFACE);
  const noFees = mirrorC6({ ...record.inputs.c6, feeSamples: 2 });
  assert.equal(noFees.state, 'INSUFFICIENT_CAUSAL_FEES');
});

test('mirrorP5 blends realized evidence and applies the recent-payoff drag (CL-D07)', () => {
  const record = D('CL-D07');
  const blended = mirrorP5(record.inputs.p5);
  assert.equal(blended.source, 'REALISED_PAIR_SIDE');
  assert.equal(blended.recentPayoffApplied, true);
  assert.equal(blended.statisticalExpectedR, -0.011364);
  const heuristic = mirrorP5(D('CL-D12').inputs.p5);
  assert.equal(heuristic.source, 'HEURISTIC_PRIOR');
  assert.equal(heuristic.reason, 'HEURISTIC_PRIOR');
});

test('mirrorA1 binds a calibration block only on the blocked candidate side (CL-D09)', () => {
  const record = D('CL-D09');
  const current = mirrorA1(record.inputs.calibration, record.inputs.pairedCurrent, 'BUY');
  assert.equal(current.state, 'BLOCK_CURRENT_SIDE_FAVORED');
  assert.equal(current.active, true);
  const opposite = mirrorA1(record.inputs.calibration, record.inputs.pairedOpposite, 'BUY');
  assert.equal(opposite.state, 'BLOCK_OPPOSITE_SIDE_FAVORED');
  assert.equal(opposite.active, false);
});

test('CAL-2 scoreboard: valid registrations append, duplicates and retrodiction are refused', () => {
  const base = {
    predictionId: 'pred-1',
    family: 'PLAN_B_EXPECTED_R',
    instrument: 'EURUSD',
    direction: 'BUY',
    strategyRoute: 'plan-b-trend',
    session: 'LONDON',
    state: 'TREND_HEALTHY',
    decisionPolicyVersion: 'dp-v1',
    modelVersion: 'plan-b-multimodel-shadow-v4',
    registeredAt: '2026-11-27T09:00:00.000Z',
    rawConfidence: 0.64,
    rawNetExpectedR: 0.12,
    executionAuthority: 'NONE',
  };
  assert.equal(validatePredictionRegistration(base).valid, true);
  assert.equal(validatePredictionRegistration(base, '2026-11-27T10:00:00.000Z').valid, true);
  const ledger = [];
  assert.equal(registerPrediction(ledger, base).valid, true);
  const duplicate = registerPrediction(ledger, { ...base, predictionId: 'pred-1' });
  assert.equal(duplicate.refusal, REFUSALS.INPUT_OUT_OF_RANGE);
  const late = registerPrediction(ledger, { ...base, predictionId: 'pred-2' }, '2026-11-27T08:00:00.000Z');
  assert.equal(late.refusal, REFUSALS.INPUT_OUT_OF_RANGE);
  assert.equal(ledger.length, 1);
});

test('CAL-2 scoreboard: P4 stays excluded and every field is required', () => {
  assert.ok(SCOREBOARD_EXCLUDED_FAMILIES.includes('OWNER_FORECAST_NET_R'));
  assert.ok(!SCOREBOARD_FAMILIES.includes('OWNER_FORECAST_NET_R'));
  const base = {
    predictionId: 'pred-9',
    family: 'OWNER_FORECAST_NET_R',
    instrument: 'EURUSD',
    direction: 'BUY',
    strategyRoute: 'plan-b-trend',
    session: 'LONDON',
    state: 'TREND_HEALTHY',
    decisionPolicyVersion: 'dp-v1',
    modelVersion: 'generated',
    registeredAt: '2026-11-27T09:00:00.000Z',
    rawConfidence: 0.5,
    rawNetExpectedR: 0.1,
    executionAuthority: 'NONE',
  };
  assert.equal(validatePredictionRegistration(base).refusal, REFUSALS.UNSUPPORTED_SURFACE);
  for (const field of SCOREBOARD_FIELDS) {
    const incomplete = { ...base, family: 'M1_EXPECTANCY_BLEND' };
    delete incomplete[field];
    assert.equal(validatePredictionRegistration(incomplete).refusal, REFUSALS.INPUT_REQUIRED, field);
  }
  const badConfidence = { ...base, family: 'M1_EXPECTANCY_BLEND', rawConfidence: 1.2 };
  assert.equal(validatePredictionRegistration(badConfidence).refusal, REFUSALS.INPUT_OUT_OF_RANGE);
  const authority = { ...base, family: 'M1_EXPECTANCY_BLEND', executionAuthority: 'FULL' };
  assert.equal(validatePredictionRegistration(authority).refusal, REFUSALS.INPUT_OUT_OF_RANGE);
});

test('the corpus matrix computes every committed verdict and no layer evaluation fails', () => {
  const matrix = buildCalibrationMatrix(CORPUS);
  for (const row of matrix.rows) {
    for (const evaluation of row.evaluations) {
      assert.equal(evaluation.ok, true, `${row.id}/${evaluation.layer}`);
    }
  }
  assert.equal(matrix.byLayer.C1.support, 5);
  assert.equal(matrix.byLayer.C1.oppose, 3);
  assert.equal(matrix.byLayer.C2.support, 4);
  assert.equal(matrix.byLayer.C2.oppose, 1);
  assert.equal(matrix.byLayer.C6.oppose, 3);
  assert.equal(matrix.byLayer.A1.oppose, 1);
});

test('the corpus records carry the committed divergence stories', () => {
  const d01 = D('CL-D01');
  assert.equal(d01.class, 'DISAGREEMENT');
  assert.ok(d01.note.includes('blocks under C1 and upsizes under C2'));
  const d02 = D('CL-D02');
  assert.equal(d02.kind, 'maturity');
  const d04 = D('CL-D04');
  assert.equal(d04.kind, 'economics');
  const d10 = D('CL-D10');
  assert.equal(d10.kind, 'authority');
  assert.ok(d10.note.includes('authority gap'));
  for (const control of ['CL-D11', 'CL-D12']) {
    assert.equal(D(control).class, 'CONTROL');
  }
});

test('tampering with the corpus, the statistics or a mirror input is a typed refusal', () => {
  const mutatedCorpus = clone(CALIBRATION_CONTRACT);
  mutatedCorpus.corpus.find((r) => r.id === 'CL-D01').evaluations[0].expect.disposition = 'support';
  assert.equal(validateCalibrationContract(mutatedCorpus), false);
  const mutatedStats = clone(CALIBRATION_CONTRACT);
  mutatedStats.statistics.corpus.disagreementCount = 11;
  assert.equal(validateCalibrationContract(mutatedStats), false);
  const mutatedMeta = clone(CALIBRATION_CONTRACT);
  mutatedMeta.meta.artifact = 'v2-calibration-consolidation-contract-v2';
  assert.equal(validateCalibrationContract(mutatedMeta), false);
});

test('CAL-1 pins one ladder, one vocabulary and the four closed gaps', () => {
  assert.deepEqual(CAL1.evidenceLadder, ['EXACT', 'PAIR_DIRECTION_ROUTE', 'ROUTE', 'GLOBAL']);
  assert.deepEqual(
    CAL1.sampleLadder.map((tier) => tier.tier),
    ['COLD', 'SCOUT', 'AUTHORITATIVE', 'MATURE'],
  );
  assert.deepEqual(CAL1.maturityVocabulary, ['SPARSE', 'COLLECTING', 'MATURE', 'DEGRADED']);
  assert.deepEqual(CAL1.authorityGradient, ['NONE', 'SHADOW_ONLY', 'ADVISORY', 'PAPER_BLOCK_RESCUE']);
  assert.equal(CAL1.blend.priorWeight, 8);
  assert.equal(CAL1.scoreboard, 'CAL-2');
  assert.equal(CAL1.closedGaps.length, 4);
});
