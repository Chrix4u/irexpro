import { PlanBEnsembleScore } from './plan-b-multimodel-shadow';

export const ENSEMBLE_GOVERNANCE_VERSION = 'ensemble-governance-v3';
export const ENSEMBLE_COST_MODEL_VERSION =
  'broker-observed-robust-tail-or-current-spread-plus-25pct-slippage-v5';
export const ENSEMBLE_DRIFT_MODEL_VERSION = 'triple-route-direction-aligned-momentum-v4';
export const ENSEMBLE_NET_EXPECTED_R_FLOOR = 0.08;
export const ENSEMBLE_PAPER_NET_EXPECTED_R_FLOOR = ENSEMBLE_NET_EXPECTED_R_FLOOR;
export const ENSEMBLE_EARLY_TRANSITION_PAPER_NET_EXPECTED_R_FLOOR = 0.2;
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
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  extensionAtr: number;
  volatilityScore: number;
  emaSeparation: number;
  mtfStrength: number;
  rsi14: number;
  /** Raw signed price change / ATR; SELL direction alignment happens inside the model. */
  shortHorizonMomentumAtr?: number;
  eventRisk?: EnsembleEventRiskState;
  sleeveEvidence?: EnsembleSleeveEvidence | null;
  evaluatedAt?: Date;
  executionSpreadEvidence?: ExecutionSpreadEvidence | null;
  /**
   * PAPER-only conservative simulation spread used when broker-native bid/ask
   * evidence is unavailable. This may authorize PAPER execution cost checks but
   * never qualifies as promotion-grade execution evidence.
   */
  paperSimulationSpreadPrice?: number;
  /** Route-specific drift envelope override for isolated PAPER research lanes. */
  driftRoute?: 'PAIRED_REVERSAL_RESEARCH';
  /**
   * Caller-scoped PAPER post-cost expectancy floor. The global 0.08R hard
   * economics floor remains the minimum, so callers can only replace a
   * stronger route default with an explicitly bounded value.
   */
  paperNetExpectedRFloorOverride?: number;
}

