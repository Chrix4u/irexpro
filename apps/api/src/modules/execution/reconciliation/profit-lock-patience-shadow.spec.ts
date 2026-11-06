import {
  evaluateProfitLockPatienceShadow,
  type ProfitLockPatienceShadowInput,
} from './profit-lock-patience-shadow';

const observedAt = new Date('2026-11-06T12:52:16.375Z');
const base = (): ProfitLockPatienceShadowInput => ({
  direction: 'SELL',
  observedAt,
  currentGrossPnl: 7.89,
  maxFavorablePnl: 10.15,
  initialRiskPnl: 8.05419578,
  latestSameSideM1ContinuationAt: new Date('2026-11-06T12:50:00Z'),
  oppositeExecutableReversal: false,
  m1Evidence: {
    completedBars: 3,
    liveQuoteBars: 3,
    latestAgeSeconds: 16.375,
    adverseBars: 1,
    alignedLatestBodyPressure: -0.1,
    alignedMomentum3: -0.0454545454,
  },
});

describe('profit-lock patience shadow', () => {
  it('recognizes the November 6 in-position continuation without granting new-entry permission', () => {
    const outcome = evaluateProfitLockPatienceShadow(base());
    expect(outcome).toMatchObject({
      mode: 'SHADOW_ONLY',
      wouldConsiderBrokerProtectedGrace: true,
      reason: 'PROTECTED_GRACE_RESEARCH_CANDIDATE',
      maxGraceSeconds: 180,
      requiresVerifiedBrokerProfitStop: true,
      noTradeAuthority: true,
      modifiesExecution: false,
    });
  });

  it('closes when an executable opposing reversal is already confirmed', () => {
    expect(
      evaluateProfitLockPatienceShadow({
        ...base(),
        oppositeExecutableReversal: true,
      }),
    ).toMatchObject({
      wouldConsiderBrokerProtectedGrace: false,
      reason: 'EXECUTABLE_OPPOSITE_REVERSAL',
    });
  });

  it('rejects severely adverse independently quoted M1 pressure', () => {
    expect(
      evaluateProfitLockPatienceShadow({
        ...base(),
        m1Evidence: {
          ...base().m1Evidence!,
          adverseBars: 2,
          alignedLatestBodyPressure: -0.6,
          alignedMomentum3: -0.3,
        },
      }),
    ).toMatchObject({
      wouldConsiderBrokerProtectedGrace: false,
      reason: 'STRONG_ADVERSE_M1_CONFIRMATION',
    });
  });

  it('does not use a future SELL confirmation or an old stale signal', () => {
    expect(
      evaluateProfitLockPatienceShadow({
        ...base(),
        latestSameSideM1ContinuationAt: new Date('2026-11-06T12:53:00Z'),
      }),
    ).toMatchObject({ reason: 'NO_RECENT_SAME_SIDE_CONTINUATION' });
    expect(
      evaluateProfitLockPatienceShadow({
        ...base(),
        latestSameSideM1ContinuationAt: new Date('2026-11-06T12:48:00Z'),
      }),
    ).toMatchObject({ reason: 'NO_RECENT_SAME_SIDE_CONTINUATION' });
  });

  it('rejects missing live quotes, invalid risk and forfeited profits', () => {
    expect(
      evaluateProfitLockPatienceShadow({
        ...base(),
        m1Evidence: { ...base().m1Evidence!, liveQuoteBars: 0 },
      }),
    ).toMatchObject({ reason: 'LIVE_M1_QUOTES_INSUFFICIENT' });
    expect(
      evaluateProfitLockPatienceShadow({
        ...base(),
        initialRiskPnl: 0,
      }),
    ).toMatchObject({ reason: 'INVALID_INITIAL_RISK_OR_PROFIT' });
    expect(
      evaluateProfitLockPatienceShadow({
        ...base(),
        currentGrossPnl: 2,
      }),
    ).toMatchObject({ reason: 'INSUFFICIENT_RETAINED_PROFIT' });
  });
});
