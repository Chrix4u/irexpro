import {
  evaluateM1ReversalTimingFusionShadow,
  M1_REVERSAL_TIMING_FUSION_SHADOW_ARTIFACT,
  type M1ReversalFusionCandidate,
} from './m1-reversal-timing-fusion-shadow';

const base: M1ReversalFusionCandidate = {
  instrument: 'USDJPY',
  direction: 'SELL',
  decisionTime: new Date('2026-11-10T18:05:00Z'),
  directionQuality: 0.7,
  alignedMomentum1Atr: 0.6,
  alignedMomentum3Atr: 0.7,
  alignedMomentum5Atr: 0.4,
  alignedEmaSlopeAtr: 0.18,
  alignedM5BodyPressure3: 0.35,
  alignedM5Momentum3Atr: 0.45,
  alignedM5Momentum1Atr: 0.2,
  alignedM5LatestBodyPressure: 0.5,
  failedBreakoutAgainstDirection: false,
};
const score = (
  candidate: Partial<M1ReversalFusionCandidate> = {},
  extra: Partial<Parameters<typeof evaluateM1ReversalTimingFusionShadow>[0]> = {},
) =>
  evaluateM1ReversalTimingFusionShadow({
    candidate: { ...base, ...candidate },
    originalRoute: 'ABSTAIN',
    planBStrategyRoute: 'CONFIRMED_REVERSAL',
    planBPaperAdmitted: true,
    ...extra,
  });

describe('M1 reversal timing M1/M5 fusion shadow', () => {
  it('identifies independently confirmed M1/M5 impulse when old failed-breakout prerequisite is absent', () => {
    const x = score();
    expect(x).toMatchObject({
      artifact: M1_REVERSAL_TIMING_FUSION_SHADOW_ARTIFACT,
      state: 'ALTERNATIVE_CONFIRMATION_CANDIDATE',
      wouldConfirmWithoutFailedBreakout: true,
      originalFailedBreakout: false,
      m1QualityPassed: true,
      m1MomentumPassed: true,
      m1SlopePassed: true,
      completedM5TurnPassed: true,
      completedM5TurnType: 'ESTABLISHED',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      signalEvidenceAsOf: '2026-11-10T18:05:00.000Z',
    });
  });
  it('accepts an independent completed decisive M5 candle, with three-bar pressure still weak', () => {
    const x = score({
      alignedM5BodyPressure3: -0.3,
      alignedM5Momentum3Atr: -0.05,
      alignedM5Momentum1Atr: 0.5,
      alignedM5LatestBodyPressure: 0.75,
    });
    expect(x).toMatchObject({
      state: 'ALTERNATIVE_CONFIRMATION_CANDIDATE',
      completedM5TurnType: 'DECISIVE_FRESH',
    });
  });
  it('does not score when Plan B reversal was not admitted or M1 already confirmed', () => {
    expect(score({}, { planBPaperAdmitted: false }).state).toBe('PLAN_B_REVERSAL_NOT_ADMITTED');
    expect(score({}, { planBStrategyRoute: 'TREND_CONTINUATION' }).state).toBe(
      'PLAN_B_REVERSAL_NOT_ADMITTED',
    );
    expect(score({}, { originalRoute: 'M1_CONFIRMED_REVERSAL' }).state).toBe(
      'ORIGINAL_M1_ALREADY_CONFIRMED',
    );
  });
  it('keeps M1 quality, M1 momentum, slope and completed M5 confirmation independent', () => {
    expect(score({ directionQuality: 0.59 }).state).toBe('M1_DIRECTION_QUALITY_LOW');
    expect(score({ alignedMomentum3Atr: 0.1 }).state).toBe('M1_MULTIBAR_IMPULSE_MISSING');
    expect(score({ alignedEmaSlopeAtr: -0.01 }).state).toBe('M1_SLOPE_NOT_ALIGNED');
    expect(
      score({
        alignedM5BodyPressure3: 0.02,
        alignedM5Momentum3Atr: -0.2,
        alignedM5Momentum1Atr: 0.1,
        alignedM5LatestBodyPressure: 0.1,
      }).state,
    ).toBe('COMPLETED_M5_TURN_MISSING');
  });
  it('does not misclassify a candidate with failed-breakout evidence as the missing-breakout cohort', () => {
    expect(score({ failedBreakoutAgainstDirection: true })).toMatchObject({
      state: 'FAILED_BREAKOUT_PRESENT_OTHER_ROUTE_BLOCK',
      wouldConfirmWithoutFailedBreakout: false,
      originalFailedBreakout: true,
    });
  });

  it('rejects non-finite or malformed features, never promotes them', () => {
    expect(score({ alignedM5Momentum1Atr: NaN }).state).toBe('INVALID_EVIDENCE');
    expect(score({ instrument: 'XAUUSD' }).state).toBe('ALTERNATIVE_CONFIRMATION_CANDIDATE');
    expect(score({ instrument: 'GOLD' }).state).toBe('INVALID_EVIDENCE');
    expect(score({ decisionTime: new Date('bad') }).state).toBe('INVALID_EVIDENCE');
    expect(score({ directionQuality: Infinity }).wouldConfirmWithoutFailedBreakout).toBe(false);
  });
});
