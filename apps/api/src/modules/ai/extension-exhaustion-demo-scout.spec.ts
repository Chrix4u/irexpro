import { evaluateExtensionExhaustionDemoScout } from './extension-exhaustion-demo-scout';

const reliable = {
  samples: 9,
  wins: 4,
  losses: 5,
  totalNetR: 1.233,
  averageNetR: 0.137,
  profitFactor: 1.235,
  recent3R: 2.186,
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    specialist: {
      candidate: true,
      reason: 'SHADOW_CANDIDATE',
      regime: 'TREND_EXTENDED',
      driftState: 'NORMAL',
      confidence: 0.73,
      netExpectedR: 0.18,
      directionQuality: 0.72,
      executionSpreadEvidenceValid: true,
    },
    eventRisk: 'CLEAR',
    m1Route: 'M1_TREND_CONTINUATION',
    m1Confidence: 0.73,
    m1DirectionQuality: 0.72,
    trainedExpertOpposed: false,
    portfolioSnapshotAvailable: true,
    reliability: reliable,
    ...overrides,
  };
}

describe('evaluateExtensionExhaustionDemoScout', () => {
  it('admits an evidence-qualified DEMO scout at a hard 0.10 lot cap', () => {
    expect(evaluateExtensionExhaustionDemoScout(input() as any)).toMatchObject({
      eligible: true,
      reason: 'EXTENSION_EXHAUSTION_DEMO_SCOUT',
      lotCap: 0.1,
      executionAuthority: 'DEMO_ONLY',
    });
  });

  it('treats zero-loss positive evidence as an infinite-profit-factor sleeve without storing Infinity', () => {
    expect(
      evaluateExtensionExhaustionDemoScout(
        input({
          reliability: {
            ...reliable,
            samples: 6,
            wins: 6,
            losses: 0,
            totalNetR: 6.4,
            averageNetR: 1.0667,
            profitFactor: null,
            recent3R: 3.2,
          },
        }) as any,
      ),
    ).toMatchObject({ eligible: true, reason: 'EXTENSION_EXHAUSTION_DEMO_SCOUT' });
  });

  it.each([
    ['specialist not candidate', { specialist: { ...input().specialist, candidate: false } }, 'SPECIALIST_NOT_CANDIDATE'],
    ['event risk not clear', { eventRisk: 'UNVERIFIED' }, 'EVENT_RISK_NOT_CLEAR'],
    ['wrong M1 route', { m1Route: 'M1_EARLY_TRANSITION' }, 'M1_TIMING_NOT_CONTINUATION'],
    ['weak M1 confidence', { m1Confidence: 0.699 }, 'M1_CONFIDENCE_TOO_LOW'],
    ['weak M1 quality', { m1DirectionQuality: 0.649 }, 'M1_DIRECTION_QUALITY_TOO_LOW'],
    ['expert opposition', { trainedExpertOpposed: true }, 'TRAINED_EXPERT_OPPOSED'],
    ['portfolio unavailable', { portfolioSnapshotAvailable: false }, 'PORTFOLIO_SNAPSHOT_UNAVAILABLE'],
    ['too few samples', { reliability: { ...reliable, samples: 5 } }, 'RELIABILITY_INSUFFICIENT_SAMPLES'],
    ['weak average R', { reliability: { ...reliable, averageNetR: 0.099 } }, 'RELIABILITY_AVERAGE_R_TOO_LOW'],
    ['weak profit factor', { reliability: { ...reliable, profitFactor: 1.149 } }, 'RELIABILITY_PROFIT_FACTOR_TOO_LOW'],
    ['negative recent payoff', { reliability: { ...reliable, recent3R: 0 } }, 'RELIABILITY_RECENT_R_NOT_POSITIVE'],
  ])('blocks %s', (_label, overrides, reason) => {
    expect(evaluateExtensionExhaustionDemoScout(input(overrides as any) as any)).toMatchObject({
      eligible: false,
      reason,
      lotCap: 0,
    });
  });
});
