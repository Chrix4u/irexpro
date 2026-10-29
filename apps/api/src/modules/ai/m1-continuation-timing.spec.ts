import {
  M1_TACTICAL_POLICY_V1,
  buildM1TacticalCandidates,
  type M1TacticalCandidate,
} from './m1-tactical-candidate';
import {
  M1_TACTICAL_FEATURE_ARTIFACT,
  buildM1TacticalFeatures,
  type M1TacticalFeatureInput,
  type M1TacticalFeatureSnapshot,
} from './m1-tactical-features';
import { classifyM1TacticalRoute } from './m1-tactical-route';
import type { LivePaperCandleInput } from '../broker/services/live-paper-market-data.service';

function seriesEndingAt(
  decisionTime: Date,
  count: number,
  minutes: number,
  base = 1.1,
  step = 0.00008,
): LivePaperCandleInput[] {
  const ms = minutes * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const openTime = new Date(decisionTime.getTime() - (count - index) * ms);
    const mid = base + index * step;
    return {
      timestamp: openTime,
      open: mid.toFixed(6),
      high: (mid + 0.00025).toFixed(6),
      low: (mid - 0.0002).toFixed(6),
      close: (mid + step * 0.6).toFixed(6),
    };
  });
}

function featureInput(): M1TacticalFeatureInput {
  const decisionTime = new Date('2026-10-29T10:30:00.000Z');
  return {
    instrument: 'EURUSD',
    decisionTime,
    m1: seriesEndingAt(decisionTime, 60, 1),
    m5: seriesEndingAt(decisionTime, 35, 5, 1.09, 0.00012),
    m15: seriesEndingAt(decisionTime, 35, 15, 1.08, 0.00015),
    h1: seriesEndingAt(decisionTime, 35, 60, 1.06, 0.0002),
    h4: seriesEndingAt(decisionTime, 35, 240, 1.02, 0.0003),
  };
}

function snapshot(overrides: Partial<M1TacticalFeatureSnapshot> = {}): M1TacticalFeatureSnapshot {
  return {
    artifact: M1_TACTICAL_FEATURE_ARTIFACT,
    instrument: 'EURUSD',
    decisionTime: new Date('2026-10-29T10:30:00.000Z'),
    latestM1OpenTime: new Date('2026-10-29T10:29:00.000Z'),
    price: 1.1,
    atr14: 0.0005,
    rsi14: 58,
    bodyRangeRatio: 0.65,
    upperWickRatio: 0.12,
    lowerWickRatio: 0.23,
    closeLocation: 0.86,
    ema9: 1.1002,
    ema21: 1.0998,
    emaSeparationAtr: 0.8,
    emaSlopeAtr: 0.24,
    momentum1Atr: 0.34,
    momentum3Atr: 0.62,
    momentum5Atr: 0.8,
    m5BodyPressure3: 0.48,
    m5Momentum1Atr: 0.42,
    m5Momentum3Atr: 0.88,
    breakoutUpAtr: 0.18,
    breakoutDownAtr: 0,
    failedBreakoutUp: false,
    failedBreakoutDown: false,
    efficiency5: 0.78,
    volatilityChange: 0.08,
    extensionAtr: 0.65,
    volatilityScore: 0.28,
    session: 'LONDON',
    alignment: { m5: 0.35, m15: 0.12, h1: 0.04, h4: -0.03 },
    higherTimeframeAgreement: 0.08,
    ...overrides,
  };
}

function candidatePair(source: M1TacticalFeatureSnapshot): readonly [M1TacticalCandidate, M1TacticalCandidate] {
  return buildM1TacticalCandidates(source, M1_TACTICAL_POLICY_V1);
}

function setTimingEvidence(
  candidate: M1TacticalCandidate,
  values: {
    latestBodyPressure: number;
    directionalRun: number;
    m30Efficiency: number;
    m30MomentumAtr: number;
    bodyExpansionRatio: number;
  },
): void {
  const timingCandidate = candidate as M1TacticalCandidate & Record<string, number>;
  timingCandidate.alignedM5LatestBodyPressure = values.latestBodyPressure;
  timingCandidate.alignedM5DirectionalRun = values.directionalRun;
  timingCandidate.alignedM30DirectionalEfficiency = values.m30Efficiency;
  timingCandidate.alignedM30MomentumAtr = values.m30MomentumAtr;
  timingCandidate.m5BodyExpansionRatio = values.bodyExpansionRatio;
}

