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
    'paperExecutionEligible' | 'paperExecutionBlockers' | 'netExpectedR'
  >;
  trainedExpert: HighConvictionOverlay;
  candidateDirection: 'BUY' | 'SELL';
  m1TimingRoute: M1TacticalRoute;
}

export interface MultimodelDemoAuthorityDecision {
  executable: boolean;
  primaryEngineCode: typeof MULTIMODEL_DEMO_ENGINE_CODE;
  trainedExpertConfirmed: boolean;
  m1TimingRoute: M1TacticalRoute;
  blockers: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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

  if (input.trainedExpert.state !== 'CONFIRM') {
    blockers.push(`MULTIMODEL_TRAINED_EXPERT_${input.trainedExpert.state}`);
  }
  if (
    input.trainedExpert.state === 'CONFIRM' &&
    input.trainedExpert.direction !== input.candidateDirection
  ) {
    blockers.push('MULTIMODEL_TRAINED_EXPERT_DIRECTION_MISMATCH');
  }

  const finalBlockers = unique(blockers);
  return {
    executable: finalBlockers.length === 0,
    primaryEngineCode: MULTIMODEL_DEMO_ENGINE_CODE,
    trainedExpertConfirmed:
      input.trainedExpert.state === 'CONFIRM' &&
      input.trainedExpert.direction === input.candidateDirection,
    m1TimingRoute: input.m1TimingRoute,
    blockers: finalBlockers,
  };
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
