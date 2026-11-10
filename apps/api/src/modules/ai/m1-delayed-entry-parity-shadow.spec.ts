import {
  DELAY_ENTRY_PARITY_SHADOW_ARTIFACT,
  DELAY_ENTRY_STOP_MULTIPLIERS,
  evaluateDelayedEntryParity,
  type VerifiedNativeMinute,
} from './m1-delayed-entry-parity-shadow';

const openedAt = new Date('2026-11-10T02:38:28.223Z');
const firstMs = Date.parse('2026-11-10T02:39:00.000Z');
const makeBar = (
  index: number,
  open = 158.075,
  high = 158.085,
  low = 158.065,
  close = 158.07,
): VerifiedNativeMinute => {
  const time = firstMs + index * 60000;
  return {
    bucket_time: new Date(time),
    open,
    high,
    low,
    close,
    source: 'ctrader-broker-native',
    sample_count: 6,
    positive_quote_sample_count: 6,
    first_sample_at: new Date(time + 650),
    last_quote_sample_at: new Date(time + 55000),
    spread_close: 0.002,
  };
};

const candles = (count = 250) => {
  const rows = Array.from({ length: count }, (_, i) => makeBar(i));
  rows[0] = makeBar(0, 158.085, 158.095, 158.075, 158.08);
  rows[1] = makeBar(1, 158.08, 158.088, 158.065, 158.07);
  rows[2] = makeBar(2, 158.07, 158.078, 158.05, 158.06);
  rows[3] = makeBar(3, 158.065, 158.12, 158.04, 158.07);
  rows[4] = makeBar(4, 158.07, 158.08, 157.95, 157.97);
  return rows;
};

const score = (
  rows: VerifiedNativeMinute[],
  overrides: Partial<Parameters<typeof evaluateDelayedEntryParity>[0]> = {},
) =>
  evaluateDelayedEntryParity({
    instrument: 'USDJPY',
    direction: 'SELL',
    openedAt,
    originalFill: 158.053,
    originalStop: 158.102,
    originalTarget: 157.972,
    originalExit: 158.099,
    actualGrossPnl: -116.38,
    actualCommission: -24,
    horizonMinutes: 60,
    candles: rows,
    ...overrides,
  });

