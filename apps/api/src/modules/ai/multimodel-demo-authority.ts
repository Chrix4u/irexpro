import type { HighConvictionOverlay } from './high-conviction-overlay';
import type { M1TacticalCandidate } from './m1-tactical-candidate';
import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';
import type { M1TacticalRoute } from './m1-tactical-route';
import type { EnsembleGovernanceDecision } from './ensemble-governance';
import type { PlanBEnsembleScore } from './plan-b-multimodel-shadow';
import type { V8ShadowMetaInput } from './v8-shadow-meta-scorer';

export const MULTIMODEL_DEMO_ENGINE_CODE = 'irexpro-multimodel-ensemble-v1';

export interface MultimodelDemoAuthorityInput {
  ensemble: Pick<PlanBEnsembleScore, 'paperAdmitted' | 'ensembleScore' | 'strategyRoute'> &
    Partial<
      Pick<
        PlanBEnsembleScore,
        | 'regimeAllowed'
        | 'reasons'
        | 'directionQuality'
        | 'tradeQuality'
        | 'exitQuality'
        | 'sessionQuality'
        | 'portfolioQuality'
      >
    >;
  governance: Pick<
    EnsembleGovernanceDecision,
    | 'paperExecutionEligible'
    | 'paperExecutionBlockers'
    | 'netExpectedR'
    | 'paperNetExpectedRPassed'
    | 'paperExecutionCostUsable'
    | 'eventRisk'
    | 'sleeveState'
    | 'driftState'
  > &
    Partial<Pick<EnsembleGovernanceDecision, 'executionSpreadEvidenceValid'>>;
  trainedExpert: HighConvictionOverlay;
  candidateDirection: 'BUY' | 'SELL';
  m1TimingRoute: M1TacticalRoute;
  forecastEconomicsShadowOnlyDemo?: boolean;
  candidateConfidence?: number;
}

export type MultimodelDemoAuthorityPath =
  | 'PRIMARY_PLAN_B'
  | 'FORECAST_SHADOW_CONSENSUS'
  | 'HIGH_CONVICTION_RESCUE'
  | 'BLOCKED';

export interface MultimodelDemoAuthorityDecision {
  executable: boolean;
  authorityPath: MultimodelDemoAuthorityPath;
  rescueVolumeCap: number | null;
  expertConflictVolumeCap: number | null;
  primaryEngineCode: typeof MULTIMODEL_DEMO_ENGINE_CODE;
  trainedExpertConfirmed: boolean;
  trainedExpertOpposed: boolean;
  m1TimingRoute: M1TacticalRoute;
  blockers: string[];
  forecastEconomicsShadow: {
    enabled: boolean;
    activated: boolean;
    originalPlanBReasons: string[];
    originalGovernanceBlockers: string[];
    historicalForecastsRemainObservable: true;
    requiresFreshUnanimousExpertAgreement: true;
  };
}

