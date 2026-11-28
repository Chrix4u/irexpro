'use strict';
/**
 * V2 common prediction-opportunity dataset builder (PI-3, directive
 * 2026-11-28). Builds the COMMON grid of prediction opportunities with
 * IDENTICAL fixed-horizon outcome definitions for every candidate model
 * (including rejected/abstained opportunities — the full grid is the
 * evaluation denominator), with chronological walk-forward splits and
 * purge + embargo leakage control, and a held-out dataset preserved
 * against tuning.
 *
 * Outcome definitions (fixed, identical for all candidates):
 *   up    — forward close-to-close simple return over H=12 M5 bars > 0;
 *   cont  — forward return has the same strict sign as the past W=12-bar
 *            return (trend continuation event);
 *   rev   — |past W-bar return| > 0.5·sigma_W AND the forward sign is
 *            opposite (reversal event);
 *   fwdR  — forward simple return normalized by ATR14 (R units);
 *   costR — (spread + commission) in price units normalized by ATR14.
 *
 * Features are computed strictly from bars CLOSED at or before the
 * decision time (closed-bar higher-timeframe lookups; no future peek).
 */

const { SYMBOL_SPECS } = require('./v2-historical-data-contract.cjs');

const DEFAULT_HORIZON_M5 = 12; // 60 minutes
const DEFAULT_LOOKBACK_M5 = 12; // 60 minutes
const DEFAULT_SAMPLE_EVERY_M5 = DEFAULT_HORIZON_M5; // non-overlapping labels
const DEFAULT_PURGE_BARS_M5 = DEFAULT_HORIZON_M5;
const DEFAULT_EMBARGO_BARS_M5 = 12;

const COMMON_OUTCOME_DEFINITIONS = Object.freeze({
  horizonM5: DEFAULT_HORIZON_M5,
  lookbackM5: DEFAULT_LOOKBACK_M5,
  sampleEveryM5: DEFAULT_SAMPLE_EVERY_M5,
  up: 'forward close-to-close simple return over H M5 bars > 0',
  cont: 'forward return sign === past W-bar return sign (both strict)',
  rev: '|past W-bar return| > 0.5*sigma_W AND forward sign opposite',
  fwdR: 'forward simple return / (ATR14 / close)',
  costR: '(spreadPips + commissionPips) * pip / ATR14',
  grid: 'FULL common grid including rejected/abstained opportunities; '
    + 'abstention never shrinks the evaluation denominator',
});

const FEATURE_NAMES = Object.freeze([
  'm1Mom', 'm1Vol', 'm5Mom', 'm5Vol', 'm5RangePos', 'm5Body',
  'm15Mom', 'm15Vol', 'h1Mom', 'h1Vol', 'h4Mom', 'h4Vol',
]);

const REFUSALS = Object.freeze([
  'DATASET_FIXTURE_REQUIRED', 'DATASET_ROWS_REQUIRED', 'DATASET_SPLIT_INVALID',
]);

function stdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

