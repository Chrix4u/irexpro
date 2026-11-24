import {
  evaluatePepperstoneDemoAdverseCut,
  PEPPERSTONE_DEMO_ADVERSE_CUT_ARTIFACT,
  type PepperstoneDemoAdverseCutInput,
} from './pepperstone-demo-adverse-cut';

const base: PepperstoneDemoAdverseCutInput = {
  enabled: true,
  brokerId: 'pepperstone-ctrader',
  accountType: 'DEMO',
  accountCurrency: 'USD',
  ownerUserId: 'owner-1',
  userId: 'owner-1',
  isM1Strategy: true,
  strategyRoute: 'CONFIRMED_REVERSAL',
  tradeInstrument: 'EURUSD',
  brokerInstrument: 'EURUSD',
  tradeDirection: 'BUY',
  brokerDirection: 'BUY',
  tradeLotSize: 1.7,
  brokerLotSize: 1.7,
  entryPrice: 1.113,
  currentPrice: 1.1127,
  authoritativeStop: 1.1125,
  brokerStop: 1.1125,
  initialRiskPnl: 50,
  currentBrokerNetPnl: -27,
  maxFavorableBrokerNetPnl: 4,
  elapsedMinutes: 4,
  priorObservationCount: 40,
  m1: {
    completedBars: 3,
    adverseBars: 2,
    consecutiveLiveQuoteBars: 2,
    alignedLatestBodyPressure: -0.8,
    alignedMomentum3: -0.5,
    latestAgeSeconds: 10,
    latestLiveSpreadPrice: 0.00002,
  },
};

describe('owner-only Pepperstone DEMO adverse cut', () => {
  it('cuts a verified loss only after two completed consecutive adverse broker-native candles', () => {
    const r = evaluatePepperstoneDemoAdverseCut(base);
    expect(r).toEqual({
      shouldClose: true,
      reason: 'PERSISTENT_ADVERSE_M1_CUT',
      currentRiskMultiple: -0.54,
    });
    expect(PEPPERSTONE_DEMO_ADVERSE_CUT_ARTIFACT).toContain('pepperstone-demo-');
  });

  it('accepts both alternate routes but never restores paused continuation', () => {
    expect(
      evaluatePepperstoneDemoAdverseCut({
        ...base,
        strategyRoute: 'EARLY_TRANSITION',
      }).shouldClose,
    ).toBe(true);
    expect(
      evaluatePepperstoneDemoAdverseCut({
        ...base,
        strategyRoute: 'TREND_CONTINUATION',
      }).shouldClose,
    ).toBe(false);
  });

  it.each([
    { enabled: false },
    { brokerId: 'ctrader' },
    { brokerId: 'icmarkets-ctrader' },
    { accountType: 'LIVE' },
    { accountCurrency: 'EUR' },
    { ownerUserId: '' },
    { ownerUserId: 'someone-else' },
    { isM1Strategy: false },
    { strategyRoute: null },
    { brokerInstrument: 'AUDUSD' },
    { brokerDirection: 'SELL' as const },
    { tradeLotSize: 0 },
    { brokerLotSize: 1.69 },
    { entryPrice: null },
    { authoritativeStop: null },
    { brokerStop: 1.1121 },
    { currentPrice: 1.1124 },
    { currentPrice: 1.1132 },
    { initialRiskPnl: null },
    { initialRiskPnl: 0 },
    { initialRiskPnl: Number.NaN },
    { currentBrokerNetPnl: -20 },
    { currentBrokerNetPnl: 0 },
    { maxFavorableBrokerNetPnl: 8 },
    { maxFavorableBrokerNetPnl: Number.NaN },
    { elapsedMinutes: 1.9 },
    { priorObservationCount: 11 },
    { m1: null },
    { m1: { ...base.m1!, completedBars: 1 } },
    { m1: { ...base.m1!, adverseBars: 1 } },
    { m1: { ...base.m1!, consecutiveLiveQuoteBars: 1 } },
    { m1: { ...base.m1!, alignedLatestBodyPressure: -0.2 } },
    { m1: { ...base.m1!, alignedMomentum3: 0.01 } },
    { m1: { ...base.m1!, latestAgeSeconds: 76 } },
    { m1: { ...base.m1!, latestAgeSeconds: -1 } },
    { m1: { ...base.m1!, latestLiveSpreadPrice: null } },
    { m1: { ...base.m1!, latestLiveSpreadPrice: 0.0002 } },
  ])('never closes on invalid/missing evidence: %j', (override) => {
    expect(evaluatePepperstoneDemoAdverseCut({ ...base, ...override }).shouldClose).toBe(false);
  });
});
