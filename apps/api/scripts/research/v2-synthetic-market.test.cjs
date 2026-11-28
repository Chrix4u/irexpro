'use strict';
/** Tests for the deterministic synthetic market generator (P2-1). */

const test = require('node:test');
const assert = require('node:assert');

const {
  SYNTHETIC_SCENARIOS,
  generateMarketPath,
  recoverPlantedDrift,
  mulberry32,
} = require('./v2-synthetic-market.cjs');

test('paths are deterministic for the same seed and config', () => {
  const a = generateMarketPath({ seed: 20261128, nBars: 500, scenario: 'EDGE_ZERO' });
  const b = generateMarketPath({ seed: 20261128, nBars: 500, scenario: 'EDGE_ZERO' });
  assert.deepStrictEqual(a, b);
  const c = generateMarketPath({ seed: 20261129, nBars: 500, scenario: 'EDGE_ZERO' });
  assert.notDeepStrictEqual(a, c);
});

test('planted drift is recovered within 3 sigma on a long path', () => {
  const path = generateMarketPath({
    seed: 811201, nBars: 20000, scenario: 'PLANTED_DRIFT',
    plantedDriftPerBarSigma: 0.06,
  });
  const { realized, planted, z } = recoverPlantedDrift(path);
  assert.ok(Math.abs(z) < 3, `drift not recovered: realized=${realized} planted=${planted} z=${z}`);
});

test('zero-edge paths have drift z within 3 sigma (null calibration)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const path = generateMarketPath({ seed, nBars: 20000, scenario: 'EDGE_ZERO' });
    const { z } = recoverPlantedDrift(path);
    assert.ok(Math.abs(z) < 3, `seed ${seed} z=${z}`);
  }
});

test('trend-regime paths expose regime episodes and reversal ground truth', () => {
  const path = generateMarketPath({
    seed: 424242, nBars: 5000, scenario: 'TREND_REGIMES', trendRegimeMeanBars: 600,
  });
  assert.ok(path.groundTruth.regimeEpisodes.length >= 3);
  assert.ok(path.groundTruth.reversalPoints.length >= 3);
  for (const episode of path.groundTruth.regimeEpisodes) {
    assert.ok(episode.toBar >= episode.fromBar);
  }
  // Episodes tile the path.
  const covered = path.groundTruth.regimeEpisodes
    .reduce((s, e) => s + (e.toBar - e.fromBar + 1), 0);
  assert.strictEqual(covered, path.nBars);
});

test('bars are OHLC-consistent and strictly ordered', () => {
  const path = generateMarketPath({ seed: 99, nBars: 1000, scenario: 'REVERSION' });
  let previousT = -1;
  for (const bar of path.bars) {
    assert.ok(bar.high >= Math.max(bar.open, bar.close));
    assert.ok(bar.low <= Math.min(bar.open, bar.close));
    assert.ok(bar.high > bar.low);
    assert.ok(bar.close > 0);
    assert.ok(bar.spreadPips > 0);
    assert.ok(bar.t > previousT);
    previousT = bar.t;
  }
});

test('reversion paths are pulled to the anchor (OU works)', () => {
  const path = generateMarketPath({
    seed: 777, nBars: 5000, scenario: 'REVERSION', ouKappa: 0.05,
  });
  // With kappa 0.05 and 5000 bars the terminal price must stay within
  // a few sigma of the start anchor, and the path must cross it often.
  const start = path.spec.startPrice;
  const end = path.bars[path.bars.length - 1].close;
  const sigmaBar = path.groundTruth.plantedParameters.sigmaBar;
  const sigmaTotal = sigmaBar * Math.sqrt(5000) * start;
  assert.ok(Math.abs(end - start) < 6 * sigmaTotal,
    `OU not anchored: start=${start} end=${end}`);
  const crosses = path.bars.filter((b) =>
    (b.close - start) * (b.open - start) < 0).length;
  assert.ok(crosses > 50, `expected anchor crossings, saw ${crosses}`);
});

test('typed refusals for invalid generator inputs', () => {
  assert.throws(() => generateMarketPath(null), /SYNTHETIC_INPUT_REQUIRED/);
  assert.throws(() => generateMarketPath({ seed: 0, nBars: 500, scenario: 'EDGE_ZERO' }),
    /SYNTHETIC_SEED_INVALID/);
  assert.throws(() => generateMarketPath({ seed: 1, nBars: 100, scenario: 'EDGE_ZERO' }),
    /SYNTHETIC_N_BARS_INVALID/);
  assert.throws(() => generateMarketPath({ seed: 1, nBars: 500, scenario: 'NOPE' }),
    /SYNTHETIC_SCENARIO_UNKNOWN/);
  assert.throws(() => generateMarketPath({ seed: 1, nBars: 500, scenario: 'EDGE_ZERO', instrument: 'USDJPY' }),
    /SYNTHETIC_INSTRUMENT_UNSUPPORTED/);
  assert.throws(() => generateMarketPath({ seed: 1, nBars: 500, scenario: 'PLANTED_DRIFT', plantedDriftPerBarSigma: 2 }),
    /SYNTHETIC_DRIFT_INVALID/);
});

test('mulberry32 is a deterministic uniform PRNG', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 100; i += 1) {
    const x = a();
    assert.ok(x >= 0 && x < 1);
    assert.strictEqual(x, b());
  }
});
