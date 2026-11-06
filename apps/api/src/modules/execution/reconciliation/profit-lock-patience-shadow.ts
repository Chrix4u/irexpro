/**
 * Independent, existing-position continuation research for cTrader DEMO.
 *
 * Opening a NEW order and HOLDING an existing order have different evidence
 * requirements. This assessment intentionally does not require a new-entry
 * BROKER_NATIVE authority or bypass a model-drift veto. It cannot hold,
 * amend, or close positions. Any future experiment MUST first install and
 * verify a profit-protecting broker stop and have an explicit bounded timer.
 */
export interface ProfitLockPatienceShadowInput {
  direction: 'BUY' | 'SELL';
  observedAt: Date;
  currentGrossPnl: number;
  initialRiskPnl: number;
  maxFavorablePnl: number;
  latestSameSideM1ContinuationAt: Date | null;
  oppositeExecutableReversal: boolean;
  m1Evidence: {
    completedBars: number;
    liveQuoteBars: number;
    latestAgeSeconds: number;
    adverseBars: number;
    alignedLatestBodyPressure: number;
    alignedMomentum3: number;
  } | null;
}

export type ProfitLockPatienceShadowReason =
  | 'INVALID_INITIAL_RISK_OR_PROFIT'
  | 'INSUFFICIENT_RETAINED_PROFIT'
  | 'EXECUTABLE_OPPOSITE_REVERSAL'
  | 'NO_RECENT_SAME_SIDE_CONTINUATION'
  | 'LIVE_M1_QUOTES_INSUFFICIENT'
  | 'STRONG_ADVERSE_M1_CONFIRMATION'
  | 'PROTECTED_GRACE_RESEARCH_CANDIDATE';

export interface ProfitLockPatienceShadowDecision {
  mode: 'SHADOW_ONLY';
  wouldConsiderBrokerProtectedGrace: boolean;
  reason: ProfitLockPatienceShadowReason;
  continuationAgeSeconds: number | null;
  maxGraceSeconds: 180;
  requiresVerifiedBrokerProfitStop: true;
  minimumNetStopProfitR: 0.1;
  noTradeAuthority: true;
  modifiesExecution: false;
}

export function evaluateProfitLockPatienceShadow(
  input: ProfitLockPatienceShadowInput,
): ProfitLockPatienceShadowDecision {
  const time = input.latestSameSideM1ContinuationAt;
  const age = time ? (input.observedAt.getTime() - time.getTime()) / 1_000 : null;
  const decision = (reason: ProfitLockPatienceShadowReason): ProfitLockPatienceShadowDecision => ({
    mode: 'SHADOW_ONLY',
    wouldConsiderBrokerProtectedGrace: reason === 'PROTECTED_GRACE_RESEARCH_CANDIDATE',
    reason,
    continuationAgeSeconds: age !== null && Number.isFinite(age) ? age : null,
    maxGraceSeconds: 180,
    requiresVerifiedBrokerProfitStop: true,
    minimumNetStopProfitR: 0.1,
    noTradeAuthority: true,
    modifiesExecution: false,
  });

  if (
    !Number.isFinite(input.observedAt.getTime()) ||
    !Number.isFinite(input.initialRiskPnl) ||
    input.initialRiskPnl <= 0 ||
    !Number.isFinite(input.maxFavorablePnl) ||
    !Number.isFinite(input.currentGrossPnl) ||
    input.maxFavorablePnl <= 0 ||
    input.currentGrossPnl <= 0
  ) {
    return decision('INVALID_INITIAL_RISK_OR_PROFIT');
  }

  // Only study substantially profitable positions whose existing lock is
  // already meaningful. A small green tick is never a reason to delay exit.
  if (
    input.maxFavorablePnl < 0.5 * input.initialRiskPnl ||
    input.currentGrossPnl < 0.4 * input.initialRiskPnl ||
    input.currentGrossPnl < 0.6 * input.maxFavorablePnl
  ) {
    return decision('INSUFFICIENT_RETAINED_PROFIT');
  }

  if (input.oppositeExecutableReversal) {
    return decision('EXECUTABLE_OPPOSITE_REVERSAL');
  }

  // Entry-vetoed M1 continuation evidence MAY inform the shadow audit of an
  // ALREADY-OPEN position. It never grants a fresh order or an actual hold.
  if (age === null || !Number.isFinite(age) || age < 0 || age > 180) {
    return decision('NO_RECENT_SAME_SIDE_CONTINUATION');
  }

  const evidence = input.m1Evidence;
  if (
    !evidence ||
    !Number.isInteger(evidence.completedBars) ||
    evidence.completedBars < 2 ||
    !Number.isInteger(evidence.liveQuoteBars) ||
    evidence.liveQuoteBars < 2 ||
    !Number.isFinite(evidence.latestAgeSeconds) ||
    evidence.latestAgeSeconds < 0 ||
    evidence.latestAgeSeconds > 90 ||
    !Number.isFinite(evidence.alignedMomentum3) ||
    !Number.isFinite(evidence.alignedLatestBodyPressure) ||
    !Number.isInteger(evidence.adverseBars) ||
    evidence.adverseBars < 0
  ) {
    return decision('LIVE_M1_QUOTES_INSUFFICIENT');
  }

  // Two strongly countertrend M1 bars plus material negative pressure are
  // a genuine warning, unlike a single slight momentum fluctuation.
  if (
    evidence.adverseBars >= 2 &&
    evidence.alignedLatestBodyPressure <= -0.35 &&
    evidence.alignedMomentum3 <= -0.15
  ) {
    return decision('STRONG_ADVERSE_M1_CONFIRMATION');
  }

  return decision('PROTECTED_GRACE_RESEARCH_CANDIDATE');
}
