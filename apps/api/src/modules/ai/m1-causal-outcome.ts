export const M1_CAUSAL_OUTCOME_HORIZON_BARS = 15 as const;

export interface M1CausalOutcomeCandle {
  timestamp: Date | string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
}

export interface M1CausalOutcomeInput {
  direction: 'BUY' | 'SELL';
  evaluatedAt: Date;
  stopDistance: number;
  targetDistance: number;
  executionCostR: number;
  bars: M1CausalOutcomeCandle[];
}

export interface M1CausalOutcomeResult {
  source: 'COMPLETED_M1_OHLC';
  horizonBars: typeof M1_CAUSAL_OUTCOME_HORIZON_BARS;
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

export function evaluateM1CausalOutcome15m(
  input: M1CausalOutcomeInput,
): M1CausalOutcomeResult | null {
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
        openedAt < firstCausalOpenMs + M1_CAUSAL_OUTCOME_HORIZON_BARS * 60_000
      );
    })
    .sort(
      (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
    );

  if (window.length !== M1_CAUSAL_OUTCOME_HORIZON_BARS) return null;
  for (let index = 0; index < window.length; index += 1) {
    const bar = window[index]!;
    if (new Date(bar.timestamp).getTime() !== firstCausalOpenMs + index * 60_000) return null;
    if (
      finitePrice(bar.open) == null ||
      finitePrice(bar.high) == null ||
      finitePrice(bar.low) == null ||
      finitePrice(bar.close) == null
    ) {
      return null;
    }
  }

  const entryPrice = finitePrice(window[0]!.open)!;
  const sign = input.direction === 'BUY' ? 1 : -1;
  const stopLoss = entryPrice - sign * input.stopDistance;
  const takeProfit = entryPrice + sign * input.targetDistance;
  const observedAt = new Date(firstCausalOpenMs + M1_CAUSAL_OUTCOME_HORIZON_BARS * 60_000);
  const base = {
    source: 'COMPLETED_M1_OHLC' as const,
    horizonBars: M1_CAUSAL_OUTCOME_HORIZON_BARS,
    entryBarOpenTime: new Date(window[0]!.timestamp).toISOString(),
    observedAt: observedAt.toISOString(),
    entryPrice,
    stopLoss,
    takeProfit,
    estimatedExecutionCostR: input.executionCostR,
  };

  for (const bar of window) {
    const high = finitePrice(bar.high)!;
    const low = finitePrice(bar.low)!;
    const stopTouched = input.direction === 'BUY' ? low <= stopLoss : high >= stopLoss;
    const targetTouched = input.direction === 'BUY' ? high >= takeProfit : low <= takeProfit;

    if (stopTouched && targetTouched) {
      return {
        ...base,
        outcome: 'AMBIGUOUS',
        terminalBarOpenTime: new Date(bar.timestamp).toISOString(),
        terminalPrice: finitePrice(bar.close)!,
        grossRMultiple: null,
        netRMultiple: null,
      };
    }

    if (stopTouched || targetTouched) {
      const targetR = input.targetDistance / input.stopDistance;
      const grossRMultiple = targetTouched ? targetR : -1;
      return {
        ...base,
        outcome: targetTouched ? 'TP' : 'SL',
        terminalBarOpenTime: new Date(bar.timestamp).toISOString(),
        terminalPrice: targetTouched ? takeProfit : stopLoss,
        grossRMultiple,
        netRMultiple: grossRMultiple - input.executionCostR,
      };
    }
  }

  const terminalBar = window.at(-1)!;
  const terminalPrice = finitePrice(terminalBar.close)!;
  const grossRMultiple = (sign * (terminalPrice - entryPrice)) / input.stopDistance;
  return {
    ...base,
    outcome: 'MTM',
    terminalBarOpenTime: new Date(terminalBar.timestamp).toISOString(),
    terminalPrice,
    grossRMultiple,
    netRMultiple: grossRMultiple - input.executionCostR,
  };
}
