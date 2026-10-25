import {
  PAPER_REALISED_CONTINUATION_ROUTE_RELIABILITY_MIN_TRADES,
  PAPER_REVERSAL_ROUTE_RELIABILITY_MIN_EPISODES,
  PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
  PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES,
  evaluatePaperRealisedContinuationExecutionGate,
  evaluatePaperRealisedContinuationRouteReliability,
  evaluatePaperReliabilityExecutionGate,
  evaluatePaperReversalRouteReliability,
  evaluatePaperTrendPairSideReliability,
  evaluatePaperTrendPairSideReliabilityShadow,
  evaluatePaperTrendReliabilityExecutionGate,
  evaluatePaperTrendRouteReliability,
} from './paper-route-reliability';

const evidence = (overrides: Record<string, unknown> = {}) => ({
  closedTrades: PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES,
  profitFactor: 1.2,
  sharpe: 0.5,
  maxDrawdown: 0.08,
  positiveWindowFraction: 0.5,
  ...overrides,
});

describe('PAPER trend-route reliability', () => {
  it('does not constrain reversal or early-transition routes', () => {
    expect(
      evaluatePaperTrendRouteReliability({
        strategyRoute: 'CONFIRMED_REVERSAL',
        evidence: evidence({ profitFactor: 0.2, maxDrawdown: 0.4 }),
      }),
    ).toMatchObject({
      state: 'NOT_APPLICABLE',
      fullSizeEligible: true,
      researchFallbackRequested: false,
    });
  });

  it('keeps continuation full-size while independent evidence is still collecting', () => {
    expect(
      evaluatePaperTrendRouteReliability({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({ closedTrades: 19, profitFactor: 0.3 }),
      }),
    ).toMatchObject({
      state: 'COLLECTING',
      fullSizeEligible: true,
      reason: 'INSUFFICIENT_ROUTE_EVIDENCE',
    });
  });

  it('demotes continuation to research-only when profit factor is below one', () => {
    expect(
      evaluatePaperTrendRouteReliability({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({ profitFactor: 0.91 }),
      }),
    ).toMatchObject({
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      researchFallbackRequested: true,
      reason: 'ROUTE_PROFIT_FACTOR_BELOW_ONE',
    });
  });

  it('demotes continuation when route drawdown exceeds the global PAPER boundary', () => {
    expect(
      evaluatePaperTrendRouteReliability({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({ profitFactor: 1.4, maxDrawdown: 0.121 }),
      }),
    ).toMatchObject({
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      reason: 'ROUTE_DRAWDOWN_EXCEEDED',
    });
  });

  it('keeps a non-losing mature continuation route at full PAPER size', () => {
    expect(
      evaluatePaperTrendRouteReliability({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({ profitFactor: 1.0, maxDrawdown: 0.12 }),
      }),
    ).toMatchObject({ state: 'HEALTHY', fullSizeEligible: true });
  });
});

describe('PAPER trend pair-side reliability shadow', () => {
  it('is observational only and does not apply to early-transition routes', () => {
    expect(
      evaluatePaperTrendPairSideReliabilityShadow({
        strategyRoute: 'EARLY_TRANSITION',
        evidence: evidence({ closedTrades: 20, profitFactor: 0.1, maxDrawdown: 0.4 }),
      }),
    ).toMatchObject({
      state: 'NOT_APPLICABLE',
      modifiesExecution: false,
      executionAuthority: 'NONE',
      reason: 'NON_CONTINUATION_ROUTE',
    });
  });

  it('keeps pair-side evidence collecting until independent episodes mature', () => {
    expect(
      evaluatePaperTrendPairSideReliabilityShadow({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({
          closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES - 1,
          profitFactor: 0.2,
          maxDrawdown: 0.3,
        }),
      }),
    ).toMatchObject({
      state: 'COLLECTING',
      modifiesExecution: false,
      executionAuthority: 'NONE',
      reason: 'INSUFFICIENT_PAIR_SIDE_EVIDENCE',
    });
  });

  it('labels mature losing pair-side continuation evidence as WEAK without changing execution', () => {
    expect(
      evaluatePaperTrendPairSideReliabilityShadow({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({
          closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
          profitFactor: 0.72,
          maxDrawdown: 0.05,
        }),
      }),
    ).toMatchObject({
      state: 'WEAK',
      modifiesExecution: false,
      executionAuthority: 'NONE',
      reason: 'PAIR_SIDE_PROFIT_FACTOR_BELOW_ONE',
    });
  });

  it('labels mature healthy pair-side evidence without authorizing execution', () => {
    expect(
      evaluatePaperTrendPairSideReliabilityShadow({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({
          closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
          profitFactor: 1.25,
          maxDrawdown: 0.04,
        }),
      }),
    ).toMatchObject({
      state: 'HEALTHY',
      modifiesExecution: false,
      executionAuthority: 'NONE',
      reason: 'PAIR_SIDE_HEALTHY',
    });
  });
});

