import { evaluateM1TacticalExpectancy } from './m1-tactical-expectancy';
import type { M1RoutePairSideReliabilityDecision } from './m1-tactical-reliability';

function reliability(
  overrides: Partial<M1RoutePairSideReliabilityDecision> = {},
): M1RoutePairSideReliabilityDecision {
  return {
    eligible: true,
    samples: 0,
    currentPolicySamples: 0,
    carriedSamples: 0,
    wins: 0,
    losses: 0,
    smoothedWinRate: 0.5,
    smoothedExpectedR: 0.3,
    realizedRSamples: 0,
    averageRealizedR: null,
    recentRealizedR: null,
    recentPayoffRSamples: 0,
    recentPayoffAverageR: null,
    reason: 'INSUFFICIENT_EVIDENCE',
    consideredPolicyVersions: ['m1-tactical-v1'],
    ...overrides,
  };
}

const base = {
  targetR: 1.6,
  confidence: 0.7,
  directionQuality: 0.7,
};

describe('M1 tactical statistical expectancy', () => {
  it('separates predictive edge from identical target geometry', () => {
    const stronger = evaluateM1TacticalExpectancy({
      ...base,
      confidence: 0.74,
      directionQuality: 0.78,
      reliability: null,
    });
    const weaker = evaluateM1TacticalExpectancy({
      ...base,
      confidence: 0.58,
      directionQuality: 0.54,
      reliability: null,
    });

    expect(stronger.targetR).toBe(1.6);
    expect(weaker.targetR).toBe(1.6);
    expect(stronger.statisticalExpectedR).toBeGreaterThan(weaker.statisticalExpectedR);
    expect(stronger.statisticalExpectedR).toBeLessThan(0.5);
    expect(weaker.statisticalExpectedR).toBeLessThan(0.15);
  });

  it('maps neutral heuristic quality close to breakeven expectancy', () => {
    const result = evaluateM1TacticalExpectancy({
      ...base,
      confidence: 0.5,
      directionQuality: 0.5,
      reliability: null,
    });

    expect(result.statisticalExpectedR).toBeCloseTo(0, 8);
  });

  it('shrinks mature evidence toward actual realised R', () => {
    const positive = evaluateM1TacticalExpectancy({
      ...base,
      reliability: reliability({
        samples: 8,
        wins: 5,
        losses: 3,
        realizedRSamples: 8,
        averageRealizedR: 0.35,
        reason: 'POSITIVE_EXPECTANCY',
      }),
    });
    const negative = evaluateM1TacticalExpectancy({
      ...base,
      reliability: reliability({
        eligible: false,
        samples: 8,
        wins: 2,
        losses: 6,
        realizedRSamples: 8,
        averageRealizedR: -0.4,
        reason: 'NEGATIVE_EXPECTANCY',
      }),
    });

    expect(positive.statisticalExpectedR).toBeGreaterThan(0.2);
    expect(negative.statisticalExpectedR).toBeLessThan(0);
    expect(positive.source).toBe('REALISED_PAIR_SIDE');
    expect(negative.source).toBe('REALISED_PAIR_SIDE');
  });

  it('lets latest-five payoff decay reduce otherwise positive long-window expectancy', () => {
    const stable = evaluateM1TacticalExpectancy({
      ...base,
      reliability: reliability({
        samples: 10,
        realizedRSamples: 10,
        averageRealizedR: 0.3,
        recentPayoffRSamples: 5,
        recentPayoffAverageR: 0.2,
        reason: 'POSITIVE_EXPECTANCY',
      }),
    });
    const decayed = evaluateM1TacticalExpectancy({
      ...base,
      reliability: reliability({
        eligible: false,
        samples: 10,
        realizedRSamples: 10,
        averageRealizedR: 0.3,
        recentPayoffRSamples: 5,
        recentPayoffAverageR: -0.5,
        reason: 'RECENT_NEGATIVE_PAYOFF',
      }),
    });

    expect(decayed.statisticalExpectedR).toBeLessThan(stable.statisticalExpectedR);
    expect(decayed.recentPayoffApplied).toBe(true);
  });

  it('fails conservative and finite when evidence contains invalid numbers', () => {
    const result = evaluateM1TacticalExpectancy({
      targetR: Number.NaN,
      confidence: Number.POSITIVE_INFINITY,
      directionQuality: Number.NaN,
      reliability: reliability({
        realizedRSamples: 5,
        averageRealizedR: Number.NaN,
        recentPayoffRSamples: 5,
        recentPayoffAverageR: Number.POSITIVE_INFINITY,
      }),
    });

    expect(Number.isFinite(result.statisticalExpectedR)).toBe(true);
    expect(Number.isFinite(result.impliedWinProbability)).toBe(true);
    expect(result.statisticalExpectedR).toBeLessThanOrEqual(0);
  });
});
