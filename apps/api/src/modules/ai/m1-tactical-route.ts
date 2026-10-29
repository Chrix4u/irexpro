import type {
  M1TacticalCandidate,
  M1TacticalDirection,
  M1TacticalPolicy,
} from './m1-tactical-candidate';
import { M1_TACTICAL_POLICY_V1 } from './m1-tactical-candidate';
import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';

export type M1TacticalRoute =
  | 'M1_TREND_CONTINUATION'
  | 'M1_CONFIRMED_REVERSAL'
  | 'M1_EARLY_TRANSITION'
  | 'ABSTAIN';

export type M1TacticalRouteReason =
  | 'TREND_STRUCTURE_ALIGNED'
  | 'FRESH_M5_CONTINUATION'
  | 'M5_CONTINUATION_EXHAUSTED'
  | 'FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE'
  | 'M5_REVERSAL_NOT_CONFIRMED'
  | 'EARLY_TRANSITION_IMPULSE'
  | 'LOCAL_IMPULSE_AGAINST_HTF'
  | 'DIRECTION_EDGE_TOO_SMALL'
  | 'HIGHER_TIMEFRAME_CONFLICT'
  | 'NO_VALID_ROUTE'
  | 'INVALID_COUNTERFACTUAL_PAIR';

export interface M1TacticalRouteDecision {
  route: M1TacticalRoute;
  direction: M1TacticalDirection | null;
  eligible: boolean;
  reason: M1TacticalRouteReason;
  scoreEdge: number;
  policyVersion: string;
}

function sameSnapshot(
  candidate: M1TacticalCandidate,
  opposite: M1TacticalCandidate,
  snapshot: M1TacticalFeatureSnapshot,
  policy: M1TacticalPolicy,
): boolean {
  return (
    candidate.direction !== opposite.direction &&
    candidate.instrument === opposite.instrument &&
    candidate.instrument === snapshot.instrument &&
    candidate.policyVersion === opposite.policyVersion &&
    candidate.policyVersion === policy.version &&
    candidate.sourceArtifact === opposite.sourceArtifact &&
    candidate.sourceArtifact === snapshot.artifact &&
    candidate.decisionTime.getTime() === opposite.decisionTime.getTime() &&
    candidate.decisionTime.getTime() === snapshot.decisionTime.getTime() &&
    candidate.latestM1OpenTime.getTime() === opposite.latestM1OpenTime.getTime() &&
    candidate.latestM1OpenTime.getTime() === snapshot.latestM1OpenTime.getTime()
  );
}