describe('PAPER trend pair-side reliability execution gate', () => {
  it('demotes a mature weak continuation pair-side to research-only', () => {
    expect(
      evaluatePaperTrendPairSideReliability({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({
          closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
          profitFactor: 0.72,
          maxDrawdown: 0.05,
        }),
      }),
    ).toMatchObject({
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      researchFallbackRequested: true,
      reason: 'PAIR_SIDE_PROFIT_FACTOR_BELOW_ONE',
    });
  });

  it('demotes a mature weak confirmed-reversal pair-side to research-only', () => {
    expect(
      evaluatePaperTrendPairSideReliability({
        strategyRoute: 'CONFIRMED_REVERSAL',
        evidence: evidence({
          closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
          profitFactor: 0.72,
          maxDrawdown: 0.05,
        }),
      }),
    ).toMatchObject({
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      researchFallbackRequested: true,
      reason: 'PAIR_SIDE_PROFIT_FACTOR_BELOW_ONE',
    });
  });

  it('keeps insufficient pair-side evidence eligible for normal PAPER', () => {
    expect(
      evaluatePaperTrendPairSideReliability({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({
          closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES - 1,
          profitFactor: 0.2,
          maxDrawdown: 0.3,
        }),
      }),
    ).toMatchObject({
      state: 'COLLECTING',
      fullSizeEligible: true,
      researchFallbackRequested: false,
    });
  });

  it('keeps mature healthy pair-side evidence eligible for normal PAPER', () => {
    expect(
      evaluatePaperTrendPairSideReliability({
        strategyRoute: 'TREND_CONTINUATION',
        evidence: evidence({
          closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
          profitFactor: 1.25,
          maxDrawdown: 0.04,
        }),
      }),
    ).toMatchObject({ state: 'HEALTHY', fullSizeEligible: true });
  });

  it('does not constrain non-continuation routes', () => {
    expect(
      evaluatePaperTrendPairSideReliability({
        strategyRoute: 'EARLY_TRANSITION',
        evidence: evidence({
          closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
          profitFactor: 0.1,
          maxDrawdown: 0.4,
        }),
      }),
    ).toMatchObject({ state: 'NOT_APPLICABLE', fullSizeEligible: true });
  });
});

describe('PAPER trend reliability execution composition', () => {
  it('keeps a healthy pair-side executable even when aggregate route telemetry is weak', () => {
    const route = evaluatePaperTrendRouteReliability({
      strategyRoute: 'TREND_CONTINUATION',
      evidence: evidence({ profitFactor: 0.7, maxDrawdown: 0.05 }),
    });
    const pairSide = evaluatePaperTrendPairSideReliability({
      strategyRoute: 'TREND_CONTINUATION',
      evidence: evidence({
        closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
        profitFactor: 1.4,
        maxDrawdown: 0.04,
      }),
    });
    expect(route.fullSizeEligible).toBe(false);
    expect(evaluatePaperTrendReliabilityExecutionGate({ route, pairSide })).toEqual({
      fullSizeEligible: true,
      pairSideDemoted: false,
      routeDiagnosticOnly: true,
    });
  });

  it('demotes only when the exact pair-side evidence is weak', () => {
    const route = evaluatePaperTrendRouteReliability({
      strategyRoute: 'TREND_CONTINUATION',
      evidence: evidence({ profitFactor: 1.4, maxDrawdown: 0.04 }),
    });
    const pairSide = evaluatePaperTrendPairSideReliability({
      strategyRoute: 'TREND_CONTINUATION',
      evidence: evidence({
        closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
        profitFactor: 0.7,
        maxDrawdown: 0.05,
      }),
    });
    expect(evaluatePaperTrendReliabilityExecutionGate({ route, pairSide })).toEqual({
      fullSizeEligible: false,
      pairSideDemoted: true,
      routeDiagnosticOnly: true,
    });
  });
});

