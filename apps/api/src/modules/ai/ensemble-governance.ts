import { PlanBEnsembleScore } from './plan-b-multimodel-shadow';

export const ENSEMBLE_GOVERNANCE_VERSION = 'ensemble-governance-v3';
export const ENSEMBLE_COST_MODEL_VERSION = 'paper-broker-p90-spread-plus-25pct-slippage-v2';
export const ENSEMBLE_DRIFT_MODEL_VERSION =
  'dual-route-continuation-4599-plus-reversal-operational-v2';
export const ENSEMBLE_NET_EXPECTED_R_FLOOR = 0.08;
export const ENSEMBLE_PAPER_NET_EXPECTED_R_FLOOR = ENSEMBLE_NET_EXPECTED_R_FLOOR;
export const ENSEMBLE_SLEEVE_CORE_MIN_CLOSED_TRADES = 100;
export const ENSEMBLE_EXECUTION_SPREAD_MIN_SAMPLES = 10;
export const ENSEMBLE_EXECUTION_SPREAD_MAX_AGE_MS = 5 * 60_000;

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

export interface ExecutionSpreadEvidence {
  source: 'BROKER_OBSERVED_P90';
  spreadPrice: number;
  sampleCount: number;
  percentile: number;
  windowMinutes: number;
  latestSampleAt: string;
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
  shortHorizonMomentumAtr?: number;
  eventRisk?: EnsembleEventRiskState;
  sleeveEvidence?: EnsembleSleeveEvidence | null;
  evaluatedAt?: Date;
  executionSpreadEvidence?: ExecutionSpreadEvidence | null;
}

