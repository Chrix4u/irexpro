import { scorePlanBShadowMeta, V8ShadowMetaInput } from './v8-shadow-meta-scorer';

export const PLAN_B_ENSEMBLE_ARTIFACT = 'plan-b-multimodel-shadow-v1';
export const PLAN_B_ENSEMBLE_MODE = 'PROSPECTIVE_SHADOW_ONLY';

export type PlanBRegime =
  | 'TREND_HEALTHY'
  | 'TREND_EXTENDED'
  | 'TREND_WEAK'
  | 'VOLATILE'
  | 'ROLLOVER_RISK';

export interface PlanBEnsembleScore {
  artifact: typeof PLAN_B_ENSEMBLE_ARTIFACT;
  mode: typeof PLAN_B_ENSEMBLE_MODE;
  modifiesExecution: false;
  regime: PlanBRegime;
  regimeAllowed: boolean;
  directionQuality: number;
  expectedR: number;
  tradeQuality: number;
  metaProbability: number;
  ensembleScore: number;
  admitted: boolean;
  reasons: string[];
}
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function regimeOf(input: V8ShadowMetaInput): PlanBRegime {
  const hour = input.scanTime.getUTCHours();
  if (hour >= 21) return 'ROLLOVER_RISK';
  if (input.volatilityScore >= 0.65) return 'VOLATILE';
  if (input.extensionAtr > 1.15) return 'TREND_EXTENDED';
  if (input.emaSeparation < 0.16 || input.mtfStrength < 0.12) return 'TREND_WEAK';
  return 'TREND_HEALTHY';
}

function directionQuality(input: V8ShadowMetaInput): number {
  const rsiDirectional =
    input.direction === 'BUY'
      ? clamp01((input.rsi14 - 50) / 22)
      : clamp01((50 - input.rsi14) / 22);
  return clamp01(
    0.42 * clamp01((input.confidence - 0.6) / 0.2) +
      0.25 * clamp01(input.emaSeparation) +
      0.23 * clamp01(input.mtfStrength) +
      0.1 * rsiDirectional,
  );
}
function tradeQuality(input: V8ShadowMetaInput): number {
  const extensionQuality = 1 - clamp01(input.extensionAtr / 1.5);
  const volatilityQuality = 1 - clamp01(input.volatilityScore / 0.75);
  const structureQuality = clamp01(
    0.55 * input.emaSeparation + 0.45 * input.mtfStrength,
  );
  return clamp01(
    0.38 * extensionQuality +
      0.27 * volatilityQuality +
      0.35 * structureQuality,
  );
}

export function scorePlanBMultimodelShadow(
  input: V8ShadowMetaInput,
): PlanBEnsembleScore {
  const meta = scorePlanBShadowMeta(input);
  const regime = regimeOf(input);
  const regimeAllowed = regime === 'TREND_HEALTHY';
  const direction = directionQuality(input);
  const quality = tradeQuality(input);
  const economicQuality = clamp01((meta.expectedR + 0.25) / 0.75);
  const ensembleScore = clamp01(
    0.36 * meta.probability +
      0.25 * direction +
      0.21 * quality +
      0.18 * economicQuality,
  );

  const reasons: string[] = [];
  if (!regimeAllowed) reasons.push(`REGIME_${regime}`);
  if (!meta.admitted) reasons.push('META_EXPECTED_VALUE');
  if (direction < 0.55) reasons.push('DIRECTION_QUALITY');
  if (quality < 0.48) reasons.push('TRADE_QUALITY');
  if (meta.expectedR < 0.08) reasons.push('EXPECTED_R');

  const admitted =
    regimeAllowed &&
    meta.admitted &&
    direction >= 0.55 &&
    quality >= 0.48 &&
    meta.expectedR >= 0.08;

  return {
    artifact: PLAN_B_ENSEMBLE_ARTIFACT,
    mode: PLAN_B_ENSEMBLE_MODE,
    modifiesExecution: false,
    regime,
    regimeAllowed,
    directionQuality: direction,
    expectedR: meta.expectedR,
    tradeQuality: quality,
    metaProbability: meta.probability,
    ensembleScore,
    admitted,
    reasons: admitted ? ['ADMIT'] : reasons,
  };
}
