import type { LivePositionRowView } from '@irexpro/types/live-account';
import type { ExecutionMode, TradeExecutionView } from '@irexpro/types/execution';

type ExecutionPositionTelemetry = TradeExecutionView & {
  currentPrice?: string | null;
  markObservedAt?: string | null;
  unrealisedPnl?: string | null;
  maxFavorablePnl?: string | null;
  maxAdversePnl?: string | null;
  profitGiveback?: string | null;
  pathObservationCount?: number | null;
  pathPeakObservedAt?: string | null;
  pathLastObservedAt?: string | null;
};

export interface ResolveAiOpenPositionRowsInput {
  executionMode: ExecutionMode | null;
  executionOpenPositions: TradeExecutionView[] | null;
  livePositions: LivePositionRowView[];
  paperBrokerConnectionId: string | null;
  paperBrokerName: string | null;
}

function fromExecutionPosition(
  trade: ExecutionPositionTelemetry,
  brokerConnectionId: string | null,
  brokerName: string | null,
): LivePositionRowView {
  const hasPathDiagnostics =
    typeof trade.maxFavorablePnl === 'string' &&
    typeof trade.maxAdversePnl === 'string' &&
    typeof trade.profitGiveback === 'string';

  return {
    id: trade.id,
    brokerConnectionId: brokerConnectionId ?? '',
    brokerName,
    environment: 'PAPER',
    instrument: trade.instrument,
    direction: trade.direction,
    lotSize: trade.lotSize,
    requestedEntryPrice: trade.requestedEntryPrice,
    fillPrice: trade.fillPrice,
    accountCurrency: trade.accountCurrency,
    currentPrice: trade.currentPrice ?? null,
    markSource: null,
    markObservedAt: trade.markObservedAt ?? null,
    markIsStale: false,
    unrealisedPnl: trade.unrealisedPnl ?? null,
    pathDiagnostics: hasPathDiagnostics
      ? {
          maxFavorablePnl: trade.maxFavorablePnl!,
          maxAdversePnl: trade.maxAdversePnl!,
          latestUnrealisedPnl: trade.unrealisedPnl ?? '0',
          profitGiveback: trade.profitGiveback!,
          observationCount: trade.pathObservationCount ?? 0,
          sameBarProtectionAmbiguityCount: 0,
          lastSameBarProtectionAmbiguityAt: null,
          peakObservedAt: trade.pathPeakObservedAt ?? null,
          lastObservedAt: trade.pathLastObservedAt ?? null,
        }
      : null,
    commission: trade.commission,
    swap: trade.swap,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    trailingStopPips: trade.trailingStopPips,
    status: 'OPEN',
    openedAt: trade.openedAt,
    createdAt: trade.createdAt,
  };
}

/**
 * Resolve the AI Trading page's open-position truth.
 *
 * PAPER execution rows are durable execution authority. The live-account feed
 * may enrich those rows, but it must never make a valid PAPER trade disappear.
 */
export function resolveAiOpenPositionRows({
  executionMode,
  executionOpenPositions,
  livePositions,
  paperBrokerConnectionId,
  paperBrokerName,
}: ResolveAiOpenPositionRowsInput): LivePositionRowView[] {
  if (executionMode !== 'PAPER_ONLY' || executionOpenPositions === null) {
    return livePositions;
  }

  const byId = new Map(livePositions.map((position) => [position.id, position]));
  for (const trade of executionOpenPositions) {
    if (!byId.has(trade.id)) {
      byId.set(
        trade.id,
        fromExecutionPosition(trade, paperBrokerConnectionId, paperBrokerName),
      );
    }
  }

  return [...byId.values()].sort(
    (a, b) => Date.parse(b.openedAt ?? b.createdAt) - Date.parse(a.openedAt ?? a.createdAt),
  );
}
