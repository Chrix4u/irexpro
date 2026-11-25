import { evaluatePepperstoneDemoNetProfitLock } from './pepperstone-demo-net-profit-lock';

/**
 * Owner demo November 20 settled-fill cases used as frozen regression
 * scenarios. Peak/current values are observations, not guaranteed fills.
 * This test authorizes no broker commands and never changes LIVE authority.
 */
describe('Owner Pepperstone DEMO Nov20 progressive profit peak protection regression', () => {
  const timestamp = new Date('2026-11-20T09:04:10Z');
  const common = {
    brokerId: 'pepperstone-ctrader',
    accountType: 'DEMO',
    tradeDirection: 'SELL' as const,
    brokerDirection: 'SELL' as const,
    isM1Strategy: true,
    tieredRetentionEnabled: true,
    progressiveTpRetentionEnabled: true,
    openedAt: new Date('2026-11-20T09:01:00Z'),
    previousObservationAt: new Date('2026-11-20T09:04:05Z'),
    observedAt: timestamp,
    previousObservationCount: 35,
    feeSampleCount: 30,
    feeEvidenceSource: 'SAME_SYMBOL' as const,
  };

  const highPeakUsdJpy = {
    ...common,
    strategyRoute: 'CONFIRMED_REVERSAL',
    tradeInstrument: 'USDJPY',
    brokerInstrument: 'USDJPY',
    tradeLotSize: 6,
    brokerLotSize: 6,
    initialRiskPnl: 188.68161863,
    brokerEntryPrice: 159.001,
    currentPrice: 158.96,
    authoritativeStop: 159.059,
    brokerStop: 159.059,
    authoritativeTakeProfit: 158.929,
    brokerTakeProfit: 158.929,
    previousObservedBrokerNetPnl: 162,
    maxFavorableBrokerNetPnl: 170.74,
    currentBrokerNetPnl: 140,
    conservativeExitReserve: 36,
  };

  const near100AudUsd = {
    ...common,
    strategyRoute: 'EARLY_TRANSITION',
    tradeInstrument: 'AUDUSD',
    brokerInstrument: 'AUDUSD',
    tradeLotSize: 3.44,
    brokerLotSize: 3.44,
    initialRiskPnl: 172,
    brokerEntryPrice: 0.66641,
    currentPrice: 0.66621,
    authoritativeStop: 0.6669,
    brokerStop: 0.6669,
    authoritativeTakeProfit: 0.6656,
    brokerTakeProfit: 0.6656,
    previousObservedBrokerNetPnl: 93,
    maxFavorableBrokerNetPnl: 99.76,
    currentBrokerNetPnl: 68,
    conservativeExitReserve: 20.64,
  };

  it('high-peak USDJPY: moves the protective trigger earlier before the 170-to-65 fall', () => {
    const old = evaluatePepperstoneDemoNetProfitLock({
      ...highPeakUsdJpy,
      progressiveTpRetentionEnabled: false,
    });
    const progressive = evaluatePepperstoneDemoNetProfitLock(highPeakUsdJpy);
    expect(old).toMatchObject({
      shouldClose: false,
      reason: 'NO_PROTECTED_GIVEBACK',
      retentionFraction: 0.75,
    });
    expect(progressive).toMatchObject({
      shouldClose: true,
      reason: 'PROTECTED_POSITIVE_NET_PROFIT',
      progressiveTpRetentionActive: true,
      tieredRetentionActive: true,
    });
    expect(progressive.retentionFraction).toBeGreaterThan(0.89);
    expect(progressive.retentionFraction).toBeLessThan(0.91);
    expect(progressive.protectedBrokerNetFloor).toBeCloseTo(152.62, 1);
    expect(progressive.protectedBrokerNetFloor!).toBeGreaterThan(old.protectedBrokerNetFloor! + 24);
  });

  it('sub-$100 AUDUSD peak: advances the floor without demanding full TP or a fixed dollar trigger', () => {
    const old = evaluatePepperstoneDemoNetProfitLock({
      ...near100AudUsd,
      progressiveTpRetentionEnabled: false,
    });
    const progressive = evaluatePepperstoneDemoNetProfitLock(near100AudUsd);
    expect(old.shouldClose).toBe(false);
    expect(progressive.shouldClose).toBe(true);
    expect(progressive.retentionFraction).toBeGreaterThan(0.72);
    expect(progressive.retentionFraction).toBeLessThan(0.75);
    expect(progressive.protectedBrokerNetFloor).toBeCloseTo(71.97, 1);
    expect(progressive.protectedBrokerNetFloor!).toBeGreaterThan(old.protectedBrokerNetFloor! + 7);
  });

  it('never expands LIVE, wrong provider or wrong broker barriers', () => {
    for (const unsafe of [
      { accountType: 'LIVE' },
      { brokerId: 'icmarkets-ctrader' },
      { brokerDirection: 'BUY' as const },
      { brokerLotSize: 5 },
      { brokerStop: 159.065 },
      { feeSampleCount: 1 },
      { conservativeExitReserve: null },
    ]) {
      const result = evaluatePepperstoneDemoNetProfitLock({
        ...highPeakUsdJpy,
        ...unsafe,
      });
      expect(result.shouldClose).toBe(false);
    }
  });

  it('does not make the protected stop fictional or close on a rising mark', () => {
    const rising = evaluatePepperstoneDemoNetProfitLock({
      ...highPeakUsdJpy,
      previousObservedBrokerNetPnl: 140,
      currentBrokerNetPnl: 155,
    });
    expect(rising.shouldClose).toBe(false);

    const insufficientAfterReserve = evaluatePepperstoneDemoNetProfitLock({
      ...highPeakUsdJpy,
      previousObservedBrokerNetPnl: 145,
      currentBrokerNetPnl: 35,
    });
    expect(insufficientAfterReserve.shouldClose).toBe(false);
    expect(insufficientAfterReserve.reason).toBe('NO_REMAINING_POSITIVE_NET');
  });
});
