import {
  M1_FAILED_MOVE_RESCUE_POLICY_V1,
  evaluateM1FailedMoveRescue,
  type M1FailedMoveRescueInput,
} from './m1-failed-move-rescue';

function input(changes: Partial<M1FailedMoveRescueInput> = {}): M1FailedMoveRescueInput {
  return {
    originalInvalidated: true,
    originalNetExpectedR: -0.1,
    oppositeNetExpectedR: 0.45,
    oppositeGovernanceEligible: true,
    oppositeBlockers: [],
    duplicateOppositeIntent: false,
    reversalAllowedByPolicy: true,
    ...changes,
  };
}

describe('evaluateM1FailedMoveRescue', () => {
  it('keeps observing while the original thesis remains valid', () => {
    const result = evaluateM1FailedMoveRescue(input({ originalInvalidated: false }));
    expect(result).toMatchObject({
      eligible: false,
      reason: 'ORIGINAL_THESIS_STILL_VALID',
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
  });

  it('rejects an opposite edge that does not clear the versioned delta floor', () => {
    const originalNetExpectedR = 0.1;
    const oppositeNetExpectedR =
      originalNetExpectedR + M1_FAILED_MOVE_RESCUE_POLICY_V1.minOppositeEdgeDelta - 0.01;
    const result = evaluateM1FailedMoveRescue(
      input({ originalNetExpectedR, oppositeNetExpectedR }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('OPPOSITE_EDGE_DELTA_BELOW_FLOOR');
  });

  it.each([
    ['EVENT_RISK_UNVERIFIED'],
    ['EXECUTION_SPREAD_UNAVAILABLE'],
    ['M1_RELIABILITY_EARLY_LOSS_STREAK'],
  ])('rejects a rescue when the opposite side carries blocker %s', (blocker) => {
    const result = evaluateM1FailedMoveRescue(
      input({ oppositeGovernanceEligible: false, oppositeBlockers: [blocker] }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('OPPOSITE_GOVERNANCE_BLOCKED');
  });

  it('rejects duplicate opposite intent and a policy that does not allow reversal', () => {
    expect(evaluateM1FailedMoveRescue(input({ duplicateOppositeIntent: true })).reason).toBe(
      'DUPLICATE_OPPOSITE_INTENT',
    );
    expect(evaluateM1FailedMoveRescue(input({ reversalAllowedByPolicy: false })).reason).toBe(
      'REVERSAL_NOT_ALLOWED_BY_POLICY',
    );
  });

  it('emits only a shadow rescue candidate when the thesis is invalidated and opposite edge is materially stronger', () => {
    const result = evaluateM1FailedMoveRescue(input());
    expect(result).toMatchObject({
      eligible: true,
      reason: 'SHADOW_RESCUE_CANDIDATE',
      originalInvalidated: true,
      originalNetExpectedR: -0.1,
      oppositeNetExpectedR: 0.45,
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
    expect(result.edgeDelta).toBeCloseTo(0.55, 8);
  });
});
