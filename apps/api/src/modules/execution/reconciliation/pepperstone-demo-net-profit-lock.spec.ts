import {
  evaluatePepperstoneDemoNetProfitLock,
  pepperstoneDemoTieredPeakRetention,
} from './pepperstone-demo-net-profit-lock';

const at = new Date('2026-11-11T01:43:18.000Z');
const input = {
  brokerId: 'pepperstone-ctrader',
  accountType: 'DEMO',
  tradeInstrument: 'USDJPY',
  brokerInstrument: 'USDJPY',
  tradeDirection: 'BUY' as const,
  brokerDirection: 'BUY' as const,
  tradeLotSize: 4,
  brokerLotSize: 4,
  isM1Strategy: true,
  strategyRoute: 'TREND_CONTINUATION',
  initialRiskPnl: 125.84710834,
  brokerEntryPrice: 158.922,
  currentPrice: 158.94,
  authoritativeStop: 158.872,
  brokerStop: 158.872,
  authoritativeTakeProfit: 159.002,
  brokerTakeProfit: 159.002,
  openedAt: new Date('2026-11-11T01:30:46.417Z'),
  previousObservationAt: new Date('2026-11-11T01:43:13.000Z'),
  observedAt: at,
  previousObservationCount: 100,
  previousObservedBrokerNetPnl: 37,
  maxFavorableBrokerNetPnl: 50.91,
  currentBrokerNetPnl: 29.5,
  conservativeExitReserve: 24,
  feeSampleCount: 17,
  feeEvidenceSource: 'SAME_ACCOUNT_FX_MAJORS' as const,
};

