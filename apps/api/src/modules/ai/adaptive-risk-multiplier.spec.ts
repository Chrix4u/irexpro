import {
  selectAdaptiveRiskMultiplier,
  type AdaptiveRiskMultiplierInput,
} from './adaptive-risk-multiplier';

const base: AdaptiveRiskMultiplierInput = {
  executionRoute: 'NORMAL_PAPER',
  opportunityScore: 0.78,
  netExpectedR: 0.18,
  executionCostUsable: true,
  hardBlockers: [],
  marketState: { state: 'TREND_HEALTHY', canUpsize: true, session: 'LONDON' },
  edge: {
    available: true,
    maturity: 'MATURE',
    smoothedExpectedR: 0.22,
    profitFactor: 1.5,
    maxDrawdown: 0.06,
    recentDegradation: false,
    canUpsize: true,
  },
  exposure: { capacity: 'CLEAR', canUpsize: true, riskEvidenceComplete: true },
};

describe('selectAdaptiveRiskMultiplier', () => {
  it('never upsizes research execution routes', () => {
    for (const route of [
      'PAPER_RESEARCH_THROUGHPUT',
      'PAIRED_REVERSAL_RESEARCH',
      'REJECTED_EDGE_CANARY',
    ] as const) {
      const decision = selectAdaptiveRiskMultiplier({
        ...base,
        executionRoute: route,
        opportunityScore: 0.99,
        netExpectedR: 0.5,
      });
      expect(decision.multiplier).toBeLessThanOrEqual(1);
      expect(decision.canUpsize).toBe(false);
    }
  });

  it('starts extension-exhaustion PAPER research at exactly half normal adaptive risk', () => {
    const decision = selectAdaptiveRiskMultiplier({
      ...base,
      executionRoute: 'PAPER_EXTENSION_EXHAUSTION_RESEARCH',
      opportunityScore: 0.99,
      netExpectedR: 0.3,
    });
    expect(decision.multiplier).toBe(0.5);
    expect(decision.canUpsize).toBe(false);
    expect(decision.executionEligible).toBe(true);
    expect(decision.reasons).toContain('EXTENSION_EXHAUSTION_RESEARCH_HALF_RISK');
  });

  it('never upsizes sparse, degraded, dislocated, rollover, high-volatility or invalid-cost evidence', () => {
    const cases: AdaptiveRiskMultiplierInput[] = [
      { ...base, edge: { ...base.edge, maturity: 'SPARSE', canUpsize: false } },
      {
        ...base,
        edge: { ...base.edge, maturity: 'DEGRADED', recentDegradation: true, canUpsize: false },
      },
      { ...base, marketState: { ...base.marketState, state: 'DISLOCATED', canUpsize: false } },
      {
        ...base,
        marketState: {
          ...base.marketState,
          state: 'ROLLOVER_RISK',
          session: 'ROLLOVER',
          canUpsize: false,
        },
      },
      { ...base, marketState: { ...base.marketState, state: 'HIGH_VOLATILITY', canUpsize: false } },
      { ...base, executionCostUsable: false },
    ];
    for (const input of cases)
      expect(selectAdaptiveRiskMultiplier(input).multiplier).toBeLessThanOrEqual(1);
  });

  it('allows 1.10x for mature positive normal PAPER edge', () => {
    const decision = selectAdaptiveRiskMultiplier(base);
    expect(decision.multiplier).toBe(1.1);
    expect(decision.canUpsize).toBe(true);
  });

  it('allows 1.25x only for exceptional mature positive normal PAPER edge', () => {
    const decision = selectAdaptiveRiskMultiplier({
      ...base,
      opportunityScore: 0.9,
      netExpectedR: 0.28,
    });
    expect(decision.multiplier).toBe(1.25);
    expect(decision.canUpsize).toBe(true);
  });

  it('downsizes degraded or concentrated but otherwise permitted trades', () => {
    expect(
      selectAdaptiveRiskMultiplier({
        ...base,
        edge: { ...base.edge, maturity: 'DEGRADED', recentDegradation: true, canUpsize: false },
      }).multiplier,
    ).toBe(0.5);
    expect(
      selectAdaptiveRiskMultiplier({
        ...base,
        exposure: { capacity: 'REDUCED', canUpsize: false, riskEvidenceComplete: true },
      }).multiplier,
    ).toBe(0.75);
  });

  it('keeps otherwise eligible research at the 0.75x risk band instead of collapsing productive evidence collection to 0.50x', () => {
    const decision = selectAdaptiveRiskMultiplier({
      ...base,
      executionRoute: 'PAPER_RESEARCH_THROUGHPUT',
      marketState: { ...base.marketState, state: 'DISLOCATED', canUpsize: false },
      edge: { ...base.edge, maturity: 'SPARSE', canUpsize: false },
    });
    expect(decision.multiplier).toBe(0.75);
    expect(decision.canUpsize).toBe(false);
    expect(decision.executionEligible).toBe(true);
    expect(decision.reasons).toContain('RESEARCH_UPSIZE_DISABLED');
  });

  it('caps still-eligible research at 0.50x when pair-side expectancy deteriorates after multiple outcomes', () => {
    const input = {
      ...base,
      executionRoute: 'PAPER_RESEARCH_THROUGHPUT' as const,
      marketState: { ...base.marketState, state: 'DISLOCATED' as const, canUpsize: false },
      edge: { ...base.edge, maturity: 'SPARSE' as const, canUpsize: false },
      researchPairSideReliability: {
        eligible: true,
        samples: 3,
        smoothedExpectedR: 0.0666666667,
        reason: 'INSUFFICIENT_EVIDENCE' as const,
      },
    };

    const decision = selectAdaptiveRiskMultiplier(input);

    expect(decision.multiplier).toBe(0.5);
    expect(decision.canUpsize).toBe(false);
    expect(decision.executionEligible).toBe(true);
    expect(decision.reasons).toContain('PAIR_SIDE_RELIABILITY_DERISK');
  });

  it('does not overreact to one isolated pair-side loss', () => {
    const input = {
      ...base,
      executionRoute: 'PAPER_RESEARCH_THROUGHPUT' as const,
      marketState: { ...base.marketState, state: 'DISLOCATED' as const, canUpsize: false },
      edge: { ...base.edge, maturity: 'SPARSE' as const, canUpsize: false },
      researchPairSideReliability: {
        eligible: true,
        samples: 1,
        smoothedExpectedR: -0.1111111111,
        reason: 'INSUFFICIENT_EVIDENCE' as const,
      },
    };

    expect(selectAdaptiveRiskMultiplier(input).multiplier).toBe(0.75);
  });

  it('never applies the research pair-side soft cap to normal PAPER', () => {
    const input = {
      ...base,
      researchPairSideReliability: {
        eligible: true,
        samples: 3,
        smoothedExpectedR: 0.0666666667,
        reason: 'INSUFFICIENT_EVIDENCE' as const,
      },
    };

    expect(selectAdaptiveRiskMultiplier(input).multiplier).toBe(1.1);
  });

  it('keeps the 0.50x band for genuinely degraded research evidence', () => {
    const decision = selectAdaptiveRiskMultiplier({
      ...base,
      executionRoute: 'PAPER_RESEARCH_THROUGHPUT',
      edge: { ...base.edge, maturity: 'DEGRADED', recentDegradation: true, canUpsize: false },
    });
    expect(decision.multiplier).toBe(0.5);
  });

  it('does not use a multiplier to bypass hard governance blockers', () => {
    const decision = selectAdaptiveRiskMultiplier({
      ...base,
      hardBlockers: ['PAPER_NET_EXPECTED_R'],
    });
    expect(decision.multiplier).toBe(0.5);
    expect(decision.executionEligible).toBe(false);
    expect(decision.hardBlockers).toEqual(['PAPER_NET_EXPECTED_R']);
  });
});
