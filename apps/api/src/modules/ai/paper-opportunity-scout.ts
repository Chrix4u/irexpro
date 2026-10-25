import type { AdaptiveShadowDirectionalPulseDecision } from './adaptive-shadow-directional-pulse';
import type { PaperChampionDirectionPriorDecision } from './paper-champion-direction-prior';
import type { PaperShadowLocalEdgePocketDecision } from './paper-shadow-local-edge-pocket';

export const PAPER_OPPORTUNITY_SCOUT_LOT_CAP = 0.1;
export const PAPER_OPPORTUNITY_SCOUT_ACTIVE_LOT_CAP = 0.1;
export const PAPER_OPPORTUNITY_SCOUT_RECOVERY_LOT_CAP = 0.1;
export const PAPER_OPPORTUNITY_SCOUT_CALIBRATED_OOD_MIN_DIRECTION_QUALITY = 0.08;
export const PAPER_OPPORTUNITY_SCOUT_TARGET_WINDOW_MINUTES = 30;
export const PAPER_OPPORTUNITY_SCOUT_RECOVERY_IDLE_MINUTES = 60;
export const PAPER_OPPORTUNITY_SCOUT_MIN_CONFIDENCE = 0.6;
export const PAPER_OPPORTUNITY_SCOUT_ACTIVE_MIN_CONFIDENCE = 0.58;
export const PAPER_OPPORTUNITY_SCOUT_RECOVERY_MIN_CONFIDENCE = 0.56;
export const PAPER_OPPORTUNITY_SCOUT_MIN_NET_EXPECTED_R = 0.08;
export const PAPER_OPPORTUNITY_SCOUT_ACTIVE_MIN_NET_EXPECTED_R = 0.06;
export const PAPER_OPPORTUNITY_SCOUT_RECOVERY_MIN_NET_EXPECTED_R = 0.04;
export const PAPER_OPPORTUNITY_SCOUT_MIN_QUALITY = 0.3;
export const PAPER_OPPORTUNITY_SCOUT_ACTIVE_MIN_QUALITY = 0.25;
export const PAPER_OPPORTUNITY_SCOUT_RECOVERY_MIN_QUALITY = 0.2;
export const PAPER_OPPORTUNITY_SCOUT_MIN_PORTFOLIO_QUALITY = 0.35;
export const PAPER_OPPORTUNITY_SCOUT_RELAXED_MIN_ALIGNED_MOMENTUM_ATR = 0.15;
export const PAPER_SHADOW_PULSE_SCOUT_MIN_CONFIDENCE = 0.52;
export const PAPER_SHADOW_PULSE_SCOUT_MIN_NET_EXPECTED_R = 0.04;
export const PAPER_SHADOW_PULSE_SCOUT_MIN_QUALITY = 0.2;
export const PAPER_SHADOW_PULSE_SCOUT_MIN_ALIGNED_MOMENTUM_ATR = 0.1;
export const PAPER_SHADOW_PULSE_SCOUT_MIN_WEIGHTED_R = 0.25;
export const PAPER_SHADOW_PULSE_SCOUT_MIN_ADVANTAGE_R = 0.75;
export const PAPER_SHADOW_PULSE_SCOUT_MIN_PULSE_QUALITY = 0.68;

export type PaperOpportunityScoutMode = 'BASE' | 'ACTIVE' | 'RECOVERY' | 'CHAMPION_DIRECTION';