describe('Pepperstone DEMO explicit after-cost profit-lock close policy', () => {
  it('would protect a broker-reported net USDJPY gain after an additional fee reserve', () => {
    expect(evaluatePepperstoneDemoNetProfitLock(input)).toMatchObject({
      shouldClose: true,
      reason: 'PROTECTED_POSITIVE_NET_PROFIT',
    });
    expect(evaluatePepperstoneDemoNetProfitLock(input).estimatedNetAfterReserve).toBeCloseTo(5.5);
  });
  it('would protect a small broker-reported net USDCHF gain before full SL', () => {
    expect(
      evaluatePepperstoneDemoNetProfitLock({
        ...input,
        tradeInstrument: 'USDCHF',
        brokerInstrument: 'USDCHF',
        brokerEntryPrice: 0.82592,
        currentPrice: 0.8261,
        authoritativeStop: 0.82542,
        brokerStop: 0.82542,
        authoritativeTakeProfit: 0.82672,
        brokerTakeProfit: 0.82672,
        initialRiskPnl: 242.15420379,
        maxFavorableBrokerNetPnl: 60.63,
        previousObservedBrokerNetPnl: 42,
        currentBrokerNetPnl: 32.6,
      }),
    ).toMatchObject({
      shouldClose: true,
      reason: 'PROTECTED_POSITIVE_NET_PROFIT',
    });
  });
  it('holds a normal pullback above protected floor and lets TP target run', () => {
    expect(
      evaluatePepperstoneDemoNetProfitLock({
        ...input,
        maxFavorableBrokerNetPnl: 208,
        initialRiskPnl: 200,
        previousObservedBrokerNetPnl: 183,
        currentBrokerNetPnl: 150,
      }).reason,
    ).toBe('ESTABLISHED_HIGH_PEAK_RUNNER_UNCHANGED');
  });
  it('protects a small 0.20-lot Pepperstone DEMO position with risk-scaled reserve', () => {
    expect(
      evaluatePepperstoneDemoNetProfitLock({
        ...input,
        tradeInstrument: 'USDCHF',
        brokerInstrument: 'USDCHF',
        tradeLotSize: 0.2,
        brokerLotSize: 0.2,
        initialRiskPnl: 12.11,
        brokerEntryPrice: 0.82592,
        currentPrice: 0.826,
        authoritativeStop: 0.82542,
        brokerStop: 0.82542,
        authoritativeTakeProfit: 0.82672,
        brokerTakeProfit: 0.82672,
        maxFavorableBrokerNetPnl: 4.49,
        previousObservedBrokerNetPnl: 3.1,
        currentBrokerNetPnl: 2.42,
        conservativeExitReserve: 1.2,
      }),
    ).toMatchObject({
      shouldClose: true,
      reason: 'PROTECTED_POSITIVE_NET_PROFIT',
    });
  });

  it('does not claim protected gain if the extra close-cost reserve is exhausted', () => {
    expect(
      evaluatePepperstoneDemoNetProfitLock({
        ...input,
        currentBrokerNetPnl: 15.68,
      }).reason,
    ).toBe('NO_REMAINING_POSITIVE_NET');
  });
  it.each([
    { brokerId: 'ctrader' },
    { brokerId: 'icmarkets-ctrader' },
    { accountType: 'LIVE' },
    { accountType: 'PAPER' },
    { isM1Strategy: false },
    { strategyRoute: 'UNRECOGNIZED' },
  ])('cannot grant a close outside current Pepperstone M1 DEMO route: %p', (patch) => {
    expect(evaluatePepperstoneDemoNetProfitLock({ ...input, ...patch }).shouldClose).toBe(false);
  });
  it.each([
    { brokerInstrument: 'EURUSD' },
    { brokerDirection: 'SELL' as const },
    { brokerLotSize: 3.9 },
    { brokerLotSize: 0 },
    { tradeLotSize: 0 },
  ])('refuses mismatched provider position: %p', (patch) => {
    expect(evaluatePepperstoneDemoNetProfitLock({ ...input, ...patch }).reason).toBe(
      'UNVERIFIED_POSITION',
    );
  });
  it.each([
    { brokerStop: 158.88 },
    { brokerTakeProfit: 159.01 },
    { currentPrice: 158.872 },
    { currentPrice: 158.92 }, // broker quote must also show the position is favorable
    { currentPrice: 159.002 },
    { authoritativeStop: null },
    { brokerEntryPrice: null },
  ])('refuses mismatched/missing or breached broker protective barriers: %p', (patch) => {
    expect(evaluatePepperstoneDemoNetProfitLock({ ...input, ...patch }).reason).toBe(
      'UNVERIFIED_BROKER_BARRIERS',
    );
  });
  it('requires recent independent position tracking and a 15-second-old position', () => {
    for (const patch of [
      { openedAt: new Date('2026-11-11T01:43:12Z') },
      { previousObservationAt: new Date('2026-11-11T01:40:00Z') },
      { previousObservationCount: 1 },
      { openedAt: null },
    ])
      expect(evaluatePepperstoneDemoNetProfitLock({ ...input, ...patch }).reason).toBe(
        'INSUFFICIENT_OBSERVATIONS',
      );
  });
  it('requires initial risk, genuine fee amount, sufficient causal broker samples', () => {
    for (const patch of [
      { initialRiskPnl: null },
      { initialRiskPnl: 0 },
      { conservativeExitReserve: null },
      { conservativeExitReserve: 0 },
    ])
      expect(evaluatePepperstoneDemoNetProfitLock({ ...input, ...patch }).reason).toBe(
        'INVALID_RISK_OR_FEE',
      );
    for (const patch of [
      { feeSampleCount: 7 },
      { feeEvidenceSource: null },
      { feeSampleCount: 4, feeEvidenceSource: 'SAME_SYMBOL' as const },
    ])
      expect(evaluatePepperstoneDemoNetProfitLock({ ...input, ...patch }).reason).toBe(
        'INSUFFICIENT_PRIOR_FEE_SAMPLES',
      );
  });
  it('never acts on a small peak, a rising mark or artificial giveback', () => {
    expect(
      evaluatePepperstoneDemoNetProfitLock({
        ...input,
        maxFavorableBrokerNetPnl: 29,
      }).reason,
    ).toBe('NO_MEANINGFUL_NET_PEAK');
    expect(
      evaluatePepperstoneDemoNetProfitLock({
        ...input,
        previousObservedBrokerNetPnl: 28.9,
      }).reason,
    ).toBe('GROSS_PNL_NOT_DECLINING');
  });
  it('does not truncate an already established 1R TP runner on its later retracement', () => {
    const result = evaluatePepperstoneDemoNetProfitLock({
      ...input,
      initialRiskPnl: 200,
      maxFavorableBrokerNetPnl: 208,
      previousObservedBrokerNetPnl: 70,
      currentBrokerNetPnl: 30,
    });
    expect(result).toMatchObject({
      shouldClose: false,
      reason: 'ESTABLISHED_HIGH_PEAK_RUNNER_UNCHANGED',
    });
  });


  it.each(['EARLY_TRANSITION', 'CONFIRMED_REVERSAL'])(
    'protects a Pepperstone DEMO %s trade after a meaningful 0.50R+ peak and 45%% giveback',
    (strategyRoute) => {
      const alternate = {
        ...input,
        strategyRoute,
        tradeLotSize: 3.18,
        brokerLotSize: 3.18,
        initialRiskPnl: 99.7008973,
        brokerEntryPrice: 159.472,
        currentPrice: 159.486,
        authoritativeStop: 159.422,
        brokerStop: 159.422,
        authoritativeTakeProfit: 159.552,
        brokerTakeProfit: 159.552,
        openedAt: new Date('2026-11-17T00:44:13Z'),
        previousObservationAt: new Date('2026-11-17T00:50:00Z'),
        observedAt: new Date('2026-11-17T00:50:05Z'),
        previousObservationCount: 65,
        maxFavorableBrokerNetPnl: 72.2,
        previousObservedBrokerNetPnl: 48,
        currentBrokerNetPnl: 39.3,
        conservativeExitReserve: 19.08,
      };
      expect(evaluatePepperstoneDemoNetProfitLock(alternate)).toMatchObject({
        shouldClose: true,
        reason: 'PROTECTED_POSITIVE_NET_PROFIT',
      });
      expect(evaluatePepperstoneDemoNetProfitLock(alternate).protectedBrokerNetFloor).toBeCloseTo(39.71, 2);
      expect(evaluatePepperstoneDemoNetProfitLock(alternate).estimatedNetAfterReserve).toBeCloseTo(20.22, 2);
      expect(evaluatePepperstoneDemoNetProfitLock({
        ...alternate, currentBrokerNetPnl: 54.26,
      }).reason).toBe('NO_PROTECTED_GIVEBACK');
      expect(evaluatePepperstoneDemoNetProfitLock({
        ...alternate, maxFavorableBrokerNetPnl: 45,
      }).reason).toBe('NO_MEANINGFUL_NET_PEAK');
      expect(evaluatePepperstoneDemoNetProfitLock({
        ...alternate, currentBrokerNetPnl: 12,
      }).shouldClose).toBe(false);
      expect(evaluatePepperstoneDemoNetProfitLock({
        ...alternate, brokerStop: 159.421,
      }).shouldClose).toBe(false);
      expect(evaluatePepperstoneDemoNetProfitLock({
        ...alternate, accountType: 'LIVE',
      }).shouldClose).toBe(false);
    },
  );


  it('extends the high-peak after-fee protection ONLY to explicitly tagged DEMO guarded pullbacks',()=>{
    const guarded={
      ...input,
      strategyRoute:'TREND_CONTINUATION',
      guardedPullbackContinuation:true,
      initialRiskPnl:40,
      maxFavorableBrokerNetPnl:28,
      previousObservedBrokerNetPnl:18,
      currentBrokerNetPnl:15,
      conservativeExitReserve:5,
    };
    expect(evaluatePepperstoneDemoNetProfitLock(guarded)).toMatchObject({
      shouldClose:true,reason:'PROTECTED_POSITIVE_NET_PROFIT'
    });
    expect(evaluatePepperstoneDemoNetProfitLock({
      ...guarded,guardedPullbackContinuation:false,
    }).reason).toBe('ESTABLISHED_HIGH_PEAK_RUNNER_UNCHANGED');
    expect(evaluatePepperstoneDemoNetProfitLock({
      ...guarded,accountType:'LIVE',
    }).shouldClose).toBe(false);
  });

  it('supports SELL-side quote and protective barrier verification', () => {
    const sell = {
      ...input,
      tradeDirection: 'SELL' as const,
      brokerDirection: 'SELL' as const,
      brokerEntryPrice: 1.1,
      currentPrice: 1.0995,
      authoritativeStop: 1.102,
      brokerStop: 1.102,
      authoritativeTakeProfit: 1.097,
      brokerTakeProfit: 1.097,
    };
    expect(evaluatePepperstoneDemoNetProfitLock(sell).shouldClose).toBe(true);
    expect(
      evaluatePepperstoneDemoNetProfitLock({
        ...sell,
        currentPrice: 1.102,
      }).shouldClose,
    ).toBe(false);
  });
});


