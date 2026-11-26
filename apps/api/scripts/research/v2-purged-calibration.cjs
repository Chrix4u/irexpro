'use strict';

// Independent research artifact: V2 purged chronological calibration pipeline
// (iRexPro AI V2 research, WS2.2). Pure logic over SYNTHETIC fixtures. No
// database access, no model execution, no broker calls, no trading authority.
//
// What this module enforces (audit findings D-01 / D-04 / overfitting
// category d):
//   * CHRONOLOGY is the caller's declared responsibility: records must arrive
//     sorted by decisionAt; unsorted input is REFUSED, never re-sorted
//     (re-sorting would silently rewrite the evidence order).
//   * PURGE: within every fold, test decisions whose outcome window could
//     overlap the training set's outcome knowledge are EXCLUDED and
//     COUNTED — both directions:
//       (a) test decisionAt earlier than trainEnd + horizonMinutes
//           (test outcome window overlaps the last training outcomes);
//       (b) train record whose outcomeAt falls after the fold's first test
//           decisionAt (its label is not knowable at evaluation time).
//     Exclusions are reported per fold; nothing is dropped silently.
//   * Fit happens ONLY on the train side of each fold, and it travels the
//     full bundle path of v2-calibrator-bundle.cjs: fit -> canonical
//     serialization -> SHA pin -> load-time verification -> apply. The
//     pipeline literally cannot use a calibrator that fails load-time checks.
//   * Metrics are computed ONLY on held-out test sides (Brier, ECE vs base
//     rate). In-sample fit quality is never reported as calibration.
//   * The aggregate calibration state is CALIBRATED only when the total
//     held-out evaluation count reaches the pre-registered minimum.
//
// Fold scheme: expanding-window walk-forward. With foldCount f, the record
// range is split into f+1 contiguous chunks of equal size (remainder spread
// deterministically onto the earliest chunks); fold i tests chunk i+1 and
// trains on everything before it, so every fold has a non-empty train set.

const {
  fitIsotonic, serializeCalibratorBundle, loadCalibratorBundle,
} = require('./v2-calibrator-bundle.cjs');

const ECE_BIN_EDGES = Object.freeze([0, 0.2, 0.4, 0.6, 0.8, 1.0001]);

function requireValidRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return { error: 'NO_RECORDS', detail: 'calibration pipeline requires a non-empty record array' };
  }
  const seen = new Set();
  let prevAt = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r === null || typeof r !== 'object') return { error: 'MALFORMED_RECORD', detail: `records[${i}] is not an object` };
    if (typeof r.decisionId !== 'string' || r.decisionId.length === 0) {
      return { error: 'DECISION_ID_REQUIRED', detail: `records[${i}].decisionId must be a non-empty string` };
    }
    if (seen.has(r.decisionId)) return { error: 'DUPLICATE_DECISION_ID', detail: `records[${i}].decisionId "${r.decisionId}" appears twice` };
    seen.add(r.decisionId);
    if (typeof r.decisionAt !== 'string' || typeof r.outcomeAt !== 'string') {
      return { error: 'TIMESTAMPS_REQUIRED', detail: `records[${i}] needs decisionAt and outcomeAt ISO-8601 strings` };
    }
    const dAt = Date.parse(r.decisionAt); const oAt = Date.parse(r.outcomeAt);
    if (!Number.isFinite(dAt) || !Number.isFinite(oAt)) {
      return { error: 'UNPARSEABLE_TIMESTAMP', detail: `records[${i}] timestamps are not parseable ISO-8601` };
    }
    if (oAt < dAt) {
      return { error: 'TEMPORAL_IMPOSSIBILITY', detail: `records[${i}].outcomeAt precedes decisionAt` };
    }
    if (prevAt !== null && dAt < prevAt) {
      return { error: 'CHRONOLOGY_REQUIRED', detail: `records[${i}] decisionAt is earlier than the previous record: input must be chronologically sorted by the caller (sorting silently would rewrite evidence order)` };
    }
    prevAt = dAt;
    if (typeof r.score !== 'number' || !Number.isFinite(r.score)) {
      return { error: 'SCORE_REQUIRED', detail: `records[${i}].score must be a finite number (raw model score)` };
    }
    if (r.outcome !== 0 && r.outcome !== 1) {
      return { error: 'OUTCOME_REQUIRED', detail: `records[${i}].outcome must be 0 or 1 (NET_R_POSITIVE_AT_HORIZON)` };
    }
  }
  return { ok: true };
}

