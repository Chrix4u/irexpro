import {
  replaySmartProfitProtection,
  type SmartProtectionTrade,
  type SmartProtectionCandle,
} from './smart-profit-protection-shadow';

const base = new Date('2026-11-10T00:00:00.000Z').getTime();
const m1 = (index: number, r: number): SmartProtectionCandle => {
  const started = new Date(base + index * 60_000);
  const bid = 1.1 + r * 0.001;
  return {
    timeframe: 'M1',
    bucket_time: started,
    source: 'ctrader-broker-native',
    close: bid,
    bid_close: bid,
    ask_close: bid + 0.00001,
    sample_count: 40,
    positive_quote_sample_count: 10,
    last_quote_sample_at: new Date(started.getTime() + 50_000),
  };
};
const context = (timeframe: 'M5' | 'M15', start: string, price: number): SmartProtectionCandle => ({
  timeframe,
  bucket_time: start,
  close: price,
  bid_close: null,
  ask_close: null,
  source: 'ctrader-broker-native',
  sample_count: 20,
  positive_quote_sample_count: 0,
  last_quote_sample_at: null,
});
const fallingHistory = (): SmartProtectionCandle[] => [
  context('M5', '2026-11-09T23:40:00Z', 1.1006),
  context('M5', '2026-11-09T23:45:00Z', 1.1005),
  context('M5', '2026-11-09T23:50:00Z', 1.1004),
  context('M5', '2026-11-09T23:55:00Z', 1.1003),
  context('M15', '2026-11-09T23:00:00Z', 1.101),
  context('M15', '2026-11-09T23:15:00Z', 1.1008),
  context('M15', '2026-11-09T23:30:00Z', 1.1006),
  context('M15', '2026-11-09T23:45:00Z', 1.1002),
];
const trial = (
  series: number[],
  opts: Partial<SmartProtectionTrade> = {},
): SmartProtectionTrade => ({
  instrument: 'EURUSD',
  direction: 'BUY',
  strategyRoute: 'CONFIRMED_REVERSAL',
  openedAt: new Date(base + 10_000),
  closedAt: new Date(base + (series.length + 1) * 60_000 + 15_000),
  entryPrice: 1.1,
  stopLoss: 1.099,
  takeProfit: 1.102,
  exitPrice: 1.102,
  initialRiskCash: 100,
  settledGrossPnl: 200,
  settledCommission: -10,
  settledSwap: 0,
  candles: [...fallingHistory(), ...series.map((r, i) => m1(i, r))],
  ...opts,
});
const by = (result: ReturnType<typeof replaySmartProfitProtection>, name: string) =>
  result.alternatives.find((c) => c.policy === name)!;