describe('M1/M5 continuation timing', () => {
  it('extracts the previous 30 minutes and completed-M5 move lifecycle evidence', () => {
    const input = featureInput();
    const m5 = [...input.m5];
    const anchor = Number(m5[m5.length - 3]!.open);
    for (let offset = 0; offset < 2; offset += 1) {
      const index = m5.length - 2 + offset;
      const open = anchor + offset * 0.00035;
      const close = open + 0.0003;
      m5[index] = {
        ...m5[index]!,
        open: open.toFixed(6),
        high: (close + 0.00005).toFixed(6),
        low: (open - 0.00005).toFixed(6),
        close: close.toFixed(6),
      };
    }

    const result = buildM1TacticalFeatures({ ...input, m5 })! as M1TacticalFeatureSnapshot &
      Record<string, number>;

    expect(result.m30MomentumAtr).toBeGreaterThan(0);
    expect(result.m30DirectionalEfficiency).toBeGreaterThan(0);
    expect(result.m5LatestBodyPressure).toBeGreaterThan(0.5);
    expect(result.m5DirectionalRun).toBeGreaterThanOrEqual(2);
    expect(result.m5BodyExpansionRatio).toBeGreaterThan(0);
  });

  it('promotes a fresh second strong M5 candle before waiting for several more candles', () => {
    const source = snapshot();
    const [buy, sell] = candidatePair(source);
    Object.assign(buy, {
      score: 1.2,
      directionQuality: 0.7,
      alignedMomentum1Atr: 0.34,
      alignedMomentum3Atr: 0.62,
      alignedMomentum5Atr: 0.8,
      alignedEmaSeparationAtr: 0.45,
      alignedEmaSlopeAtr: 0.24,
      alignedHigherTimeframeAgreement: 0.08,
      alignedM5: 0.35,
      alignedM5BodyPressure3: 0.55,
      alignedM5Momentum1Atr: 0.48,
      alignedM5Momentum3Atr: 0.92,
    });
    Object.assign(sell, { score: 0.55 });
    setTimingEvidence(buy, {
      latestBodyPressure: 0.78,
      directionalRun: 2,
      m30Efficiency: 0.68,
      m30MomentumAtr: 2.2,
      bodyExpansionRatio: 1.08,
    });

    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('M1_TREND_CONTINUATION');
    expect(result.direction).toBe('BUY');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('FRESH_M5_CONTINUATION');
  });

  it('does not chase a fifth M5 candle when body strength contracts and the move is stretched', () => {
    const source = snapshot({
      extensionAtr: 1.38,
      alignment: { m5: 0.72, m15: 0.62, h1: 0.55, h4: 0.48 },
      higherTimeframeAgreement: 0.5925,
    });
    const [buy, sell] = candidatePair(source);
    Object.assign(buy, {
      score: 1.25,
      directionQuality: 0.74,
      alignedMomentum1Atr: 0.24,
      alignedMomentum3Atr: 0.7,
      alignedMomentum5Atr: 1.1,
      alignedEmaSeparationAtr: 0.9,
      alignedEmaSlopeAtr: 0.18,
      alignedHigherTimeframeAgreement: 0.5925,
      alignedM5: 0.72,
      alignedM5BodyPressure3: 0.52,
      alignedM5Momentum1Atr: 0.18,
      alignedM5Momentum3Atr: 1.15,
    });
    Object.assign(sell, { score: 0.48 });
    setTimingEvidence(buy, {
      latestBodyPressure: 0.2,
      directionalRun: 5,
      m30Efficiency: 0.8,
      m30MomentumAtr: 3.4,
      bodyExpansionRatio: 0.42,
    });

    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('ABSTAIN');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('M5_CONTINUATION_EXHAUSTED');
  });

  it('can still participate late in a run when the latest M5 candle remains powerful and has room', () => {
    const source = snapshot({
      extensionAtr: 0.92,
      alignment: { m5: 0.72, m15: 0.62, h1: 0.55, h4: 0.48 },
      higherTimeframeAgreement: 0.5925,
    });
    const [buy, sell] = candidatePair(source);
    Object.assign(buy, {
      score: 1.25,
      directionQuality: 0.74,
      alignedMomentum1Atr: 0.4,
      alignedMomentum3Atr: 0.78,
      alignedMomentum5Atr: 1.2,
      alignedEmaSeparationAtr: 0.9,
      alignedEmaSlopeAtr: 0.25,
      alignedHigherTimeframeAgreement: 0.5925,
      alignedM5: 0.72,
      alignedM5BodyPressure3: 0.7,
      alignedM5Momentum1Atr: 0.55,
      alignedM5Momentum3Atr: 1.4,
    });
    Object.assign(sell, { score: 0.48 });
    setTimingEvidence(buy, {
      latestBodyPressure: 0.82,
      directionalRun: 4,
      m30Efficiency: 0.82,
      m30MomentumAtr: 3.2,
      bodyExpansionRatio: 1.12,
    });

    const result = classifyM1TacticalRoute(buy, sell, source, M1_TACTICAL_POLICY_V1);

    expect(result.route).toBe('M1_TREND_CONTINUATION');
    expect(result.eligible).toBe(true);
  });
});
