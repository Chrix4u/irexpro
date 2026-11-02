import { buildM1TacticalFeatures, type M1TacticalFeatureInput } from './m1-tactical-features';
import type { LivePaperCandleInput } from '../broker/services/live-paper-market-data.service';

function seriesEndingAt(
  decisionTime: Date,
  count: number,
  minutes: number,
  base = 1.1,
  step = 0.00008,
): LivePaperCandleInput[] {
  const ms = minutes * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const openTime = new Date(decisionTime.getTime() - (count - index) * ms);
    const mid = base + index * step;
    return {
      timestamp: openTime,
      open: mid.toFixed(6),
      high: (mid + 0.00025).toFixed(6),
      low: (mid - 0.0002).toFixed(6),
      close: (mid + step * 0.6).toFixed(6),
    };
  });
}

function baseInput(): M1TacticalFeatureInput {
  const decisionTime = new Date('2026-10-15T10:30:00.000Z');
  return {
    instrument: 'EURUSD',
    decisionTime,
    m1: seriesEndingAt(decisionTime, 60, 1),
    m5: seriesEndingAt(decisionTime, 35, 5, 1.09, 0.00012),
    m15: seriesEndingAt(decisionTime, 35, 15, 1.08, 0.00015),
    h1: seriesEndingAt(decisionTime, 35, 60, 1.06, 0.0002),
    h4: seriesEndingAt(decisionTime, 35, 240, 1.02, 0.0003),
  };
}

