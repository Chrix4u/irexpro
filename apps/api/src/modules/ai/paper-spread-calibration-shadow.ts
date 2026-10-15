export const PAPER_SPREAD_CALIBRATION_SHADOW_ARTIFACT = 'paper-spread-calibration-shadow-v1';
export const PAPER_SPREAD_CALIBRATION_MIN_SAMPLES = 100;
export const PAPER_SPREAD_CALIBRATION_MIN_FIXED_FRACTION = 0.25;

export type PaperSpreadSession = 'ASIA' | 'LONDON' | 'NEW_YORK' | 'ROLLOVER';

export interface PaperSpreadCalibrationHistory {
  sampleCount: number;
  p95SpreadPrice: number;
}

export interface PaperSpreadCalibrationInput {
  instrument: string;
  evaluatedAt: Date;
  fixedSpreadPrice: number;
  stopDistancePrice: number;
  history: PaperSpreadCalibrationHistory;
}

export interface PaperSpreadCalibrationDecision {
  artifact: typeof PAPER_SPREAD_CALIBRATION_SHADOW_ARTIFACT;
  instrument: string;
  session: PaperSpreadSession;
  fixedSpreadPrice: number;
  calibratedSpreadPrice: number;
  minimumSpreadFloorPrice: number;
  sampleCount: number;
  p95SpreadPrice: number | null;
  fixedCostR: number | null;
  calibratedCostR: number | null;
  costReductionR: number | null;
  reason:
    | 'CALIBRATED_P95_WITH_FLOOR'
    | 'SPARSE_HISTORY_FIXED_FALLBACK'
    | 'INVALID_HISTORY_FIXED_FALLBACK';
  executionAuthority: 'NONE';
  modifiesExecution: false;
  qualificationEvidence: false;
}

export function classifyPaperSpreadSession(evaluatedAt: Date): PaperSpreadSession {
  const hour = evaluatedAt.getUTCHours();
  if (hour >= 21) return 'ROLLOVER';
  if (hour >= 13) return 'NEW_YORK';
  if (hour >= 7) return 'LONDON';
  return 'ASIA';
}

export function evaluatePaperSpreadCalibrationShadow(
  input: PaperSpreadCalibrationInput,
): PaperSpreadCalibrationDecision {
  const session = classifyPaperSpreadSession(input.evaluatedAt);
  const fixedSpreadPrice = Number(input.fixedSpreadPrice);
  const minimumSpreadFloorPrice =
    Number.isFinite(fixedSpreadPrice) && fixedSpreadPrice > 0
      ? fixedSpreadPrice * PAPER_SPREAD_CALIBRATION_MIN_FIXED_FRACTION
      : 0;
  const sampleCount = Math.max(0, Number(input.history.sampleCount) || 0);
  const p95 = Number(input.history.p95SpreadPrice);
  const validP95 = Number.isFinite(p95) && p95 > 0;
  const validFixed = Number.isFinite(fixedSpreadPrice) && fixedSpreadPrice > 0;
  const stopDistancePrice = Number(input.stopDistancePrice);
  const validStopDistance = Number.isFinite(stopDistancePrice) && stopDistancePrice > 0;

  const buildCost = (spreadPrice: number): number | null =>
    validStopDistance && Number.isFinite(spreadPrice) && spreadPrice > 0
      ? (1.25 * spreadPrice) / stopDistancePrice
      : null;

  const base = {
    artifact:
      PAPER_SPREAD_CALIBRATION_SHADOW_ARTIFACT as typeof PAPER_SPREAD_CALIBRATION_SHADOW_ARTIFACT,
    instrument: input.instrument.trim().toUpperCase(),
    session,
    fixedSpreadPrice,
    minimumSpreadFloorPrice,
    sampleCount,
    p95SpreadPrice: validP95 ? p95 : null,
    executionAuthority: 'NONE' as const,
    modifiesExecution: false as const,
    qualificationEvidence: false as const,
  };

  const withCosts = (calibratedSpreadPrice: number) => {
    const fixedCostR = buildCost(fixedSpreadPrice);
    const calibratedCostR = buildCost(calibratedSpreadPrice);
    return {
      fixedCostR,
      calibratedCostR,
      costReductionR:
        fixedCostR !== null && calibratedCostR !== null ? fixedCostR - calibratedCostR : null,
    };
  };

  if (!validFixed || !validP95) {
    return {
      ...base,
      calibratedSpreadPrice: validFixed ? fixedSpreadPrice : 0,
      ...withCosts(validFixed ? fixedSpreadPrice : 0),
      reason: 'INVALID_HISTORY_FIXED_FALLBACK',
    };
  }

  if (sampleCount < PAPER_SPREAD_CALIBRATION_MIN_SAMPLES) {
    return {
      ...base,
      calibratedSpreadPrice: fixedSpreadPrice,
      ...withCosts(fixedSpreadPrice),
      reason: 'SPARSE_HISTORY_FIXED_FALLBACK',
    };
  }

  const calibratedSpreadPrice = Math.max(p95, minimumSpreadFloorPrice);
  return {
    ...base,
    calibratedSpreadPrice,
    ...withCosts(calibratedSpreadPrice),
    reason: 'CALIBRATED_P95_WITH_FLOOR',
  };
}
