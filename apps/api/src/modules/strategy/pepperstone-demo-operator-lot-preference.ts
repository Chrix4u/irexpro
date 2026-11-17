/**
 * Owner-requested Pepperstone DEMO lot preference. This is an admission
 * floor, NOT a risk-budget override and NEVER an instruction to upsize.
 *
 * Applies only after the orchestrator verifies the exact server-promoted
 * external model, account owner, Pepperstone cTrader DEMO and FULL_AUTO
 * session. A broker/risk-sized proposal outside the preferred 3-4 range
 * abstains rather than silently dispatching 0.01, 0.2, 1.72 or 2 lots.
 * LIVE, internal PAPER and other DEMO brokers retain existing semantics.
 */
export const PEPPERSTONE_DEMO_OPERATOR_MIN_LOTS = 3;
export const PEPPERSTONE_DEMO_OPERATOR_MAX_LOTS = 4;
export type PepperstoneDemoOperatorLotOutcome =
  | 'NOT_APPLICABLE'
  | 'ACCEPT_3_TO_4_LOTS'
  | 'PREFERRED_MINIMUM_NOT_AFFORDABLE'
  | 'PREFERRED_MAXIMUM_EXCEEDED'
  | 'SIZE_UNPROVABLE';

export interface PepperstoneDemoOperatorLotDecision {
  applies: boolean;
  allowed: boolean;
  outcome: PepperstoneDemoOperatorLotOutcome;
  riskSizedLots: number | null;
  minimumLots: typeof PEPPERSTONE_DEMO_OPERATOR_MIN_LOTS;
  maximumLots: typeof PEPPERSTONE_DEMO_OPERATOR_MAX_LOTS;
  canIncreaseRiskOrVolume: false;
}

export function evaluatePepperstoneDemoOperatorLotPreference(input: {
  exactOwnerVerifiedPepperstoneDemoFullAuto: boolean;
  riskSizedLots: string | number;
}): PepperstoneDemoOperatorLotDecision {
  const numeric =
    typeof input.riskSizedLots === 'number'
      ? input.riskSizedLots
      : typeof input.riskSizedLots === 'string' && input.riskSizedLots.trim() !== ''
        ? Number(input.riskSizedLots)
        : NaN;
  const valid = Number.isFinite(numeric) && numeric > 0;
  const result = (
    applies: boolean,
    allowed: boolean,
    outcome: PepperstoneDemoOperatorLotOutcome,
  ): PepperstoneDemoOperatorLotDecision => ({
    applies,
    allowed,
    outcome,
    riskSizedLots: valid ? numeric : null,
    minimumLots: PEPPERSTONE_DEMO_OPERATOR_MIN_LOTS,
    maximumLots: PEPPERSTONE_DEMO_OPERATOR_MAX_LOTS,
    canIncreaseRiskOrVolume: false,
  });

  if (!input.exactOwnerVerifiedPepperstoneDemoFullAuto) {
    return result(false, true, 'NOT_APPLICABLE');
  }
  if (!valid) return result(true, false, 'SIZE_UNPROVABLE');
  if (numeric < PEPPERSTONE_DEMO_OPERATOR_MIN_LOTS) {
    return result(true, false, 'PREFERRED_MINIMUM_NOT_AFFORDABLE');
  }
  if (numeric > PEPPERSTONE_DEMO_OPERATOR_MAX_LOTS) {
    return result(true, false, 'PREFERRED_MAXIMUM_EXCEEDED');
  }
  return result(true, true, 'ACCEPT_3_TO_4_LOTS');
}
