import type { TradeExecutionView } from '@irexpro/types/execution';

export interface ExecutionPathDiagnosticsView {
  maxFavorablePnl: string | null;
  maxAdversePnl: string | null;
  profitGiveback: string | null;
  observationCount: number | null;
  peakObservedAt: string | null;
  lastObservedAt: string | null;
}

export function executionPathDiagnostics(
  trade: TradeExecutionView,
): ExecutionPathDiagnosticsView | null {
  const hasMeasuredPath =
    trade.maxFavorablePnl != null ||
    trade.maxAdversePnl != null ||
    trade.profitGiveback != null ||
    (trade.pathObservationCount ?? 0) > 0;

  if (!hasMeasuredPath) return null;

  return {
    maxFavorablePnl: trade.maxFavorablePnl ?? null,
    maxAdversePnl: trade.maxAdversePnl ?? null,
    profitGiveback: trade.profitGiveback ?? null,
    observationCount: trade.pathObservationCount ?? null,
    peakObservedAt: trade.pathPeakObservedAt ?? null,
    lastObservedAt: trade.pathLastObservedAt ?? null,
  };
}
