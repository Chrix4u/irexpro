import { evaluateM5EarlyTransitionHandoff } from './m5-early-transition-handoff';

const NOW = new Date('2026-10-29T17:10:00.000Z');

function input(overrides: Record<string, unknown> = {}) {
  return {
    decisionTime: NOW,
    m5Evidence: {
      instrument: 'USDCHF',
      direction: 'BUY' as const,
      marketBarTime: new Date('2026-10-29T17:05:00.000Z'),
      evaluatedAt: new Date('2026-10-29T17:09:00.000Z'),
      strategyRoute: 'EARLY_TRANSITION' as const,
      paperAdmitted: true,
      paperExecutionEligible: true,
      eventRisk: 'CLEAR' as const,
      driftState: 'NORMAL' as const,
      netExpectedR: 0.252,
      ensembleScore: 0.61,
      consensusPassed: 7,
      consensusRequired: 6,
    },
    m1Route: 'M1_TREND_CONTINUATION' as const,
    m1Reason: 'TREND_STRUCTURE_ALIGNED',
    m1Confidence: 0.684,
    m1DirectionQuality: 0.617,
    m1ExecutionCostUsable: true,
    m1EventRisk: 'CLEAR' as const,
    ...overrides,
  };
}

describe('evaluateM5EarlyTransitionHandoff', () => {
  it('admits a fresh normal-drift M5 early transition when cTrader M1 independently confirms the same direction', () => {
    expect(evaluateM5EarlyTransitionHandoff(input() as any)).toEqual({
      eligible: true,
      reason: 'M5_EARLY_TRANSITION_M1_CONFIRMED_PROBE',
      lotCap: 0.2,
    });
  });

  it('admits a strong non-opposed M1 abstain as a capped probe instead of requiring identical route labels', () => {
    expect(
      evaluateM5EarlyTransitionHandoff(
        input({
          m1Route: 'ABSTAIN',
          m1Reason: 'HIGHER_TIMEFRAME_CONFLICT',
          m1Confidence: 0.738,
          m1DirectionQuality: 0.696,
        }) as any,
      ),
    ).toEqual({
      eligible: true,
      reason: 'M5_EARLY_TRANSITION_M1_STRONG_NON_OPPOSED_PROBE',
      lotCap: 0.2,
    });
  });

  it.each([
    [
      'stale M5 evidence',
      {
        m5Evidence: { ...input().m5Evidence, marketBarTime: new Date('2026-10-29T17:00:00.000Z') },
      },
    ],
    [
      'M5 high-impact event risk',
      { m5Evidence: { ...input().m5Evidence, eventRisk: 'HIGH_IMPACT_BLOCK' } },
    ],
    [
      'M5 non-normal drift',
      { m5Evidence: { ...input().m5Evidence, driftState: 'OUT_OF_DISTRIBUTION' } },
    ],
    ['M5 low expectancy', { m5Evidence: { ...input().m5Evidence, netExpectedR: 0.19 } }],
    ['M5 paper admission failure', { m5Evidence: { ...input().m5Evidence, paperAdmitted: false } }],
    [
      'M5 governance failure',
      { m5Evidence: { ...input().m5Evidence, paperExecutionEligible: false } },
    ],
    ['M5 weak consensus', { m5Evidence: { ...input().m5Evidence, consensusPassed: 5 } }],
    ['M1 execution cost unusable', { m1ExecutionCostUsable: false }],
    ['M1 high-impact event risk', { m1EventRisk: 'HIGH_IMPACT_BLOCK' }],
    [
      'M1 weak abstain',
      {
        m1Route: 'ABSTAIN',
        m1Reason: 'NO_VALID_ROUTE',
        m1Confidence: 0.64,
        m1DirectionQuality: 0.49,
      },
    ],
    [
      'M1 ambiguous direction edge',
      {
        m1Route: 'ABSTAIN',
        m1Reason: 'DIRECTION_EDGE_TOO_SMALL',
        m1Confidence: 0.74,
        m1DirectionQuality: 0.7,
      },
    ],
  ])('blocks %s', (_label, overrides) => {
    expect(evaluateM5EarlyTransitionHandoff(input(overrides as any) as any).eligible).toBe(false);
  });
});
