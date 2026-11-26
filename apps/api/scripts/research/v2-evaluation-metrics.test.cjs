'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./v2-evaluation-metrics.cjs');

// Synthetic fixture builder: deterministic PRNG so every expected value in
// this file is reproducible. No private data anywhere.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function buildSyntheticCohort({ n, trueWinRate, predBias, meanWinR, meanLossR, seed }) {
  const rnd = lcg(seed);
  const rows = [];
  let t = new Date('2026-11-01T00:00:00Z').getTime();
  for (let i = 0; i < n; i++) {
    t += (30 + Math.floor(rnd() * 60)) * 60 * 1000; // strictly increasing
    const win = rnd() < trueWinRate;
    const realizedNetR = win ? meanWinR + rnd() * 0.2 - 0.1 : meanLossR + rnd() * 0.2 - 0.1;
    const predictedWinProbability = Math.min(0.99, Math.max(0.01, trueWinRate + predBias));
    rows.push({
      engineId: 'SYNTH-CHALLENGER-V2',
      instrument: 'SYNTHUSD',
      direction: rnd() < 0.5 ? 'BUY' : 'SELL',
      entryTime: new Date(t).toISOString(),
      exitTime: new Date(t + 15 * 60 * 1000).toISOString(),
      predictedWinProbability,
      predictedExpectedR: 0.3,
      realizedNetR: Number(realizedNetR.toFixed(6)),
      exitType: win ? 'PROFIT_PROTECTION' : 'BROKER_CLOSE',
    });
  }
  return rows;
}

test('metrics: net after-cost R, profit factor, drawdown on a known fixture', () => {
  const rows = buildSyntheticCohort({ n: 200, trueWinRate: 0.55, predBias: 0.2, meanWinR: 0.45, meanLossR: -0.85, seed: 42 });
  const r = m.evaluate(rows, { minTrades: 100, minDetectableEffect: 0.2 });
  assert.equal(r.status !== 'NO_SETTLED_DECISIONS' && r.status !== 'INVALID_INPUT', true);
  const realized = rows.map((x) => x.realizedNetR);
  // Independent recomputation (scipy-style cross-check):
  const net = realized.reduce((a, b) => a + b, 0);
  const wins = realized.filter((x) => x > 0);
  const losses = realized.filter((x) => x < 0);
  const pf = wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0));
  assert.ok(Math.abs(r.metrics.netAfterCostR - net) < 1e-9);
  assert.ok(Math.abs(r.metrics.profitFactor - pf) < 1e-9);
  assert.equal(r.metrics.settledTrades, 200);
  assert.equal(r.metrics.wins, wins.length);
  // max drawdown recomputed independently
  let cum = 0, peak = 0, dd = 0;
  realized.forEach((x) => { cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; });
  assert.ok(Math.abs(r.metrics.maxDrawdownR - dd) < 1e-9);
  // mean loser magnitude roughly 1.9x winner -> PF < 1 even at 55% win rate:
  assert.ok(pf < 1.0);
  assert.ok(r.failures.some((f) => f.gate === 'PROFIT_FACTOR'));
  // Win rate is reported but never a gate:
  assert.ok(!r.failures.some((f) => f.gate === 'WIN_RATE'));
});

test('high win rate alone never produces QUALIFIED_FOR_REVIEW (payoff asymmetry)', () => {
  // 80% win rate, tiny wins, full-SL losses: the classic V1 economic shape
  // (documented: mean winner ~+$31 vs mean loser ~-$63).
  const rows = buildSyntheticCohort({ n: 120, trueWinRate: 0.8, predBias: 0.0, meanWinR: 0.2, meanLossR: -1.0, seed: 7 });
  const r = m.evaluate(rows, { minTrades: 100, minDetectableEffect: 0.5, eceCeiling: 1.0, stabilityMinPositiveFraction: 0.5, sharpeFloor: 0.0, profitFactorFloor: 1.15, maxDrawdownCap: 1.0 });
  assert.ok(r.metrics.wins >= 90, `expected ~80% win rate, got ${r.metrics.wins}/120`);
  assert.equal(r.status, 'GATE_FAILURES');
  assert.ok(r.failures.some((f) => f.gate === 'PROFIT_FACTOR'), 'profit factor gate must fail for payoff asymmetry');
  assert.ok(!r.failures.some((f) => f.gate === 'WIN_RATE'));
});

