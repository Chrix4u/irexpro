import { evaluatePepperstoneHighPeakGivebackShadow } from './pepperstone-high-peak-giveback-shadow';

const now = new Date('2026-11-12T03:23:30Z');
const base = {
  brokerId: 'pepperstone-ctrader',
  accountType: 'DEMO',
  accountCurrency: 'USD',
  tradeInstrument: 'EURUSD',
  brokerInstrument: 'EURUSD',
  tradeDirection: 'SELL' as const,
  brokerDirection: 'SELL' as const,
  tradeLotSize: 2,
  brokerLotSize: 2,
  strategyRoute: 'TREND_CONTINUATION',
  isM1Strategy: true,
  initialRiskPnl: 100,
  previousPeakPnl: 130,
  previousObservedPnl: 50,
  currentBrokerNetPnl: 30,
  previousObservationCount: 40,
  elapsedMinutes: 11,
  openedAt: new Date('2026-11-12T03:12:19Z'),
  previousObservationAt: new Date('2026-11-12T03:23:25Z'),
  observedAt: now,
  brokerEntryPrice: 1.10731,
  currentPrice: 1.10710,
  authoritativeStop: 1.1078,
  brokerStop: 1.1078,
  authoritativeTakeProfit: 1.10650,
  brokerTakeProfit: 1.10650,
  conservativeExtraExitCost: 12,
  causalFeeSampleCount: 12,
  m1: {
    completedBars: 3,
    adverseBars: 2,
    liveQuoteBars: 3,
    consecutiveLiveQuoteBars: 3,
    alignedLatestBodyPressure: -0.45,
    alignedMomentum3: -0.25,
    latestAgeSeconds: 12,
  },
};

describe('Pepperstone DEMO high-peak reversal comparison (research-only)', () => {
  it('finds a confirmed 1.3R-to-0.3R giveback with after-fee profit, without granting any order authority', () => {
    const r = evaluatePepperstoneHighPeakGivebackShadow(base);
    expect(r.reason).toBe('QUALIFIED_SHADOW_GIVEBACK');
    expect(r.wouldProtectIfIndependentlyQualified).toBe(true);
    expect(r.estimatedNetAfterExtraCost).toBe(18);
    expect(r.peakR).toBe(1.3);
    expect(r.currentR).toBe(0.3);
    expect(r.mode).toBe('RESEARCH_ONLY');
    expect(r.modifiesExecution).toBe(false);
    expect(r.grantsExecution).toBe(false);
    expect(r.promotionEligible).toBe(false);
    expect(r).not.toHaveProperty('shouldClose');
  });

  it('leaves a full-TP runner with a healthy profit and ordinary retracement alone', () => {
    const r = evaluatePepperstoneHighPeakGivebackShadow({
      ...base, currentBrokerNetPnl: 102, previousObservedPnl: 112,
    });
    expect(r.reason).toBe('NO_DEEP_POSITIVE_GIVEBACK');
    expect(r.wouldProtectIfIndependentlyQualified).toBe(false);
  });

  it('cannot promote missing data, account mismatch, stale M1 or broker barriers', () => {
    const variants = [
      [{ brokerId: 'ctrader' }, 'OUTSIDE_OWNED_DEMO'],
      [{ accountType: 'LIVE' }, 'OUTSIDE_OWNED_DEMO'],
      [{ accountCurrency: 'EUR' }, 'OUTSIDE_OWNED_DEMO'],
      [{ tradeLotSize: 3 }, 'POSITION_IDENTITY_UNVERIFIED'],
      [{ brokerInstrument: 'USDJPY' }, 'POSITION_IDENTITY_UNVERIFIED'],
      [{ strategyRoute: 'CONFIRMED_REVERSAL' }, 'NOT_M1_CONTINUATION'],
      [{ initialRiskPnl: null }, 'INITIAL_RISK_UNAVAILABLE'],
      [{ previousObservationCount: 2 }, 'OBSERVATIONS_NOT_MATURE'],
      [{ previousObservationAt: new Date('2026-11-12T03:21:30Z') }, 'OBSERVATIONS_NOT_MATURE'],
      [{ brokerStop: 1.1088 }, 'BROKER_BARRIERS_UNVERIFIED'],
      [{ brokerTakeProfit: 1.105 }, 'BROKER_BARRIERS_UNVERIFIED'],
      [{ previousPeakPnl: 70 }, 'NO_ESTABLISHED_HIGH_PEAK'],
      [{ conservativeExtraExitCost: null }, 'MISSING_CAUSAL_CLOSE_COSTS'],
      [{ causalFeeSampleCount: 3 }, 'MISSING_CAUSAL_CLOSE_COSTS'],
      [{ conservativeExtraExitCost: 29 }, 'NO_POST_RESERVE_PROFIT'],
      [{ m1: null }, 'DIRECTIONAL_REVERSAL_NOT_VERIFIED'],
      [{ m1: { ...base.m1, consecutiveLiveQuoteBars: 1 } }, 'DIRECTIONAL_REVERSAL_NOT_VERIFIED'],
      [{ m1: { ...base.m1, alignedMomentum3: 0.05 } }, 'DIRECTIONAL_REVERSAL_NOT_VERIFIED'],
      [{ m1: { ...base.m1, adverseBars: 1 } }, 'DIRECTIONAL_REVERSAL_NOT_VERIFIED'],
    ] as const;
    for (const [patch, reason] of variants) {
      const result = evaluatePepperstoneHighPeakGivebackShadow({
        ...base,
        ...patch,
      });
      expect(result.reason).toBe(reason);
      expect(result.wouldProtectIfIndependentlyQualified).toBe(false);
      expect(result.modifiesExecution).toBe(false);
    }
  });

  it('does not treat a high peak already below entry as protected positive exit', () => {
    const r = evaluatePepperstoneHighPeakGivebackShadow({
      ...base,
      currentBrokerNetPnl: -12,
      currentPrice: 1.1074,
    });
    expect(r.wouldProtectIfIndependentlyQualified).toBe(false);
    expect(r.reason).toBe('BROKER_BARRIERS_UNVERIFIED');
  });
});