export interface PaperOpportunityScoutInput {
  normalPaperExecution: boolean;
  direction: 'BUY' | 'SELL';
  strategyRoute: 'TREND_CONTINUATION' | 'CONFIRMED_REVERSAL' | 'EARLY_TRANSITION';
  regime:
    | 'TREND_HEALTHY'
    | 'TREND_EXTENDED'
    | 'TREND_WEAK'
    | 'REVERSAL_CONFIRMED'
    | 'TRANSITION_EARLY'
    | 'VOLATILE'
    | 'ROLLOVER_RISK';
  confidence: number;
  consensusPassed: number;
  consensusRequired: number;
  netExpectedR: number;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
  alignedMomentumAtr: number;
  paperExecutionCostUsable: boolean;
  eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
  portfolioQuality: number;
  driftState: 'NORMAL' | 'STRESSED' | 'OUT_OF_DISTRIBUTION';
  idleMinutes?: number | null;
  driftDiagnostics?: readonly string[];
  shadowDirectionalPulse?: AdaptiveShadowDirectionalPulseDecision | null;
  championDirectionPrior?: PaperChampionDirectionPriorDecision | null;
  shadowLocalEdgePocket?: PaperShadowLocalEdgePocketDecision | null;
  calibration?: {
    authoritative: boolean;
    sourceLevel: string;
    maturity: string;
    samples: number;
    calibratedWinProbability: number;
    profitFactor: number | null;
    calibratedNetExpectedR: number;
    recentDegradation: boolean;
    blockRecommended: boolean;
  } | null;
}

export type PaperOpportunityScoutReason =
  | 'OPPORTUNITY_SCOUT'
  | 'CALIBRATED_OOD_SCOUT'
  | 'SHADOW_PULSE_SCOUT'
  | 'CHAMPION_DIRECTION_SCOUT'
  | 'LOCAL_SHADOW_EDGE_SCOUT'
  | 'FULL_SIZE_ALREADY_ELIGIBLE'
  | 'ROUTE_NOT_SCOUTABLE'
  | 'REGIME_NOT_SCOUTABLE'
  | 'CONFIDENCE_TOO_LOW'
  | 'CONSENSUS_TOO_LOW'
  | 'NET_EXPECTED_R_TOO_LOW'
  | 'QUALITY_TOO_LOW'
  | 'MOMENTUM_NOT_CONFIRMED'
  | 'EXECUTION_COST_UNUSABLE'
  | 'EVENT_RISK_NOT_CLEAR'
  | 'PORTFOLIO_QUALITY_TOO_LOW'
  | 'DRIFT_EVIDENCE_TOO_WEAK';

export interface PaperOpportunityScoutDecision {
  eligible: boolean;
  reason: PaperOpportunityScoutReason;
  lotUpperBound: number;
  sizingTier: 'RESEARCH';
  mode: PaperOpportunityScoutMode;
  targetWindowMinutes: typeof PAPER_OPPORTUNITY_SCOUT_TARGET_WINDOW_MINUTES;
  idleMinutes: number | null;
}

interface PaperOpportunityScoutPolicy {
  mode: PaperOpportunityScoutMode;
  lotUpperBound: number;
  minConfidence: number;
  minNetExpectedR: number;
  minQuality: number;
  requireAlignedMomentum: boolean;
  idleMinutes: number | null;
}

