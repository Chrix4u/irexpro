'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluate, portfolioMetrics, riskNormalizedExpectancy, calibration,
  stabilityWindows, bootstrapMean, overlapClusters,
} = require('./v2-settled-trade-economics.cjs');

// Synthetic settled trades with hand-verifiable economics.
const trades = () => ([
  { tradeId: 'T1', openedAt: 0, closedAt: 100, netPnlUsd: 100, riskUsd: 100, predictedWinProbability: 0.6, outcomeWin: true },
  { tradeId: 'T2', openedAt: 10, closedAt: 200, netPnlUsd: -50, riskUsd: 100, predictedWinProbability: 0.6, outcomeWin: false },
  { tradeId: 'T3', openedAt: 300, closedAt: 400, netPnlUsd: 30, riskUsd: 100, predictedWinProbability: 0.5, outcomeWin: true },
  { tradeId: 'T4', openedAt: 350, closedAt: 500, netPnlUsd: -20, riskUsd: 100, predictedWinProbability: 0.5, outcomeWin: false },
  { tradeId: 'T5', openedAt: 600, closedAt: 700, netPnlUsd: 10, riskUsd: 100, predictedWinProbability: 0.4, outcomeWin: true },
  { tradeId: 'T6', openedAt: 650, closedAt: 800, netPnlUsd: -5, riskUsd: 100, predictedWinProbability: 0.4, outcomeWin: false },
]);

test('portfolio metrics match hand-calculated net, expectancy, profit factor and drawdown', () => {
  const m = portfolioMetrics(trades(), { startingEquityUsd: 1000 });
  assert.equal(m.netAfterCostUsd, 65);
  assert.equal(m.expectancyPerTradeUsd, 10.8333);
  assert.equal(m.profitFactor, 1.8667);
  assert.equal(m.settledWins, 3);
  assert.equal(m.settledLosses, 3);
  assert.equal(m.maxDrawdownUsd, 50);
  assert.equal(m.maxDrawdownFractionOfStartingEquity, 0.05);
});

test('profit factor stays undefined when there are no settled losses', () => {
  const m = portfolioMetrics([{ tradeId: 'W', closedAt: 1, netPnlUsd: 10 }]);
  assert.equal(m.profitFactor, null);
  assert.equal(m.profitFactorUndefinedReason, 'NO_SETTLED_LOSSES');
});

test('risk-normalized expectancy is mean net R and refuses missing risk', () => {
  const r = riskNormalizedExpectancy(trades());
  assert.equal(r.status, 'MEASURED');
  assert.equal(r.meanNetR, 0.108333);
  assert.equal(r.n, 6);
  assert.deepEqual(riskNormalizedExpectancy([{ tradeId: 'X', closedAt: 1, netPnlUsd: 5 }]).status, 'MISSING_RISK_MEASUREMENT');
});

test('calibration computes Brier, ECE and reliability bins exactly', () => {
  const c = calibration(trades());
  assert.equal(c.n, 6);
  assert.equal(c.brier, 0.256667);
  // Base rate 0.5 gives base-rate Brier 0.25; the model is worse than the base rate.
  assert.equal(c.brierSkillVsBaseRate, 0.006667);
  assert.equal(c.ece, 0.066667);
  const bin4 = c.bins[4];
  assert.equal(bin4.n, 2);
  assert.equal(bin4.meanPredicted, 0.4);
  assert.equal(bin4.observedFrequency, 0.5);
});

test('calibration excludes and counts records without prediction or outcome instead of imputing', () => {
  const mixed = [
    ...trades(),
    { tradeId: 'T7', closedAt: 900, netPnlUsd: 7 }, // no probability, no outcome
    { tradeId: 'T8', closedAt: 950, netPnlUsd: -3, predictedWinProbability: 0.7 }, // no outcome
  ];
  const c = calibration(mixed);
  assert.equal(c.n, 6);
  assert.equal(c.excluded, 2);
});

test('chronological stability splits into windows and reports positive fraction', () => {
  const s = stabilityWindows(trades(), { windows: 2 });
  assert.equal(s.windowCount, 2);
  assert.equal(s.perWindow[0].meanNetUsd, 26.6667);
  assert.equal(s.perWindow[1].meanNetUsd, -5);
  assert.equal(s.positiveWindowFraction, 0.5);
  assert.equal(s.worstWindowDivergenceUsd, 15.8333);
});

test('overlapping holding intervals are clustered, never counted as independent', () => {
  const o = overlapClusters(trades());
  assert.equal(o.clusters, 3);
  assert.equal(o.maxClusterSize, 2);
  assert.equal(o.tradesInClusters, 6);
});

test('bootstrap mean net R is deterministic, seeded and reproducible', () => {
  const a = bootstrapMean(trades(), { resamples: 500, seed: 7 });
  const b = bootstrapMean(trades(), { resamples: 500, seed: 7 });
  assert.equal(a.meanNetR, 0.108333);
  assert.deepEqual(a, b);
  assert.ok(a.ciLowNetR <= a.meanNetR);
  assert.ok(a.meanNetR <= a.ciHighNetR);
  // Six trades with mean 0.108R cannot exclude zero: uncertainty must say so.
  assert.equal(a.ciExcludesZero, false);
  assert.ok(a.ciWidthRelativeToAbsMean > 1);
});

test('evaluate composes the full report, stays research-only and rejects invalid records', () => {
  const report = evaluate([...trades(), { tradeId: null }, { tradeId: 'BAD', netPnlUsd: 'x', closedAt: 1 }]);
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.researchOnly, true);
  assert.equal(report.executionAuthority, 'NONE');
  assert.equal(report.portfolio.netAfterCostUsd, 65);
  assert.equal(report.invalid.length, 2);
  assert.equal(report.invalid[1].reason, 'MISSING_NET_PNL');
  assert.match(report.interpretiveRule, /Win rate is reported for completeness only/);
  const empty = evaluate([]);
  assert.equal(empty.status, 'NO_VALID_TRADES');
});

test('win rate is reported but never presented as profitability evidence', () => {
  const report = evaluate(trades());
  assert.equal(report.portfolio.winRate, 0.5);
  // A 50% win rate coexists with positive and with negative expectancy;
  // only the after-cost CI and profit factor carry evidential weight.
  assert.equal(report.uncertainty.ciExcludesZero, false);
});
