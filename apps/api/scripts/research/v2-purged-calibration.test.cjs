'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPurgedFolds, runPurgedCalibration, requireValidRecords,
} = require('./v2-purged-calibration.cjs');
const { fitIsotonic } = require('./v2-calibrator-bundle.cjs');

const T0 = Date.parse('2026-11-27T10:00:00Z');
const iso = (ms) => new Date(T0 + ms).toISOString();

function rec(i, { spacingMin = 30, outcomeLagMin = 15, score, outcome } = {}) {
  const dAt = iso(i * spacingMin * 60 * 1000);
  const oAt = iso((i * spacingMin + outcomeLagMin) * 60 * 1000);
  return {
    decisionId: `r-${String(i).padStart(4, '0')}`,
    decisionAt: dAt,
    outcomeAt: oAt,
    score: score ?? ((i % 10) + 1) / 11,
    outcome: outcome ?? (i % 2),
  };
}

test('fold structure: expanding walk-forward, equal chunks, both sides non-empty (12 records, 3 folds)', () => {
  const records = Array.from({ length: 12 }, (_, i) => rec(i));
  const built = buildPurgedFolds(records, { horizonMinutes: 15, foldCount: 3 });
  assert.ok(!built.error, built.error || '');
  // chunk bounds: [0,3),[3,6),[6,9),[9,12) -> fold0 trains 3 / tests 3, etc.
  assert.deepEqual(built.folds.map((f) => [f.trainCount, f.testCount]), [[3, 3], [6, 3], [9, 3]]);
  assert.equal(built.folds.every((f) => f.excludedTestCount === 0 && f.excludedTrainCount === 0), true);
});

test('fold 0 metrics are hand-computed: Brier 2/3 and ECE 2/3 on a fixed fixture', () => {
  // Train (records 0..2): scores 0.1/0.5/0.9, outcomes 0/0/1 -> isotonic bins hi=0.7 -> p=0, then p=1.
  const records = [];
  const spec = [
    { score: 0.1, outcome: 0 }, { score: 0.5, outcome: 0 }, { score: 0.9, outcome: 1 }, // train fold 0
    { score: 0.2, outcome: 0 }, { score: 0.6, outcome: 1 }, { score: 0.8, outcome: 0 }, // test fold 0
  ];
  spec.forEach((s, i) => records.push(rec(i, s)));
  records.push(...Array.from({ length: 6 }, (_, j) => rec(6 + j, { score: 0.5, outcome: j % 2 })));
  const out = runPurgedCalibration(records, { horizonMinutes: 15, foldCount: 3, minHoldoutRecords: 100 });
  assert.ok(out.ok);
  const f0 = out.folds[0];
  // Predictions on the test side: 0.2->0, 0.6->0, 0.8->1 vs outcomes 0,1,0.
  // Brier = ((0-0)^2 + (0-1)^2 + (1-0)^2)/3 = 2/3.
  assert.ok(Math.abs(f0.brier - 2 / 3) < 1e-12, `brier ${f0.brier}`);
  // ECE: bin[0,0.2) two preds p=0 meanY=0.5 -> 0.5*(2/3); bin[0.8,1.0+) one pred p=1 meanY=0 -> 1*(1/3).
  assert.ok(Math.abs(f0.ece - 2 / 3) < 1e-12, `ece ${f0.ece}`);
  assert.equal(out.calibrationState, 'UNCALIBRATED'); // 9 held-out records total << 100
  assert.equal(out.pooled.heldOutCount, 9);
});

test('test-side purge: evaluation decisions within the horizon behind the train end are excluded and COUNTED', () => {
  // spacing 5 min, horizon 15 min: fold-0 test chunk records 3,4 (t=15,20) are within 15 min of train end (t=10); record 5 (t=25) survives.
  const records = Array.from({ length: 12 }, (_, i) => rec(i, { spacingMin: 5, outcomeLagMin: 15 }));
  const built = buildPurgedFolds(records, { horizonMinutes: 15, foldCount: 3 });
  const f0 = built.folds[0];
  assert.deepEqual(f0.excludedTestIds, ['r-0003', 'r-0004']);
  assert.equal(f0.testCount, 1);
  assert.equal(f0.excludedTestCount, 2);
  // nothing is dropped silently: kept + excluded == raw chunk size
  assert.equal(f0.testCount + f0.excludedTestCount, 3);
});

test('train-side purge: train labels not yet knowable at the test start are excluded and COUNTED', () => {
  // spacing 5 min, outcome lag 7 min: fold-0 train t=0,5,10 -> outcomes at 7,12,17; test starts t=15.
  // The t=10 train record's label (t=17) postdates the first test decision (t=15): excluded from train.
  const records = Array.from({ length: 12 }, (_, i) => rec(i, { spacingMin: 5, outcomeLagMin: 7 }));
  const built = buildPurgedFolds(records, { horizonMinutes: 15, foldCount: 3 });
  const f0 = built.folds[0];
  assert.deepEqual(f0.excludedTrainIds, ['r-0002']);
  assert.equal(f0.trainCount, 2);
  assert.equal(f0.excludedTrainCount, 1);
});

