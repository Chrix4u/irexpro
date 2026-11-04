import { compareExitAlternatives, ExitCandle, ExitScenarioInput } from './profit-exit-alternatives';

describe('verified-M1 exit scenario comparisons', () => {
  const closeAt = new Date('2026-11-04T09:00:15.000Z');
  const candle = (minute: number, high: number, low: number): ExitCandle => ({
    bucket_time: new Date(Date.UTC(2026, 10, 4, 9, minute, 0)),
    high, low, sample_count: 12, positive_quote_sample_count: 6,
    last_quote_sample_at: new Date(Date.UTC(2026, 10, 4, 9, minute, 36)),
    source: 'ctrader-broker-native',
  });
  const base: ExitScenarioInput = {
    direction: 'BUY', closeAt, entryPrice: 1.1, exitPrice: 1.1003,
    stopPrice: 1.0997, takeProfitPrice: 1.1009,
    runnerStopPrice: 1.10015, runnerEligible: true,
    grossPnl: 6, commission: -1.6, swap: 0,
    candles: [candle(1, 1.1004, 1.10022), candle(2, 1.10095, 1.1002)],
  };

  it('detects a tight protected runner stop before a later TP', () => {
    const result = compareExitAlternatives({
      ...base,
      candles: [candle(1, 1.1004, 1.1001), candle(2, 1.10095, 1.10001)],
    });
    expect(result.runner).toMatchObject({ outcome: 'STOP_FIRST', netPnlProxy: 1.4 });
    expect(result.halfPartial.outcome).toBe('TP_FIRST');
  });

  it('does not invent event order for a same-minute TP and stop', () => {
    const result = compareExitAlternatives({
      ...base,
      candles: [candle(1, 1.101, 1.0995)],
    });
    expect(result.halfPartial).toMatchObject({ outcome: 'AMBIGUOUS', netPnlProxy: null });
    expect(result.runner.outcome).toBe('AMBIGUOUS');
  });

  it('classifies missing, backfilled and late-quote candles as data gaps', () => {
    const missing = compareExitAlternatives({
      ...base,
      candles: [candle(2, 1.101, 1.1002)],
    });
    expect(missing.runner.outcome).toBe('DATA_GAP');

    const backfill = compareExitAlternatives({
      ...base,
      candles: [{ ...candle(1, 1.101, 1.1002), positive_quote_sample_count: 0 }],
    });
    expect(backfill.runner).toMatchObject({ outcome: 'DATA_GAP', netPnlProxy: null });

    const late = compareExitAlternatives({
      ...base,
      candles: [{
        ...candle(1, 1.101, 1.1002),
        last_quote_sample_at: new Date('2026-11-04T09:04:00.000Z'),
      }],
    });
    expect(late.runner.outcome).toBe('DATA_GAP');
  });

  it('never upgrades an invalid protected stop into a trade', () => {
    const result = compareExitAlternatives({ ...base, runnerStopPrice: 1.1006 });
    expect(result.runner.outcome).toBe('INELIGIBLE');
    expect(result.halfPartial.outcome).toBe('TP_FIRST');
    expect(result.modifiesExecution).toBe(false);
  });

  it('handles both SELL stop barriers and negative comparative expectancy', () => {
    const result = compareExitAlternatives({
      ...base,
      direction: 'SELL',
      entryPrice: 158.4,
      exitPrice: 158.38,
      stopPrice: 158.46,
      takeProfitPrice: 158.31,
      runnerStopPrice: 158.39,
      candles: [{ ...candle(1, 158.47, 158.37) }],
    });
    expect(result.halfPartial.outcome).toBe('STOP_FIRST');
    expect(result.runner.outcome).toBe('STOP_FIRST');
    expect(result.halfPartial.deltaVsOriginal).toBeLessThan(0);
  });

  it('grades first TP after fees and adds a split-execution allowance', () => {
    const result = compareExitAlternatives(base);
    expect(result).toMatchObject({
      mode: 'SHADOW_ONLY', modifiesExecution: false,
      originalNetPnl: 4.4,
      runner: { outcome: 'TP_FIRST', netPnlProxy: 16.4, deltaVsOriginal: 12 },
      halfPartial: { outcome: 'TP_FIRST', netPnlProxy: 10, deltaVsOriginal: 5.6 },
    });
  });
});
