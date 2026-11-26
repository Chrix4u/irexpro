'use strict';

// V2 Challenger evaluation metrics — offline, descriptive, research-only.
// Computes the evaluation criteria required by the V2 research directive:
// net after-cost return, risk-normalized expectancy, max drawdown, profit
// factor, calibration, stability, sample sufficiency and uncertainty.
// Win rate alone is reported but never treated as evidence of profitability.
const ARTIFACT = 'v2-settled-trade-economics-v1';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// Deterministic seeded PRNG (mulberry32) so every bootstrap CI is
// reproducible bit-for-bit in CI and in independent review.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function validateTradeRecords(trades) {
  const valid = [];
  const invalid = [];
  for (const t of Array.isArray(trades) ? trades : []) {
    const id = t && (t.tradeId ?? t.id);
    if (!t || !id) { invalid.push({ tradeId: null, reason: 'MISSING_TRADE_ID' }); continue; }
    if (!finite(t.netPnlUsd)) { invalid.push({ tradeId: id, reason: 'MISSING_NET_PNL' }); continue; }
    if (!finite(t.closedAtMs) && !finite(t.closedAt)) { invalid.push({ tradeId: id, reason: 'MISSING_CLOSED_AT' }); continue; }
    valid.push(t);
  }
  return { valid, invalid };
}

const closeMs = (t) => (finite(t.closedAtMs) ? t.closedAtMs : t.closedAt);
const openMs = (t) => (finite(t.openedAtMs) ? t.openedAtMs : t.openedAt);

// Union-of-intervals clustering: trades whose holding intervals intersect
// cannot be treated as independent observations. Correlated USD-grouped
// entries were an explicit prior finding, so the metric is mandatory.
function overlapClusters(trades) {
  const withInterval = trades.filter((t) => finite(openMs(t)) && finite(closeMs(t)) && closeMs(t) >= openMs(t));
  if (withInterval.length === 0) return { clusters: 0, tradesInClusters: 0, maxClusterSize: 0, uncoveredTrades: trades.length };
  const sorted = [...withInterval].sort((a, b) => openMs(a) - openMs(b) === 0 ? closeMs(a) - closeMs(b) : openMs(a) - openMs(b));
  let clusters = 0;
  let maxClusterSize = 1;
  let current = [sorted[0]];
  let currentEnd = closeMs(sorted[0]);
  const flush = () => {
    if (current.length > 1) { clusters += 1; maxClusterSize = Math.max(maxClusterSize, current.length); }
    current = [];
  };
  for (let i = 1; i < sorted.length; i += 1) {
    const t = sorted[i];
    if (openMs(t) <= currentEnd) { current.push(t); currentEnd = Math.max(currentEnd, closeMs(t)); }
    else { flush(); current = [t]; currentEnd = closeMs(t); }
  }
  flush();
  return {
    clusters,
    tradesInClusters: withInterval.length,
    maxClusterSize,
    uncoveredTrades: trades.length - withInterval.length,
  };
}

