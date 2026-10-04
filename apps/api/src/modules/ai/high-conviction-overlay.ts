import type { PlanBV4BrokerScoreResponse } from '../ai-engine-client/ai-engine-client.service';
import { EnsembleShadowOutcome, summarizeEnsembleSleeveOutcomes } from './ensemble-shadow-outcome';

export type HighConvictionOverlayState =
  | 'CONFIRM'
  | 'CONFLICT'
  | 'ABSTAIN'
  | 'STALE'
  | 'UNAVAILABLE';

export interface HighConvictionOverlay {
  state: HighConvictionOverlayState;
  reason: string | null;
  decisionTime: string | null;
  freshnessSeconds: number | null;
  allBrokerNative: boolean;
  direction: 'BUY' | 'SELL' | null;
  admitted: boolean | null;
  ensembleConfidence: number | null;
  meanOpportunityProbability: number | null;
  longVotes: number | null;
  shortVotes: number | null;
  regime: string | null;
  modifiesExecution: false;
}

const REQUIRED_TIMEFRAMES = Object.freeze(['M1', 'M5', 'M15', 'H1', 'H4']);
const MAX_ALIGNMENT_MS = 6 * 60_000;

export function classifyHighConvictionOverlay(
  response: PlanBV4BrokerScoreResponse,
  candidateDirection: 'BUY' | 'SELL',
  candidateCloseTime: Date,
): HighConvictionOverlay {
  const sources = response.market_data_sources ?? {};
  const allBrokerNative = REQUIRED_TIMEFRAMES.every((timeframe) => sources[timeframe] === 'broker');

  if (response.state !== 'READY' || !response.score) {
    return {
      state: 'UNAVAILABLE',
      reason: response.reason ?? response.state,
      decisionTime: response.decision_time ?? null,
      freshnessSeconds: null,
      allBrokerNative,
      direction: null,
      admitted: null,
      ensembleConfidence: null,
      meanOpportunityProbability: null,
      longVotes: null,
      shortVotes: null,
      regime: null,
      modifiesExecution: false,
    };
  }

  const decisionTime = response.decision_time ? new Date(response.decision_time) : null;
  const alignmentMs =
    decisionTime && Number.isFinite(decisionTime.getTime())
      ? Math.abs(decisionTime.getTime() - candidateCloseTime.getTime())
      : Number.POSITIVE_INFINITY;

  if (!allBrokerNative || alignmentMs > MAX_ALIGNMENT_MS) {
    return {
      state: 'STALE',
      reason: !allBrokerNative ? 'BROKER_NATIVE_MTF_REQUIRED' : 'BROKER_MTF_TIME_MISMATCH',
      decisionTime:
        decisionTime && Number.isFinite(decisionTime.getTime()) ? decisionTime.toISOString() : null,
      freshnessSeconds: Number.isFinite(alignmentMs) ? alignmentMs / 1000 : null,
      allBrokerNative,
      direction: response.score.direction,
      admitted: response.score.admitted,
      ensembleConfidence: response.score.ensemble_confidence,
      meanOpportunityProbability: response.score.mean_opportunity_probability,
      longVotes: response.score.long_votes,
      shortVotes: response.score.short_votes,
      regime: response.score.regime,
      modifiesExecution: false,
    };
  }

  const state: HighConvictionOverlayState = !response.score.admitted
    ? 'ABSTAIN'
    : response.score.direction === candidateDirection
      ? 'CONFIRM'
      : 'CONFLICT';

  return {
    state,
    reason: null,
    decisionTime: decisionTime!.toISOString(),
    freshnessSeconds: alignmentMs / 1000,
    allBrokerNative: true,
    direction: response.score.direction,
    admitted: response.score.admitted,
    ensembleConfidence: response.score.ensemble_confidence,
    meanOpportunityProbability: response.score.mean_opportunity_probability,
    longVotes: response.score.long_votes,
    shortVotes: response.score.short_votes,
    regime: response.score.regime,
    modifiesExecution: false,
  };
}

export interface HighConvictionOverlayCohortEvidence {
  state: HighConvictionOverlayState;
  observations: number;
  resolved: number;
  evaluableResolved: number;
  wins: number;
  losses: number;
  expired: number;
  ambiguous: number;
  netR: number;
  profitFactor: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  positiveWindowFraction: number | null;
}

export function summarizeHighConvictionOverlayCohort(
  state: HighConvictionOverlayState,
  observations: number,
  outcomes: EnsembleShadowOutcome[],
): HighConvictionOverlayCohortEvidence {
  const evidence = summarizeEnsembleSleeveOutcomes(outcomes);
  const evaluable = outcomes.filter(
    (outcome) =>
      outcome.status !== 'AMBIGUOUS' && outcome.netR != null && Number.isFinite(outcome.netR),
  );

  return {
    state,
    observations,
    resolved: outcomes.length,
    evaluableResolved: evaluable.length,
    wins: outcomes.filter((outcome) => outcome.status === 'WIN').length,
    losses: outcomes.filter((outcome) => outcome.status === 'LOSS').length,
    expired: outcomes.filter((outcome) => outcome.status === 'EXPIRED').length,
    ambiguous: outcomes.filter((outcome) => outcome.status === 'AMBIGUOUS').length,
    netR: evaluable.reduce((sum, outcome) => sum + (outcome.netR ?? 0), 0),
    profitFactor: evidence.profitFactor,
    sharpe: evidence.sharpe,
    maxDrawdown: evidence.maxDrawdown,
    positiveWindowFraction: evidence.positiveWindowFraction,
  };
}
