import {
  buildEnsembleShadowPathObservations,
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
  it('builds causal pre-exit bar-level path states and excludes the exit bar', () => {
    const path = buildEnsembleShadowPathObservations(base, [
      candle(5, 1.0998, 1.1008, 1.1006),
      candle(10, 1.0999, 1.1005, 1.10015),
      candle(15, 1.0989, 1.1002, 1.099),
    ]);

    expect(path).toHaveLength(2);
    expect(path[0]).toEqual(
      expect.objectContaining({
        version: 'm5-preexit-path-state-v1',
        barIndex: 1,
      }),
    );
    expect(path[0]!.closeR).toBeCloseTo(0.6, 8);
    expect(path[0]!.runningMfeR).toBeCloseTo(0.8, 8);
    expect(path[0]!.runningMaeR).toBeCloseTo(-0.2, 8);
    expect(path[0]!.stopCushionR).toBeCloseTo(1.6, 8);
    expect(path[0]!.targetDistanceR).toBeCloseTo(0.9, 8);
    expect(path[1]!.closeR).toBeCloseTo(0.15, 8);
    expect(path[1]!.peakCloseR).toBeCloseTo(0.6, 8);
    expect(path[1]!.closeGivebackR).toBeCloseTo(0.45, 8);
    expect(path[1]!.maxCloseGivebackR).toBeCloseTo(0.45, 8);
  });

  it('computes SELL path-state distances in R-space', () => {
    const sell = {
      ...base,
      direction: 'SELL' as const,
      entryPrice: 1.1,
      stopLoss: 1.101,
      takeProfit: 1.0985,
    };
    const path = buildEnsembleShadowPathObservations(sell, [candle(5, 1.0992, 1.1002, 1.0995)]);
    expect(path).toHaveLength(1);
    expect(path[0]!.closeR).toBeCloseTo(0.5, 8);
    expect(path[0]!.runningMfeR).toBeCloseTo(0.8, 8);
    expect(path[0]!.runningMaeR).toBeCloseTo(-0.2, 8);
    expect(path[0]!.stopCushionR).toBeCloseTo(1.5, 8);
    expect(path[0]!.targetDistanceR).toBeCloseTo(1.0, 8);
  });

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

  it('scores conservative close-bar profit-protection counterfactuals without changing the base outcome', () => {
    const result = resolveEnsembleShadowOutcome(base, [
      candle(5, 1.0998, 1.1008, 1.1006),
      candle(10, 1.0999, 1.1005, 1.10015),
      candle(15, 1.0989, 1.1002, 1.099),
    ]);

    expect(result?.status).toBe('LOSS');
    expect(result?.netR).toBeCloseTo(-1.1, 8);

    const policies = result?.postEntryTelemetry?.profitProtectionCounterfactuals ?? [];
    const halfR = policies.find((policy) => policy.code === 'CLOSE_LOCK_050_GIVEBACK_040');
    const threeQuarterR = policies.find((policy) => policy.code === 'CLOSE_LOCK_075_GIVEBACK_050');

    expect(halfR?.activated).toBe(true);
    expect(halfR?.exitedEarly).toBe(true);
    expect(halfR?.grossR).toBeCloseTo(0.15, 8);
    expect(halfR?.netR).toBeCloseTo(0.05, 8);
    expect(halfR?.deltaNetRVsBase).toBeCloseTo(1.15, 8);

    expect(threeQuarterR?.activated).toBe(false);
    expect(threeQuarterR?.exitedEarly).toBe(false);
    expect(threeQuarterR?.netR).toBeCloseTo(-1.1, 8);
    expect(threeQuarterR?.deltaNetRVsBase).toBeCloseTo(0, 8);
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
        version: 'm5-first-hit-72bar-net-r-path-v3',
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
        version: 'm5-first-hit-72bar-net-r-path-v3',
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
        version: 'm5-first-hit-72bar-net-r-path-v3',
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