describe('M1 delayed-entry risk parity quote research', () => {
  it('uses exactly completed M1 closes for selection, enters next quote minute', () => {
    const first = score(candles());
    expect(first.state).toBe('CONFIRMED');
    expect(first.artifact).toBe(DELAY_ENTRY_PARITY_SHADOW_ARTIFACT);
    expect(first.simulatedEntryAt).toBe('2026-11-10T02:42:00.000Z');
    expect(first.confirmationM1Closes).toEqual([158.08, 158.07, 158.06]);
    expect(first.indicativeQuoteEntry).toBe(158.065);
    expect(first.delayMinutesFromOriginalFill).toBeCloseTo(3.53, 2);
    expect(first.noTradeAuthority).toBe(true);
    expect(first.modifiesExecution).toBe(false);
    const revised = candles();
    revised[7] = makeBar(7, 157.1, 157.3, 156.9, 157.0);
    expect(score(revised).simulatedEntryAt).toBe(first.simulatedEntryAt);
    expect(score(revised).indicativeQuoteEntry).toBe(first.indicativeQuoteEntry);
  });

  it('keeps equal risk when stop geometry widens and shows reduced TP-to-risk multiple', () => {
    const result = score(candles());
    expect(result.scenarios.map((s) => s.stopMultiplier)).toEqual([
      ...DELAY_ENTRY_STOP_MULTIPLIERS,
    ]);
    const [normal, wider] = result.scenarios;
    expect(normal.outcome).toBe('STOP_QUOTE_TOUCH');
    expect(wider.outcome).toBe('TARGET_QUOTE_TOUCH');
    expect(normal.indicativeGrossR).toBe(-1);
    expect(wider.indicativeGrossR).toBeGreaterThan(1);
    expect(normal.riskParityLotMultiplier).toBe(1);
    expect(wider.riskParityLotMultiplier).toBeCloseTo(1 / 1.4, 4);
    expect(normal.stopDistancePips).toBe(4.9);
    expect(wider.stopDistancePips).toBe(6.86);
    expect(normal.targetDistancePips).toBe(8.1);
    expect(wider.targetR).toBeLessThan(normal.targetR);
    expect(wider.estimatedCommissionR).toBeLessThan(normal.estimatedCommissionR!);
    expect(result.estimatedOriginalRiskAccountCurrency).toBeGreaterThan(100);
    expect(wider.indicativeNetAfterCommissionR).toBeLessThan(wider.indicativeGrossR!);
  });

  it('does not manufacture a trade when two aligned close moves never confirm', () => {
    const flat = Array.from({ length: 70 }, (_, i) => makeBar(i));
    const result = score(flat);
    expect(result.state).toBe('NO_CONFIRMATION');
    expect(result.scenarios).toEqual([]);
    expect(result.confirmationM1Closes).toHaveLength(5);
    expect(result.simulatedEntryAt).toBeNull();
  });

  it('rejects missing and untrusted confirmation candles before selection', () => {
    expect(score(candles().filter((_, i) => i !== 1))).toMatchObject({
      state: 'DATA_GAP',
      firstMissingMinute: '2026-11-10T02:40:00.000Z',
      scenarios: [],
    });
    const untrusted = candles();
    untrusted[0] = { ...untrusted[0], source: 'historical-backfill' };
    expect(score(untrusted).state).toBe('DATA_GAP');
    untrusted[0] = { ...makeBar(0), open: null };
    expect(score(untrusted).state).toBe('DATA_GAP');
  });

  it('marks future gaps and does not convert a missing quote into a win or loss', () => {
    const rows = candles();
    rows[3] = makeBar(3, 158.065, 158.09, 158.04, 158.07);
    rows[4] = makeBar(4, 158.07, 158.08, 158.025, 158.05);
    rows[5] = { ...makeBar(5), last_quote_sample_at: new Date(firstMs + 6 * 60000 + 1000) };
    const result = score(rows);
    expect(result.state).toBe('CONFIRMED');
    for (const item of result.scenarios) {
      expect(item.outcome).toBe('DATA_GAP');
      expect(item.indicativeGrossR).toBeNull();
      expect(item.indicativeNetAfterCommissionR).toBeNull();
      expect(item.firstMissingMinute).toBe('2026-11-10T02:44:00.000Z');
    }
  });

  it('refuses to order stop and target touches inside the same OHLC minute', () => {
    const rows = candles();
    rows[3] = makeBar(3, 158.065, 158.18, 157.93, 158.07);
    const result = score(rows);
    for (const item of result.scenarios) {
      expect(item.outcome).toBe('BOTH_IN_BAR');
      expect(item.indicativeGrossR).toBeNull();
      expect(item.indicativeNetAfterCommissionR).toBeNull();
    }
  });

  it('does not guess an FX pip value or fee ratio from inconsistent ledger economics', () => {
    const rows = candles();
    const result = score(rows, {
      actualGrossPnl: 116.38, // impossible positive gross with adverse actual exit
    });
    expect(result.estimatedOriginalRiskAccountCurrency).toBeNull();
    expect(result.scenarios[0].estimatedCommissionR).toBeNull();
    expect(result.scenarios[0].indicativeNetAfterCommissionR).toBeNull();
    expect(score(rows, { originalStop: 157.9 }).state).toBe('INVALID_GEOMETRY');
    expect(score(rows, { originalFill: 0 }).state).toBe('INVALID_GEOMETRY');
  });

  it('has an independent four-hour horizon and cannot use confirmation future at entry', () => {
    const rows = candles(260);
    const result = score(rows, { horizonMinutes: 240 });
    expect(result.horizonMinutes).toBe(240);
    expect(result.simulatedEntryAt).toBe('2026-11-10T02:42:00.000Z');
    expect(result.scenarios[0].outcome).toBe('STOP_QUOTE_TOUCH');
  });
});