function resolvePolicy(
  idleMinutes: number | null | undefined,
  championDirectionPrior?: PaperChampionDirectionPriorDecision | null,
): PaperOpportunityScoutPolicy {
  const normalizedIdleMinutes =
    Number.isFinite(idleMinutes) && idleMinutes! >= 0 ? idleMinutes! : null;
  if (
    championDirectionPrior?.supported === true &&
    normalizedIdleMinutes !== null &&
    normalizedIdleMinutes >= PAPER_OPPORTUNITY_SCOUT_TARGET_WINDOW_MINUTES
  ) {
    const recovery = normalizedIdleMinutes >= PAPER_OPPORTUNITY_SCOUT_RECOVERY_IDLE_MINUTES;
    return {
      mode: 'CHAMPION_DIRECTION',
      lotUpperBound: recovery
        ? PAPER_OPPORTUNITY_SCOUT_RECOVERY_LOT_CAP
        : PAPER_OPPORTUNITY_SCOUT_ACTIVE_LOT_CAP,
      minConfidence: recovery
        ? PAPER_OPPORTUNITY_SCOUT_RECOVERY_MIN_CONFIDENCE
        : PAPER_OPPORTUNITY_SCOUT_ACTIVE_MIN_CONFIDENCE,
      minNetExpectedR: recovery
        ? PAPER_OPPORTUNITY_SCOUT_RECOVERY_MIN_NET_EXPECTED_R
        : PAPER_OPPORTUNITY_SCOUT_ACTIVE_MIN_NET_EXPECTED_R,
      minQuality: recovery
        ? PAPER_OPPORTUNITY_SCOUT_RECOVERY_MIN_QUALITY
        : PAPER_OPPORTUNITY_SCOUT_ACTIVE_MIN_QUALITY,
      requireAlignedMomentum: true,
      idleMinutes: normalizedIdleMinutes,
    };
  }
  if (
    normalizedIdleMinutes !== null &&
    normalizedIdleMinutes >= PAPER_OPPORTUNITY_SCOUT_RECOVERY_IDLE_MINUTES
  ) {
    return {
      mode: 'RECOVERY',
      lotUpperBound: PAPER_OPPORTUNITY_SCOUT_RECOVERY_LOT_CAP,
      minConfidence: PAPER_OPPORTUNITY_SCOUT_RECOVERY_MIN_CONFIDENCE,
      minNetExpectedR: PAPER_OPPORTUNITY_SCOUT_RECOVERY_MIN_NET_EXPECTED_R,
      minQuality: PAPER_OPPORTUNITY_SCOUT_RECOVERY_MIN_QUALITY,
      requireAlignedMomentum: true,
      idleMinutes: normalizedIdleMinutes,
    };
  }
  if (
    normalizedIdleMinutes !== null &&
    normalizedIdleMinutes >= PAPER_OPPORTUNITY_SCOUT_TARGET_WINDOW_MINUTES
  ) {
    return {
      mode: 'ACTIVE',
      lotUpperBound: PAPER_OPPORTUNITY_SCOUT_ACTIVE_LOT_CAP,
      minConfidence: PAPER_OPPORTUNITY_SCOUT_ACTIVE_MIN_CONFIDENCE,
      minNetExpectedR: PAPER_OPPORTUNITY_SCOUT_ACTIVE_MIN_NET_EXPECTED_R,
      minQuality: PAPER_OPPORTUNITY_SCOUT_ACTIVE_MIN_QUALITY,
      requireAlignedMomentum: true,
      idleMinutes: normalizedIdleMinutes,
    };
  }
  return {
    mode: 'BASE',
    lotUpperBound: PAPER_OPPORTUNITY_SCOUT_LOT_CAP,
    minConfidence: PAPER_OPPORTUNITY_SCOUT_MIN_CONFIDENCE,
    minNetExpectedR: PAPER_OPPORTUNITY_SCOUT_MIN_NET_EXPECTED_R,
    minQuality: PAPER_OPPORTUNITY_SCOUT_MIN_QUALITY,
    requireAlignedMomentum: false,
    idleMinutes: normalizedIdleMinutes,
  };
}

function decision(
  policy: PaperOpportunityScoutPolicy,
  eligible: boolean,
  reason: PaperOpportunityScoutReason,
  lotUpperBound = policy.lotUpperBound,
): PaperOpportunityScoutDecision {
  return {
    eligible,
    reason,
    lotUpperBound,
    sizingTier: 'RESEARCH',
    mode: policy.mode,
    targetWindowMinutes: PAPER_OPPORTUNITY_SCOUT_TARGET_WINDOW_MINUTES,
    idleMinutes: policy.idleMinutes,
  };
}

/**
 * PAPER-only participation lane for positive-edge M5 trend opportunities that
 * miss a small number of soft ensemble votes. Longer idleness may relax only
 * soft predictive floors while position size falls. Hard event/cost/portfolio,
 * route/regime and OOD evidence requirements remain fail-closed.
 */