test('calibration: systematically optimistic predictions fail the ECE gate', () => {
  const rows = buildSyntheticCohort({ n: 200, trueWinRate: 0.5, predBias: 0.25, meanWinR: 0.4, meanLossR: -0.8, seed: 11 });
  const r = m.evaluate(rows, { minTrades: 100, minDetectableEffect: 0.5, eceCeiling: 0.10, stabilityMinPositiveFraction: 0.0, sharpeFloor: -10, profitFactorFloor: 0.0, maxDrawdownCap: 1.0 });
  assert.ok(r.metrics.calibration.ece > 0.10, `expected ECE > 0.10 for +0.25 optimism, got ${r.metrics.calibration.ece}`);
  assert.ok(r.failures.some((f) => f.gate === 'CALIBRATION'));
  // Brier recomputed independently
  const brier = rows.reduce((a, d) => a + (d.predictedWinProbability - (d.realizedNetR > 0 ? 1 : 0)) ** 2, 0) / rows.length;
  assert.ok(Math.abs(r.metrics.calibration.brier - brier) < 1e-12);
});

test('AUC with ties matches independent Mann-Whitney recomputation', () => {
  const labels = [1, 0, 1, 1, 0, 0];
  const scores = [0.7, 0.7, 0.6, 0.9, 0.2, 0.7];
  const { auc } = m.aucWithSe(labels, scores);
  // Brute-force U statistic recomputation with tie-averaging:
  const pairs = [];
  labels.forEach((li, i) => labels.forEach((lj, j) => {
    if (i === j || li !== 1 || lj !== 0) return;
    pairs.push(scores[i] > scores[j] ? 1 : scores[i] === scores[j] ? 0.5 : 0);
  }));
  const u = pairs.reduce((a, b) => a + b, 0) / pairs.length;
  assert.ok(Math.abs(auc - u) < 1e-12);
});

test('chronology: overlapping same-instrument exposure is reported, never silent', () => {
  const rows = buildSyntheticCohort({ n: 60, trueWinRate: 0.5, predBias: 0, meanWinR: 0.3, meanLossR: -0.6, seed: 3 });
  // Force a guaranteed overlap: extend an early exit window across a later entry.
  const early = new Date(rows[5].entryTime).getTime();
  const laterEntry = new Date(rows[10].entryTime).getTime();
  rows[5] = { ...rows[5], exitTime: new Date(laterEntry + 60 * 1000).toISOString() };
  assert.ok(new Date(rows[5].exitTime).getTime() > laterEntry);
  const issues = m.chronologicalIssues(rows);
  assert.ok(issues.some((x) => x.kind === 'OVERLAPPING_EXPOSURE'));
  const r = m.evaluate(rows, { minTrades: 1, minDetectableEffect: 0.01 });
  assert.ok(r.chronology.overlapCount >= 1);
  assert.ok(r.caveats.some((c) => /Overlapping/.test(c)));
});

test('insufficient sample is a gate failure, not a caveat', () => {
  const rows = buildSyntheticCohort({ n: 12, trueWinRate: 0.6, predBias: 0, meanWinR: 0.5, meanLossR: -0.5, seed: 5 });
  const r = m.evaluate(rows, { minTrades: 100, minDetectableEffect: 0.1 });
  assert.equal(r.status, 'GATE_FAILURES');
  assert.ok(r.failures.some((f) => f.gate === 'SAMPLE_SIZE'));
  assert.ok(r.failures.some((f) => f.gate === 'SUFFICIENCY'));
  const s = m.sampleSufficiency(rows, 0.1);
  assert.ok(s.requiredN > 12);
});

test('invalid inputs fail closed', () => {
  const bad = m.evaluate([], {});
  assert.equal(bad.status, 'NO_SETTLED_DECISIONS');
  const invalid = m.evaluate([{ engineId: 'x', instrument: 'A', direction: 'UP', predictedWinProbability: 1.5, predictedExpectedR: 0, realizedNetR: 0, entryTime: '2026-11-01T00:00:00Z' }], {});
  assert.equal(invalid.status, 'INVALID_INPUT');
  assert.ok(invalid.errors.length > 0);
});

test('policy provenance is always carried; defaults restate published gates', () => {
  const r = m.evaluate(buildSyntheticCohort({ n: 10, trueWinRate: 0.5, predBias: 0, meanWinR: 0.2, meanLossR: -0.4, seed: 9 }), { minTrades: 100, minDetectableEffect: 0.1 });
  assert.equal(r.policy.policySource.includes('vps-twelvedata-paper-evidence.md'), true);
  assert.equal(m.DEFAULT_POLICY.profitFactorFloor, 1.15);
});