describe('as-of broker-native smart-protection replay (never broker execution)', () => {
  it('exposes strong TP winner harmed by a simple trailing close but preserved at 75% size by partial runner', () => {
    const result = replaySmartProfitProtection(
      trial([0, 0.2, 0.55, 0.6, 0.2, 0.1, 0.35, 0.7, 1.2, 1.6, 1.9]),
    );
    expect(result.dataQuality).toBe('COMPLETE');
    expect(result.actualTpWinner).toBe(true);
    const trail = by(result, 'SIMPLE_FULL_TRAIL');
    expect(trail.action).toBe('FULL_EXIT');
    expect(trail.truncatedActualTpWinner).toBe(true);
    expect(trail.hypotheticalNetPnl).toBeLessThan(result.actualNetPnl);
    const runner = by(result, 'QUARTER_PARTIAL_RUNNER');
    expect(runner.action).toBe('PARTIAL_AND_HOLD');
    expect(runner.truncatedActualTpWinner).toBe(false);
    expect(runner.hypotheticalNetPnl).toBeGreaterThan(0);
    expect(result.executionAuthority).toBe('NONE');
    expect(result.modifiesExecution).toBe(false);
    expect(result.promotionEligible).toBe(false);
  });

  it('compares actual loss against a replayed next-minute exit; partial runner reduces but does not erase a loss', () => {
    const result = replaySmartProfitProtection(
      trial([0, 0.2, 0.55, 0.65, 0.4, 0.2, 0.1, -0.2, -0.6, -0.9, -1], {
        settledGrossPnl: -100,
        exitPrice: 1.099,
      }),
    );
    expect(result.actualNetPnl).toBe(-110);
    const trail = by(result, 'SIMPLE_FULL_TRAIL');
    expect(trail.action).toBe('FULL_EXIT');
    expect(trail.firstActionAt).toBe('2026-11-10T00:06:00.000Z');
    expect(trail.hypotheticalFillAt).toBe('2026-11-10T00:07:00.000Z');
    expect(trail.hypotheticalNetPnl).toBe(0);
    expect(trail.improvedActualNetLoser).toBe(true);
    const partial = by(result, 'QUARTER_PARTIAL_RUNNER');
    expect(partial.action).toBe('PARTIAL_AND_HOLD');
    expect(partial.hypotheticalNetPnl).toBeGreaterThan(-110);
    expect(partial.hypotheticalNetPnl).toBeLessThan(0);
  });

  it('uses only previously completed M5 and M15 context when evaluating a reversal', () => {
    const result = replaySmartProfitProtection(
      trial([0, 0.2, 0.55, 0.65, 0.35, 0.2, 0.1, -0.2, -0.6, -0.9, -1], {
        settledGrossPnl: -100,
        exitPrice: 1.099,
      }),
    );
    const contextual = by(result, 'CONFIRMED_TREND_EXIT');
    // Both independently closed context windows were already adverse.
    expect(contextual.action).toBe('FULL_EXIT');
    expect(contextual.improvedActualNetLoser).toBe(true);
  });

  it('cannot read a future M15 candle to justify an earlier direction change', () => {
    const futureContext = [
      context('M15', '2026-11-10T00:15:00Z', 1.0),
      context('M15', '2026-11-10T00:30:00Z', 0.9),
      context('M15', '2026-11-10T00:45:00Z', 0.8),
    ];
    const result = replaySmartProfitProtection(
      trial([0, 0.2, 0.55, 0.65, 0.35, 0.2, 0.1, -0.2, -0.6, -0.9, -1], {
        settledGrossPnl: -100,
        exitPrice: 1.099,
        candles: [
          ...Array.from({ length: 11 }, (_, i) =>
            m1(i, [0, 0.2, 0.55, 0.65, 0.35, 0.2, 0.1, -0.2, -0.6, -0.9, -1][i]!),
          ),
          ...futureContext,
        ],
      }),
    );
    expect(by(result, 'CONFIRMED_TREND_EXIT').action).toBe('NO_SIGNAL');
    expect(result.contextualM15Bars).toBe(0);
  });

  it('fails closed on missing quote evidence and does not infer fills from untrusted rows', () => {
    const result = replaySmartProfitProtection(
      trial([0, 0.2, 0.55, 0.65, 0.4, 0.2, 0.1], {
        candles: [
          m1(0, 0),
          {
            ...m1(1, 0.6),
            source: 'synthetic',
            positive_quote_sample_count: 0,
          },
        ],
      }),
    );
    expect(result.dataQuality).toBe('INSUFFICIENT_CAUSAL_MARKS');
    expect(result.causalM1Marks).toBe(1);
    expect(by(result, 'SIMPLE_FULL_TRAIL').action).toBe('NO_SIGNAL');
  });

  it('does not pretend a gap is an executable next-minute fill', () => {
    const series = [0, 0.55, 0.15, 0.1, -0.3, -0.4, -0.5];
    const candles = series.map((r, i) => m1(i === 3 ? 5 : i > 3 ? i + 2 : i, r));
    const result = replaySmartProfitProtection(trial(series, { candles }));
    expect(result.missingM1Minutes).toBeGreaterThan(0);
    expect(result.dataQuality).toBe('PARTIAL_QUOTE_COVERAGE');
    expect(
      result.alternatives.every((a) => !a.truncatedActualTpWinner || a.action === 'FULL_EXIT'),
    ).toBe(true);
  });

  it('cannot produce decisions with invalid risk, backward stop or missing prices', () => {
    for (const patch of [
      { initialRiskCash: 0 },
      { stopLoss: 1.101 },
      { entryPrice: NaN },
      { takeProfit: 1.098 },
    ]) {
      const result = replaySmartProfitProtection(trial([0, 0.6, 0.3, 0.2, 0, -0.2], patch));
      expect(result.dataQuality).toBe('INVALID_TRADE');
      expect(result.alternatives.every((a) => a.action === 'NO_SIGNAL')).toBe(true);
    }
  });

  it('never uses settled commission to change a historical signal time', () => {
    const sample = [0, 0.2, 0.55, 0.6, 0.2, 0.1, 0.35, 0.7, 1.2];
    const cheap = replaySmartProfitProtection(trial(sample, { settledCommission: -1 }));
    const expensive = replaySmartProfitProtection(trial(sample, { settledCommission: -25 }));
    for (const policy of ['SIMPLE_FULL_TRAIL', 'QUARTER_PARTIAL_RUNNER']) {
      expect(by(cheap, policy).firstActionAt).toBe(by(expensive, policy).firstActionAt);
      expect(by(cheap, policy).hypotheticalFillAt).toBe(by(expensive, policy).hypotheticalFillAt);
    }
    expect(expensive.actualNetPnl).toBeLessThan(cheap.actualNetPnl);
  });
});
