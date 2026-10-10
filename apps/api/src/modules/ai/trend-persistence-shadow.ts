export const TREND_PERSISTENCE_SHADOW_ARTIFACT = 'trend-persistence-shadow-v1';
export const TREND_PERSISTENCE_MIN_CONFIDENCE = 0.64;
export const TREND_PERSISTENCE_MIN_NET_EXPECTED_R = 0.08;
export const TREND_PERSISTENCE_MIN_PORTFOLIO_QUALITY = 0.35;

export type TrendPersistenceShadowReason =
  | 'SHADOW_CANDIDATE'
  | 'REGIME_NOT_WEAK_PERSISTENCE'
  | 'DRIFT_NOT_NORMAL'
  | 'CONFIDENCE_TOO_LOW'
  | 'NET_EXPECTED_R_TOO_LOW'
  | 'PORTFOLIO_QUALITY_TOO_LOW'
  | 'SPREAD_EVIDENCE_INVALID';

export interface TrendPersistenceShadowInput {
  regime: string;
  driftState: string;
  confidence: number;
  grossExpectedR: number;
  netExpectedR: number;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
  portfolioQuality: number;
  extensionAtr: number;
  shortHorizonMomentumAtr: number;
  executionSpreadEvidenceValid: boolean;
}

export interface TrendPersistenceShadowScore {
  artifact: typeof TREND_PERSISTENCE_SHADOW_ARTIFACT;
  candidate: boolean;
  reason: TrendPersistenceShadowReason;
  executionAuthority: 'NONE';
  modifiesExecution: false;
  confidence: number;
  grossExpectedR: number;
  netExpectedR: number;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
  portfolioQuality: number;
  extensionAtr: number;
  shortHorizonMomentumAtr: number;
}

export function scoreTrendPersistenceShadow(
  input: TrendPersistenceShadowInput,
): TrendPersistenceShadowScore {
  let reason: TrendPersistenceShadowReason = 'SHADOW_CANDIDATE';
  if (input.regime !== 'TREND_WEAK') reason = 'REGIME_NOT_WEAK_PERSISTENCE';
  else if (input.driftState !== 'NORMAL') reason = 'DRIFT_NOT_NORMAL';
  else if (input.confidence < TREND_PERSISTENCE_MIN_CONFIDENCE) reason = 'CONFIDENCE_TOO_LOW';
  else if (input.netExpectedR < TREND_PERSISTENCE_MIN_NET_EXPECTED_R)
    reason = 'NET_EXPECTED_R_TOO_LOW';
  else if (input.portfolioQuality < TREND_PERSISTENCE_MIN_PORTFOLIO_QUALITY)
    reason = 'PORTFOLIO_QUALITY_TOO_LOW';
  else if (!input.executionSpreadEvidenceValid) reason = 'SPREAD_EVIDENCE_INVALID';

  return {
    artifact: TREND_PERSISTENCE_SHADOW_ARTIFACT,
    candidate: reason === 'SHADOW_CANDIDATE',
    reason,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    confidence: input.confidence,
    grossExpectedR: input.grossExpectedR,
    netExpectedR: input.netExpectedR,
    directionQuality: input.directionQuality,
    tradeQuality: input.tradeQuality,
    exitQuality: input.exitQuality,
    portfolioQuality: input.portfolioQuality,
    extensionAtr: input.extensionAtr,
    shortHorizonMomentumAtr: input.shortHorizonMomentumAtr,
  };
}
