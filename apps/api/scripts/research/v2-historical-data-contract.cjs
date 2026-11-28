'use strict';
/**
 * V2 historical data ingestion contract (PI-1, directive 2026-11-28).
 *
 * Secure ingestion for future operator-authorized historical exports and
 * for the fully synthetic fixtures of this phase. Validates bar schema,
 * strict chronological ordering (duplicate and misalignment refusal), OHLC
 * sanity, and builds multi-timeframe aggregates (M1 -> M5/M15/H1/H4) with
 * strict no-future-peek semantics: a higher-timeframe bar is usable at a
 * decision time only when its full window has CLOSED at or before that
 * time.
 *
 * Privacy enforcement: raw broker records are REFUSED at ingestion
 * (DATA_PROVENANCE_REFUSED). Only synthetic fixtures and explicitly
 * operator-authorized exports may enter the research pipeline; the
 * authorized-export path is for offline use once authorization exists (P4),
 * never for publishing broker records in this repository.
 */

const SUPPORTED_SYMBOLS = Object.freeze([
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF',
]);

/** Synthetic-policy instrument specs (deterministic; research-only). */
const SYMBOL_SPECS = Object.freeze({
  EURUSD: Object.freeze({ pip: 0.0001, startPrice: 1.12, dailyVolPercent: 0.55, spreadPips: 0.8, commissionPips: 0.2 }),
  GBPUSD: Object.freeze({ pip: 0.0001, startPrice: 1.34, dailyVolPercent: 0.62, spreadPips: 0.9, commissionPips: 0.2 }),
  USDJPY: Object.freeze({ pip: 0.01, startPrice: 155.0, dailyVolPercent: 0.60, spreadPips: 1.0, commissionPips: 0.2 }),
  AUDUSD: Object.freeze({ pip: 0.0001, startPrice: 0.66, dailyVolPercent: 0.58, spreadPips: 0.9, commissionPips: 0.2 }),
  USDCAD: Object.freeze({ pip: 0.0001, startPrice: 1.36, dailyVolPercent: 0.50, spreadPips: 1.2, commissionPips: 0.2 }),
  USDCHF: Object.freeze({ pip: 0.0001, startPrice: 0.89, dailyVolPercent: 0.50, spreadPips: 1.2, commissionPips: 0.2 }),
});

const TIMEFRAME_MINUTES = Object.freeze({
  M1: 1, M5: 5, M15: 15, H1: 60, H4: 240,
});

const PI_TIMEFRAMES = Object.freeze(['M1', 'M5', 'M15', 'H1', 'H4']);

const ALLOWED_PROVENANCE = Object.freeze(['SYNTHETIC_FIXTURE', 'OPERATOR_AUTHORIZED_EXPORT']);

const finitePositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validate a bar array for a timeframe. Pure; typed refusals on defects. */
function validateBars(bars, timeframe) {
  const tfMinutes = TIMEFRAME_MINUTES[timeframe];
  if (tfMinutes === undefined) {
    throw new Error(`DATA_TIMEFRAME_UNKNOWN:${String(timeframe)}`);
  }
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error('DATA_BARS_REQUIRED');
  }
  const tfSeconds = tfMinutes * 60;
  let prevT = -Infinity;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (!b || typeof b !== 'object') {
      throw new Error(`DATA_BAR_MALFORMED:${i}`);
    }
    if (!Number.isInteger(b.t) || b.t <= 0) {
      throw new Error(`DATA_BAR_TIMESTAMP_INVALID:${i}`);
    }
    if (b.t % tfSeconds !== 0) {
      throw new Error(`DATA_BAR_TIMESTAMP_MISALIGNED:${i}`);
    }
    if (b.t <= prevT) {
      const kind = b.t === prevT ? 'DATA_BAR_DUPLICATE_TIMESTAMP' : 'DATA_BAR_OUT_OF_ORDER';
      throw new Error(`${kind}:${i}`);
    }
    prevT = b.t;
    if (!finitePositive(b.open) || !finitePositive(b.high)
      || !finitePositive(b.low) || !finitePositive(b.close)) {
      throw new Error(`DATA_BAR_PRICE_INVALID:${i}`);
    }
    if (!(b.high >= Math.max(b.open, b.close) && b.high >= b.low)) {
      throw new Error(`DATA_BAR_HIGH_INVALID:${i}`);
    }
    if (!(b.low <= Math.min(b.open, b.close) && b.low <= b.high)) {
      throw new Error(`DATA_BAR_LOW_INVALID:${i}`);
    }
    if (b.volume !== undefined && !(finiteNumber(b.volume) && b.volume >= 0)) {
      throw new Error(`DATA_BAR_VOLUME_INVALID:${i}`);
    }
  }
  return Object.freeze({ nBars: bars.length, timeframe, tfSeconds });
}

