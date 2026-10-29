import {
  M1_TACTICAL_POLICY_V1,
  buildM1TacticalCandidates,
  type M1TacticalCandidate,
} from './m1-tactical-candidate';
import {
  M1_TACTICAL_FEATURE_ARTIFACT,
  type M1TacticalFeatureSnapshot,
} from './m1-tactical-features';
import type { M1TacticalRouteDecision } from './m1-tactical-route';
import {
  evaluateM1TacticalGovernance,
  type M1TacticalGovernanceInput,
} from './m1-tactical-governance';
import type { EnsembleSleeveEvidence, ExecutionSpreadEvidence } from './ensemble-governance';
import { evaluateM1TacticalExpectancy } from './m1-tactical-expectancy';

function snapshot(overrides: Partial<M1TacticalFeatureSnapshot> = {}): M1TacticalFeatureSnapshot {
  return {
    artifact: M1_TACTICAL_FEATURE_ARTIFACT,
    instrument: 'EURUSD',
    decisionTime: new Date('2026-10-15T10:30:00.000Z'),
    latestM1OpenTime: new Date('2026-10-15T10:29:00.000Z'),
    price: 1.1,
    atr14: 0.0005,
    rsi14: 58,
    bodyRangeRatio: 0.55,
    upperWickRatio: 0.15,
    lowerWickRatio: 0.3,
    closeLocation: 0.8,
    ema9: 1.1002,
    ema21: 1.0998,
    emaSeparationAtr: 0.4,
    emaSlopeAtr: 0.22,
    momentum1Atr: 0.22,
    momentum3Atr: 0.55,
    momentum5Atr: 0.72,
    m5BodyPressure3: 0.35,
    m5Momentum1Atr: 0.22,
    m5Momentum3Atr: 0.48,
    breakoutUpAtr: 0.18,
    breakoutDownAtr: 0,
    failedBreakoutUp: false,
    failedBreakoutDown: false,
    efficiency5: 0.72,
    volatilityChange: 0.08,
    extensionAtr: 0.4,
    volatilityScore: 0.28,
    session: 'LONDON',
    alignment: { m5: 0.6, m15: 0.72, h1: 0.65, h4: 0.52 },
    higherTimeframeAgreement: 0.6225,
    ...overrides,
  };
}

function route(
  candidate: M1TacticalCandidate,
  overrides: Partial<M1TacticalRouteDecision> = {},
): M1TacticalRouteDecision {
  return {
    route: 'M1_TREND_CONTINUATION',
    direction: candidate.direction,
    eligible: true,
    reason: 'TREND_STRUCTURE_ALIGNED',
    scoreEdge: 0.25,
    policyVersion: M1_TACTICAL_POLICY_V1.version,
    ...overrides,
  };
}

const spread = (overrides: Partial<ExecutionSpreadEvidence> = {}): ExecutionSpreadEvidence => ({
  source: 'BROKER_OBSERVED_P90',
  spreadPrice: 0.00004,
  sampleCount: 20,
  percentile: 0.9,
  windowMinutes: 30,
  latestSampleAt: '2026-10-15T10:30:00.000Z',
  ...overrides,
});

function baseInput(): M1TacticalGovernanceInput {
  const features = snapshot();
  const [candidate] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);
  return {
    candidate,
    routeDecision: route(candidate),
    features,
    eventRisk: 'CLEAR',
    evaluatedAt: new Date(features.decisionTime),
    executionSpreadEvidence: spread(),
    paperSimulationSpreadPrice: 0.00008,
    sleeveEvidence: null,
    reliability: null,
    expectancy: evaluateM1TacticalExpectancy({
      targetR: candidate.grossExpectedR,
      confidence: candidate.confidence,
      directionQuality: candidate.directionQuality,
      reliability: null,
    }),
  };
}

function expectNoElevatedAuthority(result: ReturnType<typeof evaluateM1TacticalGovernance>): void {
  expect(['PAPER_ONLY_RESEARCH', 'NONE']).toContain(result.executionAuthority);
  expect(result.promotionEligible).toBe(false);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('DEMO_ONLY');
  expect(serialized).not.toContain('LIVE_EXECUTION');
}