export function evaluatePaperOpportunityScout(
  input: PaperOpportunityScoutInput,
): PaperOpportunityScoutDecision {
  const policy = resolvePolicy(
    input.idleMinutes,
    input.strategyRoute === 'TREND_CONTINUATION' ? input.championDirectionPrior : null,
  );
  const reject = (reason: PaperOpportunityScoutReason) => decision(policy, false, reason);

  if (input.normalPaperExecution) return reject('FULL_SIZE_ALREADY_ELIGIBLE');
  if (input.strategyRoute !== 'TREND_CONTINUATION') return reject('ROUTE_NOT_SCOUTABLE');
  if (!['TREND_HEALTHY', 'TREND_EXTENDED', 'TREND_WEAK'].includes(input.regime))
    return reject('REGIME_NOT_SCOUTABLE');
  if (input.eventRisk !== 'CLEAR') return reject('EVENT_RISK_NOT_CLEAR');
  if (!input.paperExecutionCostUsable) return reject('EXECUTION_COST_UNUSABLE');
  if (
    !Number.isFinite(input.portfolioQuality) ||
    input.portfolioQuality < PAPER_OPPORTUNITY_SCOUT_MIN_PORTFOLIO_QUALITY
  )
    return reject('PORTFOLIO_QUALITY_TOO_LOW');

  if (input.shadowLocalEdgePocket?.supported === true) {
    if (!Number.isFinite(input.confidence) || input.confidence < 0.6)
      return reject('CONFIDENCE_TOO_LOW');
    if (input.consensusRequired <= 0 || input.consensusPassed < 4)
      return reject('CONSENSUS_TOO_LOW');
    if (
      !Number.isFinite(input.tradeQuality) ||
      input.tradeQuality < 0.3 ||
      !Number.isFinite(input.exitQuality) ||
      input.exitQuality < 0.3
    )
      return reject('QUALITY_TOO_LOW');
    return decision(policy, true, 'LOCAL_SHADOW_EDGE_SCOUT', 0.1);
  }

  const shadowPulse = input.shadowDirectionalPulse;
  const strongShadowPulse =
    shadowPulse?.available === true &&
    shadowPulse.status === 'SUPPORTED' &&
    shadowPulse.direction === input.direction &&
    shadowPulse.candidateSamples >= 4 &&
    shadowPulse.oppositeSamples >= 4 &&
    Number.isFinite(shadowPulse.candidateWeightedR) &&
    shadowPulse.candidateWeightedR >= PAPER_SHADOW_PULSE_SCOUT_MIN_WEIGHTED_R &&
    Number.isFinite(shadowPulse.advantageR) &&
    shadowPulse.advantageR >= PAPER_SHADOW_PULSE_SCOUT_MIN_ADVANTAGE_R &&
    Number.isFinite(shadowPulse.quality) &&
    shadowPulse.quality >= PAPER_SHADOW_PULSE_SCOUT_MIN_PULSE_QUALITY;

  if (strongShadowPulse) {
    if (input.driftState === 'OUT_OF_DISTRIBUTION') return reject('DRIFT_EVIDENCE_TOO_WEAK');
    if (
      !Number.isFinite(input.confidence) ||
      input.confidence < PAPER_SHADOW_PULSE_SCOUT_MIN_CONFIDENCE
    )
      return reject('CONFIDENCE_TOO_LOW');
    if (
      !Number.isFinite(input.netExpectedR) ||
      input.netExpectedR < PAPER_SHADOW_PULSE_SCOUT_MIN_NET_EXPECTED_R
    )
      return reject('NET_EXPECTED_R_TOO_LOW');
    if (input.consensusRequired <= 0 || input.consensusPassed < 4)
      return reject('CONSENSUS_TOO_LOW');
    if (
      [input.directionQuality, input.tradeQuality, input.exitQuality].some(
        (value) => !Number.isFinite(value) || value < PAPER_SHADOW_PULSE_SCOUT_MIN_QUALITY,
      )
    )
      return reject('QUALITY_TOO_LOW');
    if (
      !Number.isFinite(input.alignedMomentumAtr) ||
      input.alignedMomentumAtr < PAPER_SHADOW_PULSE_SCOUT_MIN_ALIGNED_MOMENTUM_ATR
    )
      return reject('MOMENTUM_NOT_CONFIRMED');
    return decision(policy, true, 'SHADOW_PULSE_SCOUT', PAPER_OPPORTUNITY_SCOUT_LOT_CAP);
  }

  if (input.driftState === 'OUT_OF_DISTRIBUTION') {
    const calibration = input.calibration;
    const localCalibration =
      calibration?.authoritative === true &&
      (calibration.sourceLevel === 'EXACT' || calibration.sourceLevel === 'PAIR_DIRECTION_ROUTE') &&
      (calibration.maturity === 'COLLECTING' || calibration.maturity === 'MATURE') &&
      calibration.samples >= 10 &&
      Number.isFinite(calibration.calibratedWinProbability) &&
      calibration.calibratedWinProbability >= 0.6 &&
      Number.isFinite(calibration.profitFactor) &&
      calibration.profitFactor! >= 1.5 &&
      Number.isFinite(calibration.calibratedNetExpectedR) &&
      calibration.calibratedNetExpectedR >= 0.05 &&
      !calibration.recentDegradation &&
      !calibration.blockRecommended;
    const idleWindowReached =
      policy.mode === 'CHAMPION_DIRECTION' ||
      (policy.idleMinutes !== null && policy.idleMinutes >= 30);
    const hasHardMtfDisagreement = (input.driftDiagnostics ?? []).includes('mtfStrength:HARD_LOW');
    const microStructureValid =
      idleWindowReached &&
      input.consensusRequired > 0 &&
      input.consensusPassed >= 4 &&
      Number.isFinite(input.netExpectedR) &&
      input.netExpectedR >= 0.05 &&
      Number.isFinite(input.directionQuality) &&
      input.directionQuality >= PAPER_OPPORTUNITY_SCOUT_CALIBRATED_OOD_MIN_DIRECTION_QUALITY &&
      Number.isFinite(input.tradeQuality) &&
      input.tradeQuality >= 0.3 &&
      Number.isFinite(input.exitQuality) &&
      input.exitQuality >= 0.3;
    const momentumConfirmed =
      Number.isFinite(input.alignedMomentumAtr) && input.alignedMomentumAtr >= 0.05;

    if (idleWindowReached && input.calibration && !localCalibration) {
      return reject('DRIFT_EVIDENCE_TOO_WEAK');
    }
    if (localCalibration && microStructureValid && hasHardMtfDisagreement) {
      return reject('DRIFT_EVIDENCE_TOO_WEAK');
    }
    if (localCalibration && microStructureValid && !momentumConfirmed) {
      return reject('MOMENTUM_NOT_CONFIRMED');
    }
    if (localCalibration && microStructureValid && momentumConfirmed) {
      return decision(policy, true, 'CALIBRATED_OOD_SCOUT', 0.1);
    }
  }
  if (!Number.isFinite(input.confidence) || input.confidence < policy.minConfidence)
    return reject('CONFIDENCE_TOO_LOW');
  if (!Number.isFinite(input.netExpectedR) || input.netExpectedR < policy.minNetExpectedR)
    return reject('NET_EXPECTED_R_TOO_LOW');

  const minimumConsensus = Math.max(4, input.consensusRequired - 2);
  if (input.consensusRequired <= 0 || input.consensusPassed < minimumConsensus)
    return reject('CONSENSUS_TOO_LOW');

  if (
    [input.directionQuality, input.tradeQuality, input.exitQuality].some(
      (value) => !Number.isFinite(value) || value < policy.minQuality,
    )
  )
    return reject('QUALITY_TOO_LOW');

  const requiresMomentum =
    policy.requireAlignedMomentum ||
    input.regime === 'TREND_EXTENDED' ||
    input.regime === 'TREND_WEAK';
  if (
    requiresMomentum &&
    (!Number.isFinite(input.alignedMomentumAtr) ||
      input.alignedMomentumAtr < PAPER_OPPORTUNITY_SCOUT_RELAXED_MIN_ALIGNED_MOMENTUM_ATR)
  )
    return reject('MOMENTUM_NOT_CONFIRMED');

  if (input.driftState === 'OUT_OF_DISTRIBUTION') {
    const strongerConsensus =
      input.consensusRequired > 0 && input.consensusPassed >= input.consensusRequired - 1;
    if (input.confidence < 0.62 || input.netExpectedR < 0.12 || !strongerConsensus)
      return reject('DRIFT_EVIDENCE_TOO_WEAK');
  }

  return decision(
    policy,
    true,
    policy.mode === 'CHAMPION_DIRECTION' ? 'CHAMPION_DIRECTION_SCOUT' : 'OPPORTUNITY_SCOUT',
  );
}
