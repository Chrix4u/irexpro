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