function splitChunkBounds(n, foldCount) {
  // f folds -> f+1 chunks; chunk 0 is consumed as the initial train mass.
  const chunkCount = foldCount + 1;
  const base = Math.floor(n / chunkCount);
  const extra = n % chunkCount; // deterministic: earliest chunks one larger
  const bounds = [];
  let cursor = 0;
  for (let c = 0; c < chunkCount; c++) {
    const size = base + (c < extra ? 1 : 0);
    bounds.push({ start: cursor, end: cursor + size });
    cursor += size;
  }
  return bounds;
}

function buildPurgedFolds(records, opts) {
  const { horizonMinutes, foldCount } = opts;
  if (typeof horizonMinutes !== 'number' || !Number.isInteger(horizonMinutes) || horizonMinutes <= 0) {
    return { error: 'HORIZON_REQUIRED', detail: 'purge horizon must be a positive integer number of minutes (the outcome horizon being calibrated)' };
  }
  if (!Number.isInteger(foldCount) || foldCount < 2) {
    return { error: 'FOLD_COUNT_REQUIRED', detail: 'foldCount must be an integer >= 2 (train and test must be separable in every fold)' };
  }
  const valid = requireValidRecords(records);
  if (valid.error) return { error: valid.error, detail: valid.detail };

  const n = records.length;
  if (n < foldCount + 1) {
    return { error: 'INSUFFICIENT_RECORDS_FOR_FOLDS', detail: `${n} records cannot form ${foldCount} folds with non-empty train and test sides` };
  }
  const bounds = splitChunkBounds(n, foldCount);
  const horizonMs = horizonMinutes * 60 * 1000;
  const folds = [];

  for (let f = 0; f < foldCount; f++) {
    const trainRange = { start: 0, end: bounds[f].end };
    const testRange = { start: bounds[f + 1].start, end: bounds[f + 1].end };
    const trainRaw = records.slice(trainRange.start, trainRange.end);
    const testRaw = records.slice(testRange.start, testRange.end);
    if (trainRaw.length === 0 || testRaw.length === 0) {
      return { error: 'EMPTY_FOLD', detail: `fold ${f} degenerated to an empty side` };
    }

    const trainEndMs = Date.parse(trainRaw[trainRaw.length - 1].decisionAt);
    const testStartMs = Date.parse(testRaw[0].decisionAt);

    // (a) test-side purge: evaluation decisions too close behind the train end.
    const excludedTest = [];
    const keptTest = [];
    for (const r of testRaw) {
      if (Date.parse(r.decisionAt) - trainEndMs < horizonMs) excludedTest.push(r.decisionId);
      else keptTest.push(r);
    }
    // (b) train-side purge: labels not yet knowable when the fold's test begins.
    const excludedTrain = [];
    const keptTrain = [];
    for (const r of trainRaw) {
      if (Date.parse(r.outcomeAt) > testStartMs) excludedTrain.push(r.decisionId);
      else keptTrain.push(r);
    }

    folds.push({
      fold: f,
      trainCount: keptTrain.length,
      testCount: keptTest.length,
      excludedTestCount: excludedTest.length,
      excludedTestIds: excludedTest,
      excludedTrainCount: excludedTrain.length,
      excludedTrainIds: excludedTrain,
      train: keptTrain,
      test: keptTest,
    });
  }
  return { folds, horizonMinutes, foldCount, purgeRule: 'decision-gap >= horizon AND train outcome known before first test decision' };
}

