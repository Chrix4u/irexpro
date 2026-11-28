'use strict';
/**
 * Tests for the V2 historical data ingestion contract (PI-1): schema
 * validation refusals, provenance enforcement (raw broker records
 * refused), exact multi-timeframe aggregation with partial-bucket
 * protection, and no-future-peek closed-bar lookups.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  SUPPORTED_SYMBOLS,
  SYMBOL_SPECS,
  PI_TIMEFRAMES,
  ALLOWED_PROVENANCE,
  validateBars,
  ingestBarSeries,
  aggregateTimeframe,
  closedBarAt,
} = require('./v2-historical-data-contract.cjs');

const M1 = 60;
const M5 = 300;

function mkM1Bar(t, base = 1.1) {
  return {
    t, open: base, high: base + 0.0005, low: base - 0.0004, close: base + 0.0002,
  };
}

test('six supported symbols, five timeframes, synthetic-only provenance vocabulary', () => {
  assert.deepStrictEqual([...SUPPORTED_SYMBOLS], [
    'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF',
  ]);
  assert.deepStrictEqual([...PI_TIMEFRAMES], ['M1', 'M5', 'M15', 'H1', 'H4']);
  assert.deepStrictEqual([...ALLOWED_PROVENANCE], ['SYNTHETIC_FIXTURE', 'OPERATOR_AUTHORIZED_EXPORT']);
  for (const s of SUPPORTED_SYMBOLS) {
    assert.ok(SYMBOL_SPECS[s].spreadPips > 0 && SYMBOL_SPECS[s].dailyVolPercent > 0);
  }
});

test('validateBars accepts well-formed aligned chronological bars', () => {
  const bars = Array.from({ length: 10 }, (_, i) => mkM1Bar(M1 * (i + 100)));
  const r = validateBars(bars, 'M1');
  assert.strictEqual(r.nBars, 10);
  assert.strictEqual(r.tfSeconds, M1);
});

test('validateBars refuses malformed series with typed errors', () => {
  const ok = Array.from({ length: 3 }, (_, i) => mkM1Bar(M1 * (i + 1)));
  assert.throws(() => validateBars([], 'M1'), /DATA_BARS_REQUIRED/);
  assert.throws(() => validateBars(null, 'M1'), /DATA_BARS_REQUIRED/);
  assert.throws(() => validateBars(ok, 'M2'), /DATA_TIMEFRAME_UNKNOWN/);
  // Out of order.
  const disorder = [mkM1Bar(M1), mkM1Bar(3 * M1), mkM1Bar(2 * M1)];
  assert.throws(() => validateBars(disorder, 'M1'), /DATA_BAR_OUT_OF_ORDER/);
  // Duplicate timestamps.
  const dup = [mkM1Bar(M1), mkM1Bar(M1)];
  assert.throws(() => validateBars(dup, 'M1'), /DATA_BAR_DUPLICATE_TIMESTAMP/);
  // Misaligned to timeframe (t=90 is not minute-aligned).
  const misaligned = [mkM1Bar(M1), { ...mkM1Bar(90) }];
  assert.throws(() => validateBars(misaligned, 'M1'), /DATA_BAR_TIMESTAMP_MISALIGNED/);
  // Non-integer / non-positive timestamp.
  assert.throws(() => validateBars([{ ...mkM1Bar(M1), t: 1.5 }], 'M1'), /DATA_BAR_TIMESTAMP_INVALID/);
  // Invalid prices.
  assert.throws(() => validateBars([{ ...mkM1Bar(M1), open: NaN }], 'M1'), /DATA_BAR_PRICE_INVALID/);
  assert.throws(() => validateBars([{ ...mkM1Bar(M1), high: 1.0 }], 'M1'), /DATA_BAR_HIGH_INVALID/);
  assert.throws(() => validateBars([{ ...mkM1Bar(M1), low: 1.1001 }], 'M1'), /DATA_BAR_LOW_INVALID/);
  assert.throws(() => validateBars([{ ...mkM1Bar(M1), volume: -1 }], 'M1'), /DATA_BAR_VOLUME_INVALID/);
});

test('ingestBarSeries enforces provenance: raw broker records are refused', () => {
  const bars = Array.from({ length: 5 }, (_, i) => mkM1Bar(M1 * (i + 1)));
  const synthetic = ingestBarSeries({ symbol: 'EURUSD', timeframe: 'M1', bars, sourceTag: 'SYNTHETIC_FIXTURE' });
  assert.strictEqual(synthetic.nBars, 5);
  assert.strictEqual(synthetic.provenance, 'SYNTHETIC_FIXTURE');
  const authorized = ingestBarSeries({
    symbol: 'EURUSD', timeframe: 'M1', bars, sourceTag: 'OPERATOR_AUTHORIZED_EXPORT',
  });
  assert.strictEqual(authorized.provenance, 'OPERATOR_AUTHORIZED_EXPORT');
  assert.throws(() => ingestBarSeries({
    symbol: 'EURUSD', timeframe: 'M1', bars, sourceTag: 'RAW_BROKER_RECORD',
  }), /DATA_PROVENANCE_REFUSED/);
  assert.throws(() => ingestBarSeries({
    symbol: 'EURUSD', timeframe: 'M1', bars, sourceTag: undefined,
  }), /DATA_PROVENANCE_REFUSED/);
  assert.throws(() => ingestBarSeries({
    symbol: 'XYZUSD', timeframe: 'M1', bars, sourceTag: 'SYNTHETIC_FIXTURE',
  }), /DATA_SYMBOL_UNSUPPORTED/);
});

test('aggregateTimeframe: exact OHLC aggregation with 120 M1 bars into 24 M5 buckets', () => {
  const bars = Array.from({ length: 120 }, (_, i) => ({
    t: 3600 + M1 * i,
    open: 1.1 + i * 0.0001,
    high: 1.1 + i * 0.0001 + 0.0006,
    low: 1.1 + i * 0.0001 - 0.0005,
    close: 1.1 + i * 0.0001 + 0.0002,
    volume: 2,
  }));
  const series = ingestBarSeries({ symbol: 'EURUSD', timeframe: 'M1', bars, sourceTag: 'SYNTHETIC_FIXTURE' });
  const m5 = aggregateTimeframe(series, 'M5');
  assert.strictEqual(m5.nBars, 24);
  assert.strictEqual(m5.gapBuckets, 0);
  const first = m5.bars[0];
  assert.strictEqual(first.open, bars[0].open);
  assert.strictEqual(first.close, bars[4].close);
  assert.strictEqual(first.high, Math.max(...bars.slice(0, 5).map((b) => b.high)));
  assert.strictEqual(first.low, Math.min(...bars.slice(0, 5).map((b) => b.low)));
  assert.strictEqual(first.volume, 10);
  assert.strictEqual(first.actualBars, 5);
  assert.strictEqual(first.expectedBars, 5);
  // H1 aggregation of the same series: 2 buckets.
  const h1 = aggregateTimeframe(series, 'H1');
  assert.strictEqual(h1.nBars, 2);
  assert.strictEqual(h1.bars[0].actualBars, 60);
});

test('aggregateTimeframe drops the trailing partial bucket (no partial last bar)', () => {
  // 122 M1 bars (5-minute-aligned start): 24 full M5 buckets + 2 leftover
  // minutes -> partial trailing bucket dropped.
  const bars = Array.from({ length: 122 }, (_, i) => mkM1Bar(M5 + M1 * i));
  const series = ingestBarSeries({ symbol: 'EURUSD', timeframe: 'M1', bars, sourceTag: 'SYNTHETIC_FIXTURE' });
  const m5 = aggregateTimeframe(series, 'M5');
  assert.strictEqual(m5.nBars, 24);
  const last = m5.bars[23];
  assert.strictEqual(last.actualBars, 5);
  // M1 -> H1 with 122 bars: 2 full hour buckets, partial third dropped.
  const h1 = aggregateTimeframe(series, 'H1');
  assert.strictEqual(h1.nBars, 2);
});

test('aggregateTimeframe records interior gaps and refuses non-M1 bases', () => {
  // Hour-aligned start; remove minutes 61..63 (interior gap in the first
  // hour bucket).
  const hourAligned = 3600;
  const bars = Array.from({ length: 120 }, (_, i) => mkM1Bar(hourAligned + M1 * i));
  const withGap = bars.filter((b) => !(b.t > hourAligned && b.t <= hourAligned + 3 * M1));
  const series = ingestBarSeries({ symbol: 'EURUSD', timeframe: 'M1', bars: withGap, sourceTag: 'SYNTHETIC_FIXTURE' });
  const h1 = aggregateTimeframe(series, 'H1');
  assert.strictEqual(h1.nBars, 2);
  assert.strictEqual(h1.gapBuckets, 1);
  assert.strictEqual(h1.bars[0].actualBars, 57);
  assert.strictEqual(h1.bars[0].expectedBars, 60);
  assert.strictEqual(h1.bars[1].actualBars, 60);

  const m5series = ingestBarSeries({
    symbol: 'EURUSD', timeframe: 'M5',
    bars: Array.from({ length: 10 }, (_, i) => ({ ...mkM1Bar(M5 * (i + 1)) })),
    sourceTag: 'SYNTHETIC_FIXTURE',
  });
  assert.throws(() => aggregateTimeframe(m5series, 'H1'), /DATA_AGGREGATION_BASE_M1_REQUIRED/);
  assert.throws(() => aggregateTimeframe(series, 'M1'), /DATA_AGGREGATION_TARGET_M1_REFUSED/);
  assert.throws(() => aggregateTimeframe(series, 'H2'), /DATA_TIMEFRAME_UNKNOWN/);
});

test('closedBarAt: only fully closed higher-TF bars are visible at a decision time', () => {
  // M5 bars at t = 300,600,900... minutes (each covers [t, t+300)).
  const bars = Array.from({ length: 6 }, (_, i) => ({ ...mkM1Bar(M5 * (i + 1)) }));
  const tf = 'M5';
  // Decision at t=600s: the bar [300,600) is closed exactly at 600.
  const r1 = closedBarAt(bars, 600, tf);
  assert.strictEqual(r1.bar.t, 300);
  assert.strictEqual(r1.closedAt, 600);
  // Decision at t=899: the bar [600,900) is NOT closed; last closed is
  // [300,600).
  const r2 = closedBarAt(bars, 899, tf);
  assert.strictEqual(r2.bar.t, 300);
  assert.strictEqual(r2.closedAt, 600);
  // Before any bar closed: refusal (no future peek).
  assert.throws(() => closedBarAt(bars, 599, tf), /DATA_CONTEXT_BAR_NONE/);
  assert.throws(() => closedBarAt([], 600, tf), /DATA_CONTEXT_BARS_REQUIRED/);
  assert.throws(() => closedBarAt(bars, 600, 'H2'), /DATA_TIMEFRAME_UNKNOWN/);
});