describe('buildM1TacticalFeatures', () => {
  it('uses only fully closed bars at decisionTime', () => {
    const input = baseInput();
    const baseline = buildM1TacticalFeatures(input)!;
    const incomplete = {
      timestamp: new Date(input.decisionTime),
      open: '9.0000',
      high: '9.5000',
      low: '8.5000',
      close: '9.2500',
    };

    const withIncomplete = buildM1TacticalFeatures({
      ...input,
      m1: [...input.m1, incomplete],
    })!;

    expect(withIncomplete.price).toBeCloseTo(baseline.price, 10);
    expect(withIncomplete.latestM1OpenTime.toISOString()).toBe(
      baseline.latestM1OpenTime.toISOString(),
    );
    expect(withIncomplete.momentum1Atr).toBeCloseTo(baseline.momentum1Atr, 10);
  });

  it('uses only completed M5 candles for reversal timing evidence', () => {
    const input = baseInput();
    const baseline = buildM1TacticalFeatures(input)!;
    const incompleteM5 = {
      timestamp: new Date(input.decisionTime),
      open: '1.5000',
      high: '1.9000',
      low: '1.1000',
      close: '1.1500',
    };

    const withIncomplete = buildM1TacticalFeatures({
      ...input,
      m5: [...input.m5, incompleteM5],
    })!;

    expect(withIncomplete.m5BodyPressure3).toBeCloseTo(baseline.m5BodyPressure3, 10);
    expect(withIncomplete.m5Momentum1Atr).toBeCloseTo(baseline.m5Momentum1Atr, 10);
    expect(withIncomplete.m5Momentum3Atr).toBeCloseTo(baseline.m5Momentum3Atr, 10);
  });

  it('detects bearish strength and persistence in the last completed M5 candles', () => {
    const input = baseInput();
    const m5 = [...input.m5];
    const anchor = Number(m5[m5.length - 4]!.close);
    for (let offset = 0; offset < 3; offset += 1) {
      const index = m5.length - 3 + offset;
      const open = anchor - offset * 0.00035;
      const close = open - 0.0003;
      m5[index] = {
        ...m5[index]!,
        open: open.toFixed(6),
        high: (open + 0.00008).toFixed(6),
        low: (close - 0.00008).toFixed(6),
        close: close.toFixed(6),
      };
    }

    const result = buildM1TacticalFeatures({ ...input, m5 })!;

    expect(result.m5BodyPressure3).toBeLessThan(0);
    expect(result.m5Momentum1Atr).toBeLessThan(0);
    expect(result.m5Momentum3Atr).toBeLessThan(0);
  });

  it('treats a flat latest broker minute as neutral candle geometry instead of dropping feature context', () => {
    const input = baseInput();
    const m1 = [...input.m1];
    const last = m1[m1.length - 1]!;
    m1[m1.length - 1] = {
      ...last,
      open: '1.105000',
      high: '1.105000',
      low: '1.105000',
      close: '1.105000',
    };

    const result = buildM1TacticalFeatures({ ...input, m1 });

    expect(result).not.toBeNull();
    expect(result!.bodyRangeRatio).toBe(0);
    expect(result!.upperWickRatio).toBe(0);
    expect(result!.lowerWickRatio).toBe(0);
    expect(result!.closeLocation).toBe(0.5);
  });

  it('computes body, wick and close-location geometry from the latest closed M1 candle', () => {
    const input = baseInput();
    const m1 = [...input.m1];
    m1[m1.length - 1] = {
      ...m1[m1.length - 1]!,
      open: '1.1000',
      high: '1.1010',
      low: '1.0990',
      close: '1.1005',
    };

    const result = buildM1TacticalFeatures({ ...input, m1 })!;
    expect(result.bodyRangeRatio).toBeCloseTo(0.25, 8);
    expect(result.upperWickRatio).toBeCloseTo(0.25, 8);
    expect(result.lowerWickRatio).toBeCloseTo(0.5, 8);
    expect(result.closeLocation).toBeCloseTo(0.75, 8);
  });

  it('produces finite EMA, momentum, M5 timing, efficiency, volatility and context features', () => {
    const result = buildM1TacticalFeatures(baseInput())!;

    expect(result.session).toBe('LONDON');
    expect(result.atr14).toBeGreaterThan(0);
    expect(result.rsi14).toBeGreaterThan(50);
    expect(result.emaSeparationAtr).toBeGreaterThan(0);
    expect(result.emaSlopeAtr).toBeGreaterThan(0);
    expect(result.momentum1Atr).toBeGreaterThan(0);
    expect(result.momentum3Atr).toBeGreaterThan(0);
    expect(result.momentum5Atr).toBeGreaterThan(0);
    expect(result.m5BodyPressure3).toBeGreaterThan(0);
    expect(result.m5Momentum1Atr).toBeGreaterThan(0);
    expect(result.m5Momentum3Atr).toBeGreaterThan(0);
    expect(result.efficiency5).toBeGreaterThan(0);
    expect(result.efficiency5).toBeLessThanOrEqual(1);
    expect(Number.isFinite(result.volatilityChange)).toBe(true);
    expect(result.extensionAtr).toBeGreaterThanOrEqual(0);
    expect(result.volatilityScore).toBeGreaterThanOrEqual(0);
    expect(result.alignment.m5).toBeGreaterThan(0);
    expect(result.alignment.m15).toBeGreaterThan(0);
    expect(result.alignment.h1).toBeGreaterThan(0);
    expect(result.alignment.h4).toBeGreaterThan(0);
    expect(result.higherTimeframeAgreement).toBeGreaterThan(0);
  });

  it('detects breakout and failed-breakout structure without future bars', () => {
    const input = baseInput();
    const breakoutM1 = seriesEndingAt(input.decisionTime, 60, 1, 1.0, 0.00045).map((row) => {
      const close = Number(row.close);
      return { ...row, high: (close + 0.0001).toFixed(6) };
    });
    const breakout = buildM1TacticalFeatures({ ...input, m1: breakoutM1 })!;
    expect(breakout.breakoutUpAtr).toBeGreaterThan(0);
    expect(breakout.breakoutDownAtr).toBe(0);

    const failedM1 = [...input.m1];
    const priorHigh = Math.max(...failedM1.slice(-21, -1).map((row) => Number(row.high)));
    const priorLow = Math.min(...failedM1.slice(-21, -1).map((row) => Number(row.low)));
    const last = failedM1[failedM1.length - 1]!;
    failedM1[failedM1.length - 1] = {
      ...last,
      open: String(priorHigh - 0.0001),
      high: String(priorHigh + 0.0004),
      low: String(priorLow + 0.0002),
      close: String(priorHigh - 0.0002),
    };
    const failed = buildM1TacticalFeatures({ ...input, m1: failedM1 })!;
    expect(failed.failedBreakoutUp).toBe(true);
  });

  it('normalizes bounded cTrader no-tick M1 gaps inside feature calculation without changing the latest broker bar', () => {
    const input = baseInput();
    const baseline = buildM1TacticalFeatures(input)!;
    const m1 = [...input.m1];
    m1.splice(m1.length - 12, 1);

    const result = buildM1TacticalFeatures({ ...input, m1 });

    expect(result).not.toBeNull();
    expect(result!.latestM1OpenTime.toISOString()).toBe(baseline.latestM1OpenTime.toISOString());
    expect(result!.price).toBeCloseTo(baseline.price, 10);
    expect(Number.isFinite(result!.atr14)).toBe(true);
  });

  it('normalizes a broker-observed nine-minute cTrader no-tick gap without dropping M1 readiness', () => {
    const input = baseInput();
    const m1 = [...input.m1];
    m1.splice(m1.length - 20, 9);
    expect(buildM1TacticalFeatures({ ...input, m1 })).not.toBeNull();
  });

  it('fails closed when a recent cTrader M1 outage exceeds the ten-minute no-tick allowance', () => {
    const input = baseInput();
    const m1 = [...input.m1];
    m1.splice(m1.length - 20, 11);
    expect(buildM1TacticalFeatures({ ...input, m1 })).toBeNull();
  });

  it('discards an old large M1 outage once at least 30 recent normalized bars exist after it', () => {
    const input = baseInput();
    const m1 = [...input.m1];
    m1.splice(8, 11);
    expect(buildM1TacticalFeatures({ ...input, m1 })).not.toBeNull();
  });

  it('returns null for non-monotonic or non-finite required price evidence', () => {
    const input = baseInput();
    const nonMonotonic = [...input.m1];
    [nonMonotonic[10], nonMonotonic[11]] = [nonMonotonic[11]!, nonMonotonic[10]!];
    expect(buildM1TacticalFeatures({ ...input, m1: nonMonotonic })).toBeNull();

    const invalid = [...input.m1];
    invalid[invalid.length - 1] = { ...invalid[invalid.length - 1]!, close: 'NaN' };
    expect(buildM1TacticalFeatures({ ...input, m1: invalid })).toBeNull();
  });

  it('returns null when any required higher-timeframe context is insufficient', () => {
    const input = baseInput();
    expect(buildM1TacticalFeatures({ ...input, h4: input.h4.slice(-10) })).toBeNull();
  });
});
