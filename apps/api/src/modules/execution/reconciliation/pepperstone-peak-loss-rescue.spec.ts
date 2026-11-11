import { evaluatePepperstonePeakLossRescue } from './pepperstone-peak-loss-rescue';

const baseline = {
  brokerId: 'pepperstone-ctrader',
  accountType: 'DEMO',
  tradeInstrument: 'USDCHF',
  brokerInstrument: 'USDCHF',
  tradeDirection: 'SELL' as const,
  brokerDirection: 'SELL' as const,
  tradeLotSize: 4,
  brokerLotSize: 4,
  strategyRoute: 'TREND_CONTINUATION',
  isM1Strategy: true,
  initialRiskPnl: 244.47187962,
  previousPeakPnl: 124.95,
  currentPnl: -85,
  previousObservationCount: 100,
  elapsedMinutes: 13,
  authoritativeStop: 0.805,
  brokerStop: 0.805,
  currentPrice: 0.802,
  brokerEntryPrice: 0.801,
  m1: {
    completedBars: 3,
    adverseBars: 2,
    liveQuoteBars: 3,
    consecutiveLiveQuoteBars: 3,
    alignedLatestBodyPressure: -0.43,
    alignedMomentum3: -0.27,
    latestAgeSeconds: 15,
  },
};

describe('Pepperstone DEMO peak-to-loss rescue, research-only', () => {
  it('identifies the known pattern of a real 0.50R peak retracing to -0.35R', () => {
    const result = evaluatePepperstonePeakLossRescue(baseline);
    expect(result).toMatchObject({
      mode: 'SHADOW_ONLY',
      modifiesExecution: false,
      grantsExecution: false,
      productionEligible: false,
      wouldReduceDrawdown: true,
      reason: 'CONFIRMED_PEAK_TO_LOSS_CANDIDATE',
    });
    expect(result.peakR).toBeGreaterThan(0.5);
  });
  it('holds a profitable TP candidate despite a large temporary profit giveback', () => {
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, tradeInstrument: 'AUDUSD', brokerInstrument: 'AUDUSD',
      previousPeakPnl: 208, initialRiskPnl: 200, currentPnl: -16,
    })).toMatchObject({ wouldReduceDrawdown: false, reason: 'STILL_WITHIN_RECOVERY_BAND' });
  });
  it.each([
    ['ctrader', 'DEMO'], ['pepperstone-ctrader', 'LIVE'], ['icmarkets-ctrader', 'DEMO'],
  ])('never selects non-Pepperstone-DEMO account %s %s', (brokerId, accountType) => {
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, brokerId, accountType,
    })).toMatchObject({ wouldReduceDrawdown: false, reason: 'OUTSIDE_PEPPERSTONE_DEMO' });
  });
  it('fails closed on wrong broker position instrument, direction or volume', () => {
    for (const p of [
      { brokerInstrument: 'EURUSD' },
      { brokerDirection: 'BUY' as const },
      { brokerLotSize: 2 },
    ]) {
      expect(evaluatePepperstonePeakLossRescue({ ...baseline, ...p })).toMatchObject({
        wouldReduceDrawdown: false, reason: 'INSTRUMENT_OR_DIRECTION_MISMATCH',
      });
    }
  });
  it('does not risk a reversal/early-transition TP winner', () => {
    for (const strategyRoute of ['CONFIRMED_REVERSAL', 'EARLY_TRANSITION', null]) {
      expect(evaluatePepperstonePeakLossRescue({ ...baseline, strategyRoute })).toMatchObject({
        wouldReduceDrawdown: false, reason: 'UNSUPPORTED_STRATEGY_ROUTE',
      });
    }
  });
  it('fails closed on missing capital-allocation risk, insufficient path or young trade', () => {
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, initialRiskPnl: null,
    }).reason).toBe('NO_RELIABLE_INITIAL_RISK');
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, previousObservationCount: 1,
    }).reason).toBe('INSUFFICIENT_BROKER_OBSERVATIONS');
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, elapsedMinutes: 2,
    }).reason).toBe('POSITION_TOO_YOUNG');
  });
  it('does not rescue early, before 0.5R peak or at broker stop proximity', () => {
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, previousPeakPnl: 90,
    }).reason).toBe('NO_MEANINGFUL_PROFIT_PEAK');
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, currentPnl: 20,
    }).reason).toBe('STILL_WITHIN_RECOVERY_BAND');
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, currentPnl: -210,
    }).reason).toBe('STILL_WITHIN_RECOVERY_BAND');
  });
  it('requires a verified matching broker stop, away from the current exit-side price', () => {
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, brokerStop: 0.804,
    }).reason).toBe('BROKER_STOP_NOT_VERIFIED');
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, currentPrice: 0.8051,
    }).reason).toBe('BROKER_STOP_ALREADY_BREACHED');
  });
  it('fails closed when the live broker mark has not actually moved adversely from entry', () => {
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, brokerEntryPrice: 0.803,
    }).reason).toBe('BROKER_PRICE_NOT_ADVERSE');
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, brokerEntryPrice: null,
    }).reason).toBe('BROKER_STOP_NOT_VERIFIED');
  });
  it('requires consecutive independent broker M1 quotes and an actual adverse move', () => {
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, m1: null,
    }).reason).toBe('STALE_OR_INSUFFICIENT_M1_QUOTES');
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, m1: { ...baseline.m1, consecutiveLiveQuoteBars: 1 },
    }).reason).toBe('STALE_OR_INSUFFICIENT_M1_QUOTES');
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, m1: { ...baseline.m1, latestAgeSeconds: 120 },
    }).reason).toBe('STALE_OR_INSUFFICIENT_M1_QUOTES');
    expect(evaluatePepperstonePeakLossRescue({
      ...baseline, m1: { ...baseline.m1, alignedLatestBodyPressure: 0.15 },
    }).reason).toBe('DIRECTIONAL_REVERSAL_UNCONFIRMED');
  });
});
