export type PaperAllocationConfidenceTier =
  | 'BASE'
  | 'STRONG'
  | 'VERY_STRONG'
  | 'EXCEPTIONAL'
  | 'ELITE'
  | 'RESEARCH';

export interface PaperAllocationSizingPolicyInput {
  executionMode: string;
  brokerAccountType: string | null;
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
 * allocation-risk budget and retain any explicit server-provided lot upper
 * bound. Qualified PAPER routes may remain allocation-aware. The durable risk
 * profile remains the final percentage authority and may only reduce these
 * requested percentages.
 */
export function paperAllocationRiskTargetPercent(tier: PaperAllocationConfidenceTier): number {
  switch (tier) {
    case 'VERY_STRONG':
    case 'EXCEPTIONAL':
    case 'ELITE':
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
 * Decide whether allocation-aware sizing may replace legacy micro-lot
 * ceilings for promoted non-LIVE execution. This function does not size a trade; it only selects the capital
 * base and requested risk target consumed by PositionSizingService.
 *
 * Fail-closed properties:
 *  - enabled only on a DEMO broker account; the executionMode may be PAPER_ONLY, SEMI_AUTO or FULL_AUTO;
 *  - requires a positive finite explicit AI allocation;
 *  - requires a positive finite broker equity;
 *  - risk capital never exceeds current broker equity;
 *  - qualified PAPER preserves the model-provided dynamic AI lot ceiling;
 *  - the legacy profile lot ceiling may be removed for allocation-aware PAPER;
 *  - RESEARCH PAPER keeps the explicit AI lot upper bound as a hard ceiling;
 *  - stop-distance risk, broker min/max/step, margin, allocation and the
 *    durable maxTradeRiskPercent remain authoritative.
 */
export function paperAllocationSizingPolicy(
  input: PaperAllocationSizingPolicyInput,
): PaperAllocationSizingPolicyDecision {
  const requestedRiskPercent = paperAllocationRiskTargetPercent(input.confidenceTier);

  if (
    input.brokerAccountType !== 'DEMO' ||
    !['PAPER_ONLY', 'SEMI_AUTO', 'FULL_AUTO'].includes(input.executionMode)
  ) {
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
    removeAiLotCeiling: false,
    removeProfileLotCeiling: true,
    reason: 'ALLOCATION_AWARE_PAPER',
  };
}
