import { PlanBEnsembleScore } from './plan-b-multimodel-shadow';

export const ENSEMBLE_GOVERNANCE_VERSION = 'ensemble-governance-v1';
export const ENSEMBLE_COST_MODEL_VERSION = 'paper-spread-plus-25pct-slippage-v1';
export const ENSEMBLE_DRIFT_MODEL_VERSION = 'development-envelope-4599-v1';

export type EnsembleDriftState = 'NORMAL' | 'STRESSED' | 'OUT_OF_DISTRIBUTION';
export type EnsembleSleeveState = 'COLLECTING' | 'CORE' | 'PROBATION' | 'BLOCKED';
export type EnsembleEventRiskState = 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';

export interface EnsembleSleeveEvidence {
  closedTrades: number;
  profitFactor: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  positiveWindowFraction: number | null;
}

export interface EnsembleGovernanceInput {
  ensemble: PlanBEnsembleScore;
  instrument: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  extensionAtr: number;
  volatilityScore: number;
  emaSeparation: number;
  mtfStrength: number;
  rsi14: number;
  eventRisk?: EnsembleEventRiskState;
  sleeveEvidence?: EnsembleSleeveEvidence | null;
}

export interface EnsembleGovernanceDecision {
  version: typeof ENSEMBLE_GOVERNANCE_VERSION;
  costModelVersion: typeof ENSEMBLE_COST_MODEL_VERSION;
  driftModelVersion: typeof ENSEMBLE_DRIFT_MODEL_VERSION;
  grossExpectedR: number;
  estimatedExecutionCostR: number;
  netExpectedR: number;
  netExpectedRPassed: boolean;
  driftState: EnsembleDriftState;
  driftQuality: number;
  driftPassed: boolean;
  sleeveState: EnsembleSleeveState;
  sleeveEvidence: EnsembleSleeveEvidence | null;
  eventRisk: EnsembleEventRiskState;
  paperPromotionEligible: boolean;
  blockers: string[];
}

const SPREAD_PRICE: Record<string, number> = Object.freeze({
  EURUSD: 0.0001,
  GBPUSD: 0.00012,
  USDJPY: 0.01,
  AUDUSD: 0.0001,
  USDCAD: 0.00012,
  USDCHF: 0.00012,
});

// Frozen empirical envelope from the 4,599-event development corpus.
// These values are governance diagnostics only; they never alter the original
// prospective ensemble admission label.
const DRIFT_ENVELOPE = Object.freeze({
  confidence: {
    stressedLow: 0.641116,
    stressedHigh: 0.738567,
    hardLow: 0.640079,
    hardHigh: 0.751451,
  },
  extensionAtr: {
    stressedLow: 0.382252,
    stressedHigh: 1.49434,
    hardLow: 0.190896,
    hardHigh: 1.499639,
  },
  volatilityScore: {
    stressedLow: 0.062919,
    stressedHigh: 0.516568,
    hardLow: 0.048258,
    hardHigh: 0.720472,
  },
  emaSeparation: {
    stressedLow: 0.084885,
    stressedHigh: 0.717981,
    hardLow: 0.050248,
    hardHigh: 0.84442,
  },
  mtfStrength: { stressedLow: 0.04254, stressedHigh: 1.0, hardLow: 0.004236, hardHigh: 1.0 },
  rsi14: {
    stressedLow: 34.172718,
    stressedHigh: 65.900003,
    hardLow: 32.222943,
    hardHigh: 68.518704,
  },
});

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function driftOf(input: EnsembleGovernanceInput): { state: EnsembleDriftState; quality: number } {
  const values = {
    confidence: finite(input.confidence),
    extensionAtr: finite(input.extensionAtr),
    volatilityScore: finite(input.volatilityScore),
    emaSeparation: finite(input.emaSeparation),
    mtfStrength: finite(input.mtfStrength),
    rsi14: finite(input.rsi14),
  };

  let stressed = 0;
  for (const key of Object.keys(DRIFT_ENVELOPE) as Array<keyof typeof DRIFT_ENVELOPE>) {
    const value = values[key];
    const bounds = DRIFT_ENVELOPE[key];
    if (value < bounds.hardLow || value > bounds.hardHigh) {
      return { state: 'OUT_OF_DISTRIBUTION', quality: 0.1 };
    }
    if (value < bounds.stressedLow || value > bounds.stressedHigh) stressed += 1;
  }

  if (stressed > 0) {
    return { state: 'STRESSED', quality: Math.max(0.55, 1 - stressed * 0.12) };
  }
  return { state: 'NORMAL', quality: 1 };
}

export function classifyEnsembleSleeveEvidence(
  evidence?: EnsembleSleeveEvidence | null,
): EnsembleSleeveState {
  if (!evidence || evidence.closedTrades < 100) return 'COLLECTING';
  if (
    evidence.profitFactor == null ||
    evidence.sharpe == null ||
    evidence.maxDrawdown == null ||
    evidence.positiveWindowFraction == null
  ) {
    return 'COLLECTING';
  }
  if (evidence.profitFactor < 1 || evidence.maxDrawdown > 0.12) return 'BLOCKED';
  if (
    evidence.profitFactor < 1.15 ||
    evidence.sharpe < 1 ||
    evidence.positiveWindowFraction < 0.6
  ) {
    return 'PROBATION';
  }
  return 'CORE';
}

function executionCostR(input: EnsembleGovernanceInput): number {
  const spread = SPREAD_PRICE[input.instrument.trim().toUpperCase()] ?? 0;
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  if (
    !Number.isFinite(spread) ||
    spread <= 0 ||
    !Number.isFinite(stopDistance) ||
    stopDistance <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  // PAPER enters/exits across bid/ask. A 25% buffer above the fixed spread
  // represents conservative slippage/quote uncertainty for promotion checks.
  return (1.25 * spread) / stopDistance;
}

export function evaluateEnsembleGovernance(
  input: EnsembleGovernanceInput,
): EnsembleGovernanceDecision {
  const grossExpectedR = input.ensemble.expectedR;
  const estimatedExecutionCostR = executionCostR(input);
  const netExpectedR = grossExpectedR - estimatedExecutionCostR;
  const netExpectedRPassed = Number.isFinite(netExpectedR) && netExpectedR >= 0.08;
  const drift = driftOf(input);
  const driftPassed = drift.state === 'NORMAL';
  const sleeveState = classifyEnsembleSleeveEvidence(input.sleeveEvidence);
  const eventRisk = input.eventRisk ?? 'UNVERIFIED';

  const blockers: string[] = [];
  if (!input.ensemble.admitted) blockers.push('ENSEMBLE_NOT_ADMITTED');
  if (!netExpectedRPassed) blockers.push('NET_EXPECTED_R');
  if (!driftPassed) blockers.push(`DRIFT_${drift.state}`);
  if (sleeveState !== 'CORE') blockers.push(`SLEEVE_${sleeveState}`);
  if (eventRisk !== 'CLEAR') blockers.push(`EVENT_RISK_${eventRisk}`);

  return {
    version: ENSEMBLE_GOVERNANCE_VERSION,
    costModelVersion: ENSEMBLE_COST_MODEL_VERSION,
    driftModelVersion: ENSEMBLE_DRIFT_MODEL_VERSION,
    grossExpectedR,
    estimatedExecutionCostR,
    netExpectedR,
    netExpectedRPassed,
    driftState: drift.state,
    driftQuality: drift.quality,
    driftPassed,
    sleeveState,
    sleeveEvidence: input.sleeveEvidence ?? null,
    eventRisk,
    paperPromotionEligible: blockers.length === 0,
    blockers,
  };
}
