export const PAPER_OPPORTUNITY_SCOUT_LOT_CAP = 0.05;
export const PAPER_OPPORTUNITY_SCOUT_MIN_CONFIDENCE = 0.6;
export const PAPER_OPPORTUNITY_SCOUT_MIN_NET_EXPECTED_R = 0.08;
export const PAPER_OPPORTUNITY_SCOUT_MIN_QUALITY = 0.3;
export const PAPER_OPPORTUNITY_SCOUT_MIN_PORTFOLIO_QUALITY = 0.35;

export interface PaperOpportunityScoutInput {
  normalPaperExecution: boolean;
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
}

export type PaperOpportunityScoutReason =
  | 'OPPORTUNITY_SCOUT'
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
}

function reject(reason: PaperOpportunityScoutReason): PaperOpportunityScoutDecision {
  return {
    eligible: false,
    reason,
    lotUpperBound: PAPER_OPPORTUNITY_SCOUT_LOT_CAP,
    sizingTier: 'RESEARCH',
  };
}

/**
 * PAPER-only participation lane for positive-edge M5 trend opportunities that
 * miss a small number of soft ensemble votes. It never re-opens research or
 * confirmed-reversal authority, and it keeps hard event/cost/portfolio safety
 * evidence fail-closed. OOD candidates require materially stronger evidence.
 */
export function evaluatePaperOpportunityScout(
  input: PaperOpportunityScoutInput,
): PaperOpportunityScoutDecision {
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
  if (
    !Number.isFinite(input.confidence) ||
    input.confidence < PAPER_OPPORTUNITY_SCOUT_MIN_CONFIDENCE
  )
    return reject('CONFIDENCE_TOO_LOW');
  if (
    !Number.isFinite(input.netExpectedR) ||
    input.netExpectedR < PAPER_OPPORTUNITY_SCOUT_MIN_NET_EXPECTED_R
  )
    return reject('NET_EXPECTED_R_TOO_LOW');

  const minimumConsensus = Math.max(4, input.consensusRequired - 2);
  if (input.consensusRequired <= 0 || input.consensusPassed < minimumConsensus)
    return reject('CONSENSUS_TOO_LOW');

  if (
    [input.directionQuality, input.tradeQuality, input.exitQuality].some(
      (value) => !Number.isFinite(value) || value < PAPER_OPPORTUNITY_SCOUT_MIN_QUALITY,
    )
  )
    return reject('QUALITY_TOO_LOW');

  if (
    (input.regime === 'TREND_EXTENDED' || input.regime === 'TREND_WEAK') &&
    (!Number.isFinite(input.alignedMomentumAtr) || input.alignedMomentumAtr < 0.15)
  )
    return reject('MOMENTUM_NOT_CONFIRMED');

  if (input.driftState === 'OUT_OF_DISTRIBUTION') {
    const strongerConsensus =
      input.consensusRequired > 0 && input.consensusPassed >= input.consensusRequired - 1;
    if (input.confidence < 0.62 || input.netExpectedR < 0.12 || !strongerConsensus)
      return reject('DRIFT_EVIDENCE_TOO_WEAK');
  }

  return {
    eligible: true,
    reason: 'OPPORTUNITY_SCOUT',
    lotUpperBound: PAPER_OPPORTUNITY_SCOUT_LOT_CAP,
    sizingTier: 'RESEARCH',
  };
}
