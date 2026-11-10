import {
  evaluateM1ProbationMissedOpportunity,
  M1_PROBATION_MISSED_OPPORTUNITY_ARTIFACT,
  type ProbationBrokerM1,
} from './m1-probation-missed-opportunity-shadow';

const decisionTime = new Date('2026-11-10T15:34:00.000Z');
const startMs = Date.parse('2026-11-10T15:35:00.000Z');
function minute(
  i: number,
  open = 1.1235,
  high = 1.1237,
  low = 1.1234,
  close = 1.12355,
): ProbationBrokerM1 {
  const at = startMs + i * 60_000;
  return {
    bucket_time: new Date(at),
    open,
    high,
    low,
    close,
    source: 'ctrader-broker-native',
    sample_count: 4,
    positive_quote_sample_count: 4,
    first_sample_at: new Date(at + 200),
    last_quote_sample_at: new Date(at + 58_000),
  };
}
const candles = (): ProbationBrokerM1[] => Array.from({ length: 60 }, (_, i) => minute(i));

const score = (
  bars: ProbationBrokerM1[],
  overrides: Partial<Parameters<typeof evaluateM1ProbationMissedOpportunity>[0]> = {},
) =>
  evaluateM1ProbationMissedOpportunity({
    instrument: 'EURUSD',
    direction: 'SELL',
    decisionTime,
    stopDistance: 0.0005,
    targetDistance: 0.0008,
    bars,
    ...overrides,
  });

describe('M1 probation-only gross missed-opportunity research', () => {
  it('uses the next complete minute quote-open and labels TP without granting authority', () => {
    const bars = candles();
    bars[1] = minute(1, 1.1235, 1.12362, 1.1225, 1.1227);
    const result = score(bars);
    expect(result).toMatchObject({
      artifact: M1_PROBATION_MISSED_OPPORTUNITY_ARTIFACT,
      state: 'TARGET_QUOTE_TOUCH',
      entryQuoteAt: '2026-11-10T15:35:00.000Z',
      indicativeQuoteEntry: 1.1235,
      indicativeGrossR: 1.6,
      observedMinutes: 2,
      feesModeled: false,
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
    expect(result.stopDistancePips).toBe(5);
    expect(result.targetDistancePips).toBe(8);
  });
  it('correctly labels negative gross R on SL touch and no early profitability', () => {
    const bars = candles();
    bars[2] = minute(2, 1.1235, 1.1243, 1.12345, 1.1241);
    expect(score(bars)).toMatchObject({
      state: 'STOP_QUOTE_TOUCH',
      indicativeGrossR: -1,
      observedMinutes: 3,
      maxAdversePipsBeforeDecision: 2,
    });
  });
  it('does not resolve intrabar TP and SL when both prices are touched', () => {
    const bars = candles();
    bars[0] = minute(0, 1.1235, 1.1245, 1.1224, 1.1236);
    expect(score(bars)).toMatchObject({
      state: 'BOTH_IN_BAR',
      indicativeGrossR: null,
      observedMinutes: 1,
    });
  });
  it('excludes unordered TP-minute adverse extremes from pre-touch excursion', () => {
    const bars = candles();
    bars[1] = minute(1, 1.1235, 1.12395, 1.1225, 1.1227);
    const result = score(bars);
    expect(result.state).toBe('TARGET_QUOTE_TOUCH');
    // The high and target touch both occurred in minute 1; the high may
    // have happened after TP. Only minute 0 adverse counts as prior.
    expect(result.maxAdversePipsBeforeDecision).toBe(2);
  });

  it('does not turn missing or synthetic quotes into winners', () => {
    const bars = candles();
    bars[3] = minute(3, 1.1235, 1.12365, 1.1226, 1.1227);
    expect(score(bars.filter((_, i) => i !== 1))).toMatchObject({
      state: 'DATA_GAP',
      firstMissingMinute: '2026-11-10T15:36:00.000Z',
      indicativeGrossR: null,
    });
    const bad = candles();
    bad[0] = { ...minute(0), source: 'synthetic-backfill' };
    expect(score(bad).state).toBe('DATA_GAP');
    bad[0] = { ...minute(0), open: null };
    expect(score(bad).state).toBe('DATA_GAP');
    bad[0] = { ...minute(0), positive_quote_sample_count: 0 };
    expect(score(bad).state).toBe('DATA_GAP');
    bad[0] = { ...minute(0), first_sample_at: new Date(startMs - 1) };
    expect(score(bad).state).toBe('DATA_GAP');
  });
  it('distinguishes time mark from TP/SL after a full 60-minute valid price path', () => {
    const result = score(candles());
    expect(result.state).toBe('TIME_MARK');
    expect(result.indicativeGrossR).toBe(-0.1);
    expect(result.observedMinutes).toBe(60);
    expect(result.eventMinute).toBeNull();
  });
  it('rejects impossible geometry and handles JPY pip units for BUY', () => {
    expect(score(candles(), { stopDistance: 0 }).state).toBe('INVALID_GEOMETRY');
    expect(score(candles(), { targetDistance: -1 }).state).toBe('INVALID_GEOMETRY');
    const jpyBars = Array.from({ length: 60 }, (_, i) => {
      const b = minute(i, 158.04, 158.055, 158.03, 158.045);
      return b;
    });
    jpyBars[0] = minute(0, 158.04, 158.15, 158.02, 158.12);
    const result = score(jpyBars, {
      instrument: 'USDJPY',
      direction: 'BUY',
      stopDistance: 0.05,
      targetDistance: 0.08,
    });
    expect(result).toMatchObject({
      state: 'TARGET_QUOTE_TOUCH',
      stopDistancePips: 5,
      targetDistancePips: 8,
      indicativeGrossR: 1.6,
    });
  });
  it('never uses a decision-minute or future quote to choose trade entry', () => {
    const bars = candles();
    const result = score(bars);
    const later = candles();
    later[59] = minute(59, 1.1235, 1.1237, 1.1215, 1.122);
    expect(result.indicativeQuoteEntry).toBe(score(later).indicativeQuoteEntry);
    expect(result.entryQuoteAt).toBe(score(later).entryQuoteAt);
    expect(result.method).toBe('NEXT_FULL_M1_OPEN_FIXED_STOP_TARGET_GROSS_ONLY');
  });
});
