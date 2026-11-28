'use strict';
/**
 * Tests for the common prediction-opportunity dataset (PI-3): identical
 * outcome definitions on the full grid, no-future-peek feature proof,
 * non-overlapping decision spacing, purge + embargo walk-forward splits,
 * held-out preservation, and scaler refusals.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  COMMON_OUTCOME_DEFINITIONS,
  FEATURE_NAMES,
  buildPredictionOpportunities,
  featureVector,
  buildChronologicalSplits,
  reserveHeldOut,
  fitScaler,
  applyScaler,
} = require('./v2-prediction-dataset.cjs');
const { generatePiFixture } = require('./v2-pi-market-fixtures.cjs');

function buildSmallDataset() {
  const fx = generatePiFixture({
    seed: 6100001, scenario: 'PI_TREND_REGIMES',
    symbols: ['EURUSD', 'GBPUSD'], days: 12,
  });
  const dataset = buildPredictionOpportunities(fx);
  return { fx, dataset };
}

test('dataset builds the common grid with identical outcome definitions', () => {
  const { dataset } = buildSmallDataset();
  assert.ok(dataset.rows.length > 100, `rows=${dataset.rows.length}`);
  assert.deepStrictEqual([...dataset.symbols], ['EURUSD', 'GBPUSD']);
  // Identical definitions object for every candidate.
  assert.strictEqual(dataset.outcomeDefinitions.horizonM5, 12);
  assert.strictEqual(dataset.outcomeDefinitions.sampleEveryM5, 12);
  assert.ok(dataset.outcomeDefinitions.grid.includes('FULL common grid'));
  assert.ok(dataset.outcomeDefinitions.grid.includes('never shrinks the evaluation denominator'));
  // Every row carries the full label set and the full feature set.
  for (const row of dataset.rows.slice(0, 20)) {
    for (const key of ['up', 'cont', 'rev', 'fwd', 'past', 'sigmaW', 'fwdR', 'costR']) {
      assert.ok(row.labels[key] !== undefined);
    }
    for (const name of FEATURE_NAMES) {
      assert.ok(Number.isFinite(row.features[name]), `feature ${name}`);
    }
    assert.ok(row.labels.costR > 0);
  }
  // Fixed feature-vector order.
  const vec = featureVector(dataset.rows[0]);
  assert.strictEqual(vec.length, FEATURE_NAMES.length);
});

test('label definitions recomputed independently reconcile exactly', () => {
  const { fx, dataset } = buildSmallDataset();
  const sym = fx.series.EURUSD;
  const m5 = sym.M5.bars;
  const spec = { spreadPips: 0.8 + 0.2, pip: 0.0001 };
  let checked = 0;
  for (const row of dataset.rows.filter((r) => r.symbol === 'EURUSD').slice(0, 30)) {
    const i = row.m5Index;
    const fwd = m5[i + 12].close / m5[i].close - 1;
    const past = Math.log(m5[i].close / m5[i - 12].close);
    const up = fwd > 0 ? 1 : 0;
    const cont = (past > 0 && fwd > 0) || (past < 0 && fwd < 0) ? 1 : 0;
    assert.strictEqual(row.labels.up, up);
    assert.strictEqual(row.labels.fwd, fwd);
    assert.strictEqual(row.labels.past, past);
    if (row.labels.cont !== cont) {
      // Only reachable if definitions drift — identical by construction.
      assert.fail(`cont mismatch at i=${i}`);
    }
    assert.strictEqual(row.labels.costR > 0, true);
    checked += 1;
  }
  assert.ok(checked >= 25);
  void spec;
});

test('no-future-peek proof: mutating bars after the decision time leaves features unchanged', () => {
  const fx = generatePiFixture({
    seed: 6100002, scenario: 'PI_NULL', symbols: ['EURUSD'], days: 6,
  });
  const datasetA = buildPredictionOpportunities(fx);
  const probe = datasetA.rows[Math.floor(datasetA.rows.length / 2)];
  const cutT = probe.t; // decision time
  // Deep-mutate every M1 and M5 bar strictly after the decision time.
  const m1 = fx.series.EURUSD.M1.bars.map((b) => ({ ...b }));
  const m5 = fx.series.EURUSD.M5.bars.map((b) => ({ ...b }));
  for (const b of m1) {
    if (b.t >= cutT) {
      b.open *= 1.05; b.high *= 1.05; b.low *= 1.05; b.close *= 1.05;
    }
  }
  for (const b of m5) {
    if (b.t >= cutT) {
      b.open *= 1.05; b.high *= 1.05; b.low *= 1.05; b.close *= 1.05;
    }
  }
  const mutated = generatePiFixture({
    seed: 6100002, scenario: 'PI_NULL', symbols: ['EURUSD'], days: 6,
  });
  // Rebuild using the mutated M1 series (fixture regeneration then swap).
  const mutatedFixture = {
    ...mutated,
    series: {
      ...mutated.series,
      EURUSD: {
        ...mutated.series.EURUSD,
        M1: { ...mutated.series.EURUSD.M1, bars: m1 },
        M5: { ...mutated.series.EURUSD.M5, bars: m5 },
      },
    },
  };
  const datasetB = buildPredictionOpportunities(mutatedFixture);
  const probeB = datasetB.rows.find((r) => r.t === probe.t && r.symbol === probe.symbol);
  assert.ok(probeB, 'probe row missing');
  for (const name of FEATURE_NAMES) {
    assert.strictEqual(probe.features[name], probeB.features[name], `feature ${name} peeked`);
  }
  // Labels legitimately change (they look forward) — proving the test is
  // sensitive to future data.
  assert.notStrictEqual(probe.labels.fwd, probeB.labels.fwd);
});

test('decision spacing equals the label horizon (non-overlapping outcomes)', () => {
  const { dataset } = buildSmallDataset();
  const bySymbol = new Map();
  for (const row of dataset.rows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row);
  }
  for (const [, rows] of bySymbol) {
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(rows[i].m5Index - rows[i - 1].m5Index >= 12, 'overlapping label windows');
    }
  }
});

test('walk-forward splits enforce purge + embargo chronology', () => {
  const { dataset } = buildSmallDataset();
  const splits = buildChronologicalSplits(dataset, { nFolds: 5 });
  assert.strictEqual(splits.folds.length, 4);
  for (const fold of splits.folds) {
    assert.ok(fold.train.length > 0 && fold.test.length > 0);
    // Per symbol: every training index is at least purge+embargo bars
    // before the first test index.
    const bySymbol = new Map();
    for (const row of [...fold.train, ...fold.test]) {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, { train: [], test: [] });
    }
    for (const row of fold.train) bySymbol.get(row.symbol).train.push(row.m5Index);
    for (const row of fold.test) bySymbol.get(row.symbol).test.push(row.m5Index);
    for (const [symbol, idx] of bySymbol) {
      const firstTest = Math.min(...idx.test);
      for (const ti of idx.train) {
        assert.ok(ti < firstTest - 24, `fold ${fold.fold} ${symbol}: train idx ${ti} too close to test ${firstTest}`);
      }
    }
    // Train and test are disjoint by construction of the fold windows.
    const trainSet = new Set(fold.train.map((r) => `${r.symbol}:${r.m5Index}`));
    for (const r of fold.test) {
      assert.ok(!trainSet.has(`${r.symbol}:${r.m5Index}`));
    }
  }
});

test('held-out reservation is chronological, disjoint and preserved', () => {
  const { dataset } = buildSmallDataset();
  const { dev, heldOut, fraction } = reserveHeldOut(dataset, { fraction: 0.25 });
  assert.strictEqual(fraction, 0.25);
  assert.strictEqual(dev.length + heldOut.length, dataset.rows.length);
  const devSet = new Set(dev.map((r) => `${r.symbol}:${r.m5Index}`));
  for (const r of heldOut) assert.ok(!devSet.has(`${r.symbol}:${r.m5Index}`));
  // Per symbol: every dev timestamp strictly precedes every held-out one.
  const bySymbol = new Map();
  for (const row of [...dev, ...heldOut]) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, { dev: [], heldOut: [] });
  }
  for (const row of dev) bySymbol.get(row.symbol).dev.push(row.t);
  for (const row of heldOut) bySymbol.get(row.symbol).heldOut.push(row.t);
  for (const [symbol, times] of bySymbol) {
    const maxDev = Math.max(...times.dev);
    const minHeld = Math.min(...times.heldOut);
    assert.ok(maxDev < minHeld, `${symbol}: held-out not chronological`);
  }
});

test('scaler fits on train rows only and transforms deterministically', () => {
  const { dataset } = buildSmallDataset();
  const train = dataset.rows.slice(0, 60);
  const scaler = fitScaler(train);
  const t1 = applyScaler(scaler, dataset.rows[100].features);
  const t2 = applyScaler(scaler, dataset.rows[100].features);
  assert.deepStrictEqual(t1, t2);
  assert.ok(Object.keys(t1).length === FEATURE_NAMES.length);
  assert.throws(() => fitScaler([]), /DATASET_ROWS_REQUIRED/);
  assert.throws(() => reserveHeldOut(dataset, { fraction: 0.9 }), /DATASET_SPLIT_INVALID/);
  assert.throws(() => buildChronologicalSplits(dataset, { nFolds: 1 }), /DATASET_SPLIT_INVALID/);
  assert.throws(() => buildPredictionOpportunities(null), /DATASET_FIXTURE_REQUIRED/);
});

test('regime ground truth is carried on the grid where the scenario provides it', () => {
  const { dataset } = buildSmallDataset();
  // PI_TREND_REGIMES rows carry labels from the episode ground truth.
  const labeled = dataset.rows.filter((r) => r.regime !== null);
  assert.ok(labeled.length === dataset.rows.length);
  for (const row of labeled.slice(0, 50)) {
    assert.ok(['TREND_UP', 'TREND_DOWN', 'RANGE', 'HIGH_VOL'].includes(row.regime));
  }
});
