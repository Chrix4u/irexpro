import {
  evaluateM1MeaningfulScoutReliability,
  M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT,
} from './m1-meaningful-scout-reliability';

const now = new Date('2026-10-24T00:00:00.000Z');

function outcome(minutesAgo: number, netR: number) {
  return { observedAt: new Date(now.getTime() - minutesAgo * 60_000), netR };
}

const healthySix = [
  outcome(10, 0.74),
  outcome(20, 0.44),
  outcome(30, -0.2),
  outcome(40, -0.08),
  outcome(50, 0.46),
  outcome(60, -0.06),
];

describe('M1 meaningful 0.10 scout reliability', () => {
  it('qualifies a mature profitable early-transition pair-side', () => {
    expect(
      evaluateM1MeaningfulScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: now,
        outcomes: healthySix,
      }),
    ).toMatchObject({
      artifact: M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT,
      eligible: true,
      reason: 'POSITIVE_MEANINGFUL_EXPECTANCY',
      samples: 6,
    });
  });

  it('keeps a strong three-sample sleeve shadow-only', () => {
    const decision = evaluateM1MeaningfulScoutReliability({
      route: 'M1_EARLY_TRANSITION',
      evaluatedAt: now,
      outcomes: [outcome(10, 1.5), outcome(20, 0.3), outcome(30, -0.2)],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('INSUFFICIENT_MEANINGFUL_EVIDENCE');
  });

  it('rejects mature evidence whose profit factor is below 1.50', () => {
    const decision = evaluateM1MeaningfulScoutReliability({
      route: 'M1_EARLY_TRANSITION',
      evaluatedAt: now,
      outcomes: [
        outcome(10, 0.4),
        outcome(20, 0.3),
        outcome(30, 0.2),
        outcome(40, -0.7),
        outcome(50, -0.6),
        outcome(60, -0.5),
      ],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('WEAK_MEANINGFUL_EXPECTANCY');
  });

  it('rejects a mature sleeve when latest-three cumulative R is not positive', () => {
    const decision = evaluateM1MeaningfulScoutReliability({
      route: 'M1_EARLY_TRANSITION',
      evaluatedAt: now,
      outcomes: [
        outcome(10, -0.5),
        outcome(20, 0.2),
        outcome(30, 0.2),
        outcome(40, 1.5),
        outcome(50, 1.2),
        outcome(60, 0.8),
      ],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('RECENT_MEANINGFUL_DEGRADATION');
  });

  it('never qualifies M1 trend-continuation or confirmed-reversal', () => {
    for (const route of ['M1_TREND_CONTINUATION', 'M1_CONFIRMED_REVERSAL'] as const) {
      const decision = evaluateM1MeaningfulScoutReliability({
        route,
        evaluatedAt: now,
        outcomes: healthySix,
      });
      expect(decision.eligible).toBe(false);
      expect(decision.reason).toBe('ROUTE_NOT_MEANINGFUL_SCOUT_ELIGIBLE');
    }
  });

  it('ignores future and stale evidence when checking the six-sample minimum', () => {
    const decision = evaluateM1MeaningfulScoutReliability({
      route: 'M1_EARLY_TRANSITION',
      evaluatedAt: now,
      outcomes: [
        ...healthySix.slice(0, 4),
        { observedAt: new Date(now.getTime() + 60_000), netR: 1.5 },
        { observedAt: new Date(now.getTime() - 8 * 24 * 60 * 60_000), netR: 1.5 },
      ],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.samples).toBe(4);
    expect(decision.reason).toBe('INSUFFICIENT_MEANINGFUL_EVIDENCE');
  });
});
