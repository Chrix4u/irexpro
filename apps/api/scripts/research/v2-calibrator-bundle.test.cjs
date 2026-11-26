'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fitIsotonic, fitPlatt, serializeCalibratorBundle, pinCalibratorBundle,
  loadCalibratorBundle, canonicalJson, MIN_HOLDOUT_FOR_CALIBRATED, BUNDLE_FORMAT,
} = require('./v2-calibrator-bundle.cjs');

const META = {
  outcomeDefinition: 'NET_R_POSITIVE_AT_HORIZON',
  horizonMinutes: 15,
  trainedOnCount: 4,
  fittedAt: '2026-11-27T00:00:00Z',
  holdout: { holdoutSize: 120, brier: 0.2, ece: 0.05 },
};

test('isotonic fit (PAVA) matches hand-computed blocks: [0,0,1,1] -> step at midpoint 0.25', () => {
  const fit = fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]);
  assert.deepEqual(fit.bins, [{ hi: 0.25, p: 0 }, { hi: null, p: 1 }]);
});

test('isotonic apply semantics: inclusive upper bound, flat extrapolation, hand-checked values', () => {
  const { bins } = fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]);
  const ser = serializeCalibratorBundle({ kind: 'ISOTONIC', bins, meta: META });
  const loaded = loadCalibratorBundle({ bundle: ser.bundle, bundleSha: ser.bundleSha });
  assert.ok(loaded.ok);
  assert.equal(loaded.apply(0.05), 0);
  assert.equal(loaded.apply(0.25), 0); // score <= hi: boundary belongs to the lower bin
  assert.equal(loaded.apply(0.25001), 1);
  assert.equal(loaded.apply(0.4), 1);
  assert.equal(loaded.apply(0.99), 1); // flat extrapolation above the last boundary
});

test('isotonic fit pools violators: [0,1,0,1] -> 0 / 0.5 / 1 with boundaries at 0.15 and 0.35', () => {
  const fit = fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 1, 0, 1]);
  assert.deepEqual(fit.bins, [{ hi: 0.15, p: 0 }, { hi: 0.35, p: 0.5 }, { hi: null, p: 1 }]);
  const ser = serializeCalibratorBundle({ kind: 'ISOTONIC', bins: fit.bins, meta: META });
  const loaded = loadCalibratorBundle({ bundle: ser.bundle, bundleSha: ser.bundleSha });
  assert.ok(loaded.ok);
  assert.equal(loaded.apply(0.2), 0.5);
  assert.equal(loaded.apply(0.35), 0.5);
  assert.equal(loaded.apply(0.36), 1);
});

test('fitting is deterministic: identical inputs produce byte-identical canonical bundles and identical SHAs', () => {
  const a = serializeCalibratorBundle({ kind: 'ISOTONIC', bins: fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]).bins, meta: META });
  const b = serializeCalibratorBundle({ kind: 'ISOTONIC', bins: fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]).bins, meta: META });
  assert.equal(a.canonical, b.canonical);
  assert.equal(a.bundleSha, b.bundleSha);
  // key insertion order in the source object never changes the canonical form
  const reordered = { meta: META, calibrator: { bins: fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]).bins }, kind: 'ISOTONIC', format: BUNDLE_FORMAT };
  const c = pinCalibratorBundle(reordered);
  assert.equal(c.bundleSha, a.bundleSha);
});

test('pin -> load roundtrip: the loaded calibrator applies exactly the fitted bins', () => {
  const bins = fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 1, 0, 1]).bins;
  const ser = serializeCalibratorBundle({ kind: 'ISOTONIC', bins, meta: META });
  const pinned = pinCalibratorBundle(ser.bundle);
  const loaded = loadCalibratorBundle({ bundle: pinned.bundle, bundleSha: pinned.bundleSha });
  assert.ok(loaded.ok);
  assert.equal(loaded.calibrationState, 'CALIBRATED');
  assert.equal(loaded.apply(0.2), 0.5);
  assert.equal(loaded.bundleSha, pinned.bundleSha);
});

test('tampering ANY value in the bundle is refused by the SHA pin: parameters', () => {
  const bins = fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]).bins;
  const ser = serializeCalibratorBundle({ kind: 'ISOTONIC', bins, meta: META });
  const tampered = { ...ser.bundle, calibrator: { bins: [...bins.slice(0, 1), { hi: null, p: 0.9 }] } };
  const loaded = loadCalibratorBundle({ bundle: tampered, bundleSha: ser.bundleSha });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'TAMPERED_BUNDLE');
});

test('tampering ANY value in the bundle is refused by the SHA pin: metadata (trainedOnCount)', () => {
  const bins = fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]).bins;
  const ser = serializeCalibratorBundle({ kind: 'ISOTONIC', bins, meta: META });
  const tampered = { ...ser.bundle, meta: { ...META, trainedOnCount: 999 } };
  const loaded = loadCalibratorBundle({ bundle: tampered, bundleSha: ser.bundleSha });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'TAMPERED_BUNDLE');
});

