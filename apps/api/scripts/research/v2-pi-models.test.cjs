'use strict';
/**
 * Tests for the PI candidate models (PI-4): deterministic fits, exact
 * prior baselines, linear recovery by logistic and ridge, recency
 * adaptation by the temporal model, nonlinear advantage by boosted stumps,
 * AR(p) coefficient recovery, regime classification vs ground truth, and
 * typed refusals.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createPriorDirectionModel,
  createPriorRegressionModel,
  createLogisticL2,
  createRecencyWeightedLogistic,
  createRidgeRegression,
  createARp,
  createBoostedStumps,
  createBoostedStumpsRegression,
  createRegimeClassifier,
  sigmoid,
} = require('./v2-pi-models.cjs');
const { FEATURE_NAMES, fitScaler, applyScaler } = require('./v2-prediction-dataset.cjs');
const { generatePiFixture } = require('./v2-pi-market-fixtures.cjs');
const { buildPredictionOpportunities } = require('./v2-prediction-dataset.cjs');

// Deterministic pseudo-features for hand-made rows.
function mkRow(featureValues, labels, t = 0, symbol = 'TEST') {
  const features = {};
  FEATURE_NAMES.forEach((name, i) => { features[name] = featureValues[i] ?? 0; });
  return Object.freeze({
    symbol, m5Index: t, t, features: Object.freeze(features),
    labels: Object.freeze(labels),
  });
}

function scaledRows(rows) {
  const scaler = fitScaler(rows);
  return { scaler, rows };
}

test('prior baselines are exact: base rate and mean, deterministic', () => {
  const rows = [
    mkRow([0], { up: 1 }), mkRow([0], { up: 0 }), mkRow([0], { up: 1 }),
    mkRow([0], { up: 0 }), mkRow([0], { up: 1 }),
  ];
  const prior = createPriorDirectionModel().fit(rows, { labelKey: 'up' });
  assert.strictEqual(prior.predict().p, 3 / 5);
  assert.strictEqual(prior.complexity.paramCount, 1);
  assert.strictEqual(prior.family, 'classical');

  const regRows = [
    mkRow([0], { fwdR: 0.1 }), mkRow([0], { fwdR: -0.2 }), mkRow([0], { fwdR: 0.4 }),
  ];
  const priorReg = createPriorRegressionModel().fit(regRows, { labelKey: 'fwdR' });
  assert.ok(Math.abs(priorReg.predict().value - 0.1) < 1e-12);
});

test('logistic L2 recovers a linear signal deterministically', () => {
  // Label follows the sign of feature m5Mom (index 2).
  const rows = [];
  for (let i = 0; i < 400; i += 1) {
    const x = (i % 2 === 0 ? 1 : -1) * (0.5 + 0.1 * (i % 17));
    const featureValues = FEATURE_NAMES.map(() => 0);
    featureValues[2] = x;
    rows.push(mkRow(featureValues, { up: x > 0 ? 1 : 0 }, i));
  }
  const { scaler } = scaledRows(rows);
  const modelA = createLogisticL2({ iterations: 200 }).fit(rows, { labelKey: 'up', scaler });
  const modelB = createLogisticL2({ iterations: 200 }).fit(rows, { labelKey: 'up', scaler });
  // Determinism: identical weights -> identical predictions.
  let acc = 0;
  for (const row of rows) {
    const s = applyScaler(scaler, row.features);
    const pa = modelA.predict(s).p;
    const pb = modelB.predict(s).p;
    assert.strictEqual(pa, pb);
    if ((pa > 0.5 ? 1 : 0) === row.labels.up) acc += 1;
  }
  assert.ok(acc / rows.length > 0.8, `train accuracy ${acc / rows.length}`);
  assert.strictEqual(modelA.complexity.paramCount, FEATURE_NAMES.length + 1);
});

test('recency-weighted logistic adapts to a mid-series relation flip', () => {
  // First half: label = +m5Mom; second half: label = -m5Mom. Magnitude
  // cycles are identical in both halves (12 full residue cycles each), so
  // the plain full-batch gradient cancels exactly and it cannot learn
  // either relation, while the recency-weighted fit follows the late one.
  const rows = [];
  for (let i = 0; i < 624; i += 1) {
    const a = 0.4 + 0.05 * (Math.floor(i / 2) % 13);
    const x = i % 2 === 0 ? a : -a;
    const featureValues = FEATURE_NAMES.map(() => 0);
    featureValues[2] = x;
    const flip = i >= 312;
    rows.push(mkRow(featureValues, { up: (flip ? -1 : 1) * x > 0 ? 1 : 0 }, i));
  }
  const { scaler } = scaledRows(rows);
  const plain = createLogisticL2({ iterations: 200 }).fit(rows, { labelKey: 'up', scaler });
  const recent = createRecencyWeightedLogistic({ decay: 0.995, iterations: 200 })
    .fit(rows, { labelKey: 'up', scaler });
  const late = rows.slice(312);
  const accOf = (model) => {
    let acc = 0;
    for (const row of late) {
      const s = applyScaler(scaler, row.features);
      if ((model.predict(s).p > 0.5 ? 1 : 0) === row.labels.up) acc += 1;
    }
    return acc / late.length;
  };
  const accPlain = accOf(plain);
  const accRecent = accOf(recent);
  // Plain full-batch fit sits at the chance boundary (exactly contradictory
  // labels; at most fp-noise tie-breaking, never a learned late relation).
  assert.ok(accPlain < 0.75, `plain late accuracy ${accPlain} (chance expected)`);
  assert.ok(accRecent > accPlain + 0.2, `recent ${accRecent} vs plain ${accPlain}`);
  assert.strictEqual(recent.family, 'temporal');
});

test('boosted stumps capture a nonlinear (interval) pattern that logistic misses', () => {
  // Label = 1 iff |m5Mom| is LARGE (a "V" pattern, not linearly separable).
  const rows = [];
  for (let i = 0; i < 500; i += 1) {
    const x = ((i % 21) - 10) / 10;
    const featureValues = FEATURE_NAMES.map(() => 0);
    featureValues[2] = x;
    rows.push(mkRow(featureValues, { up: Math.abs(x) > 0.5 ? 1 : 0 }, i));
  }
  const { scaler } = scaledRows(rows);
  const logistic = createLogisticL2({ iterations: 300 }).fit(rows, { labelKey: 'up', scaler });
  const stumps = createBoostedStumps({ rounds: 30 }).fit(rows, { labelKey: 'up', scaler });
  const accOf = (model) => {
    let acc = 0;
    for (const row of rows) {
      const s = applyScaler(scaler, row.features);
      if ((model.predict(s).p > 0.5 ? 1 : 0) === row.labels.up) acc += 1;
    }
    return acc / rows.length;
  };
  const accLogistic = accOf(logistic);
  const accStumps = accOf(stumps);
  assert.ok(accStumps - accLogistic > 0.1, `stumps ${accStumps} vs logistic ${accLogistic}`);
  assert.ok(accStumps > 0.85, `stumps accuracy ${accStumps}`);
  assert.strictEqual(stumps.family, 'boosted');
  assert.strictEqual(stumps.complexity.paramCount, 30 * 3);
});

test('ridge regression recovers an exact linear relation', () => {
  // y = 0.8*f1 - 0.4*f7 + 0.25 exactly (noiseless).
  const rows = [];
  for (let i = 0; i < 200; i += 1) {
    const featureValues = FEATURE_NAMES.map(() => ((i * 7 + FEATURE_NAMES.length) % 23) / 23 - 0.5);
    const y = 0.8 * featureValues[1] - 0.4 * featureValues[7] + 0.25;
    rows.push(mkRow(featureValues, { fwdR: y }, i));
  }
  const { scaler } = scaledRows(rows);
  const ridge = createRidgeRegression({ lambda: 1e-6 }).fit(rows, { labelKey: 'fwdR', scaler });
  let maxErr = 0;
  for (const row of rows) {
    const s = applyScaler(scaler, row.features);
    const err = Math.abs(ridge.predict(s).value - row.labels.fwdR);
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr < 1e-6, `max prediction error ${maxErr}`);
});

test('AR(1) coefficient recovered from a synthetic autoregressive series', () => {
  // fwdR_i = 0.6 * fwdR_{i-1} + noise (hand-built, deterministic).
  const rows = [];
  let prev = 0.05;
  for (let i = 0; i < 800; i += 1) {
    const noise = Math.sin(i * 12.9898) * 0.4; // deterministic "noise"
    const v = 0.6 * prev + noise;
    rows.push(mkRow([0], { fwdR: v }, i * 12));
    prev = v;
  }
  const ar = createARp({ p: 1 }).fit(rows, { labelKey: 'fwdR' });
  // Check the recovered lag-1 relation on held-out rows.
  const testRows = rows.slice(600);
  let sse = 0;
  let sst = 0;
  const mean = testRows.reduce((s, r) => s + r.labels.fwdR, 0) / testRows.length;
  for (let i = 1; i < testRows.length; i += 1) {
    const pred = ar.predictFeatures([testRows[i - 1].labels.fwdR]).value;
    sse += (pred - testRows[i].labels.fwdR) ** 2;
    sst += (testRows[i].labels.fwdR - mean) ** 2;
  }
  const r2 = 1 - sse / sst;
  assert.ok(r2 > 0.3, `AR(1) out-of-sample R^2 ${r2}`);
  assert.strictEqual(ar.family, 'temporal');
});

test('regime classifier beats the majority baseline on regime fixtures', () => {
  const fx = generatePiFixture({
    seed: 7300001, scenario: 'PI_TREND_REGIMES', symbols: ['EURUSD'], days: 20,
  });
  const dataset = buildPredictionOpportunities(fx);
  const clf = createRegimeClassifier();
  clf.fit(dataset.rows);
  const counts = {};
  let correct = 0;
  for (const row of dataset.rows) {
    counts[row.regime] = (counts[row.regime] || 0) + 1;
    if (clf.classify(row.features) === row.regime) correct += 1;
  }
  const n = dataset.rows.length;
  const majority = Math.max(...Object.values(counts)) / n;
  const acc = correct / n;
  assert.ok(acc > majority, `classifier ${acc} vs majority ${majority}`);
  assert.ok(acc > 0.3, `classifier accuracy ${acc}`);
  assert.deepStrictEqual(Object.keys(counts).sort(), ['HIGH_VOL', 'RANGE', 'TREND_DOWN', 'TREND_UP']);
});

test('typed refusals on malformed model inputs', () => {
  assert.throws(() => createPriorDirectionModel().fit([], { labelKey: 'up' }), /MODEL_ROWS_REQUIRED/);
  const bad = [mkRow([0], { up: 2 })];
  assert.throws(() => createPriorDirectionModel().fit(bad, { labelKey: 'up' }), /MODEL_LABEL_INVALID/);
  const nanRow = [mkRow([NaN], { up: 1 })];
  const scaler = fitScaler(nanRow);
  assert.throws(() => createLogisticL2().fit(nanRow, { labelKey: 'up', scaler }), /MODEL_FEATURE_INVALID/);
  assert.throws(() => createARp({ p: 0 }), /MODEL_AR_P_INVALID/);
  const few = [mkRow([0], { fwdR: 0.1 }), mkRow([0], { fwdR: 0.2 })];
  assert.throws(() => createARp({ p: 5 }).fit(few, { labelKey: 'fwdR' }), /MODEL_AR_INSUFFICIENT_ROWS/);
  assert.throws(() => createARp({ p: 5 }).predictFeatures([0.1, 0.2]), /MODEL_AR_UNFITTED/);
  // Unfitted model refuses cleanly.
  const unfitted = createARp({ p: 2 });
  assert.throws(() => unfitted.predictFeatures([0.1, 0.2]), /MODEL_AR_UNFITTED/);
});

test('sigmoid and stumps-regression are deterministic and finite', () => {
  assert.ok(Math.abs(sigmoid(0) - 0.5) < 1e-12);
  assert.ok(Math.abs(sigmoid(1e9) - 1) < 1e-12);
  assert.ok(Math.abs(sigmoid(-1e9)) < 1e-12);
  // Regression stumps on a noisy linear target: deterministic predictions.
  const rows = [];
  for (let i = 0; i < 300; i += 1) {
    const featureValues = FEATURE_NAMES.map(() => ((i * 13 + 5) % 31) / 31 - 0.5);
    const y = 0.5 * featureValues[3] + 0.1 * Math.sin(i);
    rows.push(mkRow(featureValues, { fwdR: y }, i));
  }
  const { scaler } = scaledRows(rows);
  const m1 = createBoostedStumpsRegression({ rounds: 20 }).fit(rows, { labelKey: 'fwdR', scaler });
  const m2 = createBoostedStumpsRegression({ rounds: 20 }).fit(rows, { labelKey: 'fwdR', scaler });
  for (const row of rows.slice(0, 50)) {
    const s = applyScaler(scaler, row.features);
    assert.strictEqual(m1.predict(s).value, m2.predict(s).value);
    assert.ok(Number.isFinite(m1.predict(s).value));
  }
});
