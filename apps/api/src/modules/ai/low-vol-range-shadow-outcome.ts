import {
  evaluateM1CausalOutcome15m,
  type M1CausalOutcomeCandle,
  type M1CausalOutcomeResult,
} from './m1-causal-outcome';
import { LOW_VOL_RANGE_SHADOW_OUTCOME_ARTIFACT } from './low-vol-range-shadow';

export interface LowVolRangeShadowOutcome {
  artifact: typeof LOW_VOL_RANGE_SHADOW_OUTCOME_ARTIFACT;
  mode: 'SHADOW_ONLY';
  executionAuthority: 'NONE';
  modifiesExecution: false;
  productionEligible: false;
  episodeDecisionId: string;
  hypothesisCohort: 'STABILIZED_ENTRY_HYPOTHESIS' | 'UNSTABLE_MOMENTUM_CONTROL';
  evaluatedAt: string;
  outcome: M1CausalOutcomeResult['outcome'] | 'UNOBSERVABLE_DATA_GAP';
  source: M1CausalOutcomeResult['source'] | 'UNOBSERVABLE_DATA_GAP';
  /** Next completed M1 bar open is the hypothetical fill, not the candidate's close. */
  entryBarOpenTime: string | null;
  observedAt: string;
  grossRMultiple: number | null;
  /** Spread-only approximation; commission and actual slippage are NOT included. */
  afterSpreadProxyRMultiple: number | null;
  /** True broker-fee net R is unavailable for hypothetical positions. */
  netRMultiple: null;
  commissionIncluded: false;
  costBasis: 'OBSERVED_SPREAD_P90_PLUS_BUFFER_NO_COMMISSION';
  estimatedExecutionCostR: number;
  stopLoss: number | null;
  takeProfit: number | null;
  terminalBarOpenTime: string | null;
}

export function evaluateLowVolRangeShadowOutcome(input: {
  decisionId: string;
  direction: 'BUY' | 'SELL';
  evaluatedAt: Date;
  asOf: Date;
  stopDistance: number;
  targetDistance: number;
  observedExecutionCostR: number;
  hypothesisCohort: 'STABILIZED_ENTRY_HYPOTHESIS' | 'UNSTABLE_MOMENTUM_CONTROL';
  completedBrokerM1Bars: M1CausalOutcomeCandle[];
}): LowVolRangeShadowOutcome | null {
  const observation = evaluateM1CausalOutcome15m({
    direction: input.direction,
    evaluatedAt: input.evaluatedAt,
    stopDistance: input.stopDistance,
    targetDistance: input.targetDistance,
    executionCostR: input.observedExecutionCostR,
    bars: input.completedBrokerM1Bars,
  });
  const base = {
    artifact: LOW_VOL_RANGE_SHADOW_OUTCOME_ARTIFACT,
    mode: 'SHADOW_ONLY' as const,
    executionAuthority: 'NONE' as const,
    modifiesExecution: false as const,
    productionEligible: false as const,
    episodeDecisionId: input.decisionId,
    hypothesisCohort: input.hypothesisCohort,
    evaluatedAt: input.evaluatedAt.toISOString(),
    estimatedExecutionCostR: input.observedExecutionCostR,
    commissionIncluded: false as const,
    costBasis: 'OBSERVED_SPREAD_P90_PLUS_BUFFER_NO_COMMISSION' as const,
  };
  if (observation) {
    // Require completed bars through the observation deadline; a caller
    // must not expose an outcome from not-yet-closed future candles.
    if (new Date(observation.observedAt).getTime() > input.asOf.getTime()) return null;
    return {
      ...base,
      outcome: observation.outcome,
      source: observation.source,
      entryBarOpenTime: observation.entryBarOpenTime,
      observedAt: observation.observedAt,
      grossRMultiple: observation.grossRMultiple,
      afterSpreadProxyRMultiple: observation.netRMultiple,
      netRMultiple: null,
      stopLoss: observation.stopLoss,
      takeProfit: observation.takeProfit,
      terminalBarOpenTime: observation.terminalBarOpenTime,
    };
  }
  if (input.asOf.getTime() - input.evaluatedAt.getTime() < 60 * 60_000) return null;
  return {
    ...base,
    outcome: 'UNOBSERVABLE_DATA_GAP',
    source: 'UNOBSERVABLE_DATA_GAP',
    entryBarOpenTime: null,
    observedAt: input.asOf.toISOString(),
    grossRMultiple: null,
    afterSpreadProxyRMultiple: null,
    netRMultiple: null,
    stopLoss: null,
    takeProfit: null,
    terminalBarOpenTime: null,
  };
}
