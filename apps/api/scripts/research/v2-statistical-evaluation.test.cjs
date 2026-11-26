'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  wilsonInterval,
  maxDrawdown,
  evaluateAfterCostPerformance,
  evaluateCalibration,
  aucStandardError,
  minimumDetectableAucEffect,
  requiredNPerClassForAucDetection,
  assertComparisonClusters,
  compareWinRates,
} = require('./v2-statistical-evaluation.cjs');

// Cross-check anchor: PR #836 pinned 19/38 -> [34.9%, 65.2%] via scipy.
test('Wilson interval matches the PR #836 reference cohort', () => {
  const [lo, hi] = wilsonInterval(19, 38);
  assert.ok(Math.abs(lo - 0.3485) < 0.001, `lo=${lo}`);
  assert.ok(Math.abs(hi - 0.6515) < 0.001, `hi=${lo}`);
});

test('Wilson interval refuses invalid binomial input', () => {
  assert.equal(wilsonInterval(19, 0), null);
  assert.equal(wilsonInterval(-1, 38), null);
  assert.equal(wilsonInterval(19, 18), null);
});

test('max drawdown of a known R series', () => {
  assert.ok(Math.abs(maxDrawdown([2, -1.5, 0.5, -0.5]) - 1.5) < 1e-9);
  assert.ok(Math.abs(maxDrawdown([2, 1, 1.6, -1.2]) - 1.2) < 1e-9);
  assert.equal(maxDrawdown([1, 1, 1]), 0);
});

test('after-cost performance statistics on a pinned cohort', () => {
  const stats = evaluateAfterCostPerformance(
    [{ netR: 2 }, { netR: -1 }, { netR: 1.6 }, { netR: -1.2 }]);
  assert.equal(stats.n, 4);
  assert.equal(stats.winRate, 0.5);
  assert.ok(Math.abs(stats.totalNetR - 1.4) < 1e-9);
  assert.ok(Math.abs(stats.meanNetR - 0.35) < 1e-9);
  assert.ok(Math.abs(stats.profitFactor - 3.6 / 2.2) < 1e-9);
  assert.ok(Math.abs(stats.payoffRatio - 1.8 / 1.1) < 1e-9);
  // population stdev of [2,-1,1.6,-1.2] is sqrt(2.1275) = 1.45860...
  assert.ok(Math.abs(stats.stdevNetR - Math.sqrt(2.1275)) < 1e-9);
  assert.ok(Math.abs(stats.riskNormalizedExpectancy - 0.35 / Math.sqrt(2.1275)) < 1e-9);
  assert.equal(stats.maxDrawdownR, 1.2);
  const [lo, hi] = stats.winRateWilson95;
  assert.ok(lo > 0.14 && lo < 0.16 && hi > 0.84 && hi < 0.86);
});

test('calibration: Brier, ECE and reliability on pinned items', () => {
  const cal = evaluateCalibration([
    { probability: 0.8, outcome: 1 }, { probability: 0.6, outcome: 0 }]);
  assert.equal(cal.n, 2);
  assert.ok(Math.abs(cal.brierScore - 0.2) < 1e-9); // ((0.8-1)^2+(0.6-0)^2)/2
  assert.ok(Math.abs(cal.brierSkillScore - 0.2) < 1e-9); // 1 - 0.2/0.25
  assert.equal(cal.baseRate, 0.5);
  // bins: [0.8..1): meanP 0.8 meanO 1; [0.6..0.8): meanP 0.6 meanO 0
  assert.equal(cal.reliability.length, 2);
  assert.ok(Math.abs(cal.expectedCalibrationError - 0.4) < 1e-9);
  // resolution = weighted variance of bin means around base rate 0.5
  assert.ok(Math.abs(cal.resolution - 0.25) < 1e-9);
});

test('calibration refuses out-of-range probability and outcome', () => {
  assert.throws(() => evaluateCalibration([{ probability: 1.2, outcome: 1 }]),
    /CALIBRATION_PROBABILITY_INVALID/);
  assert.throws(() => evaluateCalibration([{ probability: 0.5, outcome: 2 }]),
    /CALIBRATION_OUTCOME_INVALID/);
});

// Cross-check anchor: PR #836 pinned AUC 0.4752, 105/87 -> SE 0.042.
test('Hanley-McNeil AUC SE matches the PR #836 reference', () => {
  const se = aucStandardError(0.4752, 105, 87);
  assert.ok(Math.abs(se - 0.042) < 0.0005, `se=${se}`);
});

test('AUC detection limits are stated, not implied', () => {
  // 95% two-sided minimum detectable |AUC-0.5| for 105/87 classes.
  const mde = minimumDetectableAucEffect(0.5, 105, 87);
  assert.ok(Math.abs(mde - 1.959964 * 0.041968) < 0.001, `mde=${mde}`);
  // Per-class n for AUC 0.55 at 80% power: PR #836 reports "about 518".
  const n = requiredNPerClassForAucDetection(0.55);
  assert.ok(Number.isInteger(n) && n >= 505 && n <= 530, `n=${n}`);
  assert.throws(() => requiredNPerClassForAucDetection(0.5), /AUC_N_INPUT_INVALID/);
});

test('clustered comparisons are refused, not averaged', () => {
  const a = [{ clusterKey: 'EURUSD|2026-12-01T09:00' },
    { clusterKey: 'AUDUSD|2026-12-01T09:00' }];
  const b = [{ clusterKey: 'EURUSD|2026-12-01T09:00' },
    { clusterKey: 'GBPUSD|2026-12-01T09:00' }];
  const clustered = assertComparisonClusters(a, b, 'clusterKey');
  assert.equal(clustered.clustered, true);
  assert.deepEqual(clustered.sharedClusterKeys, ['EURUSD|2026-12-01T09:00']);
  const clean = assertComparisonClusters(a,
    [{ clusterKey: 'USDJPY|2026-12-01T09:00' }], 'clusterKey');
  assert.equal(clean.clustered, false);
});

test('Newcombe difference interval on a pinned two-engine comparison', () => {
  const cmp = compareWinRates({ wins: 19, n: 38 }, { wins: 15, n: 40 });
  assert.equal(cmp.p1, 0.5);
  assert.equal(cmp.p2, 0.375);
  assert.equal(cmp.difference, 0.125);
  const [lo, hi] = cmp.confidence95;
  // hand-derived: -0.0916 / +0.3265 (Wilson 19/38 and 15/40 combined)
  assert.ok(Math.abs(lo - (-0.0916)) < 0.001, `lo=${lo}`);
  assert.ok(Math.abs(hi - 0.3265) < 0.001, `hi=${hi}`);
  assert.equal(cmp.excludesZero, false);
});

test('underpowered comparisons are typed refusals', () => {
  assert.throws(() => compareWinRates({ wins: 5, n: 10 }, { wins: 19, n: 38 }),
    /INSUFFICIENT_SAMPLE:10<30/);
  assert.throws(() => compareWinRates({ wins: 19, n: 38 }, { wins: 0, n: 0 }),
    /WIN_RATE_INPUT_INVALID/);
});
