import {
  PAPER_RESEARCH_THROUGHPUT_LOT_CAP,
  type PaperResearchThroughputInput,
  evaluatePaperResearchThroughput,
} from './paper-research-throughput';
import {
  PAPER_SPREAD_CALIBRATION_MIN_SAMPLES,
  type PaperSpreadCalibrationDecision,
} from './paper-spread-calibration-shadow';

export const PAPER_CALIBRATED_COST_RESCUE_ARTIFACT = 'paper-calibrated-cost-rescue-v1';
export const PAPER_CALIBRATED_COST_RESCUE_MIN_NET_EXPECTED_R = 0.1;

export interface PaperCalibratedCostResearchRescueInput {
  grossExpectedR: number;
  fixedNetExpectedR: number;
  researchInput: PaperResearchThroughputInput;
  calibration: PaperSpreadCalibrationDecision;
  freshBrokerSpreadAvailable?: boolean;
}

export interface PaperCalibratedCostResearchRescueDecision {
  artifact: typeof PAPER_CALIBRATED_COST_RESCUE_ARTIFACT;
  eligible: boolean;
  reason:
    | 'CALIBRATED_COST_RESEARCH_RESCUE'
    | 'INVALID_ECONOMICS'
    | 'ROLLOVER_EXCLUDED'
    | 'FRESH_BROKER_SPREAD_AUTHORITATIVE'
    | 'CALIBRATION_EVIDENCE_IMMATURE'
    | 'CALIBRATION_NOT_USABLE'
    | 'FIXED_NET_NOT_NEGATIVE'
    | 'FIXED_NET_BLOCKER_MISSING'
    | 'NO_CALIBRATED_COST_ADVANTAGE'
    | 'CALIBRATED_NET_EDGE_TOO_LOW'
    | 'UNDERLYING_RESEARCH_NOT_ELIGIBLE';
  fixedNetExpectedR: number | null;
  calibratedNetExpectedR: number | null;
  calibratedExecutionCostR: number | null;
  fixedExecutionCostR: number | null;
  costReductionR: number | null;
  underlyingResearchReason: string | null;
  executionAuthority: 'PAPER_ONLY_RESEARCH';
  qualificationEvidence: false;
  productionEligible: false;
  lotCap: typeof PAPER_RESEARCH_THROUGHPUT_LOT_CAP;
}

export function evaluatePaperCalibratedCostResearchRescue(
  input: PaperCalibratedCostResearchRescueInput,
): PaperCalibratedCostResearchRescueDecision {
  const grossExpectedR = Number(input.grossExpectedR);
  const fixedNetExpectedR = Number(input.fixedNetExpectedR);
  const fixedExecutionCostR = input.calibration.fixedCostR;
  const calibratedExecutionCostR = input.calibration.calibratedCostR;
  const costReductionR = input.calibration.costReductionR;
  const calibratedNetExpectedR =
    Number.isFinite(grossExpectedR) &&
    calibratedExecutionCostR !== null &&
    Number.isFinite(calibratedExecutionCostR)
      ? grossExpectedR - calibratedExecutionCostR
      : null;

  const decision = (
    eligible: boolean,
    reason: PaperCalibratedCostResearchRescueDecision['reason'],
    underlyingResearchReason: string | null = null,
  ): PaperCalibratedCostResearchRescueDecision => ({
    artifact: PAPER_CALIBRATED_COST_RESCUE_ARTIFACT,
    eligible,
    reason,
    fixedNetExpectedR: Number.isFinite(fixedNetExpectedR) ? fixedNetExpectedR : null,
    calibratedNetExpectedR,
    calibratedExecutionCostR,
    fixedExecutionCostR,
    costReductionR,
    underlyingResearchReason,
    executionAuthority: 'PAPER_ONLY_RESEARCH',
    qualificationEvidence: false,
    productionEligible: false,
    lotCap: PAPER_RESEARCH_THROUGHPUT_LOT_CAP,
  });

  if (
    !Number.isFinite(grossExpectedR) ||
    grossExpectedR <= 0 ||
    !Number.isFinite(fixedNetExpectedR) ||
    fixedExecutionCostR === null ||
    !Number.isFinite(fixedExecutionCostR) ||
    calibratedExecutionCostR === null ||
    !Number.isFinite(calibratedExecutionCostR) ||
    calibratedExecutionCostR < 0 ||
    calibratedNetExpectedR === null
  ) {
    return decision(false, 'INVALID_ECONOMICS');
  }

  if (input.freshBrokerSpreadAvailable) {
    return decision(false, 'FRESH_BROKER_SPREAD_AUTHORITATIVE');
  }

  if (input.calibration.session === 'ROLLOVER') {
    return decision(false, 'ROLLOVER_EXCLUDED');
  }

  if (input.calibration.sampleCount < PAPER_SPREAD_CALIBRATION_MIN_SAMPLES) {
    return decision(false, 'CALIBRATION_EVIDENCE_IMMATURE');
  }

  if (input.calibration.reason !== 'CALIBRATED_P95_WITH_FLOOR') {
    return decision(false, 'CALIBRATION_NOT_USABLE');
  }

  if (fixedNetExpectedR >= 0) {
    return decision(false, 'FIXED_NET_NOT_NEGATIVE');
  }

  if (!input.researchInput.paperExecutionBlockers.includes('PAPER_NET_EXPECTED_R')) {
    return decision(false, 'FIXED_NET_BLOCKER_MISSING');
  }

  if (
    calibratedExecutionCostR >= fixedExecutionCostR ||
    costReductionR === null ||
    !Number.isFinite(costReductionR) ||
    costReductionR <= 0
  ) {
    return decision(false, 'NO_CALIBRATED_COST_ADVANTAGE');
  }

  if (calibratedNetExpectedR < PAPER_CALIBRATED_COST_RESCUE_MIN_NET_EXPECTED_R) {
    return decision(false, 'CALIBRATED_NET_EDGE_TOO_LOW');
  }

  const normalizedResearchInput: PaperResearchThroughputInput = {
    ...input.researchInput,
    netExpectedR: calibratedNetExpectedR,
    paperExecutionBlockers: input.researchInput.paperExecutionBlockers.filter(
      (blocker) => blocker !== 'PAPER_NET_EXPECTED_R',
    ),
  };
  const underlyingResearch = evaluatePaperResearchThroughput(normalizedResearchInput);
  if (!underlyingResearch.eligible) {
    return decision(false, 'UNDERLYING_RESEARCH_NOT_ELIGIBLE', underlyingResearch.reason);
  }

  return decision(true, 'CALIBRATED_COST_RESEARCH_RESCUE', underlyingResearch.reason);
}
