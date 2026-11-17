import type { M1TacticalRoute } from './m1-tactical-route';
import type { DemoProfitabilityReliabilityGateDecision } from './demo-profitability-reliability-gate';

/**
 * Only a DEMO probe: an independently admitted, cost-aware confirmed reversal
 * must not inherit the separate M1 EARLY_TRANSITION sleeve's degraded-sample
 * veto merely because its local timing specialist used that label.
 *
 * The M1 loss-streak veto, broker identity, Plan-B admission, drift, event,
 * spread/economics, expert consensus, portfolio state and downstream risk
 * gates remain mandatory. The scheduler also applies a four-hour, broker-
 * persisted same-pair/side recovery cooldown and a 0.20-lot ceiling.
 */
export const CONFIRMED_REVERSAL_CROSS_SLEEVE_CANARY_LOT_CAP = 0.2;

export interface ConfirmedReversalCrossSleeveCanaryInput {
  m1Route: M1TacticalRoute;
  reliabilityGate: Pick<
    DemoProfitabilityReliabilityGateDecision,
    'lossStreakVeto' | 'degradedEarlyTransitionVeto'
  > | null;
  strategyRoute: string | null;
  primaryPlanBExecutable: boolean;
  portfolioSnapshotAvailable: boolean;
  brokerVerifiedPepperstoneDemo: boolean;
  paperExecutionEligible: boolean;
  executionCostUsable: boolean;
  eventRisk: string;
  driftState: string;
  netExpectedR: number | null;
  candidateDirection: 'BUY' | 'SELL';
  expertDirection: 'BUY' | 'SELL' | null;
  expertAllBrokerNative: boolean;
  expertFreshnessSeconds: number | null;
  expertConfidence: number | null;
  expertLongVotes: number | null;
  expertShortVotes: number | null;
}

export function evaluateConfirmedReversalCrossSleeveCanary(
  input: ConfirmedReversalCrossSleeveCanaryInput,
): boolean {
  if (
    input.m1Route !== 'M1_EARLY_TRANSITION' ||
    input.reliabilityGate?.degradedEarlyTransitionVeto !== true ||
    input.reliabilityGate.lossStreakVeto ||
    input.strategyRoute !== 'CONFIRMED_REVERSAL' ||
    !input.primaryPlanBExecutable ||
    !input.portfolioSnapshotAvailable ||
    !input.brokerVerifiedPepperstoneDemo ||
    !input.paperExecutionEligible ||
    !input.executionCostUsable ||
    input.eventRisk !== 'CLEAR' ||
    input.driftState !== 'NORMAL' ||
    input.netExpectedR == null ||
    !Number.isFinite(input.netExpectedR) ||
    input.netExpectedR <= 0 ||
    !input.expertAllBrokerNative ||
    input.expertDirection !== input.candidateDirection ||
    input.expertFreshnessSeconds == null ||
    !Number.isFinite(input.expertFreshnessSeconds) ||
    input.expertFreshnessSeconds < 0 ||
    input.expertFreshnessSeconds > 120 ||
    input.expertConfidence == null ||
    !Number.isFinite(input.expertConfidence) ||
    input.expertConfidence < 0.7 ||
    input.expertLongVotes == null ||
    input.expertShortVotes == null ||
    !Number.isInteger(input.expertLongVotes) ||
    !Number.isInteger(input.expertShortVotes) ||
    input.expertLongVotes < 0 ||
    input.expertShortVotes < 0
  ) {
    return false;
  }
  const totalVotes = input.expertLongVotes + input.expertShortVotes;
  const alignedVotes =
    input.candidateDirection === 'BUY' ? input.expertLongVotes : input.expertShortVotes;
  return totalVotes >= 3 && alignedVotes === totalVotes;
}
