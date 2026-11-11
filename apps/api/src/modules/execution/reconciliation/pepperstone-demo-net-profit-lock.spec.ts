import { evaluatePepperstoneDemoNetProfitLock } from './pepperstone-demo-net-profit-lock';

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
    { strategyRoute: 'EARLY_TRANSITION' },
    { strategyRoute: 'CONFIRMED_REVERSAL' },
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