const HIGH_CONVICTION_RESCUE_CONFIDENCE_FLOOR = 0.7;
const HIGH_CONVICTION_RESCUE_NET_EXPECTED_R_FLOOR = 0.2;
const HIGH_CONVICTION_RESCUE_ALLOWED_BLOCKERS = new Set([
  'ENSEMBLE_NOT_PAPER_ADMITTED',
  'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
  'DRIFT_STRESSED',
  'DRIFT_OUT_OF_DISTRIBUTION',
]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function confirmedReversalTimingConsistent(input: MultimodelDemoAuthorityInput): boolean {
  if (input.ensemble.strategyRoute !== 'CONFIRMED_REVERSAL') return true;
  if (input.m1TimingRoute === 'M1_CONFIRMED_REVERSAL') return true;
  if (input.m1TimingRoute !== 'M1_EARLY_TRANSITION') return false;

  // Plan-B and M1 intentionally use independent reversal definitions. When
  // Plan-B has already passed full admission/governance, accept a same-side
  // M1 early-transition label as reversal timing confirmation only when the
  // broker-native trained experts are unanimously aligned at high confidence.
  // This bridges a semantic label mismatch without weakening risk/economics.
  const longVotes = input.trainedExpert.longVotes ?? 0;
  const shortVotes = input.trainedExpert.shortVotes ?? 0;
  const totalVotes = longVotes + shortVotes;
  const directionalVotes = input.candidateDirection === 'BUY' ? longVotes : shortVotes;
  const confidence = input.trainedExpert.ensembleConfidence ?? 0;

  return (
    input.trainedExpert.allBrokerNative === true &&
    input.trainedExpert.direction === input.candidateDirection &&
    totalVotes >= 3 &&
    directionalVotes === totalVotes &&
    confidence >= HIGH_CONVICTION_RESCUE_CONFIDENCE_FLOOR
  );
}

function trainedExpertStronglyOpposes(input: MultimodelDemoAuthorityInput): boolean {
  const direction = input.trainedExpert.direction;
  if (!direction || direction === input.candidateDirection) return false;

  const longVotes = input.trainedExpert.longVotes ?? 0;
  const shortVotes = input.trainedExpert.shortVotes ?? 0;
  const totalVotes = longVotes + shortVotes;
  const expertDirectionalVotes = direction === 'BUY' ? longVotes : shortVotes;
  const confidence = input.trainedExpert.ensembleConfidence ?? 0;

  return (
    input.trainedExpert.allBrokerNative === true &&
    totalVotes >= 3 &&
    expertDirectionalVotes === totalVotes &&
    confidence >= HIGH_CONVICTION_RESCUE_CONFIDENCE_FLOOR
  );
}

function earlyTransitionTimingConsistent(input: MultimodelDemoAuthorityInput): boolean {
  return (
    input.ensemble.strategyRoute !== 'EARLY_TRANSITION' ||
    input.m1TimingRoute === 'M1_EARLY_TRANSITION'
  );
}

function trendContinuationTimingConsistent(input: MultimodelDemoAuthorityInput): boolean {
  return (
    input.ensemble.strategyRoute !== 'TREND_CONTINUATION' ||
    input.m1TimingRoute === 'M1_TREND_CONTINUATION'
  );
}

function highConvictionRescueEligible(input: MultimodelDemoAuthorityInput): boolean {
  // Realized DEMO + shadow evidence currently supports rescue only for the
  // EARLY_TRANSITION sleeve. Trend-continuation and confirmed-reversal must
  // qualify through the ordinary Plan-B + M1 timing path rather than using
  // trained-expert unanimity to bypass failed admission/drift.
  if (input.ensemble.strategyRoute !== 'EARLY_TRANSITION') return false;

  const longVotes = input.trainedExpert.longVotes ?? 0;
  const shortVotes = input.trainedExpert.shortVotes ?? 0;
  const totalVotes = longVotes + shortVotes;
  const directionalVotes = input.candidateDirection === 'BUY' ? longVotes : shortVotes;
  const confidence = input.trainedExpert.ensembleConfidence ?? 0;
  const onlyRelaxableBlockers = input.governance.paperExecutionBlockers.every((blocker) =>
    HIGH_CONVICTION_RESCUE_ALLOWED_BLOCKERS.has(blocker),
  );

  return (
    confirmedReversalTimingConsistent(input) &&
    earlyTransitionTimingConsistent(input) &&
    trendContinuationTimingConsistent(input) &&
    input.m1TimingRoute !== 'ABSTAIN' &&
    input.trainedExpert.allBrokerNative === true &&
    input.trainedExpert.direction === input.candidateDirection &&
    totalVotes >= 3 &&
    directionalVotes === totalVotes &&
    confidence >= HIGH_CONVICTION_RESCUE_CONFIDENCE_FLOOR &&
    Number.isFinite(input.governance.netExpectedR) &&
    input.governance.netExpectedR >= HIGH_CONVICTION_RESCUE_NET_EXPECTED_R_FLOOR &&
    input.governance.paperNetExpectedRPassed === true &&
    input.governance.paperExecutionCostUsable === true &&
    input.governance.eventRisk === 'CLEAR' &&
    input.governance.sleeveState !== 'BLOCKED' &&
    onlyRelaxableBlockers
  );
}

const FORECAST_REASONS = new Set(['EXPECTED_R', 'META_EXPECTED_VALUE']);
const FORECAST_GOVERNANCE_BLOCKERS = new Set([
  'PAPER_NET_EXPECTED_R',
  'ENSEMBLE_NOT_PAPER_ADMITTED',
  'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
]);

function forecastShadowConsensusEligible(input: MultimodelDemoAuthorityInput): boolean {
  const e = input.ensemble;
  const g = input.governance;
  const m = input.trainedExpert;
  const reasons = e.reasons ?? [];
  const forecastVeto =
    reasons.some((reason) => FORECAST_REASONS.has(reason)) ||
    g.paperExecutionBlockers.includes('PAPER_NET_EXPECTED_R');
  const economicalOnly =
    (e.paperAdmitted ||
      (reasons.length > 0 && reasons.every((reason) => FORECAST_REASONS.has(reason)))) &&
    g.paperExecutionBlockers.length > 0 &&
    g.paperExecutionBlockers.every((reason) => FORECAST_GOVERNANCE_BLOCKERS.has(reason));
  const quality =
    e.regimeAllowed === true &&
    Number.isFinite(input.candidateConfidence) &&
    input.candidateConfidence! >= 0.64 &&
    Number.isFinite(e.directionQuality) &&
    e.directionQuality! >= 0.55 &&
    Number.isFinite(e.tradeQuality) &&
    e.tradeQuality! >= 0.48 &&
    Number.isFinite(e.exitQuality) &&
    e.exitQuality! >= 0.48 &&
    Number.isFinite(e.sessionQuality) &&
    e.sessionQuality! >= 0.5 &&
    Number.isFinite(e.portfolioQuality) &&
    e.portfolioQuality! >= 0.35;
  const allVotes = (m.longVotes ?? 0) + (m.shortVotes ?? 0);
  const sameVotes = input.candidateDirection === 'BUY' ? m.longVotes : m.shortVotes;
  const agrees =
    m.allBrokerNative === true &&
    m.state !== 'UNAVAILABLE' &&
    m.state !== 'STALE' &&
    m.direction === input.candidateDirection &&
    Number.isFinite(m.freshnessSeconds) &&
    m.freshnessSeconds! >= 0 &&
    m.freshnessSeconds! <= 90 &&
    Number.isFinite(m.ensembleConfidence) &&
    m.ensembleConfidence! >= 0.7 &&
    allVotes >= 3 &&
    sameVotes === allVotes;
  const independentSafety =
    g.executionSpreadEvidenceValid === true &&
    g.paperExecutionCostUsable === true &&
    g.eventRisk === 'CLEAR' &&
    g.driftState === 'NORMAL' &&
    g.sleeveState !== 'BLOCKED' &&
    e.strategyRoute !== 'EARLY_TRANSITION' &&
    input.m1TimingRoute !== 'ABSTAIN' &&
    confirmedReversalTimingConsistent(input) &&
    trendContinuationTimingConsistent(input);
  return (
    input.forecastEconomicsShadowOnlyDemo === true &&
    forecastVeto &&
    economicalOnly &&
    quality &&
    agrees &&
    independentSafety
  );
}

export function evaluateMultimodelDemoAuthority(
  input: MultimodelDemoAuthorityInput,
): MultimodelDemoAuthorityDecision {
  const blockers: string[] = [];

  if (!input.ensemble.paperAdmitted) {
    blockers.push('MULTIMODEL_PLAN_B_NOT_ADMITTED');
  }
  if (!input.governance.paperExecutionEligible) {
    blockers.push('MULTIMODEL_GOVERNANCE_BLOCKED', ...input.governance.paperExecutionBlockers);
  }
  const trainedExpertOpposed = trainedExpertStronglyOpposes(input);
  if (!confirmedReversalTimingConsistent(input)) {
    blockers.push('MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED');
  }
  if (!earlyTransitionTimingConsistent(input)) {
    blockers.push('MULTIMODEL_EARLY_TRANSITION_NOT_M1_CONFIRMED');
  }
  if (!trendContinuationTimingConsistent(input)) {
    blockers.push('MULTIMODEL_CONTINUATION_TIMING_NOT_READY');
  }

  const finalBlockers = unique(blockers);
  const primaryPlanBExecutable = finalBlockers.length === 0;
  const shadowConsensusExecutable =
    !primaryPlanBExecutable && forecastShadowConsensusEligible(input);
  const rescueExecutable =
    !primaryPlanBExecutable && !shadowConsensusExecutable && highConvictionRescueEligible(input);
  const executable = primaryPlanBExecutable || shadowConsensusExecutable || rescueExecutable;

  return {
    executable,
    authorityPath: primaryPlanBExecutable
      ? 'PRIMARY_PLAN_B'
      : shadowConsensusExecutable
        ? 'FORECAST_SHADOW_CONSENSUS'
        : rescueExecutable
          ? 'HIGH_CONVICTION_RESCUE'
          : 'BLOCKED',
    rescueVolumeCap: rescueExecutable || shadowConsensusExecutable ? 0.2 : null,
    expertConflictVolumeCap: primaryPlanBExecutable && trainedExpertOpposed ? 0.2 : null,
    primaryEngineCode: MULTIMODEL_DEMO_ENGINE_CODE,
    trainedExpertConfirmed:
      input.trainedExpert.state === 'CONFIRM' &&
      input.trainedExpert.direction === input.candidateDirection,
    trainedExpertOpposed,
    m1TimingRoute: input.m1TimingRoute,
    blockers: executable ? [] : finalBlockers,
    forecastEconomicsShadow: {
      enabled: input.forecastEconomicsShadowOnlyDemo === true,
      activated: shadowConsensusExecutable,
      originalPlanBReasons: [...(input.ensemble.reasons ?? [])],
      originalGovernanceBlockers: [...input.governance.paperExecutionBlockers],
      historicalForecastsRemainObservable: true,
      requiresFreshUnanimousExpertAgreement: true,
    },
  };
}

export function multimodelDemoSignalConfidence(
  input: Pick<MultimodelDemoAuthorityInput, 'ensemble' | 'trainedExpert'>,
  authority: MultimodelDemoAuthorityDecision,
): number {
  const planBConfidence = Number.isFinite(input.ensemble.ensembleScore)
    ? input.ensemble.ensembleScore
    : 0;
  // Both exceptional routes explicitly require all 3 broker-native trained
  // experts to agree. Use their qualifying confidence, not the legacy Plan-B
  // score (which still embeds the forecast economics under investigation).
  if (
    authority.authorityPath !== 'HIGH_CONVICTION_RESCUE' &&
    authority.authorityPath !== 'FORECAST_SHADOW_CONSENSUS'
  ) {
    return planBConfidence;
  }

  const rescueConfidence = input.trainedExpert.ensembleConfidence;
  return rescueConfidence != null && Number.isFinite(rescueConfidence)
    ? rescueConfidence
    : planBConfidence;
}

export function multimodelDemoExecutionVolumeCap(
  rolloutVolumeCap: number,
  authority: MultimodelDemoAuthorityDecision,
): number {
  const caps = [
    rolloutVolumeCap,
    authority.rescueVolumeCap,
    authority.expertConflictVolumeCap,
  ].filter((value): value is number => value != null && Number.isFinite(value));
  return Math.min(...caps);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function m1CandidateToPlanBInput(
  candidate: M1TacticalCandidate,
  features: M1TacticalFeatureSnapshot,
  scanTime: Date,
): V8ShadowMetaInput {
  return {
    instrument: candidate.instrument,
    direction: candidate.direction,
    confidence: candidate.confidence,
    extensionAtr: features.extensionAtr,
    volatilityScore: features.volatilityScore,
    // Match the historical M5 Plan-B scale: direction-aligned EMA spread is
    // divided by two ATRs and clamped to [0,1].
    emaSeparation: clamp01(candidate.alignedEmaSeparationAtr / 2),
    mtfStrength: clamp01(candidate.alignedM15),
    rsi14: features.rsi14,
    // Plan-B aligns raw signed momentum internally by candidate direction.
    shortHorizonMomentumAtr: features.momentum1Atr,
    scanTime: new Date(scanTime),
  };
}
