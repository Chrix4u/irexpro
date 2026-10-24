import {
  ADAPTIVE_OPPORTUNITY_WEIGHTS,
  scoreAdaptiveOpportunity,
  type AdaptiveOpportunityInput,
} from './adaptive-opportunity-score';

const base: AdaptiveOpportunityInput = {
  netExpectedR: 0.2,
  estimatedExecutionCostR: 0.15,
  directionQuality: 0.72,
  tradeQuality: 0.68,
  exitQuality: 0.7,
  driftQuality: 1,
  shadowDirectionalPulseQuality: 0.5,
  hardBlockers: [],
  marketState: {
    state: 'TREND_HEALTHY',
    stateConfidence: 0.82,
    canUpsize: true,
  },
  edge: {
    available: true,
    maturity: 'MATURE',
    smoothedExpectedR: 0.25,
    smoothedWinRate: 0.62,
    profitFactor: 1.5,
    maxDrawdown: 0.06,
    recentDegradation: false,
  },
  exposure: {
    capacity: 'CLEAR',
    diversificationQuality: 0.9,
    correlatedExposureScore: 0.1,
    riskEvidenceComplete: true,
  },
};

describe('scoreAdaptiveOpportunity', () => {
  it('uses the exact approved component weights summing to one', () => {
    expect(ADAPTIVE_OPPORTUNITY_WEIGHTS).toEqual({
      netExpectedR: 0.24,
      regimeFit: 0.14,
      directionQuality: 0.11,
      tradeQuality: 0.1,
      exitQuality: 0.08,
      edgeQuality: 0.08,
      shadowDirectionalPulseQuality: 0.05,
      executionCostQuality: 0.08,
      diversificationQuality: 0.07,
      stabilityQuality: 0.05,
    });
    expect(Object.values(ADAPTIVE_OPPORTUNITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(
      1,
      12,
    );
  });

  it('never lowers the score when authoritative net expected R improves', () => {
    const weak = scoreAdaptiveOpportunity({ ...base, netExpectedR: 0.08 });
    const strong = scoreAdaptiveOpportunity({ ...base, netExpectedR: 0.32 });
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it('never improves the score when authoritative execution cost worsens', () => {
    const cheap = scoreAdaptiveOpportunity({ ...base, estimatedExecutionCostR: 0.08 });
    const expensive = scoreAdaptiveOpportunity({ ...base, estimatedExecutionCostR: 0.45 });
    expect(expensive.score).toBeLessThan(cheap.score);
  });

  it('uses the causal shadow pulse only to rank the currently supported side', () => {
    const supported = scoreAdaptiveOpportunity({ ...base, shadowDirectionalPulseQuality: 0.9 });
    const neutral = scoreAdaptiveOpportunity({ ...base, shadowDirectionalPulseQuality: 0.5 });
    const opposed = scoreAdaptiveOpportunity({ ...base, shadowDirectionalPulseQuality: 0.1 });

    expect(supported.score).toBeGreaterThan(neutral.score);
    expect(neutral.score).toBeGreaterThan(opposed.score);
    expect(supported.reasons).toContain('SHADOW_DIRECTION_SUPPORTED');
    expect(opposed.reasons).toContain('SHADOW_DIRECTION_OPPOSED');
  });

  it('treats a missing shadow pulse as neutral for backwards-compatible callers', () => {
    const explicitNeutral = scoreAdaptiveOpportunity({ ...base, shadowDirectionalPulseQuality: 0.5 });
    const missing = scoreAdaptiveOpportunity({
      ...base,
      shadowDirectionalPulseQuality: undefined,
    });
    expect(missing.components.shadowDirectionalPulseQuality).toBe(0.5);
    expect(missing.score).toBeCloseTo(explicitNeutral.score, 12);
  });

  it('penalizes degraded evidence and shared-currency concentration', () => {
    const healthy = scoreAdaptiveOpportunity(base);
    const degraded = scoreAdaptiveOpportunity({
      ...base,
      edge: { ...base.edge, maturity: 'DEGRADED', recentDegradation: true },
      exposure: {
        ...base.exposure,
        capacity: 'REDUCED',
        diversificationQuality: 0.35,
        correlatedExposureScore: 0.65,
      },
    });
    expect(degraded.score).toBeLessThan(healthy.score);
    expect(degraded.reasons).toContain('EDGE_DEGRADED');
    expect(degraded.reasons).toContain('PORTFOLIO_CAPACITY_REDUCED');
  });

  it('treats unavailable edge evidence as neutral/downside-only rather than positive evidence', () => {
    const unavailable = scoreAdaptiveOpportunity({
      ...base,
      edge: {
        ...base.edge,
        available: false,
        maturity: 'SPARSE',
        smoothedExpectedR: 0,
        smoothedWinRate: 0.5,
        profitFactor: null,
        maxDrawdown: null,
      },
    });
    const mature = scoreAdaptiveOpportunity(base);
    expect(unavailable.components.edgeQuality).toBeLessThanOrEqual(0.5);
    expect(unavailable.score).toBeLessThan(mature.score);
    expect(unavailable.reasons).toContain('EDGE_EVIDENCE_UNAVAILABLE');
  });

  it('carries hard blockers through verbatim and the pulse never clears them', () => {
    const result = scoreAdaptiveOpportunity({
      ...base,
      shadowDirectionalPulseQuality: 1,
      hardBlockers: ['PAPER_NET_EXPECTED_R', 'DRIFT_OUT_OF_DISTRIBUTION'],
    });
    expect(result.hardBlockers).toEqual(['PAPER_NET_EXPECTED_R', 'DRIFT_OUT_OF_DISTRIBUTION']);
    expect(result.executionEligible).toBe(false);
    expect(result.reasons).toContain('HARD_GOVERNANCE_BLOCKED');
  });
});
