import {
  M1_CAUSAL_OUTCOME_HORIZON_BARS,
  evaluateM1CausalOutcome15m,
  type M1CausalOutcomeCandle,
} from './m1-causal-outcome';

export const M1_DRIFT_COUNTERFACTUAL_ARTIFACT = 'm1-drift-counterfactual-15m-v1';
export const M1_DRIFT_COUNTERFACTUAL_HORIZON_BARS = M1_CAUSAL_OUTCOME_HORIZON_BARS;

export type M1DriftCounterfactualCandle = M1CausalOutcomeCandle;

export interface M1DriftCounterfactualInput {
  direction: 'BUY' | 'SELL';
  evaluatedAt: Date;
  stopDistance: number;
  targetDistance: number;
  executionCostR: number;
  bars: M1DriftCounterfactualCandle[];
}

export interface M1DriftCounterfactualResult {
  artifact: typeof M1_DRIFT_COUNTERFACTUAL_ARTIFACT;
  modifiesExecution: false;
  source: 'COMPLETED_M1_OHLC';
  horizonBars: typeof M1_DRIFT_COUNTERFACTUAL_HORIZON_BARS;
  outcome: 'TP' | 'SL' | 'MTM' | 'AMBIGUOUS';
  entryBarOpenTime: string;
  observedAt: string;
  terminalBarOpenTime: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  terminalPrice: number;
  estimatedExecutionCostR: number;
  grossRMultiple: number | null;
  netRMultiple: number | null;
}

export function evaluateM1DriftCounterfactual15m(
  input: M1DriftCounterfactualInput,
): M1DriftCounterfactualResult | null {
  const result = evaluateM1CausalOutcome15m(input);
  if (!result) return null;

  return {
    artifact: M1_DRIFT_COUNTERFACTUAL_ARTIFACT,
    modifiesExecution: false,
    ...result,
  };
}
