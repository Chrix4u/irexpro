import {
  M1_TACTICAL_POLICY_V1,
  buildM1TacticalCandidates,
  type M1TacticalCandidate,
} from './m1-tactical-candidate';
import {
  M1_TACTICAL_FEATURE_ARTIFACT,
  type M1TacticalFeatureSnapshot,
} from './m1-tactical-features';
import { classifyM1TacticalRoute } from './m1-tactical-route';

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

function pair(
  source: M1TacticalFeatureSnapshot,
): readonly [M1TacticalCandidate, M1TacticalCandidate] {
  return buildM1TacticalCandidates(source, M1_TACTICAL_POLICY_V1);
}

describe('classifyM1TacticalRoute', () => {
  it('classifies a strong aligned move as M1_TREND_CONTINUATION', () => {
    const source = snapshot();
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result).toMatchObject({
      route: 'M1_TREND_CONTINUATION',
      direction: 'BUY',
      eligible: true,
      policyVersion: 'm1-tactical-v1',
    });
    expect(result.scoreEdge).toBeGreaterThanOrEqual(M1_TACTICAL_POLICY_V1.minDirectionalEdge);
  });

  it('requires failed-move evidence plus multi-bar opposite impulse for M1_CONFIRMED_REVERSAL', () => {
    const source = snapshot({
      failedBreakoutDown: true,
      breakoutUpAtr: 0.1,
      emaSeparationAtr: 0.22,
      emaSlopeAtr: 0.35,
      momentum1Atr: 0.55,
      momentum3Atr: 0.72,
      momentum5Atr: 0.48,
      m5BodyPressure3: 0.3,
      m5Momentum1Atr: 0.2,
      m5Momentum3Atr: 0.35,
      alignment: { m5: 0.08, m15: -0.08, h1: -0.18, h4: -0.22 },
      higherTimeframeAgreement: -0.1,
      closeLocation: 0.9,
      lowerWickRatio: 0.55,
      upperWickRatio: 0.05,
    });
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('M1_CONFIRMED_REVERSAL');
    expect(result.direction).toBe('BUY');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE');
  });

  it('waits instead of selling when M1 turns down but completed M5 candles are still strongly bullish', () => {
    const source = snapshot({
      rsi14: 42,
      failedBreakoutUp: true,
      emaSeparationAtr: -0.22,
      emaSlopeAtr: -0.35,
      momentum1Atr: -0.55,
      momentum3Atr: -0.72,
      momentum5Atr: -0.48,
      alignment: { m5: -0.08, m15: 0.08, h1: 0.18, h4: 0.22 },
      higherTimeframeAgreement: 0.1,
      closeLocation: 0.1,
      lowerWickRatio: 0.05,
      upperWickRatio: 0.55,
      m5BodyPressure3: 0.65,
      m5Momentum1Atr: 0.45,
      m5Momentum3Atr: 0.9,
    });
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(sell, buy, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('ABSTAIN');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('M5_REVERSAL_NOT_CONFIRMED');
  });

  it('confirms the same sell reversal once completed M5 structure turns bearish', () => {
    const source = snapshot({
      rsi14: 42,
      failedBreakoutUp: true,
      emaSeparationAtr: -0.22,
      emaSlopeAtr: -0.35,
      momentum1Atr: -0.55,
      momentum3Atr: -0.72,
      momentum5Atr: -0.48,
      alignment: { m5: -0.08, m15: 0.08, h1: 0.18, h4: 0.22 },
      higherTimeframeAgreement: 0.1,
      closeLocation: 0.1,
      lowerWickRatio: 0.05,
      upperWickRatio: 0.55,
      m5BodyPressure3: -0.45,
      m5Momentum1Atr: -0.3,
      m5Momentum3Atr: -0.55,
    });
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(sell, buy, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('M1_CONFIRMED_REVERSAL');
    expect(result.direction).toBe('SELL');
    expect(result.eligible).toBe(true);
  });

  it('accepts one decisive completed M5 reversal candle without waiting for an arbitrary candle count', () => {
    const source = snapshot({
      failedBreakoutDown: true,
      emaSeparationAtr: 0.22,
      emaSlopeAtr: 0.35,
      momentum1Atr: 0.55,
      momentum3Atr: 0.72,
      momentum5Atr: 0.48,
      m5BodyPressure3: 0.12,
      m5Momentum1Atr: 0.42,
      m5Momentum3Atr: -0.05,
      alignment: { m5: -0.05, m15: -0.08, h1: -0.18, h4: -0.22 },
      higherTimeframeAgreement: -0.13,
      closeLocation: 0.9,
      lowerWickRatio: 0.55,
      upperWickRatio: 0.05,
    });
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('M1_CONFIRMED_REVERSAL');
    expect(result.eligible).toBe(true);
  });

  it('does not call one bullish M1 candle a reversal when multi-bar impulse is absent', () => {
    const source = snapshot({
      failedBreakoutDown: true,
      emaSeparationAtr: -0.08,
      emaSlopeAtr: 0.05,
      momentum1Atr: 0.55,
      momentum3Atr: 0.05,
      momentum5Atr: -0.12,
      alignment: { m5: -0.3, m15: -0.35, h1: -0.45, h4: -0.5 },
      higherTimeframeAgreement: -0.4,
      closeLocation: 0.8,
    });
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('ABSTAIN');
    expect(result.eligible).toBe(false);
    expect(result.reason).not.toBe('FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE');
  });

  it('classifies a strong fresh impulse in mixed higher-timeframe context as M1_EARLY_TRANSITION', () => {
    const source = snapshot({
      emaSeparationAtr: 0.2,
      emaSlopeAtr: 0.32,
      momentum1Atr: 0.42,
      momentum3Atr: 0.5,
      momentum5Atr: 0.45,
      breakoutUpAtr: 0.12,
      alignment: { m5: 0.25, m15: 0.12, h1: -0.06, h4: -0.08 },
      higherTimeframeAgreement: 0.0575,
      efficiency5: 0.78,
      closeLocation: 0.88,
    });
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('M1_EARLY_TRANSITION');
    expect(result.direction).toBe('BUY');
    expect(result.eligible).toBe(true);
  });

  it('classifies strong local impulse against bounded higher-timeframe conflict as an early-transition scout', () => {
    const source = snapshot({
      emaSeparationAtr: 1.04,
      emaSlopeAtr: 0.54,
      momentum1Atr: 0.38,
      momentum3Atr: 2.01,
      momentum5Atr: 2.87,
      breakoutUpAtr: 0,
      alignment: { m5: 1, m15: -0.27, h1: -0.37, h4: 0.3 },
      higherTimeframeAgreement: -0.336,
      efficiency5: 0.82,
      closeLocation: 0.9,
      failedBreakoutUp: false,
    });
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('M1_EARLY_TRANSITION');
    expect(result.direction).toBe('BUY');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('LOCAL_IMPULSE_AGAINST_HTF');
    expect(result.scoreEdge).toBeGreaterThanOrEqual(0.35);
  });

  it('abstains from an ordinary candidate with material higher-timeframe conflict', () => {
    const source = snapshot({
      alignment: { m5: -0.2, m15: -0.45, h1: -0.65, h4: -0.72 },
      higherTimeframeAgreement: -0.505,
      failedBreakoutDown: false,
      momentum1Atr: 0.3,
      momentum3Atr: 0.3,
      momentum5Atr: 0.25,
    });
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('ABSTAIN');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('HIGHER_TIMEFRAME_CONFLICT');
  });

  it('abstains when BUY and SELL scores are a non-material tie', () => {
    const source = snapshot({
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
      m5BodyPressure3: 0,
      m5Momentum1Atr: 0,
      m5Momentum3Atr: 0,
      breakoutUpAtr: 0,
      breakoutDownAtr: 0,
      efficiency5: 0,
      alignment: { m5: 0, m15: 0, h1: 0, h4: 0 },
      higherTimeframeAgreement: 0,
    });
    const [buy, sell] = pair(source);
    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('ABSTAIN');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('DIRECTION_EDGE_TOO_SMALL');
  });

  it('fails closed when the supplied candidates are not opposite sides of the same snapshot', () => {
    const source = snapshot();
    const [buy] = pair(source);
    const result = classifyM1TacticalRoute(buy, buy, source, M1_TACTICAL_POLICY_V1);
    expect(result.route).toBe('ABSTAIN');
    expect(result.reason).toBe('INVALID_COUNTERFACTUAL_PAIR');
  });
});