// Brier and ECE on the held-out side. ECE uses fixed 0.2-wide bins
// (pre-registered, not chosen after seeing the data).
function calibrationMetrics(pairs) {
  if (pairs.length === 0) return { n: 0, brier: undefined, ece: undefined };
  const brier = pairs.reduce((acc, { p, y }) => acc + (p - y) ** 2, 0) / pairs.length;
  let ece = 0;
  for (let b = 0; b < ECE_BIN_EDGES.length - 1; b++) {
    const lo = ECE_BIN_EDGES[b]; const hi = ECE_BIN_EDGES[b + 1];
    const inBin = pairs.filter(({ p }) => p >= lo && p < hi);
    if (inBin.length === 0) continue;
    const meanP = inBin.reduce((acc, x) => acc + x.p, 0) / inBin.length;
    const meanY = inBin.reduce((acc, x) => acc + x.y, 0) / inBin.length;
    ece += (inBin.length / pairs.length) * Math.abs(meanP - meanY);
  }
  return { n: pairs.length, brier, ece };
}

function runPurgedCalibration(records, opts = {}) {
  const horizonMinutes = opts.horizonMinutes;
  const foldCount = opts.foldCount ?? 3;
  const minHoldoutRecords = opts.minHoldoutRecords ?? 100;
  const fittedAt = opts.fittedAt ?? '2026-11-27T00:00:00Z';

  const built = buildPurgedFolds(records, { horizonMinutes, foldCount });
  if (built.error) return { ok: false, code: built.error, detail: built.detail };

  const foldReports = [];
  const pooled = [];
  let tampered = null;
  for (const fold of built.folds) {
    if (fold.train.length === 0 || fold.test.length === 0) {
      // A fold can legitimately purge to empty on one side; it is REPORTED,
      // not silently skipped, and it contributes no metrics.
      foldReports.push({
        fold: fold.fold, trainCount: fold.trainCount, testCount: fold.testCount,
        excludedTestCount: fold.excludedTestCount, excludedTrainCount: fold.excludedTrainCount,
        skipped: 'PURGED_TO_EMPTY', brier: undefined, ece: undefined,
      });
      continue;
    }
    const fit = fitIsotonic(fold.train.map((r) => r.score), fold.train.map((r) => r.outcome));
    if (fit.error) return { ok: false, code: fit.error, detail: fit.error };
    const serialized = serializeCalibratorBundle({
      kind: 'ISOTONIC', bins: fit.bins,
      meta: {
        outcomeDefinition: 'NET_R_POSITIVE_AT_HORIZON', horizonMinutes,
        trainedOnCount: fold.train.length, fittedAt,
        holdout: null, // fold-level bundles are fit WITHOUT holdout claim
      },
    });
    if (serialized.error) return { ok: false, code: serialized.error, detail: serialized.error };
    const loaded = loadCalibratorBundle({ bundle: serialized.bundle, bundleSha: serialized.bundleSha });
    if (!loaded.ok) {
      return { ok: false, code: `FOLD_${fold.fold}_BUNDLE_${loaded.code}`, detail: loaded.detail };
    }
    if (tampered === null) tampered = serialized.bundleSha; // first fold's sha, for determinism assertions

    const pairs = fold.test.map((r) => ({ p: loaded.apply(r.score), y: r.outcome }));
    pooled.push(...pairs);
    const m = calibrationMetrics(pairs);
    foldReports.push({
      fold: fold.fold, trainCount: fold.trainCount, testCount: fold.testCount,
      excludedTestCount: fold.excludedTestCount, excludedTrainCount: fold.excludedTrainCount,
      bundleSha: serialized.bundleSha, brier: m.brier, ece: m.ece,
    });
  }

  const m = calibrationMetrics(pooled);
  const calibrationState = m.n >= minHoldoutRecords ? 'CALIBRATED' : 'UNCALIBRATED';
  return {
    ok: true,
    horizonMinutes,
    foldCount,
    purgeRule: built.purgeRule,
    folds: foldReports,
    pooled: { heldOutCount: m.n, brier: m.brier, ece: m.ece },
    calibrationState,
    minHoldoutRecords,
    firstFoldBundleSha: tampered,
  };
}

module.exports = {
  buildPurgedFolds,
  calibrationMetrics,
  runPurgedCalibration,
  requireValidRecords,
  ECE_BIN_EDGES,
};