test('a fold purged to an empty side is REPORTED as skipped, never silently averaged', () => {
  // outcome lag 120 min with 5-min spacing: every train label postdates every test start.
  const records = Array.from({ length: 12 }, (_, i) => rec(i, { spacingMin: 5, outcomeLagMin: 120 }));
  const out = runPurgedCalibration(records, { horizonMinutes: 15, foldCount: 3 });
  assert.ok(out.ok);
  assert.ok(out.folds.every((f) => f.skipped === 'PURGED_TO_EMPTY'));
  assert.equal(out.pooled.heldOutCount, 0);
  assert.equal(out.calibrationState, 'UNCALIBRATED');
});

test('unsorted input is REFUSED (never silently re-sorted)', () => {
  const records = Array.from({ length: 6 }, (_, i) => rec(i));
  const reversed = [...records].reverse();
  assert.equal(requireValidRecords(reversed).error, 'CHRONOLOGY_REQUIRED');
  const built = buildPurgedFolds(reversed, { horizonMinutes: 15, foldCount: 2 });
  assert.equal(built.error, 'CHRONOLOGY_REQUIRED');
});

test('duplicates, impossible temporality, bad horizon and malformed records are refused', () => {
  const dup = [rec(0), rec(0)];
  assert.equal(requireValidRecords(dup).error, 'DUPLICATE_DECISION_ID');
  const impossible = [{ ...rec(0), decisionAt: iso(60 * 60000), outcomeAt: iso(0) }];
  assert.equal(requireValidRecords(impossible).error, 'TEMPORAL_IMPOSSIBILITY');
  const noHorizon = buildPurgedFolds([rec(0), rec(1), rec(2)], { horizonMinutes: 0, foldCount: 2 });
  assert.equal(noHorizon.error, 'HORIZON_REQUIRED');
  const badScore = [{ ...rec(0), score: 'high' }];
  assert.equal(requireValidRecords(badScore).error, 'SCORE_REQUIRED');
});

test('leakage guard: no surviving test decision lies within the horizon of the train end', () => {
  const records = Array.from({ length: 40 }, (_, i) => rec(i, { spacingMin: 5, outcomeLagMin: 15 }));
  const built = buildPurgedFolds(records, { horizonMinutes: 15, foldCount: 3 });
  for (const f of built.folds) {
    const trainEndMs = Date.parse(f.train[f.train.length - 1].decisionAt);
    for (const t of f.test) {
      assert.ok(Date.parse(t.decisionAt) - trainEndMs >= 15 * 60000, `test decision ${t.decisionId} leaked inside the purge zone`);
    }
    for (const tr of f.train) {
      const testStartMs = Date.parse(f.test[0].decisionAt);
      assert.ok(Date.parse(tr.outcomeAt) <= testStartMs, `train label ${tr.decisionId} was not knowable at test start`);
    }
  }
});

test('the pipeline end-to-end: deterministic, bundles are SHA-pinned and load-verified inside every fold', () => {
  const records = Array.from({ length: 150 }, (_, i) => rec(i, {
    score: ((i % 20) + 1) / 21,
    outcome: i % 3 === 0 ? 1 : 0,
  }));
  const a = runPurgedCalibration(records, { horizonMinutes: 15, foldCount: 3, minHoldoutRecords: 100 });
  const b = runPurgedCalibration(records, { horizonMinutes: 15, foldCount: 3, minHoldoutRecords: 100 });
  assert.deepEqual(a, b); // full determinism, including bundle SHAs
  assert.ok(a.ok);
  // 150 records, 4 chunks (38,38,37,37): held-out test sides 37+38+37=112 >= 100.
  assert.equal(a.pooled.heldOutCount, 112);
  assert.equal(a.calibrationState, 'CALIBRATED');
  assert.match(a.firstFoldBundleSha, /^[0-9a-f]{64}$/);
  for (const f of a.folds) assert.match(f.bundleSha, /^[0-9a-f]{64}$/);
  // fold-level bundles carry NO holdout claim: the state is earned only by the pooled held-out count
  assert.equal(a.folds.every((f) => typeof f.brier === 'number' && f.testCount > 0), true);
});

test('the fitted artifact inside fold 0 is exactly the hand-computed isotonic step', () => {
  const train = [
    { score: 0.1, outcome: 0 }, { score: 0.5, outcome: 0 }, { score: 0.9, outcome: 1 },
  ];
  const fit = fitIsotonic(train.map((r) => r.score), train.map((r) => r.outcome));
  assert.deepEqual(fit.bins, [{ hi: 0.7, p: 0 }, { hi: null, p: 1 }]); // hand-checked in the bundle tests
});
