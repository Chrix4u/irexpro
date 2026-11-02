export type M5EarlyTransitionDirection = 'BUY' | 'SELL';

export interface M5EarlyTransitionEvidence {
  instrument: string;
  direction: M5EarlyTransitionDirection;
  marketBarTime: Date;
  evaluatedAt: Date;
  strategyRoute: string;
  paperAdmitted: boolean;
  paperExecutionEligible: boolean;
  eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
  driftState: string;
  netExpectedR: number;
  ensembleScore: number;
  consensusPassed: number;
  consensusRequired: number;
}

export interface M5EarlyTransitionHandoffInput {
  decisionTime: Date;
  m5Evidence: M5EarlyTransitionEvidence;
  m1Route: string;
  m1Reason: string;
  m1Confidence: number;
  m1DirectionQuality: number;
  m1ExecutionCostUsable: boolean;
  m1EventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
}

export interface M5EarlyTransitionHandoffDecision {
  eligible: boolean;
  reason: string;
  lotCap: number;
}

const MAX_M5_BAR_AGE_MS = 5 * 60_000;
const MAX_M5_EVALUATION_AGE_MS = 2 * 60_000;
const MIN_M5_NET_EXPECTED_R = 0.2;
const MIN_M5_ENSEMBLE_SCORE = 0.6;
const MIN_M1_CONFIRM_CONFIDENCE = 0.6;
const MIN_M1_CONFIRM_DIRECTION_QUALITY = 0.55;
const MIN_M1_STRONG_ABSTAIN_CONFIDENCE = 0.7;
const MIN_M1_STRONG_ABSTAIN_DIRECTION_QUALITY = 0.65;
const M5_EARLY_TRANSITION_PROBE_LOT_CAP = 0.2;

function reject(reason: string): M5EarlyTransitionHandoffDecision {
  return { eligible: false, reason, lotCap: 0 };
}

function finiteAtLeast(value: number, floor: number): boolean {
  return Number.isFinite(value) && value >= floor;
}

function freshAge(now: Date, observedAt: Date, maxAgeMs: number): boolean {
  const nowMs = now.getTime();
  const observedMs = observedAt.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(observedMs)) return false;
  const ageMs = nowMs - observedMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

/**
 * Bounded DEMO handoff for a strong M5 Plan-B EARLY_TRANSITION.
 *
 * This is deliberately not a generic gate bypass. M5 must already be admitted,
 * cost-aware, positive-expectancy, normal-drift evidence. M1 then has to either
 * independently confirm continuation or provide a strong non-ambiguous abstain.
 */
export function evaluateM5EarlyTransitionHandoff(
  input: M5EarlyTransitionHandoffInput,
): M5EarlyTransitionHandoffDecision {
  const m5 = input.m5Evidence;

  if (m5.strategyRoute !== 'EARLY_TRANSITION') return reject('M5_ROUTE_NOT_EARLY_TRANSITION');
  if (!freshAge(input.decisionTime, m5.marketBarTime, MAX_M5_BAR_AGE_MS)) {
    return reject('M5_EVIDENCE_STALE');
  }
  if (!freshAge(input.decisionTime, m5.evaluatedAt, MAX_M5_EVALUATION_AGE_MS)) {
    return reject('M5_EVALUATION_STALE');
  }
  if (!m5.paperAdmitted) return reject('M5_NOT_PAPER_ADMITTED');
  if (!m5.paperExecutionEligible) return reject('M5_GOVERNANCE_BLOCKED');
  if (m5.eventRisk !== 'CLEAR') return reject('M5_EVENT_RISK_BLOCKED');
  if (m5.driftState !== 'NORMAL') return reject('M5_DRIFT_NOT_NORMAL');
  if (!finiteAtLeast(m5.netExpectedR, MIN_M5_NET_EXPECTED_R)) {
    return reject('M5_NET_EXPECTED_R_TOO_LOW');
  }
  if (!finiteAtLeast(m5.ensembleScore, MIN_M5_ENSEMBLE_SCORE)) {
    return reject('M5_ENSEMBLE_SCORE_TOO_LOW');
  }
  if (m5.consensusRequired <= 0 || m5.consensusPassed < m5.consensusRequired) {
    return reject('M5_CONSENSUS_NOT_PASSED');
  }
  if (!input.m1ExecutionCostUsable) return reject('M1_EXECUTION_COST_UNUSABLE');
  if (input.m1EventRisk !== 'CLEAR') return reject('M1_EVENT_RISK_BLOCKED');

  if (input.m1Route === 'M1_TREND_CONTINUATION') {
    if (
      !finiteAtLeast(input.m1Confidence, MIN_M1_CONFIRM_CONFIDENCE) ||
      !finiteAtLeast(input.m1DirectionQuality, MIN_M1_CONFIRM_DIRECTION_QUALITY)
    ) {
      return reject('M1_CONTINUATION_TOO_WEAK');
    }
    return {
      eligible: true,
      reason: 'M5_EARLY_TRANSITION_M1_CONFIRMED_PROBE',
      lotCap: M5_EARLY_TRANSITION_PROBE_LOT_CAP,
    };
  }

  if (input.m1Route !== 'ABSTAIN') return reject('M1_ROUTE_OPPOSES_HANDOFF');
  if (input.m1Reason === 'DIRECTION_EDGE_TOO_SMALL') {
    return reject('M1_DIRECTION_AMBIGUOUS');
  }
  if (
    !finiteAtLeast(input.m1Confidence, MIN_M1_STRONG_ABSTAIN_CONFIDENCE) ||
    !finiteAtLeast(input.m1DirectionQuality, MIN_M1_STRONG_ABSTAIN_DIRECTION_QUALITY)
  ) {
    return reject('M1_ABSTAIN_NOT_STRONG_ENOUGH');
  }

  return {
    eligible: true,
    reason: 'M5_EARLY_TRANSITION_M1_STRONG_NON_OPPOSED_PROBE',
    lotCap: M5_EARLY_TRANSITION_PROBE_LOT_CAP,
  };
}
