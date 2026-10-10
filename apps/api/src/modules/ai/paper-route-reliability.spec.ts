import {
  PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES,
  PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES,
  evaluatePaperTrendPairSideReliabilityShadow,
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
  it('is observational only and does not apply to non-continuation routes', () => {
    expect(
      evaluatePaperTrendPairSideReliabilityShadow({
        strategyRoute: 'CONFIRMED_REVERSAL',
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