function portfolioMetrics(trades, options = {}) {
  const startingEquityUsd = finite(options.startingEquityUsd) ? options.startingEquityUsd : null;
  const nets = trades.map((t) => t.netPnlUsd);
  const wins = nets.filter((v) => v > 0);
  const losses = nets.filter((v) => v < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = losses.reduce((a, b) => a + Math.abs(b), 0);
  const netUsd = nets.reduce((a, b) => a + b, 0);
  let maxDrawdownUsd = 0;
  let peak = 0;
  let equity = 0;
  const chronological = [...trades].sort((a, b) => closeMs(a) - closeMs(b));
  for (const t of chronological) {
    equity += t.netPnlUsd;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
  }
  return {
    trades: trades.length,
    netAfterCostUsd: Number(netUsd.toFixed(2)),
    expectancyPerTradeUsd: trades.length ? Number((netUsd / trades.length).toFixed(4)) : null,
    settledWins: wins.length,
    settledLosses: losses.length,
    winRate: trades.length ? Number((wins.length / trades.length).toFixed(4)) : null,
    profitFactor: grossLoss === 0 ? null : Number((grossWin / grossLoss).toFixed(4)),
    profitFactorUndefinedReason: grossLoss === 0 ? 'NO_SETTLED_LOSSES' : null,
    maxDrawdownUsd: Number(maxDrawdownUsd.toFixed(2)),
    maxDrawdownFractionOfStartingEquity: startingEquityUsd
      ? Number((maxDrawdownUsd / startingEquityUsd).toFixed(4)) : null,
  };
}

function riskNormalizedExpectancy(trades) {
  const withRisk = trades.filter((t) => finite(t.riskUsd) && t.riskUsd > 0);
  if (withRisk.length === 0) return { n: 0, meanNetR: null, status: 'MISSING_RISK_MEASUREMENT' };
  const rs = withRisk.map((t) => t.netPnlUsd / t.riskUsd);
  return {
    n: withRisk.length,
    tradesWithoutRisk: trades.length - withRisk.length,
    meanNetR: Number((rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(6)),
    status: 'MEASURED',
  };
}

// Calibration is computed only from records that carry BOTH a predicted
// win probability and a settled binary outcome. Records without either are
// excluded and counted, never imputed.
function calibration(trades, options = {}) {
  const bins = finite(options.bins) ? options.bins : 10;
  const usable = trades.filter(
    (t) => finite(t.predictedWinProbability) && t.predictedWinProbability >= 0
      && t.predictedWinProbability <= 1 && typeof t.outcomeWin === 'boolean',
  );
  const excluded = trades.length - usable.length;
  if (usable.length === 0) {
    return { n: 0, excluded, brier: null, ece: null, bins: [], status: 'NO_CALIBRATION_EVIDENCE' };
  }
  let brier = 0;
  const bucket = Array.from({ length: bins }, () => ({ n: 0, predSum: 0, obsSum: 0 }));
  for (const t of usable) {
    const y = t.outcomeWin ? 1 : 0;
    brier += (t.predictedWinProbability - y) ** 2;
    const b = Math.min(bins - 1, Math.floor(t.predictedWinProbability * bins));
    bucket[b].n += 1; bucket[b].predSum += t.predictedWinProbability; bucket[b].obsSum += y;
  }
  brier /= usable.length;
  let ece = 0;
  const binReports = bucket.map((b, i) => {
    const meanPred = b.n ? b.predSum / b.n : null;
    const obsFreq = b.n ? b.obsSum / b.n : null;
    if (b.n) ece += (b.n / usable.length) * Math.abs(meanPred - obsFreq);
    return {
      bin: i, lowerInclusive: i / bins, upperExclusive: (i + 1) / bins, n: b.n,
      meanPredicted: meanPred === null ? null : Number(meanPred.toFixed(4)),
      observedFrequency: obsFreq === null ? null : Number(obsFreq.toFixed(4)),
    };
  });
  return {
    n: usable.length,
    excluded,
    brier: Number(brier.toFixed(6)),
    brierSkillVsBaseRate: Number((brier - baseRateBrier(usable)).toFixed(6)),
    ece: Number(ece.toFixed(6)),
    bins: binReports,
    status: 'MEASURED',
  };
}

function baseRateBrier(usable) {
  const p = usable.filter((t) => t.outcomeWin).length / usable.length;
  return usable.reduce((a, t) => a + (p - (t.outcomeWin ? 1 : 0)) ** 2, 0) / usable.length;
}

// Chronological window stability: expectancy per contiguous window,
// positive-window fraction and worst divergence from the overall mean.
function stabilityWindows(trades, options = {}) {
  const windows = finite(options.windows) && options.windows >= 2 ? Math.floor(options.windows) : 4;
  const chronological = [...trades].sort((a, b) => closeMs(a) - closeMs(b));
  if (chronological.length === 0) return { windows: 0, status: 'NO_TRADES' };
  const overall = chronological.reduce((a, t) => a + t.netPnlUsd, 0) / chronological.length;
  const per = [];
  const perWindow = [];
  for (let i = 0; i < windows; i += 1) {
    const from = Math.floor((chronological.length * i) / windows);
    const to = Math.floor((chronological.length * (i + 1)) / windows);
    const slice = chronological.slice(from, to);
    if (slice.length === 0) continue;
    const mean = slice.reduce((a, t) => a + t.netPnlUsd, 0) / slice.length;
    per.push(mean);
    perWindow.push({ window: perWindow.length + 1, trades: slice.length, meanNetUsd: Number(mean.toFixed(4)), positive: mean > 0 });
  }
  const positiveFraction = perWindow.length ? perWindow.filter((w) => w.positive).length / perWindow.length : null;
  const worstDivergence = per.length
    ? Math.max(...per.map((m) => Math.abs(m - overall))) : null;
  return {
    windowCount: perWindow.length,
    positiveWindowFraction: positiveFraction === null ? null : Number(positiveFraction.toFixed(4)),
    worstWindowDivergenceUsd: worstDivergence === null ? null : Number(worstDivergence.toFixed(4)),
    perWindow,
    status: 'MEASURED',
  };
}

// Deterministic bootstrap of mean net R (risk-normalized) and mean net USD.
// Reports the CI width relative to the point estimate so reviewers can see
// whether the sample can support any conclusion at all.
function bootstrapMean(trades, options = {}) {
  const resamples = finite(options.resamples) ? Math.floor(options.resamples) : 2000;
  const seed = finite(options.seed) ? options.seed : 20261127;
  const confidence = finite(options.confidence) ? options.confidence : 0.95;
  const withRisk = trades.filter((t) => finite(t.riskUsd) && t.riskUsd > 0);
  if (withRisk.length === 0) {
    return { status: 'MISSING_RISK_MEASUREMENT', meanNetR: null, ciLowNetR: null, ciHighNetR: null };
  }
  const rs = withRisk.map((t) => t.netPnlUsd / t.riskUsd);
  const rand = mulberry32(seed);
  const means = [];
  for (let i = 0; i < resamples; i += 1) {
    let s = 0;
    for (let j = 0; j < rs.length; j += 1) s += rs[Math.floor(rand() * rs.length)];
    means.push(s / rs.length);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const point = rs.reduce((a, b) => a + b, 0) / rs.length;
  const low = percentile(means, alpha * 100);
  const high = percentile(means, (1 - alpha) * 100);
  const width = high - low;
  return {
    status: 'MEASURED',
    n: rs.length,
    resamples,
    seed,
    confidence,
    meanNetR: Number(point.toFixed(6)),
    ciLowNetR: Number(low.toFixed(6)),
    ciHighNetR: Number(high.toFixed(6)),
    ciExcludesZero: low > 0 || high < 0,
    ciWidthRelativeToAbsMean: Math.abs(point) > 1e-12 ? Number((width / Math.abs(point)).toFixed(4)) : null,
  };
}

function evaluate(trades, options = {}) {
  const { valid, invalid } = validateTradeRecords(trades);
  const base = { artifact: ARTIFACT, researchOnly: true, executionAuthority: 'NONE' };
  if (valid.length === 0) {
    return { ...base, status: 'NO_VALID_TRADES', invalid, ...emptyReport() };
  }
  const overlap = overlapClusters(valid);
  return {
    ...base,
    status: 'MEASURED',
    invalid,
    portfolio: portfolioMetrics(valid, options),
    riskNormalized: riskNormalizedExpectancy(valid),
    calibration: calibration(valid, options.calibration || {}),
    stability: stabilityWindows(valid, options.stability || {}),
    uncertainty: bootstrapMean(valid, options.bootstrap || {}),
    nonIndependence: {
      overlap,
      caveat: 'Overlapping holding intervals and correlated USD-grouped entries reduce the effective sample size; bootstrap and sign tests on overlapping trades are optimistic.',
    },
    interpretiveRule: 'Win rate is reported for completeness only. Profitability evidence requires the after-cost CI and profit factor, not the win rate.',
  };
}

function emptyReport() {
  return {
    portfolio: portfolioMetrics([]),
    riskNormalized: riskNormalizedExpectancy([]),
    calibration: calibration([]),
    stability: stabilityWindows([]),
    uncertainty: bootstrapMean([]),
    nonIndependence: null,
  };
}

module.exports = {
  evaluate, portfolioMetrics, riskNormalizedExpectancy, calibration,
  stabilityWindows, bootstrapMean, overlapClusters, mulberry32, percentile,
};
