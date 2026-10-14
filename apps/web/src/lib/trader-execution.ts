import { createExecutionApi } from '@irexpro/api-client/execution';
import type {
  TradeExecutionCloseReason,
  TradeExecutionDirection,
  TradeExecutionStatus,
  TradeExecutionView,
} from '@irexpro/types/execution';
import { api } from '@/lib/api';

export type TraderExecutionFeed =
  | 'openPositions'
  | 'recentExecutions'
  | 'closedExecutions';

export interface TraderExecutionSnapshot {
  openPositions: TradeExecutionView[];
  recentExecutions: TradeExecutionView[];
  closedExecutions: TradeExecutionView[];
  degradedFeeds: TraderExecutionFeed[];
}

interface TraderExecutionRefreshRequests {
  openPositions: Promise<unknown>;
  recentExecutions: Promise<unknown>;
  closedExecutions: Promise<unknown>;
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

function validateExecutionFeed(
  feed: TraderExecutionFeed,
  value: unknown,
): TradeExecutionView[] | null {
  if (!Array.isArray(value) || !value.every(isTradeExecutionView)) return null;
  if (feed === 'openPositions' && !value.every((trade) => trade.status === 'OPEN')) {
    return null;
  }
  if (feed === 'closedExecutions' && !value.every((trade) => trade.status === 'CLOSED')) {
    return null;
  }
  return value;
}

/**
 * Resolve the three execution read models independently. A transient failure or
 * contract mismatch in one feed must not erase successful data from the other
 * feeds. When a previous validated snapshot exists, only the failed segment is
 * preserved from that last-known-good state.
 */
export async function resolveTraderExecutionRefresh(
  requests: TraderExecutionRefreshRequests,
  previous: TraderExecutionSnapshot | null,
): Promise<TraderExecutionSnapshot> {
  const feeds: TraderExecutionFeed[] = [
    'openPositions',
    'recentExecutions',
    'closedExecutions',
  ];
  const settled = await Promise.allSettled([
    requests.openPositions,
    requests.recentExecutions,
    requests.closedExecutions,
  ]);

  const degradedFeeds: TraderExecutionFeed[] = [];
  const next = {} as Pick<
    TraderExecutionSnapshot,
    'openPositions' | 'recentExecutions' | 'closedExecutions'
  >;

  feeds.forEach((feed, index) => {
    const result = settled[index];
    const validated =
      result.status === 'fulfilled'
        ? validateExecutionFeed(feed, result.value)
        : null;

    if (validated) {
      next[feed] = validated;
      return;
    }

    degradedFeeds.push(feed);
    next[feed] = previous?.[feed] ?? [];
  });

  if (degradedFeeds.length === feeds.length && previous === null) {
    throw new Error('Execution feeds unavailable');
  }

  return {
    ...next,
    degradedFeeds,
  };
}

/**
 * Load the frontend-safe execution read models for the trader terminal without
 * coupling their availability. Runtime validation still fails closed per feed,
 * while a transient failure preserves only that feed's last-known-good data.
 */
export async function loadTraderExecutionSnapshot(
  previous: TraderExecutionSnapshot | null = null,
): Promise<TraderExecutionSnapshot> {
  return resolveTraderExecutionRefresh(
    {
      openPositions: executionApi.listOpenPositions(),
      recentExecutions: executionApi.listRecentExecutions(100),
      closedExecutions: executionApi.listClosedExecutions(50),
    },
    previous,
  );
}
