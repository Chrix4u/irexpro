import { evaluateProtectedRunnerShadow } from './protected-runner-shadow';
import {
  evaluateVerifiedProtectedRunnerStopShadow,
  type VerifiedProtectedRunnerStopInput,
} from './verified-profit-runner-stop-shadow';

const runner = evaluateProtectedRunnerShadow({
  trendWouldHold: true,
  instrument: 'EURUSD',
  direction: 'BUY',
  grossUnrealisedPnl: 7,
  initialRiskPnl: 9,
  estimatedBrokerCosts: 1.6,
  feeSampleCount: 12,
  entryPrice: 1.113,
  currentPrice: 1.1134,
  originalStopPrice: 1.1125,
  takeProfitPrice: 1.1138,
  latestLiveSpreadPrice: 0.00002,
});

const base: VerifiedProtectedRunnerStopInput = {
  brokerId: 'pepperstone-ctrader',
  accountType: 'DEMO',
  currency: 'USD',
  ownerUserId: 'owner',
  userId: 'owner',
  isM1Strategy: true,
  route: 'CONFIRMED_REVERSAL',
  instrument: 'EURUSD',
  brokerInstrument: 'EURUSD',
  direction: 'BUY',
  brokerDirection: 'BUY',
  tradeLots: 1.72,
  brokerLots: 1.72,
  entry: 1.113,
  mark: 1.1134,
  originalStop: 1.1125,
  brokerStop: 1.1125,
  takeProfit: 1.1138,
  brokerTakeProfit: 1.1138,
  brokerNetPnl: 7,
  initialRiskPnl: 9,
  estimatedExtraExitReserve: 1.6,
  historicalFeeSamples: 12,
  observedAt: new Date('2026-11-18T08:01:00Z'),
  lastBid: 1.11339,
  lastAsk: 1.11341,
  quoteObservedAt: new Date('2026-11-18T08:00:57Z'),
  runner,
};

describe('broker-validated protected runner: research-only stop readiness', () => {
  it('estimates a protected net floor using real mark, stop slope and after-fee reserve; never modifies stops', () => {
    const actual = evaluateVerifiedProtectedRunnerStopShadow(base);
    expect(actual).toMatchObject({
      artifact: 'irexpro-owner-demo-broker-verified-protected-runner-shadow-v1',
      mode: 'SHADOW_ONLY',
      eligibleForIndependentProviderValidation: true,
      reason: 'REQUIRES_BROKER_TICK_MIN_STOP_AND_AMENDMENT_VERIFICATION',
      noTradeAuthority: true,
      modifiesExecution: false,
      brokerStopUnchanged: true,
      quoteAgeSeconds: 3,
    });
    expect(actual.proposedStopForResearchOnly).toBeGreaterThan(base.entry!);
    expect(actual.proposedStopForResearchOnly).toBeLessThan(base.mark!);
    expect(actual.estimatedNetAtStopAfterReserve).toBeGreaterThan(0);
  });

  it('supports SELL with correct bid/ask side and decreasing stop', () => {
    const r = evaluateProtectedRunnerShadow({
      trendWouldHold: true,
      instrument: 'USDJPY',
      direction: 'SELL',
      grossUnrealisedPnl: 19,
      initialRiskPnl: 24,
      estimatedBrokerCosts: 2,
      feeSampleCount: 12,
      entryPrice: 158.4,
      currentPrice: 158.35,
      originalStopPrice: 158.46,
      takeProfitPrice: 158.21,
      latestLiveSpreadPrice: 0.004,
    });
    const value = evaluateVerifiedProtectedRunnerStopShadow({
      ...base,
      instrument: 'USDJPY',
      brokerInstrument: 'USDJPY',
      direction: 'SELL',
      brokerDirection: 'SELL',
      entry: 158.4,
      mark: 158.35,
      originalStop: 158.46,
      brokerStop: 158.46,
      takeProfit: 158.21,
      brokerTakeProfit: 158.21,
      initialRiskPnl: 24,
      brokerNetPnl: 19,
      estimatedExtraExitReserve: 2,
      lastBid: 158.346,
      lastAsk: 158.35,
      runner: r,
    });
    expect(value.eligibleForIndependentProviderValidation).toBe(true);
    expect(value.proposedStopForResearchOnly).toBeLessThan(158.4);
    expect(value.proposedStopForResearchOnly).toBeGreaterThan(158.35);
  });

  it.each([
    { brokerId: 'ctrader' },
    { brokerId: 'icmarkets-ctrader' },
    { accountType: 'LIVE' },
    { currency: 'EUR' },
    { ownerUserId: null },
    { ownerUserId: 'other' },
    { isM1Strategy: false },
    { route: 'TREND_CONTINUATION' },
    { route: null },
    { brokerInstrument: 'AUDUSD' },
    { brokerDirection: 'SELL' as const },
    { brokerLots: 1.7 },
    { brokerStop: 1.1123 },
    { originalStop: null },
    { takeProfit: null },
    { brokerTakeProfit: 1.1139 },
    { mark: 1.1129 },
    { quoteObservedAt: null },
    { quoteObservedAt: new Date('2026-11-18T08:00:43Z') },
    { quoteObservedAt: new Date('2026-11-18T08:01:01Z') },
    { lastBid: null },
    { lastAsk: 1.11338 },
    { lastBid: 1.1125 },
    { historicalFeeSamples: 3 },
    { estimatedExtraExitReserve: null },
    { initialRiskPnl: 0 },
    { brokerNetPnl: 0.4 },
    { runner: { ...runner, eligibleForFurtherResearch: false } },
    { runner: { ...runner, indicativeProtectedStopPrice: 1.1134 } },
    { runner: { ...runner, indicativeProtectedStopPrice: 1.1122 } },
  ])('fails closed rather than attempting provider amendment: %j', (override) => {
    const actual = evaluateVerifiedProtectedRunnerStopShadow({ ...base, ...override });
    expect(actual.noTradeAuthority).toBe(true);
    expect(actual.modifiesExecution).toBe(false);
    expect(actual.eligibleForIndependentProviderValidation).toBe(false);
  });
});
