export type PaperAllocationConfidenceTier =
  | 'BASE'
  | 'STRONG'
  | 'VERY_STRONG'
  | 'EXCEPTIONAL'
  | 'RESEARCH';

export interface PaperAllocationSizingPolicyInput {
  executionMode: string;
  allocatedCapital: number | null;
  brokerEquity: number;
  confidenceTier: PaperAllocationConfidenceTier;
}

export interface PaperAllocationSizingPolicyDecision {
  enabled: boolean;
  riskCapitalBase: number | null;
  requestedRiskPercent: number;
  removeAiLotCeiling: boolean;
  removeProfileLotCeiling: boolean;
  reason:
    | 'ALLOCATION_AWARE_PAPER'
    | 'NON_PAPER_EXECUTION'
    | 'INVALID_ALLOCATION'
    | 'INVALID_BROKER_EQUITY';
}

/**
 * PAPER-only risk target. Research routes intentionally receive a smaller
 * budget than qualified routes, but are no longer forced to an arbitrary
 * fixed 0.01-lot quantity. The durable risk profile remains the final
 * percentage authority and may only reduce these requested percentages.
 */
export function paperAllocationRiskTargetPercent(tier: PaperAllocationConfidenceTier): number {
  switch (tier) {
    case 'VERY_STRONG':
    case 'EXCEPTIONAL':
      return 2.5;
    case 'RESEARCH':
      return 1;
    case 'BASE':
    case 'STRONG':
    default:
      return 2;
  }
}

/**
 * Decide whether allocation-aware sizing may replace the legacy PAPER lot
 * ceilings. This function does not size a trade; it only selects the capital
 * base and requested risk target consumed by PositionSizingService.
 *
 * Fail-closed properties:
 *  - never enabled outside PAPER_ONLY;
 *  - requires a positive finite explicit AI allocation;
 *  - requires a positive finite broker equity;
 *  - risk capital never exceeds current broker equity;
 *  - fixed AI/profile lot ceilings may be ignored only in PAPER, leaving
 *    stop-distance risk, broker min/max/step, margin, allocation and the
 *    durable maxTradeRiskPercent as the actual authorities.
 */
export function paperAllocationSizingPolicy(
  input: PaperAllocationSizingPolicyInput,
): PaperAllocationSizingPolicyDecision {
  const requestedRiskPercent = paperAllocationRiskTargetPercent(input.confidenceTier);

  if (input.executionMode !== 'PAPER_ONLY') {
    return {
      enabled: false,
      riskCapitalBase: null,
      requestedRiskPercent,
      removeAiLotCeiling: false,
      removeProfileLotCeiling: false,
      reason: 'NON_PAPER_EXECUTION',
    };
  }

  if (!Number.isFinite(input.allocatedCapital) || (input.allocatedCapital ?? 0) <= 0) {
    return {
      enabled: false,
      riskCapitalBase: null,
      requestedRiskPercent,
      removeAiLotCeiling: false,
      removeProfileLotCeiling: false,
      reason: 'INVALID_ALLOCATION',
    };
  }

  if (!Number.isFinite(input.brokerEquity) || input.brokerEquity <= 0) {
    return {
      enabled: false,
      riskCapitalBase: null,
      requestedRiskPercent,
      removeAiLotCeiling: false,
      removeProfileLotCeiling: false,
      reason: 'INVALID_BROKER_EQUITY',
    };
  }

  return {
    enabled: true,
    riskCapitalBase: Math.min(input.allocatedCapital as number, input.brokerEquity),
    requestedRiskPercent,
    removeAiLotCeiling: true,
    removeProfileLotCeiling: true,
    reason: 'ALLOCATION_AWARE_PAPER',
  };
}
