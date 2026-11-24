import {
  compareDelayedEntryAtActualExit,
  SAME_EXIT_TIMING_ARTIFACT,
} from './m1-same-exit-entry-timing';
import type {
  DelayedEntryParityResult,
  VerifiedNativeMinute,
} from './m1-delayed-entry-parity-shadow';

const closeAt = new Date('2026-11-19T16:39:05.341Z');
const entryMs = Date.parse('2026-11-19T16:21:00Z');
const delayed = {
  state: 'CONFIRMED',
  originalDirection: 'SELL',
  simulatedEntryAt: new Date(entryMs).toISOString(),
  indicativeQuoteEntry: 1.4311,
  quotePricingNotExecutable: true,
  noTradeAuthority: true,
  modifiesExecution: false,
} as DelayedEntryParityResult;
const minute = (index: number, high = 1.4313, low = 1.4305): VerifiedNativeMinute => {
  const time = entryMs + index * 60_000;
  return {
    bucket_time: new Date(time),
    open: 1.4311,
    high,
    low,
    close: 1.4307,
    source: 'ctrader-broker-native',
    sample_count: 120,
    positive_quote_sample_count: 120,
    first_sample_at: new Date(time + 400),
    last_quote_sample_at: new Date(time + 59_000),
    spread_close: 0.00002,
  };
};
const bars = () => Array.from({ length: 19 }, (_, i) => minute(i));
const base: Parameters<typeof compareDelayedEntryAtActualExit>[0] = {
  instrument: 'USDCAD',
  direction: 'SELL' as const,
  originalFill: 1.43089,
  originalStop: 1.43152,
  originalTarget: 1.43022,
  originalExit: 1.4307,
  originalClosedAt: closeAt,
  actualGrossPnl: 26.56,
  actualCommission: -12,
  actualSwap: 0,
  verifiedOriginalRiskAccountCurrency: 69.88120195,
  delayed,
  candles: bars(),
};
const compare = (patch: Partial<typeof base> = {}) =>
  compareDelayedEntryAtActualExit({ ...base, ...patch });
