export interface M1FailedMoveRescuePolicy {
  version: string;
  minOppositeEdgeDelta: number;
}

export const M1_FAILED_MOVE_RESCUE_POLICY_V1: Readonly<M1FailedMoveRescuePolicy> = Object.freeze({
  version: 'm1-failed-move-rescue-v1',
  minOppositeEdgeDelta: 0.25,
});

export interface M1FailedMoveRescueInput {
  originalInvalidated: boolean;
  originalNetExpectedR: number;
  oppositeNetExpectedR: number;
  oppositeGovernanceEligible: boolean;
  oppositeBlockers: readonly string[];
  duplicateOppositeIntent: boolean;
  reversalAllowedByPolicy: boolean;
}

export type M1FailedMoveRescueReason =
  | 'INVALID_EVIDENCE'
  | 'ORIGINAL_THESIS_STILL_VALID'
  | 'OPPOSITE_NET_EXPECTED_R_NON_POSITIVE'
  | 'OPPOSITE_EDGE_DELTA_BELOW_FLOOR'
  | 'OPPOSITE_GOVERNANCE_BLOCKED'
  | 'DUPLICATE_OPPOSITE_INTENT'
  | 'REVERSAL_NOT_ALLOWED_BY_POLICY'
  | 'SHADOW_RESCUE_CANDIDATE';

export interface M1FailedMoveRescueDecision {
  eligible: boolean;
  reason: M1FailedMoveRescueReason;
  originalInvalidated: boolean;
  originalNetExpectedR: number;
  oppositeNetExpectedR: number;
  edgeDelta: number;
  executionAuthority: 'NONE';
  modifiesExecution: false;
}

export function evaluateM1FailedMoveRescue(
  input: M1FailedMoveRescueInput,
  policy: M1FailedMoveRescuePolicy = M1_FAILED_MOVE_RESCUE_POLICY_V1,
): M1FailedMoveRescueDecision {
  const edgeDelta = input.oppositeNetExpectedR - input.originalNetExpectedR;
  const base = {
    originalInvalidated: input.originalInvalidated,
    originalNetExpectedR: input.originalNetExpectedR,
    oppositeNetExpectedR: input.oppositeNetExpectedR,
    edgeDelta,
    executionAuthority: 'NONE' as const,
    modifiesExecution: false as const,
  };
  const invalid =
    !Number.isFinite(input.originalNetExpectedR) ||
    !Number.isFinite(input.oppositeNetExpectedR) ||
    !Number.isFinite(edgeDelta) ||
    !Number.isFinite(policy.minOppositeEdgeDelta) ||
    policy.minOppositeEdgeDelta < 0;
  if (invalid) return { ...base, eligible: false, reason: 'INVALID_EVIDENCE' };
  if (!input.originalInvalidated) {
    return { ...base, eligible: false, reason: 'ORIGINAL_THESIS_STILL_VALID' };
  }
  if (input.oppositeNetExpectedR <= 0) {
    return { ...base, eligible: false, reason: 'OPPOSITE_NET_EXPECTED_R_NON_POSITIVE' };
  }
  if (edgeDelta < policy.minOppositeEdgeDelta) {
    return { ...base, eligible: false, reason: 'OPPOSITE_EDGE_DELTA_BELOW_FLOOR' };
  }
  if (!input.oppositeGovernanceEligible || input.oppositeBlockers.length > 0) {
    return { ...base, eligible: false, reason: 'OPPOSITE_GOVERNANCE_BLOCKED' };
  }
  if (input.duplicateOppositeIntent) {
    return { ...base, eligible: false, reason: 'DUPLICATE_OPPOSITE_INTENT' };
  }
  if (!input.reversalAllowedByPolicy) {
    return { ...base, eligible: false, reason: 'REVERSAL_NOT_ALLOWED_BY_POLICY' };
  }
  return { ...base, eligible: true, reason: 'SHADOW_RESCUE_CANDIDATE' };
}
