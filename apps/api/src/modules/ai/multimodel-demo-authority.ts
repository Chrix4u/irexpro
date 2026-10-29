import type { HighConvictionOverlay } from './high-conviction-overlay';
import type { M1TacticalCandidate } from './m1-tactical-candidate';
import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';
import type { M1TacticalRoute } from './m1-tactical-route';
import type { EnsembleGovernanceDecision } from './ensemble-governance';
import type { PlanBEnsembleScore } from './plan-b-multimodel-shadow';
import type { V8ShadowMetaInput } from './v8-shadow-meta-scorer';

export const MULTIMODEL_DEMO_ENGINE_CODE = 'irexpro-multimodel-ensemble-v1';

export interface MultimodelDemoAuthorityInput {
  ensemble: Pick<PlanBEnsembleScore, 'paperAdmitted' | 'ensembleScore' | 'strategyRoute'>;
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
  >;
  trainedExpert: HighConvictionOverlay;
  candidateDirection: 'BUY' | 'SELL';
  m1TimingRoute: M1TacticalRoute;
}

export type MultimodelDemoAuthorityPath = 'PRIMARY_PLAN_B' | 'HIGH_CONVICTION_RESCUE' | 'BLOCKED';

export interface MultimodelDemoAuthorityDecision {
  executable: boolean;
  authorityPath: MultimodelDemoAuthorityPath;
  rescueVolumeCap: number | null;
  primaryEngineCode: typeof MULTIMODEL_DEMO_ENGINE_CODE;
  trainedExpertConfirmed: boolean;
  m1TimingRoute: M1TacticalRoute;
  blockers: string[];
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
  return (
    input.ensemble.strategyRoute !== 'CONFIRMED_REVERSAL' ||
    input.m1TimingRoute === 'M1_CONFIRMED_REVERSAL'
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
  if (!confirmedReversalTimingConsistent(input)) {
    blockers.push('MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED');
  }
  if (!trendContinuationTimingConsistent(input)) {
    blockers.push('MULTIMODEL_CONTINUATION_TIMING_NOT_READY');
  }

  const finalBlockers = unique(blockers);
  const primaryPlanBExecutable = finalBlockers.length === 0;
  const rescueExecutable = !primaryPlanBExecutable && highConvictionRescueEligible(input);
  const executable = primaryPlanBExecutable || rescueExecutable;

  return {
    executable,
    authorityPath: primaryPlanBExecutable
      ? 'PRIMARY_PLAN_B'
      : rescueExecutable
        ? 'HIGH_CONVICTION_RESCUE'
        : 'BLOCKED',
    rescueVolumeCap: rescueExecutable ? 0.2 : null,
    primaryEngineCode: MULTIMODEL_DEMO_ENGINE_CODE,
    trainedExpertConfirmed:
      input.trainedExpert.state === 'CONFIRM' &&
      input.trainedExpert.direction === input.candidateDirection,
    m1TimingRoute: input.m1TimingRoute,
    blockers: executable ? [] : finalBlockers,
  };
}

export function multimodelDemoSignalConfidence(
  input: Pick<MultimodelDemoAuthorityInput, 'ensemble' | 'trainedExpert'>,
  authority: MultimodelDemoAuthorityDecision,
): number {
  const planBConfidence = Number.isFinite(input.ensemble.ensembleScore)
    ? input.ensemble.ensembleScore
    : 0;
  if (authority.authorityPath !== 'HIGH_CONVICTION_RESCUE') return planBConfidence;

  const rescueConfidence = input.trainedExpert.ensembleConfidence;
  return rescueConfidence != null && Number.isFinite(rescueConfidence)
    ? rescueConfidence
    : planBConfidence;
}

export function multimodelDemoExecutionVolumeCap(
  rolloutVolumeCap: number,
  authority: MultimodelDemoAuthorityDecision,
): number {
  return authority.rescueVolumeCap == null
    ? rolloutVolumeCap
    : Math.min(rolloutVolumeCap, authority.rescueVolumeCap);
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