describe('evaluateM1TacticalGovernance', () => {
  it('uses statistical expectancy rather than fixed target geometry as expected R', () => {
    const input = baseInput();
    const stronger = evaluateM1TacticalGovernance({
      ...input,
      expectancy: { ...input.expectancy, statisticalExpectedR: 0.35 },
    });
    const weaker = evaluateM1TacticalGovernance({
      ...input,
      expectancy: { ...input.expectancy, statisticalExpectedR: 0.05 },
    });

    expect(stronger.netExpectedR).toBeGreaterThan(weaker.netExpectedR);
    expect(stronger.genericGovernance.grossExpectedR).toBeCloseTo(0.35, 12);
    expect(weaker.genericGovernance.grossExpectedR).toBeCloseTo(0.05, 12);
    expect(stronger.genericGovernance.grossExpectedR).not.toBeCloseTo(
      input.candidate.grossExpectedR,
      6,
    );
  });
  it('allows a clean continuation only as PAPER_ONLY_RESEARCH', () => {
    const result = evaluateM1TacticalGovernance(baseInput());
    expect(result.paperEligible).toBe(true);
    expect(result.executionAuthority).toBe('PAPER_ONLY_RESEARCH');
    expect(result.route).toBe('M1_TREND_CONTINUATION');
    expect(result.netExpectedR).toBeGreaterThan(0);
    expect(result.blockers).toEqual([]);
    expectNoElevatedAuthority(result);
  });

  it('blocks when neither broker spread evidence nor a PAPER spread fallback is usable', () => {
    const input = baseInput();
    const result = evaluateM1TacticalGovernance({
      ...input,
      executionSpreadEvidence: null,
      paperSimulationSpreadPrice: undefined,
    });
    expect(result.paperEligible).toBe(false);
    expect(result.executionAuthority).toBe('NONE');
    expect(result.blockers).toContain('EXECUTION_SPREAD_UNAVAILABLE');
    expectNoElevatedAuthority(result);
  });

  it.each(['HIGH_IMPACT_BLOCK', 'UNVERIFIED'] as const)(
    'blocks when macro event risk is %s',
    (eventRisk) => {
      const result = evaluateM1TacticalGovernance({ ...baseInput(), eventRisk });
      expect(result.paperEligible).toBe(false);
      expect(result.blockers).toContain(`EVENT_RISK_${eventRisk}`);
      expectNoElevatedAuthority(result);
    },
  );

  it('blocks out-of-distribution feature evidence', () => {
    const input = baseInput();
    const features = snapshot({ volatilityScore: 0.9 });
    const [candidate] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);
    const result = evaluateM1TacticalGovernance({
      ...input,
      candidate,
      routeDecision: route(candidate),
      features,
    });
    expect(result.paperEligible).toBe(false);
    expect(result.genericGovernance.driftState).toBe('OUT_OF_DISTRIBUTION');
    expect(result.blockers).toContain('DRIFT_OUT_OF_DISTRIBUTION');
    expectNoElevatedAuthority(result);
  });

  it('blocks a sleeve whose prospective evidence is empirically blocked', () => {
    const blockedSleeve: EnsembleSleeveEvidence = {
      closedTrades: 100,
      profitFactor: 0.8,
      sharpe: 0.5,
      maxDrawdown: 0.08,
      positiveWindowFraction: 0.4,
    };
    const result = evaluateM1TacticalGovernance({
      ...baseInput(),
      sleeveEvidence: blockedSleeve,
    });
    expect(result.paperEligible).toBe(false);
    expect(result.blockers).toContain('SLEEVE_BLOCKED');
    expectNoElevatedAuthority(result);
  });

  it('removes PAPER authority when recent pair-side payoff has decayed', () => {
    const reliability: NonNullable<M1TacticalGovernanceInput['reliability']> = {
      eligible: false,
      reason: 'RECENT_NEGATIVE_PAYOFF',
    };
    const result = evaluateM1TacticalGovernance({ ...baseInput(), reliability });
    expect(result.paperEligible).toBe(false);
    expect(result.executionAuthority).toBe('NONE');
    expect(result.blockers).toContain('M1_RELIABILITY_RECENT_NEGATIVE_PAYOFF');
    expectNoElevatedAuthority(result);
  });

  it('blocks when execution cost makes net expected R non-positive', () => {
    const result = evaluateM1TacticalGovernance({
      ...baseInput(),
      executionSpreadEvidence: spread({ spreadPrice: 0.001 }),
      paperSimulationSpreadPrice: undefined,
    });
    expect(result.netExpectedR).toBeLessThanOrEqual(0);
    expect(result.paperEligible).toBe(false);
    expect(result.blockers).toContain('PAPER_NET_EXPECTED_R');
    expectNoElevatedAuthority(result);
  });

  it('does not re-block a tagged local-impulse early-transition scout with the generic HTF conflict blocker', () => {
    const input = baseInput();
    const features = snapshot({
      emaSeparationAtr: 1.04,
      emaSlopeAtr: 0.54,
      momentum1Atr: 0.38,
      momentum3Atr: 2.01,
      momentum5Atr: 2.87,
      alignment: { m5: 1, m15: -0.27, h1: -0.37, h4: 0.3 },
      higherTimeframeAgreement: -0.336,
      extensionAtr: 0.4,
      volatilityScore: 0.28,
    });
    const [candidate] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);
    const result = evaluateM1TacticalGovernance({
      ...input,
      candidate,
      routeDecision: route(candidate, {
        route: 'M1_EARLY_TRANSITION',
        reason: 'LOCAL_IMPULSE_AGAINST_HTF',
        scoreEdge: 0.6,
      }),
      features,
    });

    expect(result.blockers).not.toContain('M1_HIGHER_TIMEFRAME_CONFLICT');
    expectNoElevatedAuthority(result);
  });

  it('adds an M1 higher-timeframe conflict blocker even if a caller presents an eligible route', () => {
    const input = baseInput();
    const features = snapshot({
      alignment: { m5: -0.2, m15: -0.45, h1: -0.65, h4: -0.72 },
      higherTimeframeAgreement: -0.505,
    });
    const [candidate] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);
    const result = evaluateM1TacticalGovernance({
      ...input,
      candidate,
      routeDecision: route(candidate),
      features,
    });
    expect(result.paperEligible).toBe(false);
    expect(result.blockers).toContain('M1_HIGHER_TIMEFRAME_CONFLICT');
    expectNoElevatedAuthority(result);
  });

  it('blocks an ineligible or direction-mismatched route decision before authority is granted', () => {
    const input = baseInput();
    const result = evaluateM1TacticalGovernance({
      ...input,
      routeDecision: route(input.candidate, { eligible: false, route: 'ABSTAIN', direction: null }),
    });
    expect(result.paperEligible).toBe(false);
    expect(result.executionAuthority).toBe('NONE');
    expect(result.blockers).toContain('M1_ROUTE_NOT_ELIGIBLE');
    expectNoElevatedAuthority(result);
  });
});