function abstain(
  reason: M1TacticalRouteReason,
  scoreEdge: number,
  policyVersion: string,
): M1TacticalRouteDecision {
  return {
    route: 'ABSTAIN',
    direction: null,
    eligible: false,
    reason,
    scoreEdge,
    policyVersion,
  };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

function localImpulseAgainstHtf(
  candidate: M1TacticalCandidate,
  scoreEdge: number,
  policy: M1TacticalPolicy,
): boolean {
  return (
    Number.isFinite(scoreEdge) &&
    scoreEdge >= 0.35 &&
    candidate.directionQuality >= 0.68 &&
    candidate.alignedMomentum1Atr >= 0.2 &&
    candidate.alignedMomentum3Atr >= 0.5 &&
    candidate.alignedMomentum5Atr >= 0.5 &&
    candidate.alignedEmaSlopeAtr > 0 &&
    candidate.alignedEmaSeparationAtr > 0 &&
    candidate.alignedHigherTimeframeAgreement >= -0.5 &&
    candidate.alignedHigherTimeframeAgreement < -policy.minContinuationHtfAgreement &&
    !candidate.failedBreakoutWithDirection
  );
}

function reversalImpulse(candidate: M1TacticalCandidate, policy: M1TacticalPolicy): boolean {
  return (
    candidate.failedBreakoutAgainstDirection &&
    candidate.directionQuality >= policy.minReversalQuality &&
    candidate.alignedMomentum1Atr >= policy.minReversalImpulseAtr &&
    candidate.alignedMomentum3Atr >= policy.minReversalImpulseAtr &&
    candidate.alignedMomentum5Atr >= policy.minReversalImpulseAtr * 0.5 &&
    candidate.alignedEmaSlopeAtr > 0
  );
}

function m5ReversalConfirmed(candidate: M1TacticalCandidate): boolean {
  // Reversal timing must be confirmed by completed M5 candles, not merely by
  // a fast M1 turn. This prevents a correct eventual direction call from
  // becoming an early entry while the prior M5 move is still extending.
  const establishedTurn =
    candidate.alignedM5BodyPressure3 >= 0.08 &&
    candidate.alignedM5Momentum3Atr >= 0.08 &&
    candidate.alignedM5Momentum1Atr >= -0.1;
  const decisiveFreshTurn =
    candidate.alignedM5BodyPressure3 >= 0.05 && candidate.alignedM5Momentum1Atr >= 0.3;
  return establishedTurn || decisiveFreshTurn;
}

function continuationShape(candidate: M1TacticalCandidate, policy: M1TacticalPolicy): boolean {
  return (
    candidate.directionQuality >= policy.minContinuationQuality &&
    candidate.alignedMomentum3Atr >= policy.minContinuationMomentumAtr &&
    candidate.alignedEmaSeparationAtr > 0 &&
    !candidate.failedBreakoutWithDirection
  );
}

function freshM5Continuation(
  candidate: M1TacticalCandidate,
  snapshot: M1TacticalFeatureSnapshot,
  policy: M1TacticalPolicy,
): boolean {
  if (!continuationShape(candidate, policy)) return false;

  const latestBodyPressure = finiteOr(candidate.alignedM5LatestBodyPressure, 0);
  const directionalRun = finiteOr(candidate.alignedM5DirectionalRun, 0);
  const m30Efficiency = finiteOr(candidate.alignedM30DirectionalEfficiency, 0);
  const m30MomentumAtr = finiteOr(candidate.alignedM30MomentumAtr, 0);
  const bodyExpansion = finiteOr(candidate.m5BodyExpansionRatio, 1);

  return (
    latestBodyPressure >= 0.55 &&
    directionalRun >= 1 &&
    candidate.alignedM5BodyPressure3 >= 0.2 &&
    candidate.alignedM5Momentum1Atr >= 0.18 &&
    candidate.alignedM5Momentum3Atr >= 0.35 &&
    candidate.alignedM5 >= 0.1 &&
    candidate.alignedHigherTimeframeAgreement >= -0.08 &&
    m30Efficiency >= 0.35 &&
    m30MomentumAtr >= 0.8 &&
    bodyExpansion >= 0.75 &&
    snapshot.extensionAtr <= 1.4
  );
}

function m5ContinuationExhausted(
  candidate: M1TacticalCandidate,
  snapshot: M1TacticalFeatureSnapshot,
  policy: M1TacticalPolicy,
): boolean {
  if (!continuationShape(candidate, policy)) return false;

  const latestBodyPressure = finiteOr(candidate.alignedM5LatestBodyPressure, 1);
  const directionalRun = finiteOr(candidate.alignedM5DirectionalRun, 0);
  const m30MomentumAtr = finiteOr(candidate.alignedM30MomentumAtr, 0);
  const bodyExpansion = finiteOr(candidate.m5BodyExpansionRatio, 1);
  const matureRun = directionalRun >= 4;
  const bodyContracting = latestBodyPressure < 0.32 && bodyExpansion < 0.65;
  const stretched = snapshot.extensionAtr >= 1.1 || m30MomentumAtr >= 3;
  const recentImpulseSlowing =
    candidate.alignedM5Momentum1Atr < Math.max(0.2, candidate.alignedM5Momentum3Atr * 0.35);

  return matureRun && bodyContracting && stretched && recentImpulseSlowing;
}

export function classifyM1TacticalRoute(
  candidate: M1TacticalCandidate,
  opposite: M1TacticalCandidate,
  snapshot: M1TacticalFeatureSnapshot,
  policy: M1TacticalPolicy = M1_TACTICAL_POLICY_V1,
): M1TacticalRouteDecision {
  const scoreEdge = candidate.score - opposite.score;
  if (!sameSnapshot(candidate, opposite, snapshot, policy)) {
    return abstain('INVALID_COUNTERFACTUAL_PAIR', scoreEdge, policy.version);
  }

  const reversalSignal = reversalImpulse(candidate, policy);
  const reversal = reversalSignal && m5ReversalConfirmed(candidate);
  const localImpulseScout = !reversalSignal && localImpulseAgainstHtf(candidate, scoreEdge, policy);
  if (
    !reversalSignal &&
    !localImpulseScout &&
    candidate.alignedHigherTimeframeAgreement <= -policy.minContinuationHtfAgreement
  ) {
    return abstain('HIGHER_TIMEFRAME_CONFLICT', scoreEdge, policy.version);
  }

  if (!Number.isFinite(scoreEdge) || scoreEdge < policy.minDirectionalEdge) {
    return abstain('DIRECTION_EDGE_TOO_SMALL', scoreEdge, policy.version);
  }

  if (reversalSignal && !reversal) {
    return abstain('M5_REVERSAL_NOT_CONFIRMED', scoreEdge, policy.version);
  }

  if (reversal) {
    return {
      route: 'M1_CONFIRMED_REVERSAL',
      direction: candidate.direction,
      eligible: true,
      reason: 'FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE',
      scoreEdge,
      policyVersion: policy.version,
    };
  }

  if (localImpulseScout) {
    return {
      route: 'M1_EARLY_TRANSITION',
      direction: candidate.direction,
      eligible: true,
      reason: 'LOCAL_IMPULSE_AGAINST_HTF',
      scoreEdge,
      policyVersion: policy.version,
    };
  }

  if (m5ContinuationExhausted(candidate, snapshot, policy)) {
    return abstain('M5_CONTINUATION_EXHAUSTED', scoreEdge, policy.version);
  }

  if (freshM5Continuation(candidate, snapshot, policy)) {
    return {
      route: 'M1_TREND_CONTINUATION',
      direction: candidate.direction,
      eligible: true,
      reason: 'FRESH_M5_CONTINUATION',
      scoreEdge,
      policyVersion: policy.version,
    };
  }

  const continuation =
    continuationShape(candidate, policy) &&
    candidate.alignedHigherTimeframeAgreement >= policy.minContinuationHtfAgreement;
  if (continuation) {
    return {
      route: 'M1_TREND_CONTINUATION',
      direction: candidate.direction,
      eligible: true,
      reason: 'TREND_STRUCTURE_ALIGNED',
      scoreEdge,
      policyVersion: policy.version,
    };
  }

  const transition =
    candidate.directionQuality >= policy.minTransitionQuality &&
    candidate.alignedMomentum3Atr >= policy.minTransitionMomentumAtr &&
    candidate.alignedEmaSlopeAtr > 0 &&
    Math.abs(candidate.alignedHigherTimeframeAgreement) <= policy.maxTransitionHtfAbs &&
    !candidate.failedBreakoutWithDirection;
  if (transition) {
    return {
      route: 'M1_EARLY_TRANSITION',
      direction: candidate.direction,
      eligible: true,
      reason: 'EARLY_TRANSITION_IMPULSE',
      scoreEdge,
      policyVersion: policy.version,
    };
  }

  return abstain('NO_VALID_ROUTE', scoreEdge, policy.version);
}