describe('matched original-exit M1 entry timing research', () => {
  it('separates real USDCAD $14.56 profit from conditional +2.1pip delayed entry advantage', () => {
    const r = compare();
    expect(r).toMatchObject({
      artifact: SAME_EXIT_TIMING_ARTIFACT,
      state: 'INDICATIVE_SAME_EXIT',
      comparedCompletedMinutes: 18,
      indicativeEntryImprovementPips: 2.1,
      firstBarrierAt: null,
      firstMissingMinute: null,
      noTradeAuthority: true,
      modifiesExecution: false,
      modelTrainingStatus: 'RESEARCH_ONLY_NOT_TRAINED',
    });
    expect(r.actualNetAfterFeesR).toBeCloseTo(14.56 / 69.88120195, 3);
    // 2.1 additional pips priced with the actual broker's 1.9-pip gross,
    // not with a fabricated account-currency/point conversion.
    const incrementalGross = 26.56 * (2.1 / 1.9);
    expect(r.delayedSameExitNetAfterFeesR).toBeCloseTo((14.56 + incrementalGross) / 69.88120195, 3);
    expect(r.indicativeDeltaNetR).toBeCloseTo(incrementalGross / 69.88120195, 3);
    expect(r.originalStopRiskAccountCurrency).toBeCloseTo(69.88, 2);
    expect(r.grossPerPriceUnitFromActualClose).toBeGreaterThan(0);
    expect(r.maxAdversePipsBeforeActualClose).toBeCloseTo(2, 1);
  });

  it('never credits a delayed position at the actual exit if reanchored SL or TP was touched', () => {
    for (const [candle, expected] of [
      [minute(3, 1.43175, 1.4305), 'STOP_TOUCH_BEFORE_ACTUAL_CLOSE'],
      [minute(3, 1.4313, 1.4304), 'TARGET_TOUCH_BEFORE_ACTUAL_CLOSE'],
      [minute(3, 1.43175, 1.4304), 'BOTH_BARRIERS_IN_MINUTE'],
    ] as const) {
      const next = bars();
      next[3] = candle;
      const r = compare({ candles: next });
      expect(r.state).toBe(expected);
      expect(r.firstBarrierAt).toBe('2026-11-19T16:24:00.000Z');
      expect(r.indicativeDeltaNetR).toBeNull();
      expect(r.delayedSameExitNetAfterFeesR).toBeNull();
    }
  });

  it('refuses fabricated P&L from missing, non-native or malformed M1 quotes', () => {
    for (const changed of [
      bars().filter((_, i) => i !== 5),
      bars().map((bar, i) => (i === 5 ? { ...bar, source: 'historical-backfill' } : bar)),
      bars().map((bar, i) => (i === 5 ? { ...bar, positive_quote_sample_count: 0 } : bar)),
      bars().map((bar, i) => (i === 5 ? { ...bar, high: null } : bar)),
    ]) {
      const result = compare({ candles: changed });
      expect(result).toMatchObject({
        state: 'DATA_GAP',
        comparedCompletedMinutes: 5,
        firstMissingMinute: '2026-11-19T16:26:00.000Z',
        indicativeDeltaNetR: null,
      });
    }
  });

  it('ignores post-close targets even if a later candle crosses them', () => {
    const after = {
      ...minute(18, 1.4317, 1.4302),
      bucket_time: new Date('2026-11-19T16:39:00Z'),
      first_sample_at: new Date('2026-11-19T16:39:01Z'),
      last_quote_sample_at: new Date('2026-11-19T16:39:58Z'),
    };
    const result = compare({ candles: [...bars(), after] });
    expect(result.state).toBe('INDICATIVE_SAME_EXIT');
    expect(result.comparedCompletedMinutes).toBe(18);
  });

  it('does not invent a retrospective entry when the actual position was already closed', () => {
    expect(
      compare({
        delayed: {
          ...delayed,
          simulatedEntryAt: '2026-11-19T16:40:00Z',
        },
      }).state,
    ).toBe('ENTRY_AFTER_ACTUAL_CLOSE');
    expect(
      compare({
        delayed: {
          ...delayed,
          simulatedEntryAt: '2026-11-19T16:39:00Z',
        },
      }).state,
    ).toBe('CLOSE_IN_ENTRY_MINUTE');
    expect(
      compare({
        delayed: {
          ...delayed,
          state: 'NO_CONFIRMATION',
          simulatedEntryAt: null,
        },
      }).state,
    ).toBe('NO_CONFIRMATION');
  });

  it('fails closed without broker settlement, original stop-risk or validated fee', () => {
    for (const patch of [
      { originalExit: null },
      { actualGrossPnl: null },
      { actualCommission: null },
      { actualSwap: null },
      { verifiedOriginalRiskAccountCurrency: null },
      { verifiedOriginalRiskAccountCurrency: 0 },
      { actualGrossPnl: -26.56 },
      { originalExit: 1.430885 },
      { originalStop: 1.4302 },
      { originalTarget: 1.4317 },
      { delayed: { ...delayed, indicativeQuoteEntry: null } },
    ]) {
      const r = compare(patch);
      expect(r.indicativeDeltaNetR).toBeNull();
    }
  });

  it('supports BUY with symmetrical price improvement and verifies no risk-increasing authority', () => {
    const r = compare({
      direction: 'BUY',
      originalFill: 1.4311,
      originalStop: 1.4305,
      originalTarget: 1.4318,
      originalExit: 1.4314,
      actualGrossPnl: 35,
      delayed: { ...delayed, indicativeQuoteEntry: 1.431, originalDirection: 'BUY' },
      candles: bars().map((bar) => ({
        ...bar,
        open: 1.431,
        high: 1.4315,
        low: 1.4309,
        close: 1.4312,
      })),
    });
    expect(r.state).toBe('INDICATIVE_SAME_EXIT');
    expect(r.indicativeEntryImprovementPips).toBe(1);
    expect(r.noTradeAuthority).toBe(true);
    expect(r.modifiesExecution).toBe(false);
  });
});
