import type { M1TacticalRoute } from './m1-tactical-route';
import type { M1RoutePairSideReliabilityReason } from './m1-tactical-reliability';

export interface DemoProfitabilityPairSideReliability {
  eligible: boolean;
  reason: string;
}

export interface DemoProfitabilityReliabilityGateInput {
  m1Route: M1TacticalRoute;
  m1ReliabilityReason: M1RoutePairSideReliabilityReason | null;
  pairSideReliability: DemoProfitabilityPairSideReliability | null;
}

export interface DemoProfitabilityReliabilityGateDecision {
  executable: boolean;
  blockers: string[];
  lossStreakVeto: boolean;
  degradedEarlyTransitionVeto: boolean;
}

const DEGRADED_EARLY_TRANSITION_REASONS = new Set([
  'WEAK_MEANINGFUL_EXPECTANCY',
  'RECENT_MEANINGFUL_DEGRADATION',
  'WEAK_PROVISIONAL_EXPECTANCY',
  'RECENT_PROVISIONAL_DEGRADATION',
]);

export function evaluateDemoProfitabilityReliabilityGate(
  input: DemoProfitabilityReliabilityGateInput,
): DemoProfitabilityReliabilityGateDecision {
  const lossStreakVeto = input.m1ReliabilityReason === 'EARLY_LOSS_STREAK';
  const degradedEarlyTransitionVeto =
    input.m1Route === 'M1_EARLY_TRANSITION' &&
    input.pairSideReliability?.eligible === false &&
    DEGRADED_EARLY_TRANSITION_REASONS.has(input.pairSideReliability.reason);

  const blockers: string[] = [];
  if (lossStreakVeto) blockers.push('M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK');
  if (degradedEarlyTransitionVeto) {
    blockers.push('M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED');
  }

  return {
    executable: blockers.length === 0,
    blockers,
    lossStreakVeto,
    degradedEarlyTransitionVeto,
  };
}
