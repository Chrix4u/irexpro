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
