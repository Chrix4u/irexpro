import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';

export type M1TacticalDirection = 'BUY' | 'SELL';

export interface M1TacticalPolicy {
  version: string;
  stopAtrMultiplier: number;
  targetR: number;
  minStopPips: number;
  minDirectionalEdge: number;
  minContinuationQuality: number;
  minContinuationMomentumAtr: number;
  minContinuationHtfAgreement: number;
  minReversalQuality: number;
  minReversalImpulseAtr: number;
  minTransitionQuality: number;
  minTransitionMomentumAtr: number;
  maxTransitionHtfAbs: number;
}

export const M1_TACTICAL_POLICY_V1: Readonly<M1TacticalPolicy> = Object.freeze({
  version: 'm1-tactical-v1',
  stopAtrMultiplier: 1.1,
  targetR: 1.6,
  minStopPips: 5,
  minDirectionalEdge: 0.08,
  minContinuationQuality: 0.58,
  minContinuationMomentumAtr: 0.12,
  minContinuationHtfAgreement: 0.12,
  minReversalQuality: 0.6,
  minReversalImpulseAtr: 0.25,
  minTransitionQuality: 0.56,
  minTransitionMomentumAtr: 0.18,
  maxTransitionHtfAbs: 0.25,
});

export interface M1TacticalCandidate {
  instrument: string;
  direction: M1TacticalDirection;
  decisionTime: Date;
  latestM1OpenTime: Date;
  sourceArtifact: string;
  policyVersion: string;
  entry: number;
  atr: number;
  stopDistance: number;
  targetDistance: number;
  stopLoss: number;
  takeProfit: number;
  grossExpectedR: number;
  confidence: number;
  directionQuality: number;
  score: number;
  alignedEmaSeparationAtr: number;
  alignedEmaSlopeAtr: number;
  alignedMomentum1Atr: number;
  alignedMomentum3Atr: number;
  alignedMomentum5Atr: number;
  alignedHigherTimeframeAgreement: number;
  alignedM5: number;
  alignedM15: number;
  alignedH1: number;
  alignedH4: number;
  breakoutAtr: number;
  failedBreakoutWithDirection: boolean;
  failedBreakoutAgainstDirection: boolean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function pipSize(instrument: string): number {
  return instrument.toUpperCase().endsWith('JPY') ? 0.01 : 0.0001;
}

function buildCandidate(
  snapshot: M1TacticalFeatureSnapshot,
  direction: M1TacticalDirection,
  policy: M1TacticalPolicy,
): M1TacticalCandidate {
  const sign = direction === 'BUY' ? 1 : -1;
  const stopDistance = Math.max(
    snapshot.atr14 * policy.stopAtrMultiplier,
    pipSize(snapshot.instrument) * policy.minStopPips,
  );
  const targetDistance = stopDistance * policy.targetR;

  const alignedEmaSeparationAtr = sign * snapshot.emaSeparationAtr;
  const alignedEmaSlopeAtr = sign * snapshot.emaSlopeAtr;
  const alignedMomentum1Atr = sign * snapshot.momentum1Atr;
  const alignedMomentum3Atr = sign * snapshot.momentum3Atr;
  const alignedMomentum5Atr = sign * snapshot.momentum5Atr;
  const alignedHigherTimeframeAgreement = sign * snapshot.higherTimeframeAgreement;
  const alignedM5 = sign * snapshot.alignment.m5;
  const alignedM15 = sign * snapshot.alignment.m15;
  const alignedH1 = sign * snapshot.alignment.h1;
  const alignedH4 = sign * snapshot.alignment.h4;
  const breakoutAtr = direction === 'BUY' ? snapshot.breakoutUpAtr : snapshot.breakoutDownAtr;
  const failedBreakoutWithDirection =
    direction === 'BUY' ? snapshot.failedBreakoutUp : snapshot.failedBreakoutDown;
  const failedBreakoutAgainstDirection =
    direction === 'BUY' ? snapshot.failedBreakoutDown : snapshot.failedBreakoutUp;

  const closePressure = sign * (snapshot.closeLocation - 0.5) * 2;
  const wickPressure =
    sign * (snapshot.lowerWickRatio - snapshot.upperWickRatio);
  const rsiBias = sign * ((snapshot.rsi14 - 50) / 25);
  const directionalComposite = clampSigned(
    0.19 * clampSigned(alignedEmaSeparationAtr) +
      0.1 * clampSigned(alignedEmaSlopeAtr) +
      0.16 * clampSigned(alignedMomentum3Atr) +
      0.1 * clampSigned(alignedMomentum5Atr) +
      0.2 * clampSigned(alignedHigherTimeframeAgreement) +
      0.08 * clampSigned(closePressure) +
      0.05 * clampSigned(wickPressure) +
      0.04 * clampSigned(rsiBias) +
      0.08 * clampSigned(breakoutAtr),
  );
  const directionQuality = clamp01(0.5 + directionalComposite / 2);
  const confidence = clamp01(
    0.5 + 0.3 * directionQuality + 0.08 * snapshot.efficiency5 - 0.08 * snapshot.volatilityScore,
  );
  const score =
    directionQuality +
    0.15 * confidence +
    0.05 * clampSigned(alignedMomentum1Atr) +
    0.05 * clampSigned(alignedHigherTimeframeAgreement);

  return {
    instrument: snapshot.instrument,
    direction,
    decisionTime: new Date(snapshot.decisionTime),
    latestM1OpenTime: new Date(snapshot.latestM1OpenTime),
    sourceArtifact: snapshot.artifact,
    policyVersion: policy.version,
    entry: snapshot.price,
    atr: snapshot.atr14,
    stopDistance,
    targetDistance,
    stopLoss: direction === 'BUY' ? snapshot.price - stopDistance : snapshot.price + stopDistance,
    takeProfit:
      direction === 'BUY' ? snapshot.price + targetDistance : snapshot.price - targetDistance,
    grossExpectedR: policy.targetR,
    confidence,
    directionQuality,
    score,
    alignedEmaSeparationAtr,
    alignedEmaSlopeAtr,
    alignedMomentum1Atr,
    alignedMomentum3Atr,
    alignedMomentum5Atr,
    alignedHigherTimeframeAgreement,
    alignedM5,
    alignedM15,
    alignedH1,
    alignedH4,
    breakoutAtr,
    failedBreakoutWithDirection,
    failedBreakoutAgainstDirection,
  };
}

export function buildM1TacticalCandidates(
  snapshot: M1TacticalFeatureSnapshot,
  policy: M1TacticalPolicy = M1_TACTICAL_POLICY_V1,
): readonly [M1TacticalCandidate, M1TacticalCandidate] {
  return [
    buildCandidate(snapshot, 'BUY', policy),
    buildCandidate(snapshot, 'SELL', policy),
  ];
}
