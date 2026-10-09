import { scorePlanBShadowMeta, V8ShadowMetaInput } from './v8-shadow-meta-scorer';

export const PLAN_B_ENSEMBLE_ARTIFACT = 'plan-b-multimodel-shadow-v4';
export const PLAN_B_ACTIVE_MODEL_POLICY_VERSION = `${PLAN_B_ENSEMBLE_ARTIFACT}-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1-throughput-shadow-only-v1`;
export const PLAN_B_ENSEMBLE_MODE = 'PROSPECTIVE_SHADOW_ONLY';
export const PLAN_B_CANDIDATE_CONFIDENCE_FLOOR = 0.64;
export const PLAN_B_GROSS_EXPECTED_R_FLOOR = 0.08;
export const PLAN_B_REVERSAL_GROSS_EXPECTED_R_FLOOR = 0.18;
export const PLAN_B_REVERSAL_MIN_MOMENTUM_ATR = 0.5;
export const PLAN_B_REVERSAL_MAX_MOMENTUM_ATR = 1.5;
export const PLAN_B_EARLY_TRANSITION_GROSS_EXPECTED_R_FLOOR = 0.3;
export const PLAN_B_EARLY_TRANSITION_MAX_EXTENSION_ATR = 0.9;
export const PLAN_B_EARLY_TRANSITION_MIN_EMA_SEPARATION = 0.12;
export const PLAN_B_EARLY_TRANSITION_MAX_MTF_STRENGTH = 0.12;
export const PLAN_B_EARLY_TRANSITION_MIN_MOMENTUM_ATR = -0.5;
export const PLAN_B_EARLY_TRANSITION_MAX_MOMENTUM_ATR = 1.5;
export const PLAN_B_PORTFOLIO_QUALITY_FLOOR = 0.35;

const NEW_YORK_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  hourCycle: 'h23',
});

export type PlanBRegime =
  | 'TREND_HEALTHY'
  | 'TREND_EXTENDED'
  | 'TREND_WEAK'
  | 'REVERSAL_CONFIRMED'
  | 'TRANSITION_EARLY'
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
  strategyRoute: 'TREND_CONTINUATION' | 'CONFIRMED_REVERSAL' | 'EARLY_TRANSITION';
  directionQuality: number;
  expectedR: number;
  tradeQuality: number;
  exitQuality: number;
  pairSideQuality: number;
  pairSideRoute: 'GOVERNANCE';
  sessionQuality: number;
  consensusPassed: number;
  consensusRequired: number;
  portfolioQuality: number;
  portfolioRiskScore: number;
  openPositionCount: number;
  sameInstrumentCount: number;
  sameInstrumentDirectionalLots: number;
  metaProbability: number;
  ensembleScore: number;
  paperAdmitted: boolean;
  admitted: boolean;
  reasons: string[];
}
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function regimeOf(input: V8ShadowMetaInput): PlanBRegime {
  const newYorkHour = Number(NEW_YORK_HOUR.format(input.scanTime));
  if (newYorkHour === 17) return 'ROLLOVER_RISK';
  if (input.volatilityScore >= 0.65) return 'VOLATILE';
  if (input.extensionAtr > 1.15) return 'TREND_EXTENDED';
  if (input.emaSeparation < 0.16 || input.mtfStrength < 0.12) return 'TREND_WEAK';
  return 'TREND_HEALTHY';
}

function directionQuality(input: V8ShadowMetaInput): number {
  const rsiDirectional =
    input.direction === 'BUY' ? clamp01((input.rsi14 - 50) / 22) : clamp01((50 - input.rsi14) / 22);
  return clamp01(
    0.42 * clamp01((input.confidence - 0.6) / 0.2) +
      0.25 * clamp01(input.emaSeparation) +
      0.23 * clamp01(input.mtfStrength) +
      0.1 * rsiDirectional,
  );
}
function shortHorizonMomentum(input: V8ShadowMetaInput): number {
  const rawMomentum = Number.isFinite(input.shortHorizonMomentumAtr)
    ? input.shortHorizonMomentumAtr!
    : 0;
  return input.direction === 'SELL' ? -rawMomentum : rawMomentum;
}

function reversalConfirmed(
  input: V8ShadowMetaInput,
  expectedR: number,
  baseRegime: PlanBRegime,
): boolean {
  const momentum = shortHorizonMomentum(input);
  return (
    baseRegime === 'TREND_WEAK' &&
    input.confidence >= PLAN_B_CANDIDATE_CONFIDENCE_FLOOR &&
    input.extensionAtr <= 1.15 &&
    input.volatilityScore <= 0.55 &&
    momentum >= PLAN_B_REVERSAL_MIN_MOMENTUM_ATR &&
    momentum <= PLAN_B_REVERSAL_MAX_MOMENTUM_ATR &&
    expectedR >= PLAN_B_REVERSAL_GROSS_EXPECTED_R_FLOOR
  );
}