export interface EnsembleGovernanceDecision {
  version: typeof ENSEMBLE_GOVERNANCE_VERSION;
  costModelVersion: typeof ENSEMBLE_COST_MODEL_VERSION;
  driftModelVersion: typeof ENSEMBLE_DRIFT_MODEL_VERSION;
  grossExpectedR: number;
  estimatedExecutionCostR: number;
  executionCostSource:
    | 'BROKER_OBSERVED_P90'
    | 'PAPER_SIMULATION_SPREAD'
    | 'STATIC_DIAGNOSTIC_FALLBACK';
  executionSpreadEvidenceValid: boolean;
  /** True when PAPER has a conservative finite execution-cost source. */
  paperExecutionCostUsable?: boolean;
  executionSpreadEvidence: ExecutionSpreadEvidence | null;
  /** Explicit PAPER cost-floor provenance; absent on legacy stored decisions. */
  paperFillSpreadPrice?: number;
  effectiveSpreadPrice?: number;
  paperSpreadFloorApplied?: boolean;
  netExpectedR: number;
  paperNetExpectedRPassed: boolean;
  netExpectedRPassed: boolean;
  driftState: EnsembleDriftState;
  driftQuality: number;
  /** Additive diagnostics for why the active drift envelope classified this vector. */
  driftDiagnostics?: string[];
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

function directionalMomentum(input: EnsembleGovernanceInput): number {
  const rawMomentum = finite(input.shortHorizonMomentumAtr ?? 0);
  return input.direction === 'SELL' ? -rawMomentum : rawMomentum;
}

function hardRangeDiagnostic(
  feature: string,
  value: number,
  low: number,
  high: number,
): string | null {
  if (!Number.isFinite(value)) return `${feature}:INVALID`;
  if (value < low) return `${feature}:HARD_LOW`;
  if (value > high) return `${feature}:HARD_HIGH`;
  return null;
}

function routeDriftDiagnostics(input: EnsembleGovernanceInput): string[] {
  const momentum = directionalMomentum(input);
  if (
    input.driftRoute === 'PAIRED_REVERSAL_RESEARCH' ||
    input.ensemble.regime === 'REVERSAL_CONFIRMED'
  ) {
    return [
      hardRangeDiagnostic('confidence', input.confidence, 0.64, 0.8),
      hardRangeDiagnostic('extensionAtr', input.extensionAtr, 0, 1.15),
      hardRangeDiagnostic('volatilityScore', input.volatilityScore, 0, 0.55),
      hardRangeDiagnostic('emaSeparation', input.emaSeparation, 0, 0.5),
      hardRangeDiagnostic('mtfStrength', input.mtfStrength, 0, 1),
      hardRangeDiagnostic('rsi14', input.rsi14, 20, 80),
      hardRangeDiagnostic('directionalMomentumAtr', momentum, 0.5, 1.5),
    ].filter((diagnostic): diagnostic is string => diagnostic !== null);
  }
  if (input.ensemble.strategyRoute === 'EARLY_TRANSITION') {
    const diagnostics = [
      hardRangeDiagnostic('confidence', input.confidence, 0.64, 0.8),
      hardRangeDiagnostic('extensionAtr', input.extensionAtr, 0, 0.9),
      hardRangeDiagnostic('volatilityScore', input.volatilityScore, 0, 0.55),
      hardRangeDiagnostic('emaSeparation', input.emaSeparation, 0.12, 0.5),
      hardRangeDiagnostic('rsi14', input.rsi14, 20, 80),
      hardRangeDiagnostic('directionalMomentumAtr', momentum, -0.5, 1.5),
    ].filter((diagnostic): diagnostic is string => diagnostic !== null);
    if (!Number.isFinite(input.mtfStrength)) diagnostics.push('mtfStrength:INVALID');
    else if (input.mtfStrength < 0) diagnostics.push('mtfStrength:HARD_LOW');
    else if (input.mtfStrength >= 0.12) diagnostics.push('mtfStrength:HARD_HIGH');
    return diagnostics;
  }

  const rawValues = {
    confidence: input.confidence,
    extensionAtr: input.extensionAtr,
    volatilityScore: input.volatilityScore,
    emaSeparation: input.emaSeparation,
    mtfStrength: input.mtfStrength,
    rsi14: input.rsi14,
  };
  const diagnostics: string[] = [];
  for (const key of Object.keys(DRIFT_ENVELOPE) as Array<keyof typeof DRIFT_ENVELOPE>) {
    const raw = rawValues[key];
    const bounds = DRIFT_ENVELOPE[key];
    if (!Number.isFinite(raw)) {
      diagnostics.push(`${key}:INVALID`);
      continue;
    }
    if (raw < bounds.hardLow) diagnostics.push(`${key}:HARD_LOW`);
    else if (raw > bounds.hardHigh) diagnostics.push(`${key}:HARD_HIGH`);
    else if (raw < bounds.stressedLow) diagnostics.push(`${key}:STRESSED_LOW`);
    else if (raw > bounds.stressedHigh) diagnostics.push(`${key}:STRESSED_HIGH`);
  }
  return diagnostics;
}

function reversalDriftOf(input: EnsembleGovernanceInput): {
  state: EnsembleDriftState;
  quality: number;
} {
  const momentum = directionalMomentum(input);
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

function earlyTransitionDriftOf(input: EnsembleGovernanceInput): {
  state: EnsembleDriftState;
  quality: number;
} {
  const momentum = directionalMomentum(input);
  if (
    input.confidence < 0.64 ||
    input.confidence > 0.8 ||
    input.extensionAtr < 0 ||
    input.extensionAtr > 0.9 ||
    input.volatilityScore < 0 ||
    input.volatilityScore > 0.55 ||
    input.emaSeparation < 0.12 ||
    input.emaSeparation > 0.5 ||
    input.mtfStrength < 0 ||
    input.mtfStrength >= 0.12 ||
    input.rsi14 < 20 ||
    input.rsi14 > 80 ||
    momentum < -0.5 ||
    momentum > 1.5
  ) {
    return { state: 'OUT_OF_DISTRIBUTION', quality: 0.1 };
  }
  const structureQuality = Math.min(1, input.emaSeparation / 0.2);
  const volatilityQuality = 1 - Math.min(1, input.volatilityScore / 0.55);
  return {
    state: 'NORMAL',
    quality: Math.max(0.6, Math.min(1, 0.55 + 0.25 * structureQuality + 0.2 * volatilityQuality)),
  };
}

function driftOf(input: EnsembleGovernanceInput): { state: EnsembleDriftState; quality: number } {
  if (input.driftRoute === 'PAIRED_REVERSAL_RESEARCH') return reversalDriftOf(input);
  if (input.ensemble.regime === 'REVERSAL_CONFIRMED') return reversalDriftOf(input);
  if (input.ensemble.strategyRoute === 'EARLY_TRANSITION') return earlyTransitionDriftOf(input);
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
  source: 'BROKER_OBSERVED_P90' | 'PAPER_SIMULATION_SPREAD' | 'STATIC_DIAGNOSTIC_FALLBACK';
  evidenceValid: boolean;
  paperCostUsable: boolean;
  spreadPrice: number;
  paperFallbackUsed: boolean;
} {
  const evidenceValid = executionSpreadEvidenceValid(input);
  const simulationSpread = Number(input.paperSimulationSpreadPrice ?? 0);
  const simulationSpreadValid = Number.isFinite(simulationSpread) && simulationSpread > 0;
  const spread = evidenceValid
    ? input.executionSpreadEvidence!.spreadPrice
    : simulationSpreadValid
      ? simulationSpread
      : 0;
  const source = evidenceValid
    ? 'BROKER_OBSERVED_P90'
    : simulationSpreadValid
      ? 'PAPER_SIMULATION_SPREAD'
      : 'STATIC_DIAGNOSTIC_FALLBACK';
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  const spreadUsable = Number.isFinite(spread) && spread > 0;
  if (!spreadUsable || !Number.isFinite(stopDistance) || stopDistance <= 0) {
    return {
      costR: Number.POSITIVE_INFINITY,
      source,
      evidenceValid,
      paperCostUsable: false,
      spreadPrice: spreadUsable ? spread : 0,
      paperFallbackUsed: !evidenceValid && simulationSpreadValid,
    };
  }
  // Robust broker-observed tail evidence remains the only promotion-grade cost evidence. When it
  // is unavailable, PAPER may continue evidence collection using the same
  // conservative per-pair spread assumption as the PAPER broker. The fallback
  // remains explicitly non-promotable because evidenceValid stays false.
  return {
    costR: (1.25 * spread) / stopDistance,
    source,
    evidenceValid,
    paperCostUsable: evidenceValid || simulationSpreadValid,
    spreadPrice: spread,
    paperFallbackUsed: !evidenceValid && simulationSpreadValid,
  };
}

export function evaluateEnsembleGovernance(
  input: EnsembleGovernanceInput,
): EnsembleGovernanceDecision {
  const grossExpectedR = input.ensemble.expectedR;
  const executionCost = executionCostR(input);
  const estimatedExecutionCostR = executionCost.costR;
  const netExpectedR = grossExpectedR - estimatedExecutionCostR;
  const defaultPaperNetExpectedRFloor =
    input.ensemble.strategyRoute === 'EARLY_TRANSITION'
      ? ENSEMBLE_EARLY_TRANSITION_PAPER_NET_EXPECTED_R_FLOOR
      : ENSEMBLE_PAPER_NET_EXPECTED_R_FLOOR;
  const overridePaperNetExpectedRFloor = Number.isFinite(input.paperNetExpectedRFloorOverride)
    ? Math.max(ENSEMBLE_NET_EXPECTED_R_FLOOR, Number(input.paperNetExpectedRFloorOverride))
    : null;
  const paperNetExpectedRFloor = overridePaperNetExpectedRFloor ?? defaultPaperNetExpectedRFloor;
  const paperNetExpectedRPassed =
    Number.isFinite(netExpectedR) && netExpectedR >= paperNetExpectedRFloor;
  const netExpectedRPassed =
    Number.isFinite(netExpectedR) && netExpectedR >= ENSEMBLE_NET_EXPECTED_R_FLOOR;
  const drift = driftOf(input);
  const driftDiagnostics = routeDriftDiagnostics(input);
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
  if (!input.ensemble.admitted && input.ensemble.strategyRoute !== 'EARLY_TRANSITION')
    paperExecutionBlockers.push('ENSEMBLE_NOT_PROMOTABLE_ADMISSION');
  if (!executionCost.paperCostUsable) paperExecutionBlockers.push('EXECUTION_SPREAD_UNAVAILABLE');
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
    paperExecutionCostUsable: executionCost.paperCostUsable,
    executionSpreadEvidence: input.executionSpreadEvidence ?? null,
    paperFillSpreadPrice: executionCost.spreadPrice,
    effectiveSpreadPrice: executionCost.spreadPrice,
    paperSpreadFloorApplied: executionCost.paperFallbackUsed,
    netExpectedR,
    paperNetExpectedRPassed,
    netExpectedRPassed,
    driftState: drift.state,
    driftQuality: drift.quality,
    driftDiagnostics,
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
