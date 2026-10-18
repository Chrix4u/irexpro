import {
  M1_TACTICAL_POLICY_V1,
  buildM1TacticalCandidates,
  type M1TacticalPolicy,
} from './m1-tactical-candidate';
import {
  M1_TACTICAL_FEATURE_ARTIFACT,
  type M1TacticalFeatureSnapshot,
} from './m1-tactical-features';

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
    emaSeparationAtr: 0.8,
    emaSlopeAtr: 0.22,
    momentum1Atr: 0.22,
    momentum3Atr: 0.55,
    momentum5Atr: 0.72,
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

describe('buildM1TacticalCandidates', () => {
  it('creates exactly one BUY and one SELL from the same causal snapshot', () => {
    const source = snapshot();
    const result = buildM1TacticalCandidates(source, M1_TACTICAL_POLICY_V1);

    expect(result).toHaveLength(2);
    expect(result.map((candidate) => candidate.direction)).toEqual(['BUY', 'SELL']);
    for (const candidate of result) {
      expect(candidate.instrument).toBe('EURUSD');
      expect(candidate.decisionTime.toISOString()).toBe(source.decisionTime.toISOString());
      expect(candidate.latestM1OpenTime.toISOString()).toBe(source.latestM1OpenTime.toISOString());
      expect(candidate.sourceArtifact).toBe(M1_TACTICAL_FEATURE_ARTIFACT);
      expect(candidate.policyVersion).toBe('m1-tactical-v1');
      expect(candidate.entry).toBe(source.price);
      expect(candidate.atr).toBe(source.atr14);
    }
  });

  it('uses symmetric cost-neutral stop/target geometry for BUY and SELL', () => {
    const [buy, sell] = buildM1TacticalCandidates(snapshot(), M1_TACTICAL_POLICY_V1);

    expect(buy.stopDistance).toBeCloseTo(sell.stopDistance, 12);
    expect(buy.targetDistance).toBeCloseTo(sell.targetDistance, 12);
    expect(buy.grossExpectedR).toBeCloseTo(sell.grossExpectedR, 12);
    expect(buy.grossExpectedR).toBeCloseTo(M1_TACTICAL_POLICY_V1.targetR, 12);
    expect(buy.stopLoss).toBeCloseTo(buy.entry - buy.stopDistance, 12);
    expect(buy.takeProfit).toBeCloseTo(buy.entry + buy.targetDistance, 12);
    expect(sell.stopLoss).toBeCloseTo(sell.entry + sell.stopDistance, 12);
    expect(sell.takeProfit).toBeCloseTo(sell.entry - sell.targetDistance, 12);
  });

  it('enforces the absolute pip stop floor when ATR is tiny', () => {
    const tinyAtr = snapshot({ atr14: 0.00001 });
    const [buy, sell] = buildM1TacticalCandidates(tinyAtr, M1_TACTICAL_POLICY_V1);
    expect(buy.stopDistance).toBeGreaterThanOrEqual(5 * 0.0001);
    expect(sell.stopDistance).toBe(buy.stopDistance);
  });

  it('uses the JPY pip size for the absolute stop floor', () => {
    const [buy] = buildM1TacticalCandidates(
      snapshot({ instrument: 'USDJPY', price: 149.2, atr14: 0.001 }),
      M1_TACTICAL_POLICY_V1,
    );
    expect(buy.stopDistance).toBeGreaterThanOrEqual(5 * 0.01);
  });

  it('aligns directional features without discarding the counterfactual side', () => {
    const [buy, sell] = buildM1TacticalCandidates(snapshot(), M1_TACTICAL_POLICY_V1);

    expect(buy.alignedMomentum3Atr).toBeGreaterThan(0);
    expect(sell.alignedMomentum3Atr).toBeLessThan(0);
    expect(buy.alignedHigherTimeframeAgreement).toBeGreaterThan(0);
    expect(sell.alignedHigherTimeframeAgreement).toBeLessThan(0);
    expect(buy.directionQuality).toBeGreaterThan(sell.directionQuality);
    expect(buy.score).toBeGreaterThan(sell.score);
  });

  it('keeps a neutral tie symmetric so route selection can ABSTAIN', () => {
    const neutral = snapshot({
      rsi14: 50,
      bodyRangeRatio: 0.1,
      upperWickRatio: 0.45,
      lowerWickRatio: 0.45,
      closeLocation: 0.5,
      emaSeparationAtr: 0,
      emaSlopeAtr: 0,
      momentum1Atr: 0,
      momentum3Atr: 0,
      momentum5Atr: 0,
      breakoutUpAtr: 0,
      breakoutDownAtr: 0,
      efficiency5: 0,
      volatilityChange: 0,
      alignment: { m5: 0, m15: 0, h1: 0, h4: 0 },
      higherTimeframeAgreement: 0,
    });
    const [buy, sell] = buildM1TacticalCandidates(neutral, M1_TACTICAL_POLICY_V1);

    expect(buy.directionQuality).toBeCloseTo(sell.directionQuality, 12);
    expect(buy.score).toBeCloseTo(sell.score, 12);
  });

  it('caps candidate confidence at the versioned governance-compatible ceiling', () => {
    const strong = snapshot({
      emaSeparationAtr: 1,
      emaSlopeAtr: 1,
      momentum1Atr: 1,
      momentum3Atr: 1,
      momentum5Atr: 1,
      efficiency5: 1,
      volatilityScore: 0,
      alignment: { m5: 1, m15: 1, h1: 1, h4: 1 },
      higherTimeframeAgreement: 1,
      closeLocation: 1,
      upperWickRatio: 0,
      lowerWickRatio: 1,
      rsi14: 70,
      breakoutUpAtr: 1,
    });
    const [buy] = buildM1TacticalCandidates(strong, M1_TACTICAL_POLICY_V1);
    expect(buy.confidence).toBeLessThanOrEqual(M1_TACTICAL_POLICY_V1.maxConfidence);
    expect(M1_TACTICAL_POLICY_V1.maxConfidence).toBe(0.738);
  });

  it('honours an explicit versioned policy geometry', () => {
    const policy: M1TacticalPolicy = {
      ...M1_TACTICAL_POLICY_V1,
      version: 'm1-tactical-v1-test',
      stopAtrMultiplier: 2,
      targetR: 1.25,
    };
    const [buy] = buildM1TacticalCandidates(snapshot(), policy);
    expect(buy.policyVersion).toBe('m1-tactical-v1-test');
    expect(buy.stopDistance).toBeCloseTo(0.001, 12);
    expect(buy.grossExpectedR).toBeCloseTo(1.25, 12);
  });
});