function earlyTransitionCandidate(
  input: V8ShadowMetaInput,
  expectedR: number,
  baseRegime: PlanBRegime,
): boolean {
  const momentum = shortHorizonMomentum(input);
  const rsiDirectional =
    input.direction === 'BUY' ? clamp01((input.rsi14 - 50) / 22) : clamp01((50 - input.rsi14) / 22);
  return (
    baseRegime === 'TREND_WEAK' &&
    input.confidence >= PLAN_B_CANDIDATE_CONFIDENCE_FLOOR &&
    input.extensionAtr <= PLAN_B_EARLY_TRANSITION_MAX_EXTENSION_ATR &&
    input.volatilityScore <= 0.55 &&
    input.emaSeparation >= PLAN_B_EARLY_TRANSITION_MIN_EMA_SEPARATION &&
    input.emaSeparation <= 0.5 &&
    input.mtfStrength >= 0 &&
    input.mtfStrength < PLAN_B_EARLY_TRANSITION_MAX_MTF_STRENGTH &&
    momentum >= PLAN_B_EARLY_TRANSITION_MIN_MOMENTUM_ATR &&
    momentum <= PLAN_B_EARLY_TRANSITION_MAX_MOMENTUM_ATR &&
    (rsiDirectional >= 0.12 || momentum >= 0.15) &&
    expectedR >= PLAN_B_EARLY_TRANSITION_GROSS_EXPECTED_R_FLOOR
  );
}

function earlyTransitionDirectionQuality(input: V8ShadowMetaInput): number {
  const structureQuality = clamp01(input.emaSeparation / 0.2);
  const rsiDirectional =
    input.direction === 'BUY' ? clamp01((input.rsi14 - 50) / 22) : clamp01((50 - input.rsi14) / 22);
  const confidenceQuality = clamp01((input.confidence - 0.6) / 0.2);
  const momentumQuality = clamp01((shortHorizonMomentum(input) + 0.5) / 1.25);
  return clamp01(
    0.6 * structureQuality +
      0.25 * rsiDirectional +
      0.1 * confidenceQuality +
      0.05 * momentumQuality,
  );
}

function earlyTransitionTradeQuality(input: V8ShadowMetaInput): number {
  const extensionQuality = 1 - clamp01(input.extensionAtr / 1.15);
  const volatilityQuality = 1 - clamp01(input.volatilityScore / 0.55);
  const structureQuality = clamp01(input.emaSeparation / 0.2);
  const momentumQuality = clamp01((shortHorizonMomentum(input) + 0.5) / 1.25);
  const rsiDirectional =
    input.direction === 'BUY' ? clamp01((input.rsi14 - 50) / 22) : clamp01((50 - input.rsi14) / 22);
  return clamp01(
    0.25 * extensionQuality +
      0.25 * volatilityQuality +
      0.35 * structureQuality +
      0.15 * Math.max(momentumQuality, rsiDirectional),
  );
}

function earlyTransitionExitQuality(input: V8ShadowMetaInput): number {
  const extensionQuality = 1 - clamp01(input.extensionAtr / 1.15);
  const volatilityQuality = 1 - clamp01(input.volatilityScore / 0.55);
  const structureQuality = clamp01(input.emaSeparation / 0.2);
  const momentumQuality = clamp01((shortHorizonMomentum(input) + 0.5) / 1.25);
  const rsiDirectional =
    input.direction === 'BUY' ? clamp01((input.rsi14 - 50) / 22) : clamp01((50 - input.rsi14) / 22);
  return clamp01(
    0.3 * extensionQuality +
      0.25 * volatilityQuality +
      0.3 * structureQuality +
      0.15 * Math.max(momentumQuality, rsiDirectional),
  );
}

function reversalDirectionQuality(input: V8ShadowMetaInput): number {
  const momentumQuality = clamp01(shortHorizonMomentum(input) / 0.75);
  const confidenceQuality = clamp01((input.confidence - 0.6) / 0.2);
  const rsiDirectional =
    input.direction === 'BUY' ? clamp01((input.rsi14 - 50) / 22) : clamp01((50 - input.rsi14) / 22);
  const transitionQuality = 1 - clamp01(input.emaSeparation / 0.25);
  return clamp01(
    0.45 * momentumQuality +
      0.2 * confidenceQuality +
      0.2 * rsiDirectional +
      0.15 * transitionQuality,
  );
}

