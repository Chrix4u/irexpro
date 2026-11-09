import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';

/**
 * Provisional, non-executable low-volatility mean-reversion research.
 * All cutoffs are hypotheses, not model-calibrated probability or production
 * qualification. The existing trend/M1 broker execution path never reads
 * these fields; observe after completed broker-native M1 bars only.
 */
export const LOW_VOL_RANGE_SHADOW_ARTIFACT = 'low-vol-range-shadow-v1' as const;
export const LOW_VOL_RANGE_SHADOW_OUTCOME_ARTIFACT = 'low-vol-range-shadow-outcome-15m-v1' as const;
export const LOW_VOL_RANGE_EPISODE_MINUTES = 16;
export const LOW_VOL_RANGE_STOP_ATR = 1.5;
export const LOW_VOL_RANGE_TARGET_ATR = 1.0;

export type LowVolRangeShadowReason =
  | 'STALE_OR_INVALID_FEATURE_EVIDENCE'
  | 'OBSERVED_SPREAD_UNVERIFIED'
  | 'OBSERVED_SPREAD_STOP_GEOMETRY_UNSAFE'
  | 'EVENT_RISK_NOT_CLEAR'
  | 'VOLATILITY_NOT_LOW'
  | 'EMA_STRUCTURE_NOT_RANGE'
  | 'HIGHER_TIMEFRAME_OPPOSES_PROPOSED_SIDE'
  | 'RSI_NOT_EXTREME'
  | 'PRICE_NOT_STRETCHED_FROM_EMA'
  | 'REVERSAL_MOMENTUM_NOT_STABILIZED';

export interface LowVolRangeShadowInput {
  features: M1TacticalFeatureSnapshot;
  direction: 'BUY' | 'SELL';
  evaluatedAt: Date;
  eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
  spreadEvidenceValid: boolean;
  /** Observed broker spread + other known execution geometry, in stop-risk units. */
  observedExecutionCostR: number | null;
}

