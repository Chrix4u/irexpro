import { EnsembleSleeveEvidence } from './ensemble-governance';

export const PAPER_TREND_ROUTE_RELIABILITY_ARTIFACT = 'paper-trend-route-reliability-v1';
export const PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES = 20;
export const PAPER_TREND_ROUTE_RELIABILITY_MIN_PROFIT_FACTOR = 1.0;
export const PAPER_TREND_ROUTE_RELIABILITY_MAX_DRAWDOWN = 0.12;

export type PaperTrendRouteReliabilityState =
  | 'NOT_APPLICABLE'
  | 'COLLECTING'
  | 'HEALTHY'
  | 'RESEARCH_ONLY';

export interface PaperTrendRouteReliabilityDecision {
  artifact: typeof PAPER_TREND_ROUTE_RELIABILITY_ARTIFACT;
  state: PaperTrendRouteReliabilityState;
  fullSizeEligible: boolean;
  researchFallbackRequested: boolean;
  episodes: number;
  profitFactor: number | null;
  maxDrawdown: number | null;
  reason:
    | 'NON_CONTINUATION_ROUTE'
    | 'INSUFFICIENT_ROUTE_EVIDENCE'
    | 'ROUTE_HEALTHY'
    | 'ROUTE_PROFIT_FACTOR_BELOW_ONE'
    | 'ROUTE_DRAWDOWN_EXCEEDED';
}

export function evaluatePaperTrendRouteReliability(input: {
  strategyRoute: string;
  evidence?: EnsembleSleeveEvidence | null;
}): PaperTrendRouteReliabilityDecision {
  const evidence = input.evidence ?? null;
  const episodes = Math.max(0, Math.trunc(evidence?.closedTrades ?? 0));
  const profitFactor = evidence?.profitFactor ?? null;
  const maxDrawdown = evidence?.maxDrawdown ?? null;

  if (input.strategyRoute !== 'TREND_CONTINUATION') {
    return {
      artifact: PAPER_TREND_ROUTE_RELIABILITY_ARTIFACT,
      state: 'NOT_APPLICABLE',
      fullSizeEligible: true,
      researchFallbackRequested: false,
      episodes,
      profitFactor,
      maxDrawdown,
      reason: 'NON_CONTINUATION_ROUTE',
    };
  }

  if (episodes < PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES) {
    return {
      artifact: PAPER_TREND_ROUTE_RELIABILITY_ARTIFACT,
      state: 'COLLECTING',
      fullSizeEligible: true,
      researchFallbackRequested: false,
      episodes,
      profitFactor,
      maxDrawdown,
      reason: 'INSUFFICIENT_ROUTE_EVIDENCE',
    };
  }

  if (maxDrawdown != null && maxDrawdown > PAPER_TREND_ROUTE_RELIABILITY_MAX_DRAWDOWN) {
    return {
      artifact: PAPER_TREND_ROUTE_RELIABILITY_ARTIFACT,
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      researchFallbackRequested: true,
      episodes,
      profitFactor,
      maxDrawdown,
      reason: 'ROUTE_DRAWDOWN_EXCEEDED',
    };
  }

  if (
    profitFactor != null &&
    Number.isFinite(profitFactor) &&
    profitFactor < PAPER_TREND_ROUTE_RELIABILITY_MIN_PROFIT_FACTOR
  ) {
    return {
      artifact: PAPER_TREND_ROUTE_RELIABILITY_ARTIFACT,
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      researchFallbackRequested: true,
      episodes,
      profitFactor,
      maxDrawdown,
      reason: 'ROUTE_PROFIT_FACTOR_BELOW_ONE',
    };
  }

  return {
    artifact: PAPER_TREND_ROUTE_RELIABILITY_ARTIFACT,
    state: 'HEALTHY',
    fullSizeEligible: true,
    researchFallbackRequested: false,
    episodes,
    profitFactor,
    maxDrawdown,
    reason: 'ROUTE_HEALTHY',
  };
}