/** Ingest a validated bar series with provenance enforcement. */
function ingestBarSeries({ symbol, timeframe, bars, sourceTag }) {
  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new Error(`DATA_SYMBOL_UNSUPPORTED:${String(symbol)}`);
  }
  if (!ALLOWED_PROVENANCE.includes(sourceTag)) {
    throw new Error(`DATA_PROVENANCE_REFUSED:${String(sourceTag)}`);
  }
  const validated = validateBars(bars, timeframe);
  const frozenBars = Object.freeze(bars.map((b) => Object.freeze({
    t: b.t, open: b.open, high: b.high, low: b.low, close: b.close,
    volume: b.volume !== undefined ? b.volume : 0,
  })));
  return Object.freeze({
    symbol,
    timeframe,
    tfMinutes: TIMEFRAME_MINUTES[timeframe],
    sourceTag,
    provenance: sourceTag,
    nBars: validated.nBars,
    firstT: frozenBars[0].t,
    lastT: frozenBars[frozenBars.length - 1].t,
    bars: frozenBars,
  });
}

/**
 * Aggregate an M1 series into a higher timeframe. Buckets cover full
 * windows only: the final bucket is dropped when the data has not yet
 * covered its whole window (no partial last bar). Interior gaps are
 * recorded per bucket (actualBars < expectedBars) and counted.
 */
function aggregateTimeframe(m1Series, targetTimeframe) {
  if (!m1Series || !Array.isArray(m1Series.bars)) {
    throw new Error('DATA_SERIES_REQUIRED');
  }
  if (m1Series.timeframe !== 'M1') {
    throw new Error(`DATA_AGGREGATION_BASE_M1_REQUIRED:${String(m1Series.timeframe)}`);
  }
  const tfMinutes = TIMEFRAME_MINUTES[targetTimeframe];
  if (tfMinutes === undefined) {
    throw new Error(`DATA_TIMEFRAME_UNKNOWN:${String(targetTimeframe)}`);
  }
  if (targetTimeframe === 'M1') {
    throw new Error('DATA_AGGREGATION_TARGET_M1_REFUSED');
  }
  validateBars(m1Series.bars, 'M1');
  const tfSeconds = tfMinutes * 60;
  const expectedBars = tfMinutes;
  const lastT = m1Series.bars[m1Series.bars.length - 1].t;
  const outBars = [];
  let gapBuckets = 0;
  let bucket = null;
  const flush = (partial) => {
    if (bucket === null) return;
    // Emit only buckets whose full window is covered by the data.
    if (partial && bucket.endT > lastT + 60) {
      bucket = null;
      return;
    }
    if (bucket.actualBars < expectedBars) gapBuckets += 1;
    outBars.push(Object.freeze({
      t: bucket.startT,
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      volume: bucket.volume,
      actualBars: bucket.actualBars,
      expectedBars,
    }));
    bucket = null;
  };
  for (const b of m1Series.bars) {
    const startT = Math.floor(b.t / tfSeconds) * tfSeconds;
    if (bucket === null || bucket.startT !== startT) {
      flush(true);
      bucket = {
        startT, endT: startT + tfSeconds, open: b.open, high: b.high,
        low: b.low, close: b.close, volume: b.volume, actualBars: 1,
      };
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low = Math.min(bucket.low, b.low);
      bucket.close = b.close;
      bucket.volume += b.volume;
      bucket.actualBars += 1;
    }
  }
  flush(true);
  return Object.freeze({
    symbol: m1Series.symbol,
    timeframe: targetTimeframe,
    tfMinutes,
    sourceTag: m1Series.sourceTag,
    provenance: m1Series.provenance,
    nBars: outBars.length,
    gapBuckets,
    firstT: outBars.length ? outBars[0].t : null,
    lastT: outBars.length ? outBars[outBars.length - 1].t : null,
    bars: Object.freeze(outBars),
  });
}

/**
 * No-future-peek context lookup: the latest higher-timeframe bar whose
 * full window (t .. t + tfMinutes) closed at or before decisionTimeSec.
 * Returns the closed bar or throws DATA_CONTEXT_BAR_NONE.
 */
function closedBarAt(higherTfBars, decisionTimeSec, timeframe) {
  if (!Array.isArray(higherTfBars) || higherTfBars.length === 0) {
    throw new Error('DATA_CONTEXT_BARS_REQUIRED');
  }
  const tfMinutes = TIMEFRAME_MINUTES[timeframe];
  if (tfMinutes === undefined) {
    throw new Error(`DATA_TIMEFRAME_UNKNOWN:${String(timeframe)}`);
  }
  const tfSeconds = tfMinutes * 60;
  // Binary search for the last bar with t + tfSeconds <= decisionTimeSec.
  let lo = 0;
  let hi = higherTfBars.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (higherTfBars[mid].t + tfSeconds <= decisionTimeSec) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) {
    throw new Error('DATA_CONTEXT_BAR_NONE');
  }
  const bar = higherTfBars[best];
  return Object.freeze({
    bar,
    closedAt: bar.t + tfSeconds,
    decisionTimeSec,
    windowVerifiedClosed: true,
  });
}

module.exports = {
  SUPPORTED_SYMBOLS,
  SYMBOL_SPECS,
  TIMEFRAME_MINUTES,
  PI_TIMEFRAMES,
  ALLOWED_PROVENANCE,
  validateBars,
  ingestBarSeries,
  aggregateTimeframe,
  closedBarAt,
};
