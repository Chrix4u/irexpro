export const EXTENSION_EXHAUSTION_SHADOW_ARTIFACT = 'extension-exhaustion-shadow-v1';
export const EXTENSION_EXHAUSTION_MIN_NET_EXPECTED_R = 0.08;
export const EXTENSION_EXHAUSTION_MIN_DIRECTION_QUALITY = 0.35;

export type ExtensionExhaustionShadowReason =
  | 'SHADOW_CANDIDATE'
  | 'REGIME_NOT_EXTENDED'
  | 'DRIFT_NOT_NORMAL'
  | 'CONFIDENCE_TOO_LOW'
  | 'NET_EXPECTED_R_TOO_LOW'
  | 'DIRECTION_QUALITY_TOO_LOW'
  | 'SPREAD_EVIDENCE_INVALID';

export interface ExtensionExhaustionShadowInput {
  regime: string;
  driftState: string;
  confidence: number;
  netExpectedR: number;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
  extensionAtr: number;
  executionSpreadEvidenceValid: boolean;
}

export interface ExtensionExhaustionShadowScore {
  artifact: typeof EXTENSION_EXHAUSTION_SHADOW_ARTIFACT;
  candidate: boolean;
  reason: ExtensionExhaustionShadowReason;
  executionAuthority: 'NONE';
  modifiesExecution: false;
  confidence: number;
  netExpectedR: number;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
  extensionAtr: number;
}

export function scoreExtensionExhaustionShadow(
  input: ExtensionExhaustionShadowInput,
): ExtensionExhaustionShadowScore {
  let reason: ExtensionExhaustionShadowReason = 'SHADOW_CANDIDATE';
  if (input.regime !== 'TREND_EXTENDED') reason = 'REGIME_NOT_EXTENDED';
  else if (input.driftState !== 'NORMAL') reason = 'DRIFT_NOT_NORMAL';
  else if (input.confidence < 0.64) reason = 'CONFIDENCE_TOO_LOW';
  else if (input.netExpectedR < EXTENSION_EXHAUSTION_MIN_NET_EXPECTED_R)
    reason = 'NET_EXPECTED_R_TOO_LOW';
  else if (input.directionQuality < EXTENSION_EXHAUSTION_MIN_DIRECTION_QUALITY)
    reason = 'DIRECTION_QUALITY_TOO_LOW';
  else if (!input.executionSpreadEvidenceValid) reason = 'SPREAD_EVIDENCE_INVALID';

  return {
    artifact: EXTENSION_EXHAUSTION_SHADOW_ARTIFACT,
    candidate: reason === 'SHADOW_CANDIDATE',
    reason,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    confidence: input.confidence,
    netExpectedR: input.netExpectedR,
    directionQuality: input.directionQuality,
    tradeQuality: input.tradeQuality,
    exitQuality: input.exitQuality,
    extensionAtr: input.extensionAtr,
  };
}

export const PAPER_EXTENSION_EXHAUSTION_RESEARCH_ARTIFACT =
  'paper-extension-exhaustion-research-v1';
export const PAPER_EXTENSION_EXHAUSTION_MIN_NET_EXPECTED_R = 0.12;

export type PaperExtensionExhaustionResearchReason =
  | 'PAPER_RESEARCH_CANDIDATE'
  | 'REGIME_NOT_EXTENDED'
  | 'DRIFT_NOT_NORMAL'
  | 'CONFIDENCE_TOO_LOW'
  | 'NET_EXPECTED_R_TOO_LOW'
  | 'DIRECTION_QUALITY_TOO_LOW'
  | 'EVENT_RISK_NOT_CLEAR'
  | 'EXECUTION_COST_UNUSABLE';

export interface PaperExtensionExhaustionResearchInput {
  regime: string;
  driftState: string;
  confidence: number;
  netExpectedR: number;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
  extensionAtr: number;
  eventRisk: string;
  paperExecutionCostUsable: boolean;
}

export interface PaperExtensionExhaustionResearchDecision {
  artifact: typeof PAPER_EXTENSION_EXHAUSTION_RESEARCH_ARTIFACT;
  eligible: boolean;
  reason: PaperExtensionExhaustionResearchReason;
  executionAuthority: 'PAPER_ONLY';
  productionEligible: false;
  qualificationEvidence: false;
  confidence: number;
  netExpectedR: number;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
  extensionAtr: number;
}

export function evaluatePaperExtensionExhaustionResearch(
  input: PaperExtensionExhaustionResearchInput,
): PaperExtensionExhaustionResearchDecision {
  let reason: PaperExtensionExhaustionResearchReason = 'PAPER_RESEARCH_CANDIDATE';
  if (input.regime !== 'TREND_EXTENDED') reason = 'REGIME_NOT_EXTENDED';
  else if (input.driftState !== 'NORMAL') reason = 'DRIFT_NOT_NORMAL';
  else if (input.confidence < 0.64) reason = 'CONFIDENCE_TOO_LOW';
  else if (input.netExpectedR < PAPER_EXTENSION_EXHAUSTION_MIN_NET_EXPECTED_R)
    reason = 'NET_EXPECTED_R_TOO_LOW';
  else if (input.directionQuality < EXTENSION_EXHAUSTION_MIN_DIRECTION_QUALITY)
    reason = 'DIRECTION_QUALITY_TOO_LOW';
  else if (input.eventRisk !== 'CLEAR') reason = 'EVENT_RISK_NOT_CLEAR';
  else if (!input.paperExecutionCostUsable) reason = 'EXECUTION_COST_UNUSABLE';

  return {
    artifact: PAPER_EXTENSION_EXHAUSTION_RESEARCH_ARTIFACT,
    eligible: reason === 'PAPER_RESEARCH_CANDIDATE',
    reason,
    executionAuthority: 'PAPER_ONLY',
    productionEligible: false,
    qualificationEvidence: false,
    confidence: input.confidence,
    netExpectedR: input.netExpectedR,
    directionQuality: input.directionQuality,
    tradeQuality: input.tradeQuality,
    exitQuality: input.exitQuality,
    extensionAtr: input.extensionAtr,
  };
}
