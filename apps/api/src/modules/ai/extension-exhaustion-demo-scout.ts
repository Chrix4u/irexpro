export const EXTENSION_EXHAUSTION_DEMO_SCOUT_ARTIFACT =
  'extension-exhaustion-demo-scout-v1' as const;
export const EXTENSION_EXHAUSTION_DEMO_SCOUT_LOT_CAP = 0.1;
export const EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_SAMPLES = 6;
export const EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_AVG_R = 0.1;
export const EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_PF = 1.15;
export const EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_M1_CONFIDENCE = 0.7;
export const EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_M1_DIRECTION_QUALITY = 0.65;

export interface ExtensionExhaustionShadowReliability {
  samples: number;
  wins: number;
  losses: number;
  totalNetR: number;
  averageNetR: number;
  profitFactor: number | null;
  recent3R: number;
}

export interface ExtensionExhaustionDemoScoutInput {
  specialist: {
    candidate: boolean;
    reason: string;
    regime: string;
    driftState: string;
    confidence: number;
    netExpectedR: number;
    directionQuality: number;
    executionSpreadEvidenceValid: boolean;
  };
  eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
  m1Route: string;
  m1Confidence: number;
  m1DirectionQuality: number;
  trainedExpertOpposed: boolean;
  portfolioSnapshotAvailable: boolean;
  reliability: ExtensionExhaustionShadowReliability | null;
}

export type ExtensionExhaustionDemoScoutReason =
  | 'EXTENSION_EXHAUSTION_DEMO_SCOUT'
  | 'SPECIALIST_NOT_CANDIDATE'
  | 'EVENT_RISK_NOT_CLEAR'
  | 'M1_TIMING_NOT_CONTINUATION'
  | 'M1_CONFIDENCE_TOO_LOW'
  | 'M1_DIRECTION_QUALITY_TOO_LOW'
  | 'TRAINED_EXPERT_OPPOSED'
  | 'PORTFOLIO_SNAPSHOT_UNAVAILABLE'
  | 'RELIABILITY_UNAVAILABLE'
  | 'RELIABILITY_INSUFFICIENT_SAMPLES'
  | 'RELIABILITY_AVERAGE_R_TOO_LOW'
  | 'RELIABILITY_PROFIT_FACTOR_TOO_LOW'
  | 'RELIABILITY_RECENT_R_NOT_POSITIVE';

export interface ExtensionExhaustionDemoScoutDecision {
  artifact: typeof EXTENSION_EXHAUSTION_DEMO_SCOUT_ARTIFACT;
  eligible: boolean;
  reason: ExtensionExhaustionDemoScoutReason;
  lotCap: number;
  executionAuthority: 'DEMO_ONLY';
  reliability: ExtensionExhaustionShadowReliability | null;
}

function decision(
  input: ExtensionExhaustionDemoScoutInput,
  reason: ExtensionExhaustionDemoScoutReason,
): ExtensionExhaustionDemoScoutDecision {
  const eligible = reason === 'EXTENSION_EXHAUSTION_DEMO_SCOUT';
  return {
    artifact: EXTENSION_EXHAUSTION_DEMO_SCOUT_ARTIFACT,
    eligible,
    reason,
    lotCap: eligible ? EXTENSION_EXHAUSTION_DEMO_SCOUT_LOT_CAP : 0,
    executionAuthority: 'DEMO_ONLY',
    reliability: input.reliability,
  };
}

export function evaluateExtensionExhaustionDemoScout(
  input: ExtensionExhaustionDemoScoutInput,
): ExtensionExhaustionDemoScoutDecision {
  if (!input.specialist.candidate) return decision(input, 'SPECIALIST_NOT_CANDIDATE');
  if (input.eventRisk !== 'CLEAR') return decision(input, 'EVENT_RISK_NOT_CLEAR');
  if (input.m1Route !== 'M1_TREND_CONTINUATION') {
    return decision(input, 'M1_TIMING_NOT_CONTINUATION');
  }
  if (
    !Number.isFinite(input.m1Confidence) ||
    input.m1Confidence < EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_M1_CONFIDENCE
  ) {
    return decision(input, 'M1_CONFIDENCE_TOO_LOW');
  }
  if (
    !Number.isFinite(input.m1DirectionQuality) ||
    input.m1DirectionQuality < EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_M1_DIRECTION_QUALITY
  ) {
    return decision(input, 'M1_DIRECTION_QUALITY_TOO_LOW');
  }
  if (input.trainedExpertOpposed) return decision(input, 'TRAINED_EXPERT_OPPOSED');
  if (!input.portfolioSnapshotAvailable) {
    return decision(input, 'PORTFOLIO_SNAPSHOT_UNAVAILABLE');
  }
  const reliability = input.reliability;
  if (!reliability) return decision(input, 'RELIABILITY_UNAVAILABLE');
  if (reliability.samples < EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_SAMPLES) {
    return decision(input, 'RELIABILITY_INSUFFICIENT_SAMPLES');
  }
  if (
    !Number.isFinite(reliability.averageNetR) ||
    reliability.averageNetR < EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_AVG_R
  ) {
    return decision(input, 'RELIABILITY_AVERAGE_R_TOO_LOW');
  }
  const zeroLossPositiveEvidence =
    reliability.losses === 0 && reliability.wins > 0 && reliability.totalNetR > 0;
  if (
    !zeroLossPositiveEvidence &&
    (reliability.profitFactor == null ||
      !Number.isFinite(reliability.profitFactor) ||
      reliability.profitFactor < EXTENSION_EXHAUSTION_DEMO_SCOUT_MIN_PF)
  ) {
    return decision(input, 'RELIABILITY_PROFIT_FACTOR_TOO_LOW');
  }
  if (!Number.isFinite(reliability.recent3R) || reliability.recent3R <= 0) {
    return decision(input, 'RELIABILITY_RECENT_R_NOT_POSITIVE');
  }
  return decision(input, 'EXTENSION_EXHAUSTION_DEMO_SCOUT');
}
