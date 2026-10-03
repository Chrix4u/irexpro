import {
  resolveEnsembleShadowOutcome,
  summarizeEnsembleSleeveOutcomes,
} from './ensemble-shadow-outcome';

const base = {
  direction: 'BUY' as const,
  marketBarTime: new Date('2026-10-05T10:00:00Z'),
  entryPrice: 1.1,
  stopLoss: 1.099,
  takeProfit: 1.1015,
  estimatedExecutionCostR: 0.1,
};

function candle(minute: number, low: number, high: number, close = (low + high) / 2) {
  return {
    timestamp: new Date(Date.UTC(2026, 9, 5, 10, minute, 0)),
    low,
    high,
    close,
  };
}

describe('ensemble shadow outcome', () => {
  it('resolves first-hit take profit and deducts cost R', () => {
    const result = resolveEnsembleShadowOutcome(base, [
      candle(5, 1.0998, 1.1008),
      candle(10, 1.1002, 1.1016),
    ]);
    expect(result?.status).toBe('WIN');
    expect(result?.grossR).toBeCloseTo(1.5, 8);
    expect(result?.netR).toBeCloseTo(1.4, 8);
    expect(result?.barsObserved).toBe(2);
  });

  it('resolves stop loss before a later take profit', () => {
    const result = resolveEnsembleShadowOutcome(base, [
      candle(5, 1.0989, 1.1005),
      candle(10, 1.1, 1.102),
    ]);
    expect(result?.status).toBe('LOSS');
    expect(result?.grossR).toBeCloseTo(-1, 8);
    expect(result?.netR).toBeCloseTo(-1.1, 8);
  });

  it('records conservative profit giveback before a later stop loss', () => {
    const result = resolveEnsembleShadowOutcome(base, [
      candle(5, 1.0998, 1.1007, 1.1006),
      candle(10, 1.0989, 1.1004, 1.099),
    ]);

    expect(result?.status).toBe('LOSS');
    expect(result?.postEntryTelemetry?.maxFavorableR).toBeCloseTo(0.7, 8);
    expect(result?.postEntryTelemetry?.gaveBackHalfRToLoss).toBe(true);
    expect(result?.postEntryTelemetry?.gaveBackOneRToLoss).toBe(false);
    expect(result?.postEntryTelemetry?.maxCloseGivebackR).toBeCloseTo(1.7, 8);
  });

  it('does not count unknown exit-bar favorable excursion before a stop', () => {
    const result = resolveEnsembleShadowOutcome(base, [candle(5, 1.0989, 1.1008, 1.099)]);

    expect(result?.status).toBe('LOSS');
    expect(result?.postEntryTelemetry?.maxFavorableR).toBe(0);
    expect(result?.postEntryTelemetry?.gaveBackHalfRToLoss).toBe(false);
  });

  it('marks same-bar SL and TP as ambiguous', () => {
    const result = resolveEnsembleShadowOutcome(base, [candle(5, 1.0988, 1.1017)]);
    expect(result?.status).toBe('AMBIGUOUS');
    expect(result?.netR).toBeNull();
  });

  it('expires only after the complete fixed horizon', () => {
    const candles = Array.from({ length: 3 }, (_, index) =>
      candle(5 * (index + 1), 1.0995, 1.1005, 1.1002),
    );
    expect(resolveEnsembleShadowOutcome(base, candles, 4)).toBeNull();

    const resolved = resolveEnsembleShadowOutcome(
      base,
      [...candles, candle(20, 1.0995, 1.1005, 1.1004)],
      4,
    );
    expect(resolved?.status).toBe('EXPIRED');
    expect(resolved?.barsObserved).toBe(4);
    expect(resolved?.netR).toBeCloseTo(0.3, 8);
  });

  it('summarizes only non-ambiguous net-R outcomes', () => {
    const summary = summarizeEnsembleSleeveOutcomes([
      {
        version: 'm5-first-hit-72bar-net-r-path-v2',
        status: 'WIN',
        resolvedAt: '2026-10-05T10:10:00Z',
        barsObserved: 2,
        exitPrice: 1,
        grossR: 1.5,
        netR: 1.4,
        reason: 'TAKE_PROFIT_HIT',
        postEntryTelemetry: null,
      },
      {
        version: 'm5-first-hit-72bar-net-r-path-v2',
        status: 'LOSS',
        resolvedAt: '2026-10-06T10:10:00Z',
        barsObserved: 2,
        exitPrice: 1,
        grossR: -1,
        netR: -1.1,
        reason: 'STOP_LOSS_HIT',
        postEntryTelemetry: null,
      },
      {
        version: 'm5-first-hit-72bar-net-r-path-v2',
        status: 'AMBIGUOUS',
        resolvedAt: '2026-10-07T10:10:00Z',
        barsObserved: 1,
        exitPrice: null,
        grossR: null,
        netR: null,
        reason: 'SAME_BAR_SL_TP',
        postEntryTelemetry: null,
      },
    ]);
    expect(summary.closedTrades).toBe(2);
    expect(summary.profitFactor).toBeCloseTo(1.4 / 1.1, 8);
    expect(summary.maxDrawdown).not.toBeNull();
    expect(summary.positiveWindowFraction).not.toBeNull();
  });
});
