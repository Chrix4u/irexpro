'use strict';
/**
 * Tests for the E-10 full-scale campaign module (multi-instrument matrix
 * and walk-forward variant). Small sizes for CI; the full-scale run is a
 * committed artifact executed by the CLI runner.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  meanAndInterval95,
  sliceMarket,
  runWalkForwardCampaign,
  runMultiInstrumentMatrix,
} = require('./v2-e10-campaign.cjs');
const { generateMarketPath } = require('./v2-synthetic-market.cjs');

test('meanAndInterval95 refuses unestimable cells, never guesses', () => {
  assert.throws(() => meanAndInterval95([]), /E10_REPLAYS_INVALID/);
  const small = meanAndInterval95([1, 2, 3]);
  assert.strictEqual(small.mean, null);
  assert.ok(small.refused.startsWith('E10_INSUFFICIENT_REPLAYS'));
});

test('meanAndInterval95 computes mean and symmetric 95% interval at n>=30', () => {
  const samples = Array.from({ length: 30 }, (_, i) => i + 1);
  const r = meanAndInterval95(samples);
  const mean = (30 * 31) / 2 / 30;
  assert.strictEqual(r.n, 30);
  assert.ok(Math.abs(r.mean - mean) < 1e-12);
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / 29;
  const se = Math.sqrt(variance / 30);
  assert.ok(Math.abs(r.interval95[0] - (mean - 1.959964 * se)) < 1e-9);
  assert.ok(Math.abs(r.interval95[1] - (mean + 1.959964 * se)) < 1e-9);
});

test('sliceMarket re-indexes bars and ground truth chronologically', () => {
  const market = generateMarketPath({ seed: 4150001, nBars: 1200, scenario: 'TREND_REGIMES' });
  const sliced = sliceMarket(market, 400, 900);
  assert.strictEqual(sliced.nBars, 500);
  assert.strictEqual(sliced.bars[0].i, 400); // original index preserved on bars
  for (const p of sliced.groundTruth.reversalPoints) {
    assert.ok(p.bar >= 0 && p.bar < 500, 'reversal bars re-indexed into slice');
  }
  // The parent bar of each sliced reversal point is within the slice window.
  const parent = market.groundTruth.reversalPoints
    .filter((p) => p.bar >= 400 && p.bar < 900);
  assert.strictEqual(sliced.groundTruth.reversalPoints.length, parent.length);
  for (let i = 0; i < parent.length; i += 1) {
    assert.strictEqual(sliced.groundTruth.reversalPoints[i].bar, parent[i].bar - 400);
  }
});

test('walk-forward: chronological folds, closed positions, cumulative identity', () => {
  const wf = runWalkForwardCampaign({ seed: 4510001, nBars: 1600, folds: 4 });
  assert.strictEqual(wf.folds, 4);
  assert.strictEqual(wf.foldResults.length, 4);
  // Chronological coverage: folds are contiguous and ordered.
  for (let f = 0; f < wf.foldResults.length; f += 1) {
    assert.strictEqual(wf.foldResults[f].fold, f);
    if (f > 0) {
      assert.strictEqual(wf.foldResults[f].fromBar, wf.foldResults[f - 1].toBar);
    }
  }
  assert.strictEqual(wf.foldResults[0].fromBar, 0);
  assert.strictEqual(wf.foldResults[wf.foldResults.length - 1].toBar, wf.nBars);
  // Cumulative identity: the curve equals the running sum of fold deltas.
  let run = 0;
  for (let f = 0; f < wf.foldResults.length; f += 1) {
    run += wf.foldResults[f].pairedDeltaNetR;
    assert.ok(Math.abs(wf.cumulativeCurve[f + 1] - run) < 1e-12);
  }
  assert.ok(Math.abs(wf.cumulativeDeltaNetR - run) < 1e-12);
  // Aggregate over folds is a typed refusal below 30 folds by design.
  assert.ok(wf.aggregateDelta.refused !== undefined || Number.isFinite(wf.aggregateDelta.mean));
  assert.ok(wf.leakageControl.includes('no parameter is re-fitted'));
  assert.ok(wf.leakageControl.includes('temporal-stability check'));
});

test('walk-forward refusals', () => {
  assert.throws(() => runWalkForwardCampaign({ folds: 1, seed: 1, nBars: 800 }),
    /E10_FOLDS_INVALID/);
  assert.throws(() => runWalkForwardCampaign({ folds: 4, seed: -1, nBars: 800 }),
    /E10_SEED_INVALID/);
});

test('multi-instrument matrix: cells, refusals below 30 replays, determinism', () => {
  const config = {
    instruments: ['EURUSD'],
    scenarios: ['TREND_REGIMES'],
    replaysPerCell: 2,
    nBars: 600,
    seedBase: 4140000,
  };
  const m1 = runMultiInstrumentMatrix(config);
  assert.strictEqual(m1.cells.length, 1);
  assert.strictEqual(m1.totalPairedReplays, 2);
  const cell = m1.cells[0].aggregate;
  // Typed refusal: 2 replays is not estimable.
  assert.ok(cell.challengerNetR.refused.startsWith('E10_INSUFFICIENT_REPLAYS'));
  // Determinism: identical config -> identical aggregate means.
  const m2 = runMultiInstrumentMatrix(config);
  assert.deepStrictEqual(
    m1.cells[0].aggregate.challengerTradesPerReplay.n,
    m2.cells[0].aggregate.challengerTradesPerReplay.n);
  assert.strictEqual(
    m1.cells[0].aggregate.challengerTradesPerReplay.mean,
    m2.cells[0].aggregate.challengerTradesPerReplay.mean);
});

test('matrix refusals', () => {
  assert.throws(() => runMultiInstrumentMatrix({ replaysPerCell: 0 }),
    /E10_REPLAYS_INVALID/);
  assert.throws(() => runMultiInstrumentMatrix({ replaysPerCell: 5, nBars: 100 }),
    /E10_CELL_INVALID/);
  assert.throws(() => runMultiInstrumentMatrix({ replaysPerCell: 5, nBars: 600, seedBase: 0 }),
    /E10_SEED_INVALID/);
});
