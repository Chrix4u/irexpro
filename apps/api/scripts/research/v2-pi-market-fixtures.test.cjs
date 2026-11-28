'use strict';
/**
 * Tests for the multi-symbol multi-timeframe synthetic fixtures (PI-2):
 * deterministic generation, exact timeframe counts via the PI-1 contract,
 * planted-continuation edge empirically recoverable, null fixtures with
 * zero edge, regime ground truth, and reversion dynamics.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  PI_SCENARIOS,
  generatePiFixture,
  measureContinuationRate,
} = require('./v2-pi-market-fixtures.cjs');

const SMALL = { symbols: ['EURUSD', 'GBPUSD'], days: 6 };

test('fixtures are deterministic: identical config, identical bars', () => {
  const a = generatePiFixture({ seed: 5100001, scenario: 'PI_NULL', ...SMALL });
  const b = generatePiFixture({ seed: 5100001, scenario: 'PI_NULL', ...SMALL });
  assert.strictEqual(a.series.EURUSD.M1.nBars, b.series.EURUSD.M1.nBars);
  assert.deepStrictEqual(
    a.series.EURUSD.M1.bars.map((x) => x.close),
    b.series.EURUSD.M1.bars.map((x) => x.close),
  );
  // Different seed family -> different paths.
  const c = generatePiFixture({ seed: 5200001, scenario: 'PI_NULL', ...SMALL });
  assert.notDeepStrictEqual(
    a.series.EURUSD.M1.bars.map((x) => x.close).slice(0, 50),
    c.series.EURUSD.M1.bars.map((x) => x.close).slice(0, 50),
  );
});

test('six symbols across five timeframes with exact aggregate counts', () => {
  const fx = generatePiFixture({ seed: 5100002, scenario: 'PI_NULL' });
  assert.deepStrictEqual([...fx.symbols], [
    'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF',
  ]);
  const sym = fx.series.EURUSD;
  const days = fx.days;
  assert.strictEqual(sym.M1.nBars, days * 1440);
  assert.strictEqual(sym.M5.nBars, days * 288);
  assert.strictEqual(sym.M15.nBars, days * 96);
  assert.strictEqual(sym.H1.nBars, days * 24);
  assert.strictEqual(sym.H4.nBars, days * 6);
  assert.strictEqual(sym.M5.gapBuckets, 0);
  assert.strictEqual(sym.M1.provenance, 'SYNTHETIC_FIXTURE');
});

test('PI_NULL carries zero planted edge: continuation rate ~ 0.5', () => {
  const fx = generatePiFixture({ seed: 5100003, scenario: 'PI_NULL', symbols: ['EURUSD'], days: 30 });
  const r = measureContinuationRate(fx, 'EURUSD');
  assert.ok(r.total >= 30);
  // With ~3600 samples, the 95% band for a fair coin is 0.5 ± 0.0165.
  assert.ok(Math.abs(r.rate - 0.5) < 0.02, `rate=${r.rate}`);
  assert.strictEqual(fx.plantedContinuationProb, null);
});

test('PI_PLANTED_CONTINUATION edge is empirically recoverable near the planted level', () => {
  const fx = generatePiFixture({
    seed: 5200004, scenario: 'PI_PLANTED_CONTINUATION', symbols: ['EURUSD'], days: 60,
    plantedContinuationProb: 0.56,
  });
  const r = measureContinuationRate(fx, 'EURUSD');
  assert.ok(r.total > 200, `triggers=${r.total}`);
  assert.ok(Math.abs(r.rate - 0.56) < 0.04, `rate=${r.rate}`);
  // Triggers are strictly non-overlapping windows (one-to-one structure).
  const trig = fx.series.EURUSD.groundTruth.triggers;
  for (let i = 1; i < trig.length; i += 1) {
    assert.ok(trig[i].bar - trig[i - 1].bar >= 12, 'trigger windows overlap');
  }
  assert.strictEqual(fx.plantedContinuationProb, 0.56);
});

test('PI_TREND_REGIMES records complete regime episode ground truth', () => {
  const fx = generatePiFixture({ seed: 5300005, scenario: 'PI_TREND_REGIMES', symbols: ['EURUSD'], days: 20 });
  const episodes = fx.series.EURUSD.groundTruth.regimeEpisodes;
  assert.ok(episodes.length >= 2);
  assert.strictEqual(episodes[0].fromBar, 0);
  const last = episodes[episodes.length - 1];
  assert.strictEqual(last.toBar, 20 * 1440 - 1);
  for (const e of episodes) {
    assert.ok(['TREND_UP', 'TREND_DOWN', 'RANGE', 'HIGH_VOL'].includes(e.label));
    assert.ok(e.toBar >= e.fromBar);
  }
  for (let i = 1; i < episodes.length; i += 1) {
    assert.strictEqual(episodes[i].fromBar, episodes[i - 1].toBar + 1);
  }
});

test('PI_REVERSION exhibits negative lag-1 return autocorrelation', () => {
  const fx = generatePiFixture({
    seed: 5400006, scenario: 'PI_REVERSION', symbols: ['EURUSD'], days: 10,
    ouKappa: 0.15,
  });
  const bars = fx.series.EURUSD.M1.bars;
  const rets = [];
  for (let i = 1; i < bars.length; i += 1) {
    rets.push(Math.log(bars[i].close) - Math.log(bars[i - 1].close));
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < rets.length; i += 1) {
    den += (rets[i] - mean) ** 2;
    if (i > 0) num += (rets[i] - mean) * (rets[i - 1] - mean);
  }
  const ac1 = num / den;
  assert.ok(ac1 < -0.05, `lag1=${ac1}`);
});

test('typed refusals on malformed fixture configuration', () => {
  assert.throws(() => generatePiFixture({ seed: 0, scenario: 'PI_NULL', ...SMALL }), /PI_FIXTURE_SEED_INVALID/);
  assert.throws(() => generatePiFixture({ seed: 1, scenario: 'NOPE', ...SMALL }), /PI_FIXTURE_SCENARIO_UNKNOWN/);
  assert.throws(() => generatePiFixture(null), /PI_FIXTURE_INPUT_REQUIRED/);
  assert.throws(() => generatePiFixture({ seed: 1, scenario: 'PI_NULL', symbols: ['ZZZUSD'], days: 2 }), /PI_FIXTURE_SYMBOLS_INVALID/);
  assert.throws(() => generatePiFixture({ seed: 1, scenario: 'PI_NULL', ...SMALL, plantedContinuationProb: 0.99 }), /PI_FIXTURE_PLANTED_PROB_INVALID/);
  assert.throws(() => measureContinuationRate(
    generatePiFixture({ seed: 1, scenario: 'PI_NULL', ...SMALL }),
    'USDJPY',
  ), /PI_FIXTURE_SYMBOL_MISSING/);
});

test('small-sample measurement refuses instead of guessing', () => {
  const fx = generatePiFixture({ seed: 5100007, scenario: 'PI_NULL', symbols: ['EURUSD'], days: 1 });
  const r = measureContinuationRate(fx, 'EURUSD', { sampleEvery: 1440 });
  assert.strictEqual(r.rate, null);
  assert.ok(r.refused.startsWith('PI_RATE_INSUFFICIENT_SAMPLE'));
});
