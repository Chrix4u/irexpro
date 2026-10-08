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
