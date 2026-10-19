export const M1_DRIFT_COUNTERFACTUAL_ARTIFACT = 'm1-drift-counterfactual-15m-v1';
export const M1_DRIFT_COUNTERFACTUAL_HORIZON_BARS = 15;

export interface M1DriftCounterfactualCandle {
  timestamp: Date | string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
}

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

function finitePrice(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function evaluateM1DriftCounterfactual15m(
  input: M1DriftCounterfactualInput,
): M1DriftCounterfactualResult | null {
  const evaluatedMs = input.evaluatedAt.getTime();
  if (
    !Number.isFinite(evaluatedMs) ||
    !Number.isFinite(input.stopDistance) ||
    input.stopDistance <= 0 ||
    !Number.isFinite(input.targetDistance) ||
    input.targetDistance <= 0 ||
    !Number.isFinite(input.executionCostR) ||
    input.executionCostR < 0
  ) {
    return null;
  }

  const firstCausalOpenMs = evaluatedMs + 60_000;
  const window = input.bars
    .filter((bar) => {
      const openedAt = new Date(bar.timestamp).getTime();
      return (
        Number.isFinite(openedAt) &&
        openedAt >= firstCausalOpenMs &&
        openedAt < firstCausalOpenMs + M1_DRIFT_COUNTERFACTUAL_HORIZON_BARS * 60_000
      );
    })
    .sort(
      (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
    );

  if (window.length !== M1_DRIFT_COUNTERFACTUAL_HORIZON_BARS) return null;
  for (let index = 0; index < window.length; index += 1) {
    if (new Date(window[index]!.timestamp).getTime() !== firstCausalOpenMs + index * 60_000)
      return null;
  }

  const entryPrice = finitePrice(window[0]!.open);
  if (entryPrice == null) return null;
  const sign = input.direction === 'BUY' ? 1 : -1;
  const stopLoss = entryPrice - sign * input.stopDistance;
  const takeProfit = entryPrice + sign * input.targetDistance;
  const observedAt = new Date(firstCausalOpenMs + M1_DRIFT_COUNTERFACTUAL_HORIZON_BARS * 60_000);

  for (const bar of window) {
    const high = finitePrice(bar.high);
    const low = finitePrice(bar.low);
    if (high == null || low == null) return null;
    const stopTouched = input.direction === 'BUY' ? low <= stopLoss : high >= stopLoss;
    const targetTouched = input.direction === 'BUY' ? high >= takeProfit : low <= takeProfit;
    if (stopTouched && targetTouched) {
      return {
        artifact: M1_DRIFT_COUNTERFACTUAL_ARTIFACT,
        modifiesExecution: false,
        source: 'COMPLETED_M1_OHLC',
        horizonBars: M1_DRIFT_COUNTERFACTUAL_HORIZON_BARS,
        outcome: 'AMBIGUOUS',
        entryBarOpenTime: new Date(window[0]!.timestamp).toISOString(),
        observedAt: observedAt.toISOString(),
        terminalBarOpenTime: new Date(bar.timestamp).toISOString(),
        entryPrice,
        stopLoss,
        takeProfit,
        terminalPrice: finitePrice(bar.close) ?? entryPrice,
        estimatedExecutionCostR: input.executionCostR,
        grossRMultiple: null,
        netRMultiple: null,
      };
    }
    if (stopTouched || targetTouched) {
      const targetR = input.targetDistance / input.stopDistance;
      return {
        artifact: M1_DRIFT_COUNTERFACTUAL_ARTIFACT,
        modifiesExecution: false,
        source: 'COMPLETED_M1_OHLC',
        horizonBars: M1_DRIFT_COUNTERFACTUAL_HORIZON_BARS,
        outcome: targetTouched ? 'TP' : 'SL',
        entryBarOpenTime: new Date(window[0]!.timestamp).toISOString(),
        observedAt: observedAt.toISOString(),
        terminalBarOpenTime: new Date(bar.timestamp).toISOString(),
        entryPrice,
        stopLoss,
        takeProfit,
        terminalPrice: targetTouched ? takeProfit : stopLoss,
        estimatedExecutionCostR: input.executionCostR,
        grossRMultiple: targetTouched ? targetR : -1,
        netRMultiple: (targetTouched ? targetR : -1) - input.executionCostR,
      };
    }
  }

  const terminalPrice = finitePrice(window.at(-1)!.close);
  if (terminalPrice == null) return null;
  return {
    artifact: M1_DRIFT_COUNTERFACTUAL_ARTIFACT,
    modifiesExecution: false,
    source: 'COMPLETED_M1_OHLC',
    horizonBars: M1_DRIFT_COUNTERFACTUAL_HORIZON_BARS,
    outcome: 'MTM',
    entryBarOpenTime: new Date(window[0]!.timestamp).toISOString(),
    observedAt: observedAt.toISOString(),
    terminalBarOpenTime: new Date(window.at(-1)!.timestamp).toISOString(),
    entryPrice,
    stopLoss,
    takeProfit,
    terminalPrice,
    estimatedExecutionCostR: input.executionCostR,
    grossRMultiple: (sign * (terminalPrice - entryPrice)) / input.stopDistance,
    netRMultiple: (sign * (terminalPrice - entryPrice)) / input.stopDistance - input.executionCostR,
  };
}
