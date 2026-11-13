import {
  evaluateMultimodelDemoAuthority,
  multimodelDemoExecutionVolumeCap,
} from './multimodel-demo-authority';
import type { M1TacticalRoute } from './m1-tactical-route';

function reversalAuthorityInput(m1TimingRoute: M1TacticalRoute) {
  return {
    ensemble: {
      paperAdmitted: true,
      ensembleScore: 0.74,
      strategyRoute: 'CONFIRMED_REVERSAL' as const,
    },
    governance: {
      paperExecutionEligible: true,
      paperExecutionBlockers: [],
      netExpectedR: 0.31,
      paperNetExpectedRPassed: true,
      paperExecutionCostUsable: true,
      eventRisk: 'CLEAR' as const,
      sleeveState: 'COLLECTING' as const,
      driftState: 'NORMAL' as const,
    },
    trainedExpert: {
      state: 'ABSTAIN' as const,
      reason: null,
      decisionTime: '2026-10-29T00:00:00.000Z',
      freshnessSeconds: 0,
      allBrokerNative: true,
      direction: 'SELL' as const,
      admitted: false,
      ensembleConfidence: 0.55,
      meanOpportunityProbability: 0.35,
      longVotes: 1,
      shortVotes: 2,
      regime: 'calm',
      modifiesExecution: false as const,
    },
    candidateDirection: 'SELL' as const,
    m1TimingRoute,
  };
}

const confirmedM1M5 = {
  directionQuality: 0.69,
  alignedMomentum1Atr: 0.72,
  alignedMomentum3Atr: 1.73,
  alignedMomentum5Atr: 1.01,
  alignedEmaSlopeAtr: 0.25,
  alignedM5Momentum1Atr: 0.284,
  alignedM5Momentum3Atr: 0.284,
  alignedM5BodyPressure3: 0.132,
  alignedM5LatestBodyPressure: 0.42,
  alignedHigherTimeframeAgreement: 0.248,
  failedBreakoutAgainstDirection: false,
};

function bridgingInput() {
  const base = reversalAuthorityInput('M1_TREND_CONTINUATION');
  return {
    ...base,
    trainedExpert: {
      ...base.trainedExpert,
      ensembleConfidence: 0.73,
      longVotes: 0,
      shortVotes: 3,
    },
    m1ReversalEvidence: { ...confirmedM1M5 },
  };
}

