import type { AdaptiveEdgeMaturity } from './adaptive-edge-matrix.service';
import type { AdaptiveMarketState } from './adaptive-market-state';
import type { AdaptivePortfolioCapacity } from './adaptive-currency-exposure';

export const ADAPTIVE_OPPORTUNITY_SCORE_ARTIFACT = 'adaptive-opportunity-score-v1';

export const ADAPTIVE_OPPORTUNITY_WEIGHTS = Object.freeze({
  netExpectedR: 0.24,
  regimeFit: 0.14,
  directionQuality: 0.11,
  tradeQuality: 0.1,
  exitQuality: 0.08,
  edgeQuality: 0.08,
  shadowDirectionalPulseQuality: 0.05,
  executionCostQuality: 0.08,
  diversificationQuality: 0.07,
  stabilityQuality: 0.05,
});

export interface AdaptiveOpportunityInput {
  netExpectedR: number;
  estimatedExecutionCostR: number;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
  driftQuality: number;
  shadowDirectionalPulseQuality?: number;
  hardBlockers: string[];
  marketState: {
    state: AdaptiveMarketState;
    stateConfidence: number;
    canUpsize: boolean;
  };
  edge: {
    available: boolean;
    maturity: AdaptiveEdgeMaturity;
    smoothedExpectedR: number;
    smoothedWinRate: number;
    profitFactor: number | null;
    maxDrawdown: number | null;
    recentDegradation: boolean;
  };
  exposure: {
    capacity: AdaptivePortfolioCapacity;
    diversificationQuality: number;
    correlatedExposureScore: number;
    riskEvidenceComplete: boolean;
  };
}

export interface AdaptiveOpportunityComponents {
  netExpectedRQuality: number;
  regimeFit: number;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
  edgeQuality: number;
  shadowDirectionalPulseQuality: number;
  executionCostQuality: number;
  diversificationQuality: number;
  stabilityQuality: number;
}