function reversalTradeQuality(input: V8ShadowMetaInput): number {
  const extensionQuality = 1 - clamp01(input.extensionAtr / 1.5);
  const volatilityQuality = 1 - clamp01(input.volatilityScore / 0.75);
  const momentumQuality = clamp01(shortHorizonMomentum(input) / 0.75);
  const transitionQuality = 1 - clamp01(input.emaSeparation / 0.25);
  return clamp01(
    0.25 * extensionQuality +
      0.25 * volatilityQuality +
      0.35 * momentumQuality +
      0.15 * transitionQuality,
  );
}

function reversalExitQuality(input: V8ShadowMetaInput): number {
  const extensionQuality = 1 - clamp01(input.extensionAtr / 1.5);
  const volatilityQuality = 1 - clamp01(input.volatilityScore / 0.75);
  const momentumQuality = clamp01(shortHorizonMomentum(input) / 0.75);
  const transitionQuality = 1 - clamp01(input.emaSeparation / 0.25);
  return clamp01(
    0.2 * extensionQuality +
      0.25 * volatilityQuality +
      0.35 * momentumQuality +
      0.2 * transitionQuality,
  );
}

function tradeQuality(input: V8ShadowMetaInput): number {
  const extensionQuality = 1 - clamp01(input.extensionAtr / 1.5);
  const volatilityQuality = 1 - clamp01(input.volatilityScore / 0.75);
  const structureQuality = clamp01(0.55 * input.emaSeparation + 0.45 * input.mtfStrength);
  return clamp01(0.38 * extensionQuality + 0.27 * volatilityQuality + 0.35 * structureQuality);
}

function pairSideRoute(): 'GOVERNANCE' {
  // Pair/side eligibility is deliberately not hard-coded from development
  // results. The authoritative route is assigned by the prospective sleeve
  // health ledger in ensemble-governance.ts after enough resolved outcomes.
  return 'GOVERNANCE';
}

function pairSideQuality(): number {
  // Neutral diagnostic weight only. This value is not a vote and cannot
  // authorize PAPER; governance requires the prospective sleeve to be CORE.
  return 0.5;
}

function sessionQuality(input: V8ShadowMetaInput): number {
  const newYorkHour = Number(NEW_YORK_HOUR.format(input.scanTime));
  if (newYorkHour === 17) return 0.1;
  const hour = input.scanTime.getUTCHours();
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
): {
  quality: number;
  risk: number;
  sameInstrumentCount: number;
  sameInstrumentDirectionalLots: number;
} {
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
  const sameSignOverlap =
    candidate.reduce((sum, [currency, delta]) => {
      const current = exposure.get(currency) ?? 0;
      return sum + (current * delta > 0 ? Math.min(1, Math.abs(current) / candidateLot) : 0);
    }, 0) / 2;
  const sameInstrumentCount = positions.filter(
    (position) =>
      position.instrument.trim().toUpperCase() === instrument &&
      position.direction === input.direction,
  ).length;
  const netInstrumentLots = positions.reduce((sum, position) => {
    if (position.instrument.trim().toUpperCase() !== instrument) return sum;
    const lots = Number(position.lotSize);
    if (!Number.isFinite(lots) || lots <= 0) return sum;
    return sum + (position.direction === 'BUY' ? lots : -lots);
  }, 0);
  // Ticket count is diagnostic only. Concentration is based on net aligned
  // lots so splitting one exposure into multiple orders cannot change the
  // portfolio risk score, while opposite-direction exposure offsets it.
  const sameInstrumentDirectionalLots = Math.max(0, sign * netInstrumentLots);
  const directionalLoad = clamp01(sameInstrumentDirectionalLots / (candidateLot * 3));
  const risk = clamp01(0.72 * sameSignOverlap + 0.28 * directionalLoad);
  return {
    quality: 1 - risk,
    risk,
    sameInstrumentCount,
    sameInstrumentDirectionalLots,
  };
}