export interface EnsembleGovernanceDecision {
  version: typeof ENSEMBLE_GOVERNANCE_VERSION;
  costModelVersion: typeof ENSEMBLE_COST_MODEL_VERSION;
  driftModelVersion: typeof ENSEMBLE_DRIFT_MODEL_VERSION;
  grossExpectedR: number;
  estimatedExecutionCostR: number;
  executionCostSource: 'BROKER_OBSERVED_P90' | 'STATIC_DIAGNOSTIC_FALLBACK';
  executionSpreadEvidenceValid: boolean;
  executionSpreadEvidence: ExecutionSpreadEvidence | null;
  netExpectedR: number;
  paperNetExpectedRPassed: boolean;
  netExpectedRPassed: boolean;
  driftState: EnsembleDriftState;
  driftQuality: number;
  paperDriftPassed: boolean;
  driftPassed: boolean;
  sleeveState: EnsembleSleeveState;
  sleeveEvidence: EnsembleSleeveEvidence | null;
  eventRisk: EnsembleEventRiskState;
  paperExecutionEligible: boolean;
  paperExecutionBlockers: string[];
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

function reversalDriftOf(input: EnsembleGovernanceInput): {
  state: EnsembleDriftState;
  quality: number;
} {
  const momentum = finite(input.shortHorizonMomentumAtr ?? 0);
  // PAPER reversal route uses an explicit operational envelope rather than the
  // continuation-only 4,599-event MTF envelope. It stays fail-closed at the
  // boundaries and remains subject to prospective sleeve qualification before
  // any promotion beyond PAPER.
  if (
    input.confidence < 0.64 ||
    input.confidence > 0.8 ||
    input.extensionAtr < 0 ||
    input.extensionAtr > 1.15 ||
    input.volatilityScore < 0 ||
    input.volatilityScore > 0.55 ||
    input.emaSeparation < 0 ||
    input.emaSeparation > 0.5 ||
    input.mtfStrength < 0 ||
    input.mtfStrength > 1 ||
    input.rsi14 < 20 ||
    input.rsi14 > 80 ||
    momentum < 0.5 ||
    momentum > 1.5
  ) {
    return { state: 'OUT_OF_DISTRIBUTION', quality: 0.1 };
  }
  const quality = Math.max(
    0.6,
    Math.min(
      1,
      0.65 + 0.2 * Math.min(1, momentum / 0.75) + 0.15 * (1 - input.volatilityScore / 0.55),
    ),
  );
  return { state: 'NORMAL', quality };
}

function driftOf(input: EnsembleGovernanceInput): { state: EnsembleDriftState; quality: number } {
  if (input.ensemble.regime === 'REVERSAL_CONFIRMED') return reversalDriftOf(input);
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
  if (!evidence || evidence.closedTrades < ENSEMBLE_SLEEVE_CORE_MIN_CLOSED_TRADES)
    return 'COLLECTING';
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

function executionSpreadEvidenceValid(input: EnsembleGovernanceInput): boolean {
  const evidence = input.executionSpreadEvidence;
  if (!evidence) return false;
  if (!Number.isFinite(evidence.spreadPrice) || evidence.spreadPrice <= 0) return false;
  if (
    !Number.isFinite(evidence.sampleCount) ||
    evidence.sampleCount < ENSEMBLE_EXECUTION_SPREAD_MIN_SAMPLES
  )
    return false;
  if (!Number.isFinite(evidence.percentile) || evidence.percentile < 0.5 || evidence.percentile > 1)
    return false;
  const latest = new Date(evidence.latestSampleAt).getTime();
  const evaluatedAt = (input.evaluatedAt ?? new Date()).getTime();
  if (!Number.isFinite(latest) || !Number.isFinite(evaluatedAt)) return false;
  const ageMs = evaluatedAt - latest;
  return ageMs >= 0 && ageMs <= ENSEMBLE_EXECUTION_SPREAD_MAX_AGE_MS;
}

function executionCostR(input: EnsembleGovernanceInput): {
  costR: number;
  source: 'BROKER_OBSERVED_P90' | 'STATIC_DIAGNOSTIC_FALLBACK';
  evidenceValid: boolean;
} {
  const evidenceValid = executionSpreadEvidenceValid(input);
  const spread = evidenceValid
    ? input.executionSpreadEvidence!.spreadPrice
    : (SPREAD_PRICE[input.instrument.trim().toUpperCase()] ?? 0);
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  if (
    !Number.isFinite(spread) ||
    spread <= 0 ||
    !Number.isFinite(stopDistance) ||
    stopDistance <= 0
  ) {
    return {
      costR: Number.POSITIVE_INFINITY,
      source: evidenceValid ? 'BROKER_OBSERVED_P90' : 'STATIC_DIAGNOSTIC_FALLBACK',
      evidenceValid,
    };
  }
  // PAPER enters/exits across bid/ask. The authoritative execution estimate is
  // the broker-observed rolling P90 spread plus a 25% slippage/quote buffer.
  // Static spreads remain diagnostic-only and can never authorize execution.
  return {
    costR: (1.25 * spread) / stopDistance,
    source: evidenceValid ? 'BROKER_OBSERVED_P90' : 'STATIC_DIAGNOSTIC_FALLBACK',
    evidenceValid,
  };
}

export function evaluateEnsembleGovernance(
  input: EnsembleGovernanceInput,
): EnsembleGovernanceDecision {
  const grossExpectedR = input.ensemble.expectedR;
  const executionCost = executionCostR(input);
  const estimatedExecutionCostR = executionCost.costR;
  const netExpectedR = grossExpectedR - estimatedExecutionCostR;
  const paperNetExpectedRPassed =
    Number.isFinite(netExpectedR) && netExpectedR > ENSEMBLE_PAPER_NET_EXPECTED_R_FLOOR;
  const netExpectedRPassed =
    Number.isFinite(netExpectedR) && netExpectedR >= ENSEMBLE_NET_EXPECTED_R_FLOOR;
  const drift = driftOf(input);
  const driftPassed = drift.state === 'NORMAL';
  // PAPER and eventual promotion share the same drift envelope. A stressed or
  // out-of-distribution vector can still be observed in shadow mode, but it is
  // not a valid simulated execution candidate.
  const paperDriftPassed = driftPassed;
  const sleeveState = classifyEnsembleSleeveEvidence(input.sleeveEvidence);
  const eventRisk = input.eventRisk ?? 'UNVERIFIED';

  // PAPER is the evidence-collection environment. A sleeve that is still
  // COLLECTING (or on PROBATION) may continue generating real simulated
  // execution evidence, but an empirically BLOCKED sleeve must not execute.
  // CORE remains mandatory for promotion beyond PAPER.
  const paperExecutionBlockers: string[] = [];
  if (!input.ensemble.paperAdmitted) paperExecutionBlockers.push('ENSEMBLE_NOT_PAPER_ADMITTED');
  if (!input.ensemble.admitted) paperExecutionBlockers.push('ENSEMBLE_NOT_PROMOTABLE_ADMISSION');
  if (!executionCost.evidenceValid) paperExecutionBlockers.push('EXECUTION_SPREAD_UNAVAILABLE');
  if (!paperNetExpectedRPassed) paperExecutionBlockers.push('PAPER_NET_EXPECTED_R');
  if (!paperDriftPassed) paperExecutionBlockers.push(`DRIFT_${drift.state}`);
  if (sleeveState === 'BLOCKED') paperExecutionBlockers.push('SLEEVE_BLOCKED');
  if (eventRisk !== 'CLEAR') paperExecutionBlockers.push(`EVENT_RISK_${eventRisk}`);

  const blockers: string[] = [];
  if (!input.ensemble.admitted) blockers.push('ENSEMBLE_NOT_ADMITTED');
  if (!executionCost.evidenceValid) blockers.push('EXECUTION_SPREAD_UNAVAILABLE');
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
    executionCostSource: executionCost.source,
    executionSpreadEvidenceValid: executionCost.evidenceValid,
    executionSpreadEvidence: input.executionSpreadEvidence ?? null,
    netExpectedR,
    paperNetExpectedRPassed,
    netExpectedRPassed,
    driftState: drift.state,
    driftQuality: drift.quality,
    paperDriftPassed,
    driftPassed,
    sleeveState,
    sleeveEvidence: input.sleeveEvidence ?? null,
    eventRisk,
    paperExecutionEligible: paperExecutionBlockers.length === 0,
    paperExecutionBlockers,
    paperPromotionEligible: blockers.length === 0,
    blockers,
  };
}
