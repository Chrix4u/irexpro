import { evaluateM1ShadowPairSideReliability } from './m1-shadow-pair-side-reliability';

describe('M1 causal shadow pair-side reliability', () => {
  const at = new Date('2026-10-23T19:55:00.000Z');
  const row = (minutesAgo: number, netR: number) => ({
    observedAt: new Date(at.getTime() - minutesAgo * 60_000),
    netR,
  });

  it('qualifies a profitable early-transition pair-side at micro scale', () => {
    expect(
      evaluateM1ShadowPairSideReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: at,
        outcomes: [row(180, 1.5), row(600, 0.225), row(900, -0.195)],
      }),
    ).toMatchObject({ eligible: true, reason: 'POSITIVE_SHADOW_EXPECTANCY', samples: 3 });
  });

  it('fails closed with fewer than three causal outcomes', () => {
    expect(
      evaluateM1ShadowPairSideReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: at,
        outcomes: [row(30, 0.7), row(60, 0.4)],
      }),
    ).toMatchObject({ eligible: false, reason: 'INSUFFICIENT_SHADOW_EVIDENCE' });
  });

  it('blocks weak payoff even when total R is positive', () => {
    expect(
      evaluateM1ShadowPairSideReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: at,
        outcomes: [row(30, 0.2), row(60, 0.2), row(90, -0.3), row(120, -0.05)],
      }),
    ).toMatchObject({ eligible: false, reason: 'WEAK_SHADOW_EXPECTANCY' });
  });

  it('brakes after three latest non-positive outcomes', () => {
    expect(
      evaluateM1ShadowPairSideReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt: at,
        outcomes: [row(10, -0.1), row(20, -0.2), row(30, -0.3), row(300, 2.0)],
      }),
    ).toMatchObject({ eligible: false, reason: 'RECENT_SHADOW_LOSS_STREAK' });
  });

  it('never qualifies another M1 route', () => {
    expect(
      evaluateM1ShadowPairSideReliability({
        route: 'M1_TREND_CONTINUATION',
        evaluatedAt: at,
        outcomes: [row(30, 1), row(60, 1), row(90, 1)],
      }),
    ).toMatchObject({ eligible: false, reason: 'ROUTE_NOT_MICRO_ELIGIBLE' });
  });
});
