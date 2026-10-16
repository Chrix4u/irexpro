export const ADAPTIVE_CURRENCY_EXPOSURE_ARTIFACT = 'adaptive-currency-exposure-v1';

export type ForexDirection = 'BUY' | 'SELL';
export type AdaptivePortfolioCapacity = 'CLEAR' | 'REDUCED' | 'BLOCKED';

export interface AdaptiveCurrencyRiskPosition {
  instrument: string;
  direction: ForexDirection;
  riskAtStop: number | null;
}

export interface AdaptiveCurrencyRiskCandidate {
  instrument: string;
  direction: ForexDirection;
  riskAtStop: number;
}

export interface AdaptiveCurrencyExposureDecision {
  artifact: typeof ADAPTIVE_CURRENCY_EXPOSURE_ARTIFACT;
  currencyRiskMap: Record<string, number>;
  candidateCurrencyRisk: Record<string, number>;
  projectedCurrencyRiskMap: Record<string, number>;
  correlatedExposureScore: number;
  diversificationQuality: number;
  largestAlignedCurrencyConcentration: number;
  sameInstrumentDirectionalRisk: number;
  riskEvidenceComplete: boolean;
  capacity: AdaptivePortfolioCapacity;
  canUpsize: boolean;
  reasons: string[];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizedInstrument(instrument: string): string | null {
  const value = instrument.trim().toUpperCase();
  return /^[A-Z]{6}$/.test(value) ? value : null;
}

export function decomposeCurrencyRisk(
  instrument: string,
  direction: ForexDirection,
  riskAtStop: number,
): Record<string, number> {
  const symbol = normalizedInstrument(instrument);
  if (!symbol || !Number.isFinite(riskAtStop) || riskAtStop <= 0) return {};
  const base = symbol.slice(0, 3);
  const quote = symbol.slice(3, 6);
  const sign = direction === 'BUY' ? 1 : -1;
  return {
    [base]: sign * riskAtStop,
    [quote]: -sign * riskAtStop,
  };
}

function addExposure(target: Record<string, number>, delta: Record<string, number>): void {
  for (const [currency, value] of Object.entries(delta)) {
    target[currency] = (target[currency] ?? 0) + value;
  }
}

export function analyzeAdaptiveCurrencyExposure(input: {
  positions: AdaptiveCurrencyRiskPosition[];
  candidate: AdaptiveCurrencyRiskCandidate;
}): AdaptiveCurrencyExposureDecision {
  const currencyRiskMap: Record<string, number> = {};
  let riskEvidenceComplete = true;
  let sameInstrumentDirectionalRisk = 0;
  const candidateSymbol = normalizedInstrument(input.candidate.instrument);

  for (const position of input.positions) {
    const symbol = normalizedInstrument(position.instrument);
    if (
      !symbol ||
      position.riskAtStop === null ||
      !Number.isFinite(position.riskAtStop) ||
      position.riskAtStop <= 0
    ) {
      riskEvidenceComplete = false;
      continue;
    }
    addExposure(
      currencyRiskMap,
      decomposeCurrencyRisk(position.instrument, position.direction, position.riskAtStop),
    );
    if (symbol === candidateSymbol && position.direction === input.candidate.direction) {
      sameInstrumentDirectionalRisk += position.riskAtStop;
    }
  }

  const candidateCurrencyRisk = decomposeCurrencyRisk(
    input.candidate.instrument,
    input.candidate.direction,
    input.candidate.riskAtStop,
  );
  const candidateValid =
    candidateSymbol !== null &&
    Number.isFinite(input.candidate.riskAtStop) &&
    input.candidate.riskAtStop > 0 &&
    Object.keys(candidateCurrencyRisk).length === 2;
  if (!candidateValid) riskEvidenceComplete = false;

  const projectedCurrencyRiskMap = { ...currencyRiskMap };
  addExposure(projectedCurrencyRiskMap, candidateCurrencyRisk);

  const candidateRisk = candidateValid ? input.candidate.riskAtStop : 1;
  let alignedLoad = 0;
  let largestAlignedCurrencyConcentration = 0;
  for (const [currency, candidateDelta] of Object.entries(candidateCurrencyRisk)) {
    const current = currencyRiskMap[currency] ?? 0;
    if (current * candidateDelta <= 0) continue;
    const ratio = Math.abs(current) / candidateRisk;
    largestAlignedCurrencyConcentration = Math.max(largestAlignedCurrencyConcentration, ratio);
    alignedLoad += Math.min(2, ratio);
  }
  const correlatedExposureScore = clamp01(alignedLoad / 2);
  const diversificationQuality = 1 - correlatedExposureScore;

  let capacity: AdaptivePortfolioCapacity;
  if (!candidateValid || correlatedExposureScore >= 0.8) capacity = 'BLOCKED';
  else if (!riskEvidenceComplete || correlatedExposureScore >= 0.35) capacity = 'REDUCED';
  else capacity = 'CLEAR';

  const reasons: string[] = [];
  if (!riskEvidenceComplete) reasons.push('RISK_AT_STOP_EVIDENCE_INCOMPLETE');
  if (correlatedExposureScore >= 0.8) reasons.push('SHARED_CURRENCY_CONCENTRATION_BLOCKED');
  else if (correlatedExposureScore >= 0.35) reasons.push('SHARED_CURRENCY_CONCENTRATION_REDUCED');
  if (!reasons.length) reasons.push('PORTFOLIO_CAPACITY_CLEAR');

  return {
    artifact: ADAPTIVE_CURRENCY_EXPOSURE_ARTIFACT,
    currencyRiskMap,
    candidateCurrencyRisk,
    projectedCurrencyRiskMap,
    correlatedExposureScore,
    diversificationQuality,
    largestAlignedCurrencyConcentration,
    sameInstrumentDirectionalRisk,
    riskEvidenceComplete,
    capacity,
    canUpsize: riskEvidenceComplete && capacity === 'CLEAR',
    reasons,
  };
}