function logReturnsFrom(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i += 1) {
    out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

function atr14(bars, endIndexInclusive) {
  const start = Math.max(1, endIndexInclusive - 13);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= endIndexInclusive; i += 1) {
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    );
    sum += tr;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

/** Build the common prediction-opportunity grid for one fixture. */
function buildPredictionOpportunities(fixture, options = {}) {
  if (!fixture || !fixture.series || typeof fixture.series !== 'object') {
    throw new Error('DATASET_FIXTURE_REQUIRED');
  }
  const horizonM5 = options.horizonM5 ?? DEFAULT_HORIZON_M5;
  const lookbackM5 = options.lookbackM5 ?? DEFAULT_LOOKBACK_M5;
  const sampleEveryM5 = options.sampleEveryM5 ?? DEFAULT_SAMPLE_EVERY_M5;
  if (!(Number.isInteger(horizonM5) && horizonM5 >= 1)) {
    throw new Error('DATASET_HORIZON_INVALID');
  }
  if (!(Number.isInteger(sampleEveryM5) && sampleEveryM5 >= 1)) {
    throw new Error('DATASET_SAMPLE_INVALID');
  }
  const warmupM5 = Math.max(14, lookbackM5 + 1); // ATR14 + lookback
  const rows = [];
  for (const symbol of fixture.symbols) {
    const sym = fixture.series[symbol];
    const m5 = sym.M5.bars;
    const m1 = sym.M1.bars;
    const m15 = sym.M15.bars;
    const h1 = sym.H1.bars;
    const h4 = sym.H4.bars;
    const spec = SYMBOL_SPECS[symbol];
    const episodes = sym.groundTruth.regimeEpisodes || [];
    // Advancing pointers for closed higher-TF context (no future peek).
    let m1Ptr = -1;
    let m15Ptr = -1;
    let h1Ptr = -1;
    let h4Ptr = -1;
    const regimeAtM1Bar = (m1Bar) => {
      if (episodes.length === 0) return null;
      for (const e of episodes) {
        if (m1Bar >= e.fromBar && m1Bar <= e.toBar) return e.label;
      }
      return null;
    };
    for (let i = warmupM5; i + horizonM5 < m5.length; i += sampleEveryM5) {
      const decisionTimeSec = m5[i].t + 300; // M5 bar i closes here.
      while (m1Ptr + 1 < m1.length && m1[m1Ptr + 1].t + 60 <= decisionTimeSec) m1Ptr += 1;
      while (m15Ptr + 1 < m15.length && m15[m15Ptr + 1].t + 900 <= decisionTimeSec) m15Ptr += 1;
      while (h1Ptr + 1 < h1.length && h1[h1Ptr + 1].t + 3600 <= decisionTimeSec) h1Ptr += 1;
      while (h4Ptr + 1 < h4.length && h4[h4Ptr + 1].t + 14400 <= decisionTimeSec) h4Ptr += 1;
      if (m1Ptr < 11 || m15Ptr < 5 || h1Ptr < 3 || h4Ptr < 3) continue;
      // --- features (closed bars only) ---
      const m1Closes = m1.slice(m1Ptr - 11, m1Ptr + 1).map((b) => b.close);
      const m1Rets = logReturnsFrom(m1Closes);
      const m5Closes = m5.slice(i - 11, i + 1).map((b) => b.close);
      const m5Rets = logReturnsFrom(m5Closes);
      const m5Window = m5.slice(i - 11, i + 1);
      const hi12 = Math.max(...m5Window.map((b) => b.high));
      const lo12 = Math.min(...m5Window.map((b) => b.low));
      const m15Rets = logReturnsFrom(m15.slice(m15Ptr - 5, m15Ptr + 1).map((b) => b.close));
      const h1Rets = logReturnsFrom(h1.slice(h1Ptr - 3, h1Ptr + 1).map((b) => b.close));
      const h4Rets = logReturnsFrom(h4.slice(h4Ptr - 3, h4Ptr + 1).map((b) => b.close));
      const lastBar = m5[i];
      const features = {
        m1Mom: m1Rets.reduce((s, r) => s + r, 0),
        m1Vol: stdev(m1Rets),
        m5Mom: m5Rets.reduce((s, r) => s + r, 0),
        m5Vol: stdev(m5Rets),
        m5RangePos: hi12 > lo12 ? (lastBar.close - lo12) / (hi12 - lo12) : 0.5,
        m5Body: Math.abs(lastBar.close - lastBar.open) / (lastBar.high - lastBar.low || 1e-12),
        m15Mom: m15Rets.reduce((s, r) => s + r, 0),
        m15Vol: stdev(m15Rets),
        h1Mom: h1Rets.reduce((s, r) => s + r, 0),
        h1Vol: stdev(h1Rets),
        h4Mom: h4Rets.reduce((s, r) => s + r, 0),
        h4Vol: stdev(h4Rets),
      };
      // --- labels (identical definitions for all candidates) ---
      const closeNow = m5[i].close;
      const closeFwd = m5[i + horizonM5].close;
      const fwd = closeFwd / closeNow - 1;
      const past = Math.log(closeNow / m5[i - lookbackM5].close);
      const sigmaW = stdev(m5Rets) * Math.sqrt(lookbackM5);
      const atr = atr14(m5, i);
      const atrNorm = atr && atr > 0 ? atr / closeNow : null;
      const up = fwd > 0 ? 1 : 0;
      const cont = (past > 0 && fwd > 0) || (past < 0 && fwd < 0) ? 1 : 0;
      const rev = Math.abs(past) > 0.5 * sigmaW && Math.sign(fwd) !== Math.sign(past) ? 1 : 0;
      const fwdR = atrNorm ? fwd / atrNorm : null;
      const costR = atr ? (spec.spreadPips + spec.commissionPips) * spec.pip / atr : null;
      rows.push(Object.freeze({
        symbol,
        m5Index: i,
        t: decisionTimeSec,
        features: Object.freeze(features),
        labels: Object.freeze({
          up, cont, rev, fwd, past, sigmaW, fwdR, costR,
        }),
        regime: fixture.scenario === 'PI_TREND_REGIMES'
          ? regimeAtM1Bar(i * 5) : null,
      }));
    }
  }
  if (rows.length === 0) {
    throw new Error('DATASET_ROWS_REQUIRED');
  }
  return Object.freeze({
    scenario: fixture.scenario,
    symbols: Object.freeze([...fixture.symbols]),
    horizonM5,
    lookbackM5,
    sampleEveryM5,
    outcomeDefinitions: COMMON_OUTCOME_DEFINITIONS,
    featureNames: Object.freeze([...FEATURE_NAMES]),
    rows: Object.freeze(rows),
  });
}

/** Feature vector in fixed order for model fitting. */
function featureVector(row) {
  return FEATURE_NAMES.map((name) => row.features[name]);
}

/**
 * Chronological walk-forward splits with purge + embargo. Rows are split
 * per symbol into nFolds equal chronological folds; for fold k the test
 * window is fold k and the training window is every earlier row whose
 * m5Index is at least (purge + embargo) bars before the test window's
 * first m5Index, on the same symbol.
 */
function buildChronologicalSplits(dataset, options = {}) {
  const nFolds = options.nFolds ?? 6;
  const purgeBars = options.purgeBars ?? DEFAULT_PURGE_BARS_M5;
  const embargoBars = options.embargoBars ?? DEFAULT_EMBARGO_BARS_M5;
  if (!Array.isArray(dataset.rows) || dataset.rows.length === 0) {
    throw new Error('DATASET_ROWS_REQUIRED');
  }
  if (!(Number.isInteger(nFolds) && nFolds >= 2 && nFolds <= 20)) {
    throw new Error('DATASET_SPLIT_INVALID');
  }
  const bySymbol = new Map();
  for (const row of dataset.rows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row);
  }
  const folds = [];
  for (let k = 1; k <= nFolds - 1; k += 1) {
    const train = [];
    const test = [];
    for (const [, rows] of bySymbol) {
      const perFold = Math.floor(rows.length / nFolds);
      const testStart = k * perFold;
      const testEnd = (k + 1) * perFold;
      const testRows = rows.slice(testStart, testEnd);
      const firstTestIndex = testRows.length ? testRows[0].m5Index : Infinity;
      for (const row of rows) {
        if (row.m5Index < firstTestIndex - purgeBars - embargoBars) train.push(row);
      }
      test.push(...testRows);
    }
    if (train.length === 0 || test.length === 0) {
      return Object.freeze({
        nFolds, purgeBars, embargoBars, folds: [],
        refused: 'DATASET_SPLIT_INSUFFICIENT_ROWS',
      });
    }
    folds.push(Object.freeze({
      fold: k,
      train: Object.freeze(train),
      test: Object.freeze(test),
      gapBars: purgeBars + embargoBars,
    }));
  }
  return Object.freeze({
    nFolds, purgeBars, embargoBars, folds: Object.freeze(folds),
  });
}