describe('Owner-scoped DEMO tiered 65/75/80 after-fee peak retention', () => {
  const typicalNov17Sell = {
    ...input,
    brokerId: 'pepperstone-ctrader',
    accountType: 'DEMO',
    strategyRoute: 'EARLY_TRANSITION',
    tieredRetentionEnabled: true,
    tradeDirection: 'SELL' as const,
    brokerDirection: 'SELL' as const,
    tradeLotSize: 3.18,
    brokerLotSize: 3.18,
    brokerEntryPrice: 159.487,
    currentPrice: 159.454,
    authoritativeStop: 159.537,
    brokerStop: 159.537,
    authoritativeTakeProfit: 159.407,
    brokerTakeProfit: 159.407,
    openedAt: new Date('2026-11-17T02:10:23Z'),
    previousObservationAt: new Date('2026-11-17T02:17:48Z'),
    observedAt: new Date('2026-11-17T02:17:53Z'),
    previousObservationCount: 88,
    initialRiskPnl: 99.69464595,
    conservativeExitReserve: 19.08,
    feeEvidenceSource: 'SAME_ACCOUNT_FX_MAJORS' as const,
    feeSampleCount: 15,
    maxFavorableBrokerNetPnl: 86.20,
    previousObservedBrokerNetPnl: 70,
    currentBrokerNetPnl: 64.40,
  };

  it('sets 65%, 75% and 80% of peak at exactly the R boundaries', () => {
    expect(pepperstoneDemoTieredPeakRetention(0.499999)).toBe(0.55);
    expect(pepperstoneDemoTieredPeakRetention(0.5)).toBe(0.65);
    expect(pepperstoneDemoTieredPeakRetention(0.749999)).toBe(0.65);
    expect(pepperstoneDemoTieredPeakRetention(0.75)).toBe(0.75);
    expect(pepperstoneDemoTieredPeakRetention(0.999999)).toBe(0.75);
    expect(pepperstoneDemoTieredPeakRetention(1)).toBe(0.80);
    expect(pepperstoneDemoTieredPeakRetention(2.1)).toBe(0.80);
    expect(pepperstoneDemoTieredPeakRetention(Number.NaN)).toBe(0.55);
  });

  it.each(['EARLY_TRANSITION', 'CONFIRMED_REVERSAL'])(
    'requests a protected positive close on %s at ~75%% of the $86.20 USDJPY peak',
    (strategyRoute) => {
      const at75 = evaluatePepperstoneDemoNetProfitLock({
        ...typicalNov17Sell, strategyRoute,
      });
      expect(at75).toMatchObject({
        shouldClose: true,
        reason: 'PROTECTED_POSITIVE_NET_PROFIT',
        tieredRetentionActive: true,
        retentionFraction: 0.75,
      });
      expect(at75.observedPeakR).toBeCloseTo(0.8646, 3);
      expect(at75.protectedBrokerNetFloor).toBeCloseTo(64.65, 2);
      expect(at75.estimatedNetAfterReserve).toBeCloseTo(45.32, 2);

      const old = evaluatePepperstoneDemoNetProfitLock({
        ...typicalNov17Sell, strategyRoute, tieredRetentionEnabled: false,
      });
      expect(old).toMatchObject({
        shouldClose: false, reason: 'NO_PROTECTED_GIVEBACK',
        tieredRetentionActive: false, retentionFraction: 0.55,
      });
      expect(old.protectedBrokerNetFloor).toBeCloseTo(47.41, 2);
    },
  );

  it('does not close a plausible TP runner while broker net remains ABOVE 75% peak', () => {
    const hold = evaluatePepperstoneDemoNetProfitLock({
      ...typicalNov17Sell,
      previousObservedBrokerNetPnl: 80,
      currentBrokerNetPnl: 70,
    });
    expect(hold).toMatchObject({
      shouldClose: false, reason: 'NO_PROTECTED_GIVEBACK',
      retentionFraction: 0.75,
    });
  });

  it('retains 65% for the prior USDJPY 0.72R peak and 80% at 1.10R', () => {
    const at65 = evaluatePepperstoneDemoNetProfitLock({
      ...typicalNov17Sell,
      maxFavorableBrokerNetPnl: 72.2,
      previousObservedBrokerNetPnl: 51,
      currentBrokerNetPnl: 46.7,
    });
    expect(at65).toMatchObject({
      shouldClose: true, retentionFraction: 0.65,
    });
    expect(at65.protectedBrokerNetFloor).toBeCloseTo(46.93, 2);

    const at80 = evaluatePepperstoneDemoNetProfitLock({
      ...typicalNov17Sell,
      maxFavorableBrokerNetPnl: 110,
      previousObservedBrokerNetPnl: 96,
      currentBrokerNetPnl: 87.7,
    });
    expect(at80).toMatchObject({
      shouldClose: true, retentionFraction: 0.8,
    });
    expect(at80.protectedBrokerNetFloor).toBeCloseTo(88, 2);
  });

  it('preserves fee safeguards, broker proof, trend-continuation behavior and LIVE denial', () => {
    const patches = [
      {accountType: 'LIVE'},
      {brokerId: 'icmarkets-ctrader'},
      {brokerInstrument: 'EURUSD'},
      {brokerLotSize: 3},
      {brokerStop: 159.53},
      {feeSampleCount: 2},
      {conservativeExitReserve: null},
      {previousObservationAt: new Date('2026-11-17T02:12:00Z')},
    ];
    for (const patch of patches) {
      expect(evaluatePepperstoneDemoNetProfitLock({
        ...typicalNov17Sell, ...patch,
      }).shouldClose).toBe(false);
    }
    expect(evaluatePepperstoneDemoNetProfitLock({
      ...typicalNov17Sell, currentBrokerNetPnl: 14,
    }).shouldClose).toBe(false);
    expect(evaluatePepperstoneDemoNetProfitLock({
      ...typicalNov17Sell, strategyRoute: 'TREND_CONTINUATION',
      guardedPullbackContinuation: false,
    }).reason).toBe('ESTABLISHED_HIGH_PEAK_RUNNER_UNCHANGED');
    expect(evaluatePepperstoneDemoNetProfitLock({
      ...typicalNov17Sell, strategyRoute: 'TREND_CONTINUATION',
      guardedPullbackContinuation: true,
    }).retentionFraction).toBe(0.55);
  });
});
