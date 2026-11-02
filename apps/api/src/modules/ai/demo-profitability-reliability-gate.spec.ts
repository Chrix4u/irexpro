import { evaluateDemoProfitabilityReliabilityGate } from './demo-profitability-reliability-gate';

describe('evaluateDemoProfitabilityReliabilityGate', () => {
  it('hard-vetoes broker execution for an M1 EARLY_LOSS_STREAK', () => {
    expect(
      evaluateDemoProfitabilityReliabilityGate({
        m1Route: 'M1_TREND_CONTINUATION',
        m1ReliabilityReason: 'EARLY_LOSS_STREAK',
        pairSideReliability: null,
      }),
    ).toEqual({
      executable: false,
      blockers: ['M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK'],
      lossStreakVeto: true,
      degradedEarlyTransitionVeto: false,
    });
  });

  it.each([
    'WEAK_MEANINGFUL_EXPECTANCY',
    'RECENT_MEANINGFUL_DEGRADATION',
    'WEAK_PROVISIONAL_EXPECTANCY',
    'RECENT_PROVISIONAL_DEGRADATION',
  ])('vetoes M1 early transition when pair-side reliability is %s', (reason) => {
    const result = evaluateDemoProfitabilityReliabilityGate({
      m1Route: 'M1_EARLY_TRANSITION',
      m1ReliabilityReason: 'INSUFFICIENT_EVIDENCE',
      pairSideReliability: { eligible: false, reason },
    });

    expect(result.executable).toBe(false);
    expect(result.degradedEarlyTransitionVeto).toBe(true);
    expect(result.blockers).toContain('M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED');
  });

  it('preserves healthy M1 early-transition execution', () => {
    expect(
      evaluateDemoProfitabilityReliabilityGate({
        m1Route: 'M1_EARLY_TRANSITION',
        m1ReliabilityReason: 'POSITIVE_EXPECTANCY',
        pairSideReliability: { eligible: true, reason: 'POSITIVE_MEANINGFUL_EXPECTANCY' },
      }).executable,
    ).toBe(true);
  });

  it('does not apply the early-transition pair-side veto to trend continuation', () => {
    expect(
      evaluateDemoProfitabilityReliabilityGate({
        m1Route: 'M1_TREND_CONTINUATION',
        m1ReliabilityReason: 'POSITIVE_EXPECTANCY',
        pairSideReliability: { eligible: false, reason: 'RECENT_MEANINGFUL_DEGRADATION' },
      }).executable,
    ).toBe(true);
  });

  it('does not invent a blocker when reliability evidence is missing', () => {
    expect(
      evaluateDemoProfitabilityReliabilityGate({
        m1Route: 'M1_EARLY_TRANSITION',
        m1ReliabilityReason: null,
        pairSideReliability: null,
      }),
    ).toEqual({
      executable: true,
      blockers: [],
      lossStreakVeto: false,
      degradedEarlyTransitionVeto: false,
    });
  });
});
