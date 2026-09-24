import { createExecutionApi } from '@irexpro/api-client/execution';
import type {
  TradeExecutionCloseReason,
  TradeExecutionDirection,
  TradeExecutionStatus,
  TradeExecutionView,
} from '@irexpro/types/execution';
import { api } from '@/lib/api';

export interface TraderExecutionSnapshot {
  openPositions: TradeExecutionView[];
  recentExecutions: TradeExecutionView[];
  closedExecutions: TradeExecutionView[];
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
    value === 'KILL_SWITCH_FORCE_CLOSE' ||
    value === 'BROKER_CLOSE' ||
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
  const [openPositions, recentExecutions, closedExecutions] = await Promise.all([
    executionApi.listOpenPositions(),
    executionApi.listRecentExecutions(100),
    executionApi.listClosedExecutions(50),
  ]);

  if (!Array.isArray(openPositions) || !openPositions.every(isTradeExecutionView)) {
    throw new Error('Open positions contract mismatch');
  }
  if (!Array.isArray(recentExecutions) || !recentExecutions.every(isTradeExecutionView)) {
    throw new Error('Recent executions contract mismatch');
  }
  if (!Array.isArray(closedExecutions) || !closedExecutions.every(isTradeExecutionView)) {
    throw new Error('Closed executions contract mismatch');
  }
  if (!openPositions.every((trade) => trade.status === 'OPEN')) {
    throw new Error('Open positions endpoint returned a non-OPEN trade');
  }
  if (!closedExecutions.every((trade) => trade.status === 'CLOSED')) {
    throw new Error('Closed executions endpoint returned a non-CLOSED trade');
  }

  return { openPositions, recentExecutions, closedExecutions };
}
