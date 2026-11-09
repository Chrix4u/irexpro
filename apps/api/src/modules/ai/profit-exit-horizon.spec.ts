import {
  evaluatePostExitHoldHorizons,
  summarizeExitObservation,
  ExitCandle,
  ExitScenarioInput,
} from './profit-exit-alternatives';

describe('post-exit completed M1 horizon recovery research v2', () => {
  const at = new Date('2026-11-09T08:51:05.000Z');
  const base: ExitScenarioInput = {
    direction: 'BUY',
    closeAt: at,
    entryPrice: 1.11877,
    exitPrice: 1.11851,
    stopPrice: 1.11827,
    takeProfitPrice: 1.11957,
    runnerStopPrice: null,
    runnerEligible: false,
    grossPnl: -4.18,
    commission: -1.62,
    swap: 0,
    candles: [],
  };
  const candles = (price = 1.11912): ExitCandle[] =>
    Array.from({ length: 60 }, (_, n) => {
      const at = new Date(Date.UTC(2026, 10, 9, 8, 52 + n));
      return {
        bucket_time: at,
        high: price + 0.00001,
        low: price - 0.00001,
        bid_close: price,
        ask_close: price + 0.00001,
        spread_close: 0.00001,
        sample_count: 20,
        positive_quote_sample_count: 18,
        last_quote_sample_at: new Date(at.getTime() + 51_000),
        source: 'ctrader-broker-native',
      };
    });

  it('exposes recovered 15m/30m/60m hypothetical after-fee net for the Nov 9 EURUSD BUY', () => {
    const x = evaluatePostExitHoldHorizons({ ...base, candles: candles() });
    expect(x).toHaveLength(3);
    expect(x.map((s) => s.completedBars)).toEqual([15, 30, 60]);
    expect(x.map((s) => s.state)).toEqual([
      'OPEN_AT_HORIZON',
      'OPEN_AT_HORIZON',
      'OPEN_AT_HORIZON',
    ]);
    expect(x[0].actualNetPnl).toBe(-5.8);
    expect(x[0].indicativeNetPnl).toBeCloseTo(4.0077, 1);
    expect(x[0].deltaVsActualClose).toBeCloseTo(9.8077, 1);
    expect(x[0].providerFillCertified).toBe(false);
  });

  it('censors at first possible broker stop and never invents a later recovery', () => {
    const bars = candles();
    bars[8] = { ...bars[8], low: 1.11827 };
    const x = evaluatePostExitHoldHorizons({ ...base, candles: bars });
    expect(x.map((s) => s.state)).toEqual([
      'POSSIBLE_STOP_FIRST',
      'POSSIBLE_STOP_FIRST',
      'POSSIBLE_STOP_FIRST',
    ]);
    expect(x.every((s) => s.indicativeNetPnl === null)).toBe(true);
  });

  it('accounts for the quote spread when the midpoint low is above broker stop', () => {
    const bars = candles();
    bars[2] = { ...bars[2], low: 1.11828, spread_close: 0.00003 };
    expect(evaluatePostExitHoldHorizons({ ...base, candles: bars })[0].state).toBe(
      'POSSIBLE_STOP_FIRST',
    );
  });

  it('never calls simultaneous stop/target hits a successful fill', () => {
    const bars = candles();
    bars[7] = { ...bars[7], low: 1.11827, high: 1.11957 };
    const x = evaluatePostExitHoldHorizons({ ...base, candles: bars });
    expect(x[0]).toMatchObject({
      state: 'SAME_BAR_AMBIGUITY',
      indicativeNetPnl: null,
      providerFillCertified: false,
    });
  });

  it('does not infer a 15-minute hold if the target might have filled earlier', () => {
    const bars = candles();
    bars[9] = { ...bars[9], high: 1.1196 };
    expect(evaluatePostExitHoldHorizons({ ...base, candles: bars })[0]).toMatchObject({
      state: 'POSSIBLE_TARGET_FIRST',
      indicativeNetPnl: null,
    });
  });

  it('rejects incomplete native M1 paths, unsampled/backfilled quotes and duplicate candles', () => {
    const baseCandles = candles();
    const variants: ExitCandle[][] = [
      baseCandles.slice(1),
      baseCandles.filter((_, n) => n !== 4),
      [...baseCandles, baseCandles[2]!],
      baseCandles.map((c, n) => (n === 1 ? { ...c, positive_quote_sample_count: 0 } : c)),
      baseCandles.map((c, n) =>
        n === 1 ? { ...c, last_quote_sample_at: new Date('2026-11-09T10:00:00Z') } : c,
      ),
      baseCandles.map((c, n) => (n === 1 ? { ...c, bid_close: null } : c)),
      baseCandles.map((c, n) => (n === 1 ? { ...c, source: 'twelve-data' } : c)),
    ];
    for (const rows of variants) {
      const result = evaluatePostExitHoldHorizons({ ...base, candles: rows });
      expect(result[0].state).toBe('DATA_GAP');
      expect(result[0].indicativeNetPnl).toBeNull();
    }
  });

  it('handles SELL executable ask and positive/negative post-exit prices symmetrically', () => {
    const sell = {
      ...base,
      direction: 'SELL' as const,
      entryPrice: 157.9,
      exitPrice: 157.95,
      stopPrice: 158.1,
      takeProfitPrice: 157.6,
      grossPnl: -3.2,
    };
    const rows = candles().map((c) => ({
      ...c,
      high: 157.84,
      low: 157.82,
      bid_close: 157.83,
      ask_close: 157.84,
      spread_close: 0.01,
    }));
    const x = evaluatePostExitHoldHorizons({ ...sell, candles: rows });
    expect(x[0].state).toBe('OPEN_AT_HORIZON');
    expect(x[0].indicativeNetPnl).toBeGreaterThan(0);
    expect(x[0].actualNetPnl).toBe(-4.82);
  });

  it('does not invent converted currency profit for zero-movement broker exits', () => {
    const x = evaluatePostExitHoldHorizons({
      ...base,
      exitPrice: base.entryPrice,
      grossPnl: 0,
      candles: candles(),
    });
    expect(x[0]).toMatchObject({
      state: 'MONEY_CONVERSION_UNAVAILABLE',
      indicativeNetPnl: null,
      actualNetPnl: -1.62,
    });
  });

  it('profit lock can be measured as recovered or worse without changing the actual exit', () => {
    const profit = {
      ...base,
      closeAt: new Date('2026-11-09T10:30:49Z'),
      entryPrice: 1.34192,
      exitPrice: 1.34221,
      stopPrice: 1.34143,
      takeProfitPrice: 1.34273,
      grossPnl: 0.78,
      commission: -0.32,
    };
    const rows = Array.from({ length: 60 }, (_, n): ExitCandle => {
      const time = new Date(Date.UTC(2026, 10, 9, 10, 31 + n));
      const price = n < 30 ? 1.34193 : 1.34245;
      return {
        bucket_time: time,
        high: price + 0.00001,
        low: price - 0.00001,
        bid_close: price,
        ask_close: price + 0.00001,
        spread_close: 0.00001,
        sample_count: 20,
        positive_quote_sample_count: 20,
        last_quote_sample_at: new Date(time.getTime() + 50_000),
        source: 'ctrader-broker-native',
      };
    });
    const x = evaluatePostExitHoldHorizons({ ...profit, candles: rows });
    expect(x[0].actualNetPnl).toBe(0.46);
    expect(x[0].indicativeNetPnl).toBeLessThan(0);
    expect(x[2].indicativeNetPnl).toBeGreaterThan(0.46);
  });
  it('does not hide a qualified partial-close study behind ineligible runner status', () => {
    const tp = {
      runner: { outcome: 'INELIGIBLE' as const },
      halfPartial: { outcome: 'TP_FIRST' as const },
    };
    const sl = {
      runner: { outcome: 'INELIGIBLE' as const },
      halfPartial: { outcome: 'STOP_FIRST' as const },
    };
    const none = {
      runner: { outcome: 'INELIGIBLE' as const },
      halfPartial: { outcome: 'INELIGIBLE' as const },
    };
    expect(summarizeExitObservation(tp)).toEqual({
      state: 'TP_FIRST',
      scenario: 'HALF_PARTIAL',
    });
    expect(summarizeExitObservation(sl)).toEqual({
      state: 'STOP_FIRST',
      scenario: 'HALF_PARTIAL',
    });
    expect(summarizeExitObservation(none)).toEqual({
      state: 'INELIGIBLE',
      scenario: 'HALF_PARTIAL',
    });
  });

  it('prefers an eligible runner observation without rewriting its outcome', () => {
    const gap = {
      runner: { outcome: 'DATA_GAP' as const },
      halfPartial: { outcome: 'TP_FIRST' as const },
    };
    const stop = {
      runner: { outcome: 'STOP_FIRST' as const },
      halfPartial: { outcome: 'TP_FIRST' as const },
    };
    expect(summarizeExitObservation(gap)).toEqual({
      state: 'DATA_GAP',
      scenario: 'PROTECTED_RUNNER',
    });
    expect(summarizeExitObservation(stop)).toEqual({
      state: 'STOP_FIRST',
      scenario: 'PROTECTED_RUNNER',
    });
  });
});