test('the V1 cap-0.738 monotone-transform defect class is structurally refused: NON_MONOTONIC_CALIBRATOR', () => {
  const ser = serializeCalibratorBundle({
    kind: 'ISOTONIC',
    bins: [{ hi: 0.5, p: 0.8 }, { hi: null, p: 0.2 }],
    meta: META,
  });
  const loaded = loadCalibratorBundle({ bundle: ser.bundle, bundleSha: ser.bundleSha });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'NON_MONOTONIC_CALIBRATOR');
});

test('calibration state derives ONLY from recorded holdout evidence (decision-record C1 discipline)', () => {
  const bins = fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]).bins;
  const noHoldout = serializeCalibratorBundle({ kind: 'ISOTONIC', bins, meta: { ...META, holdout: null } });
  const l1 = loadCalibratorBundle({ bundle: noHoldout.bundle, bundleSha: noHoldout.bundleSha });
  assert.equal(l1.calibrationState, 'UNCALIBRATED'); // applies, but can never stamp CALIBRATED

  const smallHoldout = serializeCalibratorBundle({
    kind: 'ISOTONIC', bins, meta: { ...META, holdout: { holdoutSize: MIN_HOLDOUT_FOR_CALIBRATED - 1, brier: 0.2, ece: 0.05 } },
  });
  const l2 = loadCalibratorBundle({ bundle: smallHoldout.bundle, bundleSha: smallHoldout.bundleSha });
  assert.equal(l2.calibrationState, 'UNCALIBRATED'); // below the pre-registered minimum
});

test('Platt scaling: finite parameters, (0,1) outputs, positive slope on a positive fixture, deterministic', () => {
  const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const outcomes = [0, 0, 0, 1, 0, 1, 1, 1];
  const fit = fitPlatt(scores, outcomes);
  const fit2 = fitPlatt(scores, outcomes);
  assert.deepEqual(fit.params, fit2.params); // determinism
  assert.ok(Number.isFinite(fit.params.a) && Number.isFinite(fit.params.b));
  assert.ok(fit.params.a > 0, 'positively associated fixture must yield a positive slope');
  const p = (s) => 1 / (1 + Math.exp(-(fit.params.a * s + fit.params.b)));
  for (const s of [0, 0.5, 1]) assert.ok(p(s) > 0 && p(s) < 1);
  assert.ok(p(0.9) > p(0.1), 'platt output is monotone in the score when slope is positive');
});

test('empty or malformed fit inputs are refused, never guessed', () => {
  assert.equal(fitIsotonic([], []).error, 'EMPTY_FIT_INPUT');
  assert.equal(fitIsotonic([0.1, 0.2], [0]).error, 'EMPTY_FIT_INPUT');
  assert.equal(fitPlatt([], []).error, 'EMPTY_FIT_INPUT');
  assert.equal(fitPlatt([0.1, 0.2], [0.5, 1]).error, 'INVALID_OUTCOMES');
  assert.equal(fitIsotonic([0.1, NaN], [0, 1]).error, 'NON_FINITE_FIT_INPUT');
});

test('unsupported bundle versions and broken metadata are refused at load', () => {
  const bins = fitIsotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]).bins;
  const wrongFormat = pinCalibratorBundle({ ...serializeCalibratorBundle({ kind: 'ISOTONIC', bins, meta: META }).bundle, format: 'V1_CONFIDENCE_V0' });
  assert.equal(wrongFormat.error, 'UNSUPPORTED_BUNDLE_VERSION');

  const noHorizon = serializeCalibratorBundle({ kind: 'ISOTONIC', bins, meta: { ...META, horizonMinutes: 0 } });
  const l1 = loadCalibratorBundle({ bundle: noHorizon.bundle, bundleSha: noHorizon.bundleSha });
  assert.equal(l1.code, 'HORIZON_REQUIRED');

  const noOutcomeDef = serializeCalibratorBundle({ kind: 'ISOTONIC', bins, meta: { ...META, outcomeDefinition: 'WIN_RATE' } });
  const l2 = loadCalibratorBundle({ bundle: noOutcomeDef.bundle, bundleSha: noOutcomeDef.bundleSha });
  assert.equal(l2.code, 'OUTCOME_DEFINITION_REQUIRED');

  const unknownKind = serializeCalibratorBundle({ kind: 'ISOTONIC', bins, meta: META });
  const l3 = loadCalibratorBundle({ bundle: { ...unknownKind.bundle, kind: 'MAGIC' }, bundleSha: 'x'.repeat(64) });
  assert.equal(l3.code, 'TAMPERED_BUNDLE'); // hash breaks before kind is even read
});
