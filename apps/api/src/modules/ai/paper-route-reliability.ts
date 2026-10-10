import { EnsembleSleeveEvidence } from './ensemble-governance';

export const PAPER_TREND_ROUTE_RELIABILITY_ARTIFACT = 'paper-trend-route-reliability-v1';
export const PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES = 20;
export const PAPER_TREND_ROUTE_RELIABILITY_MIN_PROFIT_FACTOR = 1.0;
export const PAPER_TREND_ROUTE_RELIABILITY_MAX_DRAWDOWN = 0.12;

export const PAPER_TREND_PAIR_SIDE_RELIABILITY_SHADOW_ARTIFACT =
  'paper-trend-pair-side-reliability-shadow-v1';
export const PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES = 8;

export type PaperTrendPairSideReliabilityShadowState =
  | 'NOT_APPLICABLE'
  | 'COLLECTING'
  | 'HEALTHY'
  | 'WEAK';

export interface PaperTrendPairSideReliabilityShadowDecision {
  artifact: typeof PAPER_TREND_PAIR_SIDE_RELIABILITY_SHADOW_ARTIFACT;
  state: PaperTrendPairSideReliabilityShadowState;
  modifiesExecution: false;
  executionAuthority: 'NONE';
  episodes: number;
  profitFactor: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  positiveWindowFraction: number | null;
  reason:
    | 'NON_CONTINUATION_ROUTE'
    | 'INSUFFICIENT_PAIR_SIDE_EVIDENCE'
    | 'PAIR_SIDE_HEALTHY'
    | 'PAIR_SIDE_PROFIT_FACTOR_BELOW_ONE'
    | 'PAIR_SIDE_DRAWDOWN_EXCEEDED';
}

export function evaluatePaperTrendPairSideReliabilityShadow(input: {
  strategyRoute: string;
  evidence?: EnsembleSleeveEvidence | null;
}): PaperTrendPairSideReliabilityShadowDecision {
  const evidence = input.evidence ?? null;
  const episodes = Math.max(0, Math.trunc(evidence?.closedTrades ?? 0));
  const profitFactor = evidence?.profitFactor ?? null;
  const sharpe = evidence?.sharpe ?? null;
  const maxDrawdown = evidence?.maxDrawdown ?? null;
  const positiveWindowFraction = evidence?.positiveWindowFraction ?? null;
  const base: Omit<PaperTrendPairSideReliabilityShadowDecision, 'state' | 'reason'> = {
    artifact: PAPER_TREND_PAIR_SIDE_RELIABILITY_SHADOW_ARTIFACT,
    modifiesExecution: false as const,
    executionAuthority: 'NONE' as const,
    episodes,
    profitFactor,
    sharpe,
    maxDrawdown,
    positiveWindowFraction,
  };

  if (input.strategyRoute !== 'TREND_CONTINUATION') {
    return { ...base, state: 'NOT_APPLICABLE', reason: 'NON_CONTINUATION_ROUTE' };
  }

  if (episodes < PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES) {
    return { ...base, state: 'COLLECTING', reason: 'INSUFFICIENT_PAIR_SIDE_EVIDENCE' };
  }

  if (maxDrawdown != null && maxDrawdown > PAPER_TREND_ROUTE_RELIABILITY_MAX_DRAWDOWN) {
    return { ...base, state: 'WEAK', reason: 'PAIR_SIDE_DRAWDOWN_EXCEEDED' };
  }

  if (
    profitFactor != null &&
    Number.isFinite(profitFactor) &&
    profitFactor < PAPER_TREND_ROUTE_RELIABILITY_MIN_PROFIT_FACTOR
  ) {
    return { ...base, state: 'WEAK', reason: 'PAIR_SIDE_PROFIT_FACTOR_BELOW_ONE' };
  }

  return { ...base, state: 'HEALTHY', reason: 'PAIR_SIDE_HEALTHY' };
}

export const PAPER_TREND_PAIR_SIDE_RELIABILITY_ARTIFACT = 'paper-trend-pair-side-reliability-v1';

export type PaperTrendPairSideReliabilityState =
  | 'NOT_APPLICABLE'
  | 'COLLECTING'
  | 'HEALTHY'
  | 'RESEARCH_ONLY';

export interface PaperTrendPairSideReliabilityDecision {
  artifact: typeof PAPER_TREND_PAIR_SIDE_RELIABILITY_ARTIFACT;
  state: PaperTrendPairSideReliabilityState;
  fullSizeEligible: boolean;
  researchFallbackRequested: boolean;
  episodes: number;
  profitFactor: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  positiveWindowFraction: number | null;
  reason: PaperTrendPairSideReliabilityShadowDecision['reason'];
}

export function evaluatePaperTrendPairSideReliability(input: {
  strategyRoute: string;
  evidence?: EnsembleSleeveEvidence | null;
}): PaperTrendPairSideReliabilityDecision {
  const shadow = evaluatePaperTrendPairSideReliabilityShadow(input);
  const base = {
    artifact: PAPER_TREND_PAIR_SIDE_RELIABILITY_ARTIFACT,
    episodes: shadow.episodes,
    profitFactor: shadow.profitFactor,
    sharpe: shadow.sharpe,
    maxDrawdown: shadow.maxDrawdown,
    positiveWindowFraction: shadow.positiveWindowFraction,
    reason: shadow.reason,
  } as const;

  if (shadow.state === 'WEAK') {
    return {
      ...base,
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      researchFallbackRequested: true,
    };
  }

  return {
    ...base,
    state: shadow.state,
    fullSizeEligible: true,
    researchFallbackRequested: false,
  };
}

export interface PaperTrendReliabilityExecutionGateDecision {
  fullSizeEligible: boolean;
  pairSideDemoted: boolean;
  routeDiagnosticOnly: true;
}

export function evaluatePaperTrendReliabilityExecutionGate(input: {
  route: PaperTrendRouteReliabilityDecision;
  pairSide: PaperTrendPairSideReliabilityDecision;
}): PaperTrendReliabilityExecutionGateDecision {
  // Route-wide reliability stays visible as portfolio-level telemetry. Execution
  // selectivity is pair/side-specific so a weak sleeve cannot suppress unrelated
  // profitable continuation sleeves.
  return {
    fullSizeEligible: input.pairSide.fullSizeEligible,
    pairSideDemoted: !input.pairSide.fullSizeEligible,
    routeDiagnosticOnly: true,
  };
}

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
