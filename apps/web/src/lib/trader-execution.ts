import { createExecutionApi } from '@irexpro/api-client/execution';
import type {
  TradeExecutionCloseReason,
  TradeExecutionDirection,
  TradeExecutionStatus,
  TradeExecutionView,
} from '@irexpro/types/execution';
import { api } from '@/lib/api';

export type TraderExecutionDegradedFeed =
  | 'OPEN_POSITIONS'
  | 'RECENT_EXECUTIONS'
  | 'CLOSED_EXECUTIONS';

export interface TraderExecutionSnapshot {
  openPositions: TradeExecutionView[];
  recentExecutions: TradeExecutionView[];
  closedExecutions: TradeExecutionView[];
  /** Native reads that failed contract/transport validation and were reconstructed when possible. */
  degradedFeeds: TraderExecutionDegradedFeed[];
}

const executionApi = createExecutionApi(api);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDirection(value: unknown): value is TradeExecutionDirection {
  return value === 'BUY' || value === 'SELL';
}

function isStatus(value: unknown): value is TradeExecutionStatus {
  return (
    value === 'PENDING' ||
    value === 'OPEN' ||
    value === 'CLOSED' ||
    value === 'REJECTED' ||
    value === 'CANCELLED' ||
    value === 'RECONCILIATION_PENDING'
  );
}

function isCloseReason(value: unknown): value is TradeExecutionCloseReason | null {
  return (
    value === null ||
    value === 'STOP_LOSS_HIT' ||
    value === 'TAKE_PROFIT_HIT' ||
    value === 'MANUAL_CLOSE' ||
    value === 'AI_CLOSE_SIGNAL' ||
    value === 'PROFIT_PROTECTION' ||
    value === 'KILL_SWITCH_FORCE_CLOSE' ||
    value === 'BROKER_CLOSE' ||
    value === 'STRATEGY_CUTOVER' ||
    value === 'RECONCILIATION'
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isTradeExecutionView(value: unknown): value is TradeExecutionView {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === 'string' &&
    typeof value.instrument === 'string' &&
    isDirection(value.direction) &&
    typeof value.lotSize === 'string' &&
    typeof value.requestedEntryPrice === 'string' &&
    isNullableString(value.fillPrice) &&
    typeof value.stopLoss === 'string' &&
    typeof value.takeProfit === 'string' &&
    isNullableString(value.trailingStopPips) &&
    isStatus(value.status) &&
    isNullableString(value.exitPrice) &&
    isNullableString(value.accountCurrency) &&
    isNullableString(value.realisedPnl) &&
    isNullableString(value.commission) &&
    isNullableString(value.swap) &&
    (value.executionReasonCode === undefined || isNullableString(value.executionReasonCode)) &&
    isCloseReason(value.closeReason) &&
    isNullableString(value.openedAt) &&
    isNullableString(value.closedAt) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    !('userId' in value) &&
    !('brokerConnectionId' in value) &&
    !('signalId' in value) &&
    !('idempotencyKey' in value) &&
    !('externalOrderId' in value) &&
    !('brokerRejectionReason' in value)
  );
}

/**
 * Load the first frontend-safe execution read model for the trader terminal.
 * Runtime validation fails closed if the API returns an unexpected or overly
 * broad object shape.
 */
export async function loadTraderExecutionSnapshot(): Promise<TraderExecutionSnapshot> {
  const [openResult, recentResult, closedResult] = await Promise.allSettled([
    executionApi.listOpenPositions(),
    executionApi.listRecentExecutions(100),
    executionApi.listClosedExecutions(50),
  ]);

  const degradedFeeds: TraderExecutionDegradedFeed[] = [];

  const openPositions =
    openResult.status === 'fulfilled' &&
    Array.isArray(openResult.value) &&
    openResult.value.every(isTradeExecutionView) &&
    openResult.value.every((trade) => trade.status === 'OPEN')
      ? openResult.value
      : null;
  if (!openPositions) degradedFeeds.push('OPEN_POSITIONS');

  const recentExecutions =
    recentResult.status === 'fulfilled' &&
    Array.isArray(recentResult.value) &&
    recentResult.value.every(isTradeExecutionView)
      ? recentResult.value
      : null;
  if (!recentExecutions) degradedFeeds.push('RECENT_EXECUTIONS');

  const closedExecutions =
    closedResult.status === 'fulfilled' &&
    Array.isArray(closedResult.value) &&
    closedResult.value.every(isTradeExecutionView) &&
    closedResult.value.every((trade) => trade.status === 'CLOSED')
      ? closedResult.value
      : null;
  if (!closedExecutions) degradedFeeds.push('CLOSED_EXECUTIONS');

  if (!openPositions && !recentExecutions && !closedExecutions) {
    throw new Error('Execution reads unavailable');
  }

  const mergeFallbackExecutions = (
    groups: Array<TradeExecutionView[] | null>,
  ): TradeExecutionView[] => {
    const byId = new Map<string, TradeExecutionView>();
    for (const group of groups) {
      for (const trade of group ?? []) byId.set(trade.id, trade);
    }
    return [...byId.values()].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  };

  const resolvedRecent =
    recentExecutions ?? mergeFallbackExecutions([openPositions, closedExecutions]);
  const resolvedOpen =
    openPositions ?? resolvedRecent.filter((trade) => trade.status === 'OPEN');
  const resolvedClosed =
    closedExecutions ?? resolvedRecent.filter((trade) => trade.status === 'CLOSED');

  return {
    openPositions: resolvedOpen,
    recentExecutions: resolvedRecent,
    closedExecutions: resolvedClosed,
    degradedFeeds,
  };
}