export function evaluateLowVolRangeShadow(input: LowVolRangeShadowInput) {
  const { features: f, direction, evaluatedAt } = input;
  const sign = direction === 'BUY' ? 1 : -1;
  const atr = f.atr14;
  const stopDistance = atr * LOW_VOL_RANGE_STOP_ATR;
  const targetDistance = atr * LOW_VOL_RANGE_TARGET_ATR;
  const distanceTowardEmaAtr = (sign * (f.ema21 - f.price)) / atr;
  const emaSeparationAtr = Math.abs(f.emaSeparationAtr);
  const alignedH1 = sign * f.alignment.h1;
  const alignedH4 = sign * f.alignment.h4;
  const higherTimeframeAlignment = Math.min(alignedH1, alignedH4);
  const m5Alignment = Math.abs(f.alignment.m5);
  const stabilizedMomentum = sign * f.momentum1Atr;
  const featureAgeMs = evaluatedAt.getTime() - f.latestM1OpenTime.getTime();
  const finite = [
    evaluatedAt.getTime(),
    f.latestM1OpenTime.getTime(),
    atr,
    f.price,
    f.ema21,
    f.emaSeparationAtr,
    f.volatilityScore,
    f.rsi14,
    f.alignment.h1,
    f.alignment.h4,
    f.alignment.m5,
    f.momentum1Atr,
  ].every(Number.isFinite);
  const valid =
    finite &&
    f.price > 0 &&
    f.ema21 > 0 &&
    atr > 0 &&
    featureAgeMs >= 60_000 &&
    featureAgeMs <= 180_000;
  const reasons: LowVolRangeShadowReason[] = [];
  if (!valid) reasons.push('STALE_OR_INVALID_FEATURE_EVIDENCE');
  if (
    !input.spreadEvidenceValid ||
    input.observedExecutionCostR === null ||
    !Number.isFinite(input.observedExecutionCostR) ||
    input.observedExecutionCostR < 0
  ) {
    reasons.push('OBSERVED_SPREAD_UNVERIFIED');
  } else if (input.observedExecutionCostR > 0.4) {
    reasons.push('OBSERVED_SPREAD_STOP_GEOMETRY_UNSAFE');
  }
  if (input.eventRisk !== 'CLEAR') reasons.push('EVENT_RISK_NOT_CLEAR');
  if (!Number.isFinite(f.volatilityScore) || f.volatilityScore > 0.16 || f.volatilityScore < 0) {
    reasons.push('VOLATILITY_NOT_LOW');
  }
  if (
    !Number.isFinite(emaSeparationAtr) ||
    emaSeparationAtr > 0.35 ||
    !Number.isFinite(m5Alignment) ||
    m5Alignment > 0.45
  ) {
    reasons.push('EMA_STRUCTURE_NOT_RANGE');
  }
  // A higher-timeframe trend WITH the proposed direction can coexist with
  // a local range. A strong trend AGAINST it is excluded.
  if (!Number.isFinite(higherTimeframeAlignment) || higherTimeframeAlignment < -0.5) {
    reasons.push('HIGHER_TIMEFRAME_OPPOSES_PROPOSED_SIDE');
  }
  if (!Number.isFinite(f.rsi14) || (direction === 'BUY' ? f.rsi14 > 38 : f.rsi14 < 62)) {
    reasons.push('RSI_NOT_EXTREME');
  }
  if (!Number.isFinite(distanceTowardEmaAtr) || distanceTowardEmaAtr < 0.55) {
    reasons.push('PRICE_NOT_STRETCHED_FROM_EMA');
  }
  if (!Number.isFinite(stabilizedMomentum) || stabilizedMomentum < -0.25) {
    reasons.push('REVERSAL_MOMENTUM_NOT_STABILIZED');
  }

  const candidate = reasons.length === 0;
  // Outcome-only CONTROL when RSI is extreme but the impulse is unstable.
  // Never grant broker authority or describe this as an entry signal.
  const unstableMomentumControl =
    reasons.length === 1 && reasons[0] === 'REVERSAL_MOMENTUM_NOT_STABILIZED';
  const outcomeStudyEligible = candidate || unstableMomentumControl;
  const hypothesisCohort = candidate
    ? ('STABILIZED_ENTRY_HYPOTHESIS' as const)
    : unstableMomentumControl
      ? ('UNSTABLE_MOMENTUM_CONTROL' as const)
      : null;
  return {
    artifact: LOW_VOL_RANGE_SHADOW_ARTIFACT,
    mode: 'SHADOW_ONLY' as const,
    executionAuthority: 'NONE' as const,
    modifiesExecution: false as const,
    grantsExecution: false as const,
    qualificationEvidence: false as const,
    productionEligible: false as const,
    candidate,
    outcomeStudyEligible,
    hypothesisCohort,
    direction,
    reasons,
    evaluatedAt: evaluatedAt.toISOString(),
    latestM1OpenTime: Number.isFinite(f.latestM1OpenTime.getTime())
      ? f.latestM1OpenTime.toISOString()
      : null,
    rsi14: Number.isFinite(f.rsi14) ? f.rsi14 : null,
    volatilityScore: Number.isFinite(f.volatilityScore) ? f.volatilityScore : null,
    emaSeparationAtr: Number.isFinite(emaSeparationAtr) ? emaSeparationAtr : null,
    m5Alignment: Number.isFinite(m5Alignment) ? m5Alignment : null,
    higherTimeframeAlignment: Number.isFinite(higherTimeframeAlignment)
      ? higherTimeframeAlignment
      : null,
    priceDistanceToEmaAtr: Number.isFinite(distanceTowardEmaAtr) ? distanceTowardEmaAtr : null,
    momentumTowardTradeAtr: Number.isFinite(stabilizedMomentum) ? stabilizedMomentum : null,
    // These stop/target levels are research geometry, never broker instructions.
    hypotheticalStopDistance: outcomeStudyEligible ? stopDistance : null,
    hypotheticalTargetDistance: outcomeStudyEligible ? targetDistance : null,
    observedExecutionCostR: Number.isFinite(input.observedExecutionCostR)
      ? input.observedExecutionCostR
      : null,
    entryPricing: 'NEXT_COMPLETED_BROKER_M1_OPEN' as const,
    researchEpisodeMinutes: LOW_VOL_RANGE_EPISODE_MINUTES,
  };
}