describe('PAPER confirmed-reversal route reliability', () => {
  it('keeps a reversal route collecting until eight compatible episodes exist', () => {
    expect(
      evaluatePaperReversalRouteReliability({
        strategyRoute: 'CONFIRMED_REVERSAL',
        evidence: evidence({
          closedTrades: PAPER_REVERSAL_ROUTE_RELIABILITY_MIN_EPISODES - 1,
          profitFactor: 0.2,
          maxDrawdown: 0.2,
        }),
      }),
    ).toMatchObject({
      state: 'COLLECTING',
      fullSizeEligible: true,
      reason: 'INSUFFICIENT_REVERSAL_ROUTE_EVIDENCE',
    });
  });

  it('demotes a mature losing reversal route', () => {
    expect(
      evaluatePaperReversalRouteReliability({
        strategyRoute: 'CONFIRMED_REVERSAL',
        evidence: evidence({
          closedTrades: PAPER_REVERSAL_ROUTE_RELIABILITY_MIN_EPISODES,
          profitFactor: 0.32,
          maxDrawdown: 0.06,
        }),
      }),
    ).toMatchObject({
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      reason: 'REVERSAL_ROUTE_PROFIT_FACTOR_BELOW_ONE',
    });
  });

  it('blocks an immature reversal pair-side when the mature route is weak', () => {
    const route = evaluatePaperReversalRouteReliability({
      strategyRoute: 'CONFIRMED_REVERSAL',
      evidence: evidence({
        closedTrades: PAPER_REVERSAL_ROUTE_RELIABILITY_MIN_EPISODES,
        profitFactor: 0.32,
        maxDrawdown: 0.06,
      }),
    });
    const pairSide = evaluatePaperTrendPairSideReliability({
      strategyRoute: 'CONFIRMED_REVERSAL',
      evidence: evidence({ closedTrades: 2, profitFactor: 2.0, maxDrawdown: 0.01 }),
    });

    expect(
      evaluatePaperReliabilityExecutionGate({
        strategyRoute: 'CONFIRMED_REVERSAL',
        route,
        pairSide,
      }),
    ).toMatchObject({
      fullSizeEligible: false,
      routeDemoted: true,
      pairSideDemoted: false,
    });
  });

  it('allows a mature healthy reversal pair-side to override a weak aggregate route', () => {
    const route = evaluatePaperReversalRouteReliability({
      strategyRoute: 'CONFIRMED_REVERSAL',
      evidence: evidence({
        closedTrades: PAPER_REVERSAL_ROUTE_RELIABILITY_MIN_EPISODES,
        profitFactor: 0.32,
        maxDrawdown: 0.06,
      }),
    });
    const pairSide = evaluatePaperTrendPairSideReliability({
      strategyRoute: 'CONFIRMED_REVERSAL',
      evidence: evidence({
        closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
        profitFactor: 1.4,
        maxDrawdown: 0.04,
      }),
    });

    expect(
      evaluatePaperReliabilityExecutionGate({
        strategyRoute: 'CONFIRMED_REVERSAL',
        route,
        pairSide,
      }),
    ).toMatchObject({
      fullSizeEligible: true,
      routeDemoted: false,
      pairSideDemoted: false,
    });
  });
});

