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
  /** Same-decision completed M1/M5 evidence, never later candles. */
  m1ReversalEvidence?: Pick<
    M1TacticalCandidate,
    | 'directionQuality'
    | 'alignedMomentum1Atr'
    | 'alignedMomentum3Atr'
    | 'alignedMomentum5Atr'
    | 'alignedEmaSlopeAtr'
    | 'alignedM5Momentum1Atr'
    | 'alignedM5Momentum3Atr'
    | 'alignedM5BodyPressure3'
    | 'alignedM5LatestBodyPressure'
    | 'alignedHigherTimeframeAgreement'
    | 'failedBreakoutAgainstDirection'
  >;
}

export type MultimodelDemoAuthorityPath = 'PRIMARY_PLAN_B' | 'HIGH_CONVICTION_RESCUE' | 'BLOCKED';

export interface MultimodelDemoAuthorityDecision {
  executable: boolean;
  authorityPath: MultimodelDemoAuthorityPath;
  rescueVolumeCap: number | null;
  expertConflictVolumeCap: number | null;
  /** Capped semantic alignment, not an unconstrained new reversal strategy. */
  reversalTimingBridge: boolean;
  reversalTimingBridgeVolumeCap: number | null;
  primaryEngineCode: typeof MULTIMODEL_DEMO_ENGINE_CODE;
  trainedExpertConfirmed: boolean;
  trainedExpertOpposed: boolean;
  m1TimingRoute: M1TacticalRoute;
  blockers: string[];
}

const HIGH_CONVICTION_RESCUE_CONFIDENCE_FLOOR = 0.7;
const HIGH_CONVICTION_RESCUE_ALLOWED_BLOCKERS = new Set([
  'ENSEMBLE_NOT_PAPER_ADMITTED',
  'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
  'DRIFT_STRESSED',
  'DRIFT_OUT_OF_DISTRIBUTION',
]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * A Plan-B reversal is a market-regime label, while M1 continuation means
 * the *current local price impulse* is already moving toward the proposed
 * side. They can be compatible, but only with independent M1 and completed
 * M5 proof plus unanimous, fresh broker-native expert corroboration.
 *
 * This narrow bridge retains normal Plan-B governance, drift, events,
 * broker spread, session, portfolio, fee and loss vetoes. Never accept ABSTAIN.
 */
function reversalTimingBridgeEligible(input: MultimodelDemoAuthorityInput): boolean {
  if (
    input.ensemble.strategyRoute !== 'CONFIRMED_REVERSAL' ||
    input.m1TimingRoute !== 'M1_TREND_CONTINUATION'
  )
    return false;
  const c = input.m1ReversalEvidence;
  if (!c || c.failedBreakoutAgainstDirection !== false) return false;
  const votesLong = input.trainedExpert.longVotes ?? 0;
  const votesShort = input.trainedExpert.shortVotes ?? 0;
  const votes = votesLong + votesShort;
  const alignedVotes = input.candidateDirection === 'BUY' ? votesLong : votesShort;
  const expertAge = input.trainedExpert.freshnessSeconds;
  if (
    input.trainedExpert.allBrokerNative !== true ||
    input.trainedExpert.direction !== input.candidateDirection ||
    votes < 3 ||
    votes !== alignedVotes ||
    !Number.isFinite(input.trainedExpert.ensembleConfidence) ||
    (input.trainedExpert.ensembleConfidence ?? 0) < 0.7 ||
    !Number.isFinite(expertAge) ||
    expertAge == null ||
    expertAge < 0 ||
    expertAge > 120
  )
    return false;

  const values = [
    c.directionQuality,
    c.alignedMomentum1Atr,
    c.alignedMomentum3Atr,
    c.alignedMomentum5Atr,
    c.alignedEmaSlopeAtr,
    c.alignedM5Momentum1Atr,
    c.alignedM5Momentum3Atr,
    c.alignedM5BodyPressure3,
    c.alignedHigherTimeframeAgreement,
  ];
  if (values.some((v) => !Number.isFinite(v))) return false;
  const establishedM5 =
    c.alignedM5BodyPressure3 >= 0.12 &&
    c.alignedM5Momentum3Atr >= 0.2 &&
    c.alignedM5Momentum1Atr >= 0.2;
  const decisiveM5 =
    c.alignedM5LatestBodyPressure != null &&
    Number.isFinite(c.alignedM5LatestBodyPressure) &&
    c.alignedM5LatestBodyPressure >= 0.6 &&
    c.alignedM5Momentum1Atr >= 0.3 &&
    c.alignedM5Momentum3Atr >= -0.1;
  return (
    c.directionQuality >= 0.68 &&
    c.alignedMomentum1Atr >= 0.5 &&
    c.alignedMomentum3Atr >= 0.5 &&
    c.alignedMomentum5Atr >= 0.25 &&
    c.alignedEmaSlopeAtr > 0 &&
    c.alignedHigherTimeframeAgreement >= 0.2 &&
    (establishedM5 || decisiveM5)
  );
}

function confirmedReversalTimingConsistent(input: MultimodelDemoAuthorityInput): boolean {
  if (input.ensemble.strategyRoute !== 'CONFIRMED_REVERSAL') return true;
  if (input.m1TimingRoute === 'M1_CONFIRMED_REVERSAL') return true;
  if (reversalTimingBridgeEligible(input)) return true;
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
    // Broker cost geometry must be provable, but the forecasted return
    // magnitude is research-only, even for the existing capped rescue path.
    Number.isFinite(input.governance.netExpectedR) &&
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
  const trainedExpertOpposed = trainedExpertStronglyOpposes(input);
  const reversalTimingBridge = reversalTimingBridgeEligible(input);
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
    expertConflictVolumeCap: primaryPlanBExecutable && trainedExpertOpposed ? 0.2 : null,
    reversalTimingBridge: primaryPlanBExecutable && reversalTimingBridge,
    reversalTimingBridgeVolumeCap: primaryPlanBExecutable && reversalTimingBridge ? 0.2 : null,
    primaryEngineCode: MULTIMODEL_DEMO_ENGINE_CODE,
    trainedExpertConfirmed:
      input.trainedExpert.state === 'CONFIRM' &&
      input.trainedExpert.direction === input.candidateDirection,
    trainedExpertOpposed,
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
  const caps = [
    rolloutVolumeCap,
    authority.rescueVolumeCap,
    authority.expertConflictVolumeCap,
    authority.reversalTimingBridgeVolumeCap,
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
