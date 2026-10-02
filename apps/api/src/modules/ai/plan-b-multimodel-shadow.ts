import { scorePlanBShadowMeta, V8ShadowMetaInput } from './v8-shadow-meta-scorer';

export const PLAN_B_ENSEMBLE_ARTIFACT = 'plan-b-multimodel-shadow-v2';
export const PLAN_B_ENSEMBLE_MODE = 'PROSPECTIVE_SHADOW_ONLY';

export type PlanBRegime =
  | 'TREND_HEALTHY'
  | 'TREND_EXTENDED'
  | 'TREND_WEAK'
  | 'VOLATILE'
  | 'ROLLOVER_RISK';

export interface PlanBPortfolioPosition {
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string | number;
}

export interface PlanBEnsembleScore {
  artifact: typeof PLAN_B_ENSEMBLE_ARTIFACT;
  mode: typeof PLAN_B_ENSEMBLE_MODE;
  modifiesExecution: false;
  regime: PlanBRegime;
  regimeAllowed: boolean;
  directionQuality: number;
  expectedR: number;
  tradeQuality: number;
  exitQuality: number;
  pairSideQuality: number;
  sessionQuality: number;
  consensusPassed: number;
  consensusRequired: number;
  portfolioQuality: number;
  portfolioRiskScore: number;
  openPositionCount: number;
  sameInstrumentCount: number;
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

const PAIR_SIDE_STABILITY: Record<string, number> = Object.freeze({
  EURUSD_BUY: 0.72,
  EURUSD_SELL: 0.60,
  GBPUSD_BUY: 0.44,
  GBPUSD_SELL: 0.52,
  USDJPY_BUY: 0.56,
  USDJPY_SELL: 0.42,
  AUDUSD_BUY: 0.55,
  AUDUSD_SELL: 0.47,
  USDCAD_BUY: 0.63,
  USDCAD_SELL: 0.76,
  USDCHF_BUY: 0.45,
  USDCHF_SELL: 0.49,
});

function pairSideQuality(input: V8ShadowMetaInput): number {
  return PAIR_SIDE_STABILITY[`${input.instrument.trim().toUpperCase()}_${input.direction}`] ?? 0.5;
}

function sessionQuality(input: V8ShadowMetaInput): number {
  const hour = input.scanTime.getUTCHours();
  if (hour >= 21 || hour < 1) return 0.1;
  if (hour >= 7 && hour < 16) return 0.9;
  if (hour >= 16 && hour < 20) return 0.72;
  return 0.52;
}

function exitQuality(input: V8ShadowMetaInput): number {
  const extensionRoom = 1 - clamp01(input.extensionAtr / 1.5);
  const volatilityControl = 1 - clamp01(input.volatilityScore / 0.75);
  const continuation = clamp01(0.52 * input.mtfStrength + 0.48 * input.emaSeparation);
  return clamp01(0.4 * extensionRoom + 0.25 * volatilityControl + 0.35 * continuation);
}

function portfolioQualityOf(
  input: V8ShadowMetaInput,
  positions: PlanBPortfolioPosition[],
): { quality: number; risk: number; sameInstrumentCount: number } {
  const exposure = new Map<string, number>();
  const add = (currency: string, value: number) =>
    exposure.set(currency, (exposure.get(currency) ?? 0) + value);
  for (const position of positions) {
    const instrument = position.instrument.trim().toUpperCase();
    if (instrument.length !== 6) continue;
    const lots = Number(position.lotSize);
    if (!Number.isFinite(lots) || lots <= 0) continue;
    const sign = position.direction === 'BUY' ? 1 : -1;
    add(instrument.slice(0, 3), sign * lots);
    add(instrument.slice(3, 6), -sign * lots);
  }
  const instrument = input.instrument.trim().toUpperCase();
  const sign = input.direction === 'BUY' ? 1 : -1;
  const candidateLot = 0.1;
  const candidate = [
    [instrument.slice(0, 3), sign * candidateLot] as const,
    [instrument.slice(3, 6), -sign * candidateLot] as const,
  ];
  const sameSignOverlap = candidate.reduce((sum, [currency, delta]) => {
    const current = exposure.get(currency) ?? 0;
    return sum + (current * delta > 0 ? Math.min(1, Math.abs(current) / candidateLot) : 0);
  }, 0) / 2;
  const sameInstrumentCount = positions.filter(
    (position) =>
      position.instrument.trim().toUpperCase() === instrument &&
      position.direction === input.direction,
  ).length;
  const directionalLoad = clamp01(sameInstrumentCount / 3);
  const risk = clamp01(0.72 * sameSignOverlap + 0.28 * directionalLoad);
  return { quality: 1 - risk, risk, sameInstrumentCount };
}

export function scorePlanBMultimodelShadow(
  input: V8ShadowMetaInput,
  positions: PlanBPortfolioPosition[] = [],
): PlanBEnsembleScore {
  const meta = scorePlanBShadowMeta(input);
  const regime = regimeOf(input);
  const regimeAllowed = regime === 'TREND_HEALTHY';
  const direction = directionQuality(input);
  const quality = tradeQuality(input);
  const exit = exitQuality(input);
  const pairSide = pairSideQuality(input);
  const session = sessionQuality(input);
  const portfolio = portfolioQualityOf(input, positions);
  const economicQuality = clamp01((meta.expectedR + 0.25) / 0.75);
  const ensembleScore = clamp01(
    0.22 * meta.probability +
      0.15 * direction +
      0.12 * quality +
      0.11 * exit +
      0.10 * pairSide +
      0.08 * session +
      0.10 * economicQuality +
      0.12 * portfolio.quality,
  );

  const reasons: string[] = [];
  if (!regimeAllowed) reasons.push(`REGIME_${regime}`);
  if (!meta.admitted) reasons.push('META_EXPECTED_VALUE');
  if (direction < 0.55) reasons.push('DIRECTION_QUALITY');
  if (quality < 0.48) reasons.push('TRADE_QUALITY');
  if (exit < 0.48) reasons.push('EXIT_FEASIBILITY');
  if (pairSide < 0.48) reasons.push('PAIR_SIDE_STABILITY');
  if (session < 0.5) reasons.push('SESSION_QUALITY');
  if (meta.expectedR < 0.08) reasons.push('EXPECTED_R');
  if (portfolio.quality < 0.35) reasons.push('PORTFOLIO_CONCENTRATION');

  const votes = [
    meta.admitted,
    direction >= 0.55,
    quality >= 0.48,
    exit >= 0.48,
    pairSide >= 0.48,
    session >= 0.5,
    meta.expectedR >= 0.08,
    portfolio.quality >= 0.35,
  ];
  const consensusPassed = votes.filter(Boolean).length;
  const consensusRequired = 7;

  const admitted =
    regimeAllowed &&
    consensusPassed >= consensusRequired &&
    meta.admitted &&
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
    exitQuality: exit,
    pairSideQuality: pairSide,
    sessionQuality: session,
    consensusPassed,
    consensusRequired,
    portfolioQuality: portfolio.quality,
    portfolioRiskScore: portfolio.risk,
    openPositionCount: positions.length,
    sameInstrumentCount: portfolio.sameInstrumentCount,
    metaProbability: meta.probability,
    ensembleScore,
    admitted,
    reasons: admitted ? ['ADMIT'] : reasons,
  };
}
