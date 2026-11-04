import { evaluateProtectedRunnerShadow, ProtectedRunnerShadowInput } from './protected-runner-shadow';

describe('protected runner DEMO shadow evaluator', () => {
  const input: ProtectedRunnerShadowInput = {
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
  };

  it('selects a purely indicative stop that retains positive estimated net after costs', () => {
    const decision = evaluateProtectedRunnerShadow(input);
    expect(decision).toMatchObject({
      mode: 'SHADOW_ONLY',
      eligibleForFurtherResearch: true,
      reason: 'BROKER_VALIDATION_REQUIRED',
      noTradeAuthority: true,
      estimatedBrokerCosts: 1.6,
      feeSampleCount: 12,
    });
    expect(decision.proposedNetFloorPnl).toBeCloseTo(3.24);
    expect(decision.proposedGrossFloorPnl).toBeCloseTo(4.84);
    expect(decision.indicativeProtectedStopPrice).toBeGreaterThan(input.entryPrice!);
    expect(decision.indicativeProtectedStopPrice).toBeLessThan(input.currentPrice!);
    expect(decision.stopHeadroomInSpreads).toBeGreaterThan(2);
  });

  it('does not propose holding if trend alignment or causal fees are missing', () => {
    expect(evaluateProtectedRunnerShadow({ ...input, trendWouldHold: false }).reason).toBe(
      'TREND_RECHECK_NOT_ALIGNED',
    );
    expect(evaluateProtectedRunnerShadow({ ...input, estimatedBrokerCosts: null }).reason).toBe(
      'INSUFFICIENT_CAUSAL_FEE_SAMPLES',
    );
    expect(evaluateProtectedRunnerShadow({ ...input, feeSampleCount: 4 }).reason).toBe(
      'INSUFFICIENT_CAUSAL_FEE_SAMPLES',
    );
  });

  it('rejects a winner whose fee-adjusted minimum protection is unaffordable', () => {
    const d = evaluateProtectedRunnerShadow({
      ...input,
      grossUnrealisedPnl: 2.14,
      estimatedBrokerCosts: 1.6,
      initialRiskPnl: 9,
    });
    expect(d.eligibleForFurtherResearch).toBe(false);
    expect(d.reason).toBe('NO_PROTECTED_NET_PROFIT');
  });

  it('rejects spread-tight stop placement, a missing TP and inverted entry risk', () => {
    const tight = evaluateProtectedRunnerShadow({
      ...input,
      latestLiveSpreadPrice: 0.00009,
    });
    expect(tight.eligibleForFurtherResearch).toBe(false);
    expect(tight.reason).toBe('PROTECTION_STOP_TOO_CLOSE');

    expect(evaluateProtectedRunnerShadow({ ...input, takeProfitPrice: null }).reason).toBe(
      'INVALID_RISK_OR_PRICE_EVIDENCE',
    );
    expect(evaluateProtectedRunnerShadow({ ...input, takeProfitPrice: 1.11341 }).reason).toBe(
      'NO_TP_UPSIDE_ROOM',
    );
    expect(evaluateProtectedRunnerShadow({ ...input, originalStopPrice: 1.114 }).reason).toBe(
      'INVALID_RISK_OR_PRICE_EVIDENCE',
    );
  });

  it('supports a sell position with a protective stop below entry', () => {
    const d = evaluateProtectedRunnerShadow({
      ...input,
      instrument: 'USDJPY',
      direction: 'SELL',
      entryPrice: 158.4,
      currentPrice: 158.35,
      originalStopPrice: 158.46,
      takeProfitPrice: 158.21,
      latestLiveSpreadPrice: 0.004,
    });
    expect(d.eligibleForFurtherResearch).toBe(true);
    expect(d.indicativeProtectedStopPrice).toBeLessThan(158.4);
    expect(d.indicativeProtectedStopPrice).toBeGreaterThan(158.35);
  });

  it('keeps results shadow-only even if protection looks attractive', () => {
    const d = evaluateProtectedRunnerShadow(input);
    expect(d.noTradeAuthority).toBe(true);
    expect(d.mode).toBe('SHADOW_ONLY');
    expect(d).not.toHaveProperty('executeStop');
  });
});