describe('PAPER realised continuation route reliability', () => {
  const realised = (overrides: Record<string, unknown> = {}) => ({
    closedTrades: PAPER_REALISED_CONTINUATION_ROUTE_RELIABILITY_MIN_TRADES,
    grossProfit: 12,
    grossLoss: 10,
    netPnl: 2,
    ...overrides,
  });

  it('keeps normal PAPER eligible while compatible realised evidence is still collecting', () => {
    expect(
      evaluatePaperRealisedContinuationRouteReliability({
        ...realised({ closedTrades: PAPER_REALISED_CONTINUATION_ROUTE_RELIABILITY_MIN_TRADES - 1 }),
      }),
    ).toMatchObject({
      state: 'COLLECTING',
      fullSizeEligible: true,
      profitFactor: 1.2,
      reason: 'INSUFFICIENT_REALISED_ROUTE_EVIDENCE',
    });
  });

  it('demotes a mature compatible realised continuation route with profit factor below one', () => {
    expect(
      evaluatePaperRealisedContinuationRouteReliability({
        ...realised({ grossProfit: 7, grossLoss: 10, netPnl: -3 }),
      }),
    ).toMatchObject({
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      researchFallbackRequested: true,
      profitFactor: 0.7,
      reason: 'REALISED_ROUTE_PROFIT_FACTOR_BELOW_ONE',
    });
  });

  it('treats a mature all-loss route as weak with zero profit factor', () => {
    expect(
      evaluatePaperRealisedContinuationRouteReliability({
        ...realised({ grossProfit: 0, grossLoss: 10, netPnl: -10 }),
      }),
    ).toMatchObject({
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      profitFactor: 0,
      reason: 'REALISED_ROUTE_PROFIT_FACTOR_BELOW_ONE',
    });
  });

  it('treats a mature positive no-loss route as healthy without inventing a finite PF', () => {
    expect(
      evaluatePaperRealisedContinuationRouteReliability({
        ...realised({ grossProfit: 10, grossLoss: 0, netPnl: 10 }),
      }),
    ).toMatchObject({
      state: 'HEALTHY',
      fullSizeEligible: true,
      profitFactor: null,
      reason: 'REALISED_ROUTE_HEALTHY',
    });
  });

  it('keeps a mature route at PF exactly one eligible', () => {
    expect(
      evaluatePaperRealisedContinuationRouteReliability({
        ...realised({ grossProfit: 10, grossLoss: 10, netPnl: 0 }),
      }),
    ).toMatchObject({ state: 'HEALTHY', fullSizeEligible: true, profitFactor: 1 });
  });
});

describe('PAPER realised continuation execution composition', () => {
  const weakRoute = evaluatePaperRealisedContinuationRouteReliability({
    closedTrades: PAPER_REALISED_CONTINUATION_ROUTE_RELIABILITY_MIN_TRADES,
    grossProfit: 7,
    grossLoss: 10,
    netPnl: -3,
  });

  it('demotes mature weak realised continuation when pair-side evidence is still collecting', () => {
    const pairSide = evaluatePaperTrendPairSideReliability({
      strategyRoute: 'TREND_CONTINUATION',
      evidence: evidence({ closedTrades: 3, profitFactor: 1.8, maxDrawdown: 0.02 }),
    });
    expect(evaluatePaperRealisedContinuationExecutionGate({ route: weakRoute, pairSide })).toEqual({
      fullSizeEligible: false,
      routeDemoted: true,
      matureHealthyPairSideOverride: false,
    });
  });

  it('allows only a mature healthy pair-side to override a mature weak realised route', () => {
    const pairSide = evaluatePaperTrendPairSideReliability({
      strategyRoute: 'TREND_CONTINUATION',
      evidence: evidence({
        closedTrades: PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
        profitFactor: 1.4,
        maxDrawdown: 0.04,
      }),
    });
    expect(evaluatePaperRealisedContinuationExecutionGate({ route: weakRoute, pairSide })).toEqual({
      fullSizeEligible: true,
      routeDemoted: false,
      matureHealthyPairSideOverride: true,
    });
  });

  it('does not demote when the realised route is healthy', () => {
    const route = evaluatePaperRealisedContinuationRouteReliability({
      closedTrades: PAPER_REALISED_CONTINUATION_ROUTE_RELIABILITY_MIN_TRADES,
      grossProfit: 12,
      grossLoss: 10,
      netPnl: 2,
    });
    const pairSide = evaluatePaperTrendPairSideReliability({
      strategyRoute: 'TREND_CONTINUATION',
      evidence: evidence({ closedTrades: 0 }),
    });
    expect(evaluatePaperRealisedContinuationExecutionGate({ route, pairSide })).toEqual({
      fullSizeEligible: true,
      routeDemoted: false,
      matureHealthyPairSideOverride: false,
    });
  });
});