export interface AdaptiveOpportunityDecision {
  artifact: typeof ADAPTIVE_OPPORTUNITY_SCORE_ARTIFACT;
  score: number;
  executionEligible: boolean;
  hardBlockers: string[];
  components: AdaptiveOpportunityComponents;
  reasons: string[];
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function regimeFitOf(state: AdaptiveMarketState, confidence: number): number {
  const base: Record<AdaptiveMarketState, number> = {
    TREND_HEALTHY: 1,
    REVERSAL: 0.92,
    TRANSITION: 0.78,
    TREND_EXTENDED: 0.62,
    TREND_WEAK: 0.48,
    RANGE: 0.42,
    HIGH_VOLATILITY: 0.25,
    DISLOCATED: 0.08,
    ROLLOVER_RISK: 0.05,
    UNKNOWN: 0.05,
  };
  return clamp01(base[state] * clamp01(confidence));
}

function edgeQualityOf(input: AdaptiveOpportunityInput['edge']): number {
  if (!input.available) return 0.35;
  if (input.maturity === 'DEGRADED' || input.recentDegradation) return 0.12;
  if (input.maturity === 'SPARSE') return 0.4;
  if (input.maturity === 'COLLECTING') {
    return clamp01(0.42 + 0.08 * clamp01(input.smoothedWinRate));
  }

  const expectancy = clamp01((input.smoothedExpectedR + 0.05) / 0.45);
  const winRate = clamp01(input.smoothedWinRate);
  const pf = input.profitFactor == null ? 0.4 : clamp01((input.profitFactor - 0.8) / 1.2);
  const dd = input.maxDrawdown == null ? 0.4 : 1 - clamp01(input.maxDrawdown / 0.12);
  return clamp01(0.35 * expectancy + 0.2 * winRate + 0.25 * pf + 0.2 * dd);
}

export function scoreAdaptiveOpportunity(
  input: AdaptiveOpportunityInput,
): AdaptiveOpportunityDecision {
  const shadowDirectionalPulseQuality =
    input.shadowDirectionalPulseQuality === undefined
      ? 0.5
      : clamp01(input.shadowDirectionalPulseQuality);
  const components: AdaptiveOpportunityComponents = {
    netExpectedRQuality: clamp01((input.netExpectedR + 0.05) / 0.45),
    regimeFit: regimeFitOf(input.marketState.state, input.marketState.stateConfidence),
    directionQuality: clamp01(input.directionQuality),
    tradeQuality: clamp01(input.tradeQuality),
    exitQuality: clamp01(input.exitQuality),
    edgeQuality: edgeQualityOf(input.edge),
    shadowDirectionalPulseQuality,
    executionCostQuality: 1 - clamp01(input.estimatedExecutionCostR / 0.6),
    diversificationQuality: clamp01(input.exposure.diversificationQuality),
    stabilityQuality: clamp01(
      input.driftQuality *
        (input.edge.recentDegradation ? 0.25 : 1) *
        (input.exposure.riskEvidenceComplete ? 1 : 0.65),
    ),
  };

  const score = clamp01(
    ADAPTIVE_OPPORTUNITY_WEIGHTS.netExpectedR * components.netExpectedRQuality +
      ADAPTIVE_OPPORTUNITY_WEIGHTS.regimeFit * components.regimeFit +
      ADAPTIVE_OPPORTUNITY_WEIGHTS.directionQuality * components.directionQuality +
      ADAPTIVE_OPPORTUNITY_WEIGHTS.tradeQuality * components.tradeQuality +
      ADAPTIVE_OPPORTUNITY_WEIGHTS.exitQuality * components.exitQuality +
      ADAPTIVE_OPPORTUNITY_WEIGHTS.edgeQuality * components.edgeQuality +
      ADAPTIVE_OPPORTUNITY_WEIGHTS.shadowDirectionalPulseQuality *
        components.shadowDirectionalPulseQuality +
      ADAPTIVE_OPPORTUNITY_WEIGHTS.executionCostQuality * components.executionCostQuality +
      ADAPTIVE_OPPORTUNITY_WEIGHTS.diversificationQuality * components.diversificationQuality +
      ADAPTIVE_OPPORTUNITY_WEIGHTS.stabilityQuality * components.stabilityQuality,
  );

  const reasons: string[] = [];
  if (!input.edge.available) reasons.push('EDGE_EVIDENCE_UNAVAILABLE');
  if (input.edge.maturity === 'DEGRADED' || input.edge.recentDegradation)
    reasons.push('EDGE_DEGRADED');
  if (shadowDirectionalPulseQuality >= 0.65) reasons.push('SHADOW_DIRECTION_SUPPORTED');
  if (shadowDirectionalPulseQuality <= 0.35) reasons.push('SHADOW_DIRECTION_OPPOSED');
  if (input.exposure.capacity === 'REDUCED') reasons.push('PORTFOLIO_CAPACITY_REDUCED');
  if (input.exposure.capacity === 'BLOCKED') reasons.push('PORTFOLIO_CAPACITY_BLOCKED');
  if (!input.exposure.riskEvidenceComplete) reasons.push('PORTFOLIO_RISK_EVIDENCE_INCOMPLETE');
  if (input.marketState.state === 'DISLOCATED') reasons.push('MARKET_STATE_DISLOCATED');
  if (input.marketState.state === 'UNKNOWN') reasons.push('MARKET_STATE_UNKNOWN');
  if (input.marketState.state === 'ROLLOVER_RISK') reasons.push('MARKET_STATE_ROLLOVER');
  if (input.netExpectedR <= 0) reasons.push('NON_POSITIVE_NET_EXPECTED_R');
  if (input.hardBlockers.length) reasons.push('HARD_GOVERNANCE_BLOCKED');
  if (!reasons.length) reasons.push('ADAPTIVE_OPPORTUNITY_HEALTHY');

  return {
    artifact: ADAPTIVE_OPPORTUNITY_SCORE_ARTIFACT,
    score,
    executionEligible: input.hardBlockers.length === 0,
    hardBlockers: [...input.hardBlockers],
    components,
    reasons,
  };
}
