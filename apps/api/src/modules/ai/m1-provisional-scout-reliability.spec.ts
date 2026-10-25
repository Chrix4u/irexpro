import { evaluateM1ProvisionalScoutReliability } from './m1-provisional-scout-reliability';

const now = new Date('2026-10-25T12:00:00.000Z');
const outcome = (minutesAgo: number, netR: number) => ({
  observedAt: new Date(now.getTime() - minutesAgo * 60_000),
  netR,
});

describe('M1 provisional 0.05 scout reliability', () => {
  it('qualifies an exceptionally strong three-sample early-transition sleeve', () => {
    expect(
      evaluateM1ProvisionalScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: now,
        outcomes: [outcome(10, 1.5), outcome(20, 0.3), outcome(30, -0.2)],
      }),
    ).toMatchObject({ eligible: true, tier: 'PROVISIONAL', samples: 3, lotCap: 0.05 });
  });

  it('never qualifies fewer than three samples', () => {
    expect(
      evaluateM1ProvisionalScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: now,
        outcomes: [outcome(10, 1.5), outcome(20, 0.3)],
      }),
    ).toMatchObject({ eligible: false, reason: 'INSUFFICIENT_PROVISIONAL_EVIDENCE' });
  });

  it('defers six or more samples to the mature evaluator', () => {
    expect(
      evaluateM1ProvisionalScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: now,
        outcomes: [1.0, 0.6, 0.4, -0.1, 0.3, -0.1].map((r, i) => outcome((i + 1) * 10, r)),
      }),
    ).toMatchObject({ eligible: false, reason: 'MATURE_EVIDENCE_AVAILABLE' });
  });

  it('blocks weak payoff, recent degradation, and unsupported routes', () => {
    expect(
      evaluateM1ProvisionalScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: now,
        outcomes: [outcome(10, 0.4), outcome(20, 0.2), outcome(30, -0.4)],
      }).eligible,
    ).toBe(false);
    expect(
      evaluateM1ProvisionalScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: now,
        outcomes: [outcome(10, -0.8), outcome(20, 0.3), outcome(30, 0.2)],
      }),
    ).toMatchObject({ eligible: false, reason: 'RECENT_PROVISIONAL_DEGRADATION' });
    expect(
      evaluateM1ProvisionalScoutReliability({
        route: 'M1_TREND_CONTINUATION',
        evaluatedAt: now,
        outcomes: [outcome(10, 1.5), outcome(20, 0.3), outcome(30, -0.2)],
      }),
    ).toMatchObject({ eligible: false, reason: 'ROUTE_NOT_PROVISIONAL_SCOUT_ELIGIBLE' });
  });

  it('ignores stale and future rows before counting the sample band', () => {
    expect(
      evaluateM1ProvisionalScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: now,
        outcomes: [
          outcome(10, 1.5),
          outcome(20, 0.3),
          { observedAt: new Date(now.getTime() + 60_000), netR: 1.0 },
          { observedAt: new Date(now.getTime() - 8 * 24 * 60 * 60_000), netR: 1.0 },
        ],
      }),
    ).toMatchObject({ eligible: false, samples: 2 });
  });
});
