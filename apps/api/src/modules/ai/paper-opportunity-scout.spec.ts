import { evaluatePaperOpportunityScout } from './paper-opportunity-scout';

describe('PAPER opportunity scout', () => {
  const base = {
    normalPaperExecution: false,
    strategyRoute: 'TREND_CONTINUATION' as const,
    regime: 'TREND_HEALTHY' as const,
    confidence: 0.66,
    consensusPassed: 4,
    consensusRequired: 6,
    netExpectedR: 0.14,
    directionQuality: 0.42,
    tradeQuality: 0.42,
    exitQuality: 0.42,
    alignedMomentumAtr: 0.28,
    paperExecutionCostUsable: true,
    eventRisk: 'CLEAR' as const,
    portfolioQuality: 0.8,
    driftState: 'STRESSED' as const,
  };

  it('takes a reduced-risk positive-edge trend opportunity that misses two soft votes', () => {
    expect(evaluatePaperOpportunityScout(base)).toEqual({
      eligible: true,
      reason: 'OPPORTUNITY_SCOUT',
      lotUpperBound: 0.05,
      sizingTier: 'RESEARCH',
    });
  });

  it('can scout a bounded out-of-distribution trend only with stronger evidence', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        driftState: 'OUT_OF_DISTRIBUTION',
        confidence: 0.65,
        consensusPassed: 5,
        netExpectedR: 0.16,
      }),
    ).toMatchObject({ eligible: true, reason: 'OPPORTUNITY_SCOUT' });
  });

  it('does not reopen the deteriorated confirmed-reversal route', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        strategyRoute: 'CONFIRMED_REVERSAL',
        regime: 'REVERSAL_CONFIRMED',
        confidence: 0.72,
        consensusPassed: 6,
        netExpectedR: 0.3,
      }),
    ).toMatchObject({ eligible: false, reason: 'ROUTE_NOT_SCOUTABLE' });
  });

  it('requires real positive economics and hard safety evidence', () => {
    expect(evaluatePaperOpportunityScout({ ...base, netExpectedR: 0.079 })).toMatchObject({
      eligible: false,
      reason: 'NET_EXPECTED_R_TOO_LOW',
    });
    expect(evaluatePaperOpportunityScout({ ...base, eventRisk: 'UNVERIFIED' })).toMatchObject({
      eligible: false,
      reason: 'EVENT_RISK_NOT_CLEAR',
    });
    expect(
      evaluatePaperOpportunityScout({ ...base, paperExecutionCostUsable: false }),
    ).toMatchObject({
      eligible: false,
      reason: 'EXECUTION_COST_UNUSABLE',
    });
  });
});