/**
 * Reserve the final chronology fraction per symbol as held-out, never
 * used for fitting or tuning — only for the single final evaluation.
 */
function reserveHeldOut(dataset, options = {}) {
  const fraction = options.fraction ?? 0.2;
  if (!(fraction > 0 && fraction < 0.5)) {
    throw new Error('DATASET_SPLIT_INVALID');
  }
  const bySymbol = new Map();
  for (const row of dataset.rows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row);
  }
  const dev = [];
  const heldOut = [];
  for (const [, rows] of bySymbol) {
    const cut = Math.floor(rows.length * (1 - fraction));
    dev.push(...rows.slice(0, cut));
    heldOut.push(...rows.slice(cut));
  }
  return Object.freeze({
    fraction,
    dev: Object.freeze(dev),
    heldOut: Object.freeze(heldOut),
    heldOutPreserved: true,
  });
}

/** Fit a feature scaler on training rows only. */
function fitScaler(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('DATASET_ROWS_REQUIRED');
  }
  const means = {};
  const sds = {};
  for (const name of FEATURE_NAMES) {
    const values = rows.map((r) => r.features[name]);
    means[name] = values.reduce((s, v) => s + v, 0) / rows.length;
    sds[name] = stdev(values) || 1;
  }
  return Object.freeze({
    featureNames: Object.freeze([...FEATURE_NAMES]),
    means: Object.freeze(means),
    sds: Object.freeze(sds),
  });
}

/** Apply a scaler to one feature record. */
function applyScaler(scaler, features) {
  const out = {};
  for (const name of FEATURE_NAMES) {
    out[name] = (features[name] - scaler.means[name]) / scaler.sds[name];
  }
  return Object.freeze(out);
}

module.exports = {
  COMMON_OUTCOME_DEFINITIONS,
  FEATURE_NAMES,
  REFUSALS,
  DEFAULT_HORIZON_M5,
  DEFAULT_LOOKBACK_M5,
  DEFAULT_SAMPLE_EVERY_M5,
  buildPredictionOpportunities,
  featureVector,
  buildChronologicalSplits,
  reserveHeldOut,
  fitScaler,
  applyScaler,
  stdev,
};