export function scorePlanBMultimodelShadow(
  input: V8ShadowMetaInput,
  positions: PlanBPortfolioPosition[] = [],
): PlanBEnsembleScore {
  const meta = scorePlanBShadowMeta(input);
  const baseRegime = regimeOf(input);
  const confirmedReversal = reversalConfirmed(input, meta.expectedR, baseRegime);
  const earlyTransition =
    !confirmedReversal && earlyTransitionCandidate(input, meta.expectedR, baseRegime);
  const regime: PlanBRegime = confirmedReversal
    ? 'REVERSAL_CONFIRMED'
    : earlyTransition
      ? 'TRANSITION_EARLY'
      : baseRegime;
  const strategyRoute: PlanBEnsembleScore['strategyRoute'] = confirmedReversal
    ? 'CONFIRMED_REVERSAL'
    : earlyTransition
      ? 'EARLY_TRANSITION'
      : 'TREND_CONTINUATION';
  const regimeAllowed =
    regime === 'TREND_HEALTHY' || regime === 'REVERSAL_CONFIRMED' || regime === 'TRANSITION_EARLY';
  const direction = confirmedReversal
    ? reversalDirectionQuality(input)
    : earlyTransition
      ? earlyTransitionDirectionQuality(input)
      : directionQuality(input);
  const quality = confirmedReversal
    ? reversalTradeQuality(input)
    : earlyTransition
      ? earlyTransitionTradeQuality(input)
      : tradeQuality(input);
  const exit = confirmedReversal
    ? reversalExitQuality(input)
    : earlyTransition
      ? earlyTransitionExitQuality(input)
      : exitQuality(input);
  const pairSideRouteValue = pairSideRoute();
  const pairSide = pairSideQuality();
  const session = sessionQuality(input);
  const portfolio = portfolioQualityOf(input, positions);
  const economicQuality = clamp01((meta.expectedR + 0.25) / 0.75);
  const ensembleScore = clamp01(
    0.22 * meta.probability +
      0.15 * direction +
      0.12 * quality +
      0.11 * exit +
      0.1 * pairSide +
      0.08 * session +
      0.1 * economicQuality +
      0.12 * portfolio.quality,
  );

  const reasons: string[] = [];
  if (!regimeAllowed) reasons.push(`REGIME_${regime}`);
  if (input.confidence < PLAN_B_CANDIDATE_CONFIDENCE_FLOOR) reasons.push('CONFIDENCE_FLOOR');
  if (!meta.admitted) reasons.push('META_EXPECTED_VALUE');
  if (direction < 0.55) reasons.push('DIRECTION_QUALITY');
  if (quality < 0.48) reasons.push('TRADE_QUALITY');
  if (exit < 0.48) reasons.push('EXIT_FEASIBILITY');
  if (session < 0.5) reasons.push('SESSION_QUALITY');
  const requiredGrossExpectedR = confirmedReversal
    ? PLAN_B_REVERSAL_GROSS_EXPECTED_R_FLOOR
    : earlyTransition
      ? PLAN_B_EARLY_TRANSITION_GROSS_EXPECTED_R_FLOOR
      : PLAN_B_GROSS_EXPECTED_R_FLOOR;
  if (meta.expectedR < requiredGrossExpectedR) reasons.push('EXPECTED_R');
  if (portfolio.quality < PLAN_B_PORTFOLIO_QUALITY_FLOOR) reasons.push('PORTFOLIO_CONCENTRATION');

  const votes = [
    meta.admitted,
    direction >= 0.55,
    quality >= 0.48,
    exit >= 0.48,
    session >= 0.5,
    meta.expectedR >= requiredGrossExpectedR,
    portfolio.quality >= PLAN_B_PORTFOLIO_QUALITY_FLOOR,
  ];
  const consensusPassed = votes.filter(Boolean).length;
  // Equivalent strictness to the previous 7-of-8 rule after removing the
  // always-development-derived pair/side vote: at most one non-pair gate may
  // fail, while meta admission and expected-R remain mandatory below.
  const consensusRequired = 6;

  const coreAdmissionPassed =
    consensusPassed >= consensusRequired &&
    input.confidence >= PLAN_B_CANDIDATE_CONFIDENCE_FLOOR &&
    meta.admitted &&
    meta.expectedR >= requiredGrossExpectedR &&
    portfolio.quality >= PLAN_B_PORTFOLIO_QUALITY_FLOOR;
  const paperAdmitted = regimeAllowed && coreAdmissionPassed;
  // Early transitions are deliberately PAPER-only until their independent
  // episode ledger qualifies them. Continuation and confirmed-reversal routes
  // retain the existing promotable admission semantics.
  const admitted = paperAdmitted && strategyRoute !== 'EARLY_TRANSITION';

  return {
    artifact: PLAN_B_ENSEMBLE_ARTIFACT,
    mode: PLAN_B_ENSEMBLE_MODE,
    modifiesExecution: false,
    regime,
    regimeAllowed,
    strategyRoute,
    directionQuality: direction,
    expectedR: meta.expectedR,
    tradeQuality: quality,
    exitQuality: exit,
    pairSideQuality: pairSide,
    pairSideRoute: pairSideRouteValue,
    sessionQuality: session,
    consensusPassed,
    consensusRequired,
    portfolioQuality: portfolio.quality,
    portfolioRiskScore: portfolio.risk,
    openPositionCount: positions.length,
    sameInstrumentCount: portfolio.sameInstrumentCount,
    sameInstrumentDirectionalLots: portfolio.sameInstrumentDirectionalLots,
    metaProbability: meta.probability,
    ensembleScore,
    paperAdmitted,
    admitted,
    reasons: admitted
      ? ['ADMIT']
      : paperAdmitted && strategyRoute === 'EARLY_TRANSITION'
        ? ['PAPER_ADMIT_EARLY_TRANSITION']
        : reasons,
  };
}