describe('Plan-B confirmed-reversal timing consistency', () => {
  it('blocks a Plan-B confirmed reversal when M1 timing abstains', () => {
    const result = evaluateMultimodelDemoAuthority(reversalAuthorityInput('ABSTAIN'));
    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
    expect(result.blockers).toContain('MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED');
  });

  it('blocks a Plan-B confirmed reversal when M1 only sees an early transition', () => {
    const result = evaluateMultimodelDemoAuthority(reversalAuthorityInput('M1_EARLY_TRANSITION'));
    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
    expect(result.blockers).toContain('MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED');
  });

  it('accepts same-direction M1 early-transition timing when three broker-native experts unanimously confirm the Plan-B reversal', () => {
    const input = reversalAuthorityInput('M1_EARLY_TRANSITION');
    const result = evaluateMultimodelDemoAuthority({
      ...input,
      trainedExpert: {
        ...input.trainedExpert,
        state: 'ABSTAIN',
        ensembleConfidence: 0.71,
        longVotes: 0,
        shortVotes: 3,
      },
    });
    expect(result.executable).toBe(true);
    expect(result.authorityPath).toBe('PRIMARY_PLAN_B');
    expect(result.blockers).toEqual([]);
    expect(result.reversalTimingBridge).toBe(false);
  });

  it('keeps a Plan-B confirmed reversal executable when M1 independently confirms reversal', () => {
    const result = evaluateMultimodelDemoAuthority(reversalAuthorityInput('M1_CONFIRMED_REVERSAL'));
    expect(result.executable).toBe(true);
    expect(result.authorityPath).toBe('PRIMARY_PLAN_B');
    expect(result.blockers).toEqual([]);
    expect(result.reversalTimingBridge).toBe(false);
  });

  it('reconciles a locally confirming M1 sell impulse with an admitted Plan-B reversal, capped to 0.20 lot', () => {
    const result = evaluateMultimodelDemoAuthority(bridgingInput());
    expect(result).toMatchObject({
      executable: true,
      authorityPath: 'PRIMARY_PLAN_B',
      reversalTimingBridge: true,
      reversalTimingBridgeVolumeCap: 0.2,
      trainedExpertOpposed: false,
      blockers: [],
    });
    expect(multimodelDemoExecutionVolumeCap(4, result)).toBe(0.2);
  });

  it('reconciles a newly decisive M5 reversal even before M1 three-bar momentum matures', () => {
    const base = bridgingInput();
    const result = evaluateMultimodelDemoAuthority({
      ...base,
      m1ReversalEvidence: {
        ...base.m1ReversalEvidence,
        directionQuality: 0.637,
        alignedMomentum1Atr: 0.907,
        alignedMomentum3Atr: 0.151,
        alignedMomentum5Atr: 0.151,
        alignedEmaSlopeAtr: 0.146,
        alignedM5Momentum1Atr: 0.52,
        alignedM5Momentum3Atr: 1.041,
        alignedM5BodyPressure3: 0.485,
        alignedM5LatestBodyPressure: 0.727,
        alignedHigherTimeframeAgreement: 0.265,
      },
    });
    expect(result.executable).toBe(true);
    expect(result.reversalTimingBridge).toBe(true);
    expect(result.reversalTimingBridgeVolumeCap).toBe(0.2);
    expect(multimodelDemoExecutionVolumeCap(4, result)).toBe(0.2);
  });

  it('keeps weak or opposite fresh-M5 reversals blocked rather than relaxing drift', () => {
    const base = bridgingInput();
    const fresh = {
      ...base.m1ReversalEvidence,
      directionQuality: 0.637,
      alignedMomentum1Atr: 0.907,
      alignedMomentum3Atr: 0.151,
      alignedMomentum5Atr: 0.151,
      alignedM5Momentum1Atr: 0.52,
      alignedM5Momentum3Atr: 1.041,
      alignedM5BodyPressure3: 0.485,
      alignedM5LatestBodyPressure: 0.727,
      alignedHigherTimeframeAgreement: 0.265,
    };
    const bad = [
      { directionQuality: 0.619 },
      { alignedMomentum1Atr: 0.69 },
      { alignedMomentum3Atr: 0.09 },
      { alignedMomentum5Atr: 0.09 },
      { alignedM5Momentum1Atr: 0.39 },
      { alignedM5Momentum3Atr: 0.29 },
      { alignedM5BodyPressure3: 0.19 },
      { alignedM5LatestBodyPressure: 0.69 },
      { alignedHigherTimeframeAgreement: 0.24 },
      { alignedEmaSlopeAtr: 0 },
    ];
    for (const overrides of bad) {
      const result = evaluateMultimodelDemoAuthority({
        ...base,
        m1ReversalEvidence: { ...fresh, ...overrides },
      });
      expect(result.executable).toBe(false);
      expect(result.reversalTimingBridge).toBe(false);
    }
  });

  it('never promotes drift, event, unavailable spread or non-admitted Plan B through the semantic bridge', () => {
    const base = bridgingInput();
    for (const alteration of [
      { ensemble: { ...base.ensemble, paperAdmitted: false } },
      {
        governance: {
          ...base.governance,
          paperExecutionEligible: false,
          paperExecutionBlockers: ['DRIFT_OUT_OF_DISTRIBUTION'],
        },
      },
      {
        governance: {
          ...base.governance,
          paperExecutionEligible: false,
          paperExecutionBlockers: ['EVENT_RISK_UNVERIFIED'],
          eventRisk: 'UNVERIFIED' as const,
        },
      },
      {
        governance: {
          ...base.governance,
          paperExecutionEligible: false,
          paperExecutionBlockers: ['EXECUTION_SPREAD_UNAVAILABLE'],
          paperExecutionCostUsable: false,
        },
      },
    ]) {
      const result = evaluateMultimodelDemoAuthority({ ...base, ...alteration });
      expect(result.executable).toBe(false);
      expect(result.reversalTimingBridge).toBe(false);
      expect(result.reversalTimingBridgeVolumeCap).toBeNull();
      expect(result.blockers.length).toBeGreaterThan(0);
    }
  });

  it('does not accept stale, mixed, nonnative, opposing or weak expert votes', () => {
    const base = bridgingInput();
    for (const partial of [
      { longVotes: 1, shortVotes: 2 },
      { longVotes: 3, shortVotes: 0, direction: 'BUY' as const },
      { allBrokerNative: false },
      { ensembleConfidence: 0.699 },
      { freshnessSeconds: 121 },
      { freshnessSeconds: -1 },
      { freshnessSeconds: null },
    ]) {
      const result = evaluateMultimodelDemoAuthority({
        ...base,
        trainedExpert: { ...base.trainedExpert, ...partial },
      });
      expect(result.executable).toBe(false);
      expect(result.blockers).toContain('MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED');
    }
  });

  it('never allows M1 abstain, missing breakout geometry, weak M1/M5 or opposing timeframe evidence', () => {
    const base = bridgingInput();
    const bad = [
      { directionQuality: 0.679 },
      { alignedMomentum1Atr: 0.49 },
      { alignedMomentum3Atr: 0.49 },
      { alignedMomentum5Atr: 0.24 },
      { alignedEmaSlopeAtr: 0 },
      { alignedHigherTimeframeAgreement: 0.19 },
      { alignedM5BodyPressure3: 0.11, alignedM5LatestBodyPressure: 0.4 },
      { alignedM5Momentum3Atr: 0.15, alignedM5LatestBodyPressure: 0.4 },
      { alignedM5Momentum1Atr: 0.19 },
      { alignedMomentum3Atr: NaN },
      { failedBreakoutAgainstDirection: true },
    ];
    for (const overrides of bad) {
      const result = evaluateMultimodelDemoAuthority({
        ...base,
        m1ReversalEvidence: { ...base.m1ReversalEvidence, ...overrides },
      });
      expect(result.executable).toBe(false);
      expect(result.reversalTimingBridgeVolumeCap).toBeNull();
    }
    const abstained = evaluateMultimodelDemoAuthority({
      ...base,
      m1TimingRoute: 'ABSTAIN',
    });
    expect(abstained.executable).toBe(false);
  });

  it('keeps unrelated trend and early-transition routes and their sizing unaffected', () => {
    const base = bridgingInput();
    const normal = evaluateMultimodelDemoAuthority({
      ...base,
      ensemble: { ...base.ensemble, strategyRoute: 'TREND_CONTINUATION' },
    });
    expect(normal.executable).toBe(true);
    expect(normal.reversalTimingBridge).toBe(false);
    expect(multimodelDemoExecutionVolumeCap(4, normal)).toBe(4);
  });
});
