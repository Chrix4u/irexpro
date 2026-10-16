export const ADAPTIVE_MARKET_STATE_ARTIFACT = 'adaptive-market-state-v1';

export type AdaptiveMarketState =
  | 'TREND_HEALTHY'
  | 'TREND_EXTENDED'
  | 'TREND_WEAK'
  | 'RANGE'
  | 'TRANSITION'
  | 'REVERSAL'
  | 'HIGH_VOLATILITY'
  | 'DISLOCATED'
  | 'ROLLOVER_RISK'
  | 'UNKNOWN';

export type AdaptiveMarketSession = 'ASIA' | 'LONDON' | 'NEW_YORK' | 'ROLLOVER';

export interface AdaptiveMarketStateInput {
  scanTime: Date;
  legacyRegime: string;
  strategyRoute: string;
  driftState: string;
  confidence: number;
  emaSeparation: number;
  mtfStrength: number;
  h4Alignment?: number;
  h4ContextAvailable?: boolean;
  extensionAtr: number;
  shortHorizonMomentumAtr: number;
  volatilityScore: number;
  rsi14: number;
  executionCostUsable: boolean;
  dataFreshness: 'FRESH' | 'STALE' | 'UNKNOWN';
}

export interface AdaptiveMarketStateDecision {
  artifact: typeof ADAPTIVE_MARKET_STATE_ARTIFACT;
  state: AdaptiveMarketState;
  stateConfidence: number;
  tradingConfidence: number;
  trendStrength: number;
  transitionScore: number;
  reversalScore: number;
  volatilityState: 'NORMAL' | 'ELEVATED' | 'HIGH' | 'UNKNOWN';
  higherTimeframeAgreement: number;
  h4Alignment: number;
  h4ContextAvailable: boolean;
  session: AdaptiveMarketSession;
  reasons: string[];
  dataFreshness: AdaptiveMarketStateInput['dataFreshness'];
  canUpsize: boolean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function adaptiveMarketSession(scanTime: Date): AdaptiveMarketSession {
  const hour = scanTime.getUTCHours();
  if (hour >= 21) return 'ROLLOVER';
  if (hour < 7) return 'ASIA';
  if (hour < 13) return 'LONDON';
  return 'NEW_YORK';
}

function finiteInputs(input: AdaptiveMarketStateInput): boolean {
  if (input.h4ContextAvailable === true && !Number.isFinite(input.h4Alignment)) return false;
  return [
    input.scanTime.getTime(),
    input.confidence,
    input.emaSeparation,
    input.mtfStrength,
    input.extensionAtr,
    input.shortHorizonMomentumAtr,
    input.volatilityScore,
    input.rsi14,
  ].every(Number.isFinite);
}

export function classifyAdaptiveMarketState(
  input: AdaptiveMarketStateInput,
): AdaptiveMarketStateDecision {
  const session = adaptiveMarketSession(input.scanTime);
  const h4ContextAvailable =
    input.h4ContextAvailable === true && Number.isFinite(input.h4Alignment);
  const h4Alignment = h4ContextAvailable ? clamp01(input.h4Alignment ?? 0) : 0;
  const baseHigherTimeframeAgreement = finiteInputs(input)
    ? clamp01((Math.max(0, input.emaSeparation) + Math.max(0, input.mtfStrength)) / 0.8)
    : 0;
  const higherTimeframeAgreement = h4ContextAvailable
    ? clamp01(0.75 * baseHigherTimeframeAgreement + 0.25 * h4Alignment)
    : baseHigherTimeframeAgreement;
  const h4Conflict = h4ContextAvailable && h4Alignment < 0.15;
  const trendStrength = finiteInputs(input)
    ? clamp01(
        0.42 * clamp01(input.emaSeparation / 0.5) +
          0.42 * clamp01(input.mtfStrength / 0.5) +
          0.16 * clamp01(Math.abs(input.shortHorizonMomentumAtr) / 0.75),
      )
    : 0;
  const transitionScore = finiteInputs(input)
    ? clamp01(
        0.5 * (1 - clamp01(input.mtfStrength / 0.25)) +
          0.3 * clamp01(input.emaSeparation / 0.25) +
          0.2 * clamp01(Math.abs(input.shortHorizonMomentumAtr) / 0.5),
      )
    : 0;
  const reversalScore = finiteInputs(input)
    ? clamp01(
        0.55 * clamp01(Math.max(0, input.shortHorizonMomentumAtr) / 0.75) +
          0.25 * (1 - clamp01(input.mtfStrength / 0.3)) +
          0.2 * clamp01((input.confidence - 0.6) / 0.2),
      )
    : 0;
  const volatilityState: AdaptiveMarketStateDecision['volatilityState'] = !Number.isFinite(
    input.volatilityScore,
  )
    ? 'UNKNOWN'
    : input.volatilityScore >= 0.65
      ? 'HIGH'
      : input.volatilityScore >= 0.5
        ? 'ELEVATED'
        : 'NORMAL';

  const base = {
    artifact: ADAPTIVE_MARKET_STATE_ARTIFACT,
    tradingConfidence: input.confidence,
    trendStrength,
    transitionScore,
    reversalScore,
    volatilityState,
    higherTimeframeAgreement,
    h4Alignment,
    h4ContextAvailable,
    session,
    dataFreshness: input.dataFreshness,
  } as const;

  if (!finiteInputs(input) || input.dataFreshness !== 'FRESH') {
    return {
      ...base,
      state: 'UNKNOWN',
      stateConfidence: 0.2,
      reasons: [!finiteInputs(input) ? 'INCOMPLETE_MARKET_EVIDENCE' : 'STALE_MARKET_EVIDENCE'],
      canUpsize: false,
    };
  }

  if (input.driftState === 'OUT_OF_DISTRIBUTION') {
    return {
      ...base,
      state: 'DISLOCATED',
      stateConfidence: 0.9,
      reasons: ['DRIFT_OUT_OF_DISTRIBUTION'],
      canUpsize: false,
    };
  }

  if (session === 'ROLLOVER' || input.legacyRegime === 'ROLLOVER_RISK') {
    return {
      ...base,
      state: 'ROLLOVER_RISK',
      stateConfidence: 0.95,
      reasons: ['ROLLOVER_SESSION'],
      canUpsize: false,
    };
  }

  if (input.strategyRoute === 'CONFIRMED_REVERSAL' || input.legacyRegime === 'REVERSAL_CONFIRMED') {
    return {
      ...base,
      state: 'REVERSAL',
      stateConfidence: clamp01(0.55 + 0.35 * reversalScore),
      reasons: ['CONFIRMED_REVERSAL_ROUTE'],
      canUpsize: input.executionCostUsable && input.driftState === 'NORMAL' && !h4Conflict,
    };
  }

  if (input.strategyRoute === 'EARLY_TRANSITION' || input.legacyRegime === 'TRANSITION_EARLY') {
    return {
      ...base,
      state: 'TRANSITION',
      stateConfidence: clamp01(0.5 + 0.35 * transitionScore),
      reasons: ['EARLY_TRANSITION_ROUTE'],
      canUpsize: false,
    };
  }

  if (volatilityState === 'HIGH' || input.legacyRegime === 'VOLATILE') {
    return {
      ...base,
      state: 'HIGH_VOLATILITY',
      stateConfidence: 0.85,
      reasons: ['HIGH_VOLATILITY'],
      canUpsize: false,
    };
  }

  if (
    input.legacyRegime === 'TREND_WEAK' &&
    input.emaSeparation < 0.08 &&
    input.mtfStrength < 0.08 &&
    Math.abs(input.shortHorizonMomentumAtr) < 0.12
  ) {
    return {
      ...base,
      state: 'RANGE',
      stateConfidence: 0.72,
      reasons: ['LOW_STRUCTURE_RANGE'],
      canUpsize: false,
    };
  }

  if (input.legacyRegime === 'TREND_EXTENDED') {
    return {
      ...base,
      state: 'TREND_EXTENDED',
      stateConfidence: 0.76,
      reasons: ['LEGACY_TREND_EXTENDED'],
      canUpsize: false,
    };
  }

  if (input.legacyRegime === 'TREND_WEAK') {
    return {
      ...base,
      state: 'TREND_WEAK',
      stateConfidence: 0.68,
      reasons: ['LEGACY_TREND_WEAK'],
      canUpsize: false,
    };
  }

  const canUpsize =
    input.legacyRegime === 'TREND_HEALTHY' &&
    input.driftState === 'NORMAL' &&
    input.executionCostUsable &&
    trendStrength >= 0.45 &&
    !h4Conflict;
  const healthyReasons = ['HEALTHY_TREND_STRUCTURE'];
  if (h4ContextAvailable && h4Alignment >= 0.55) healthyReasons.push('H4_CONTEXT_ALIGNED');
  if (h4Conflict) healthyReasons.push('H4_CONTEXT_CONFLICT');
  return {
    ...base,
    state: 'TREND_HEALTHY',
    stateConfidence: clamp01(0.62 + 0.25 * higherTimeframeAgreement),
    reasons: healthyReasons,
    canUpsize,
  };
}
