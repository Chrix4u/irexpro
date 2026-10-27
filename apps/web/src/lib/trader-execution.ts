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

export interface RecentExecutionActivitySummary {
  executionCount: number;
  wins: number;
  losses: number;
  flats: number;
  netRealisedPnl: string | null;
  accountCurrency: string | null;
  latestOpenedAt: string | null;
}

function sumExactDecimalStrings(values: string[]): string | null {
  if (values.length === 0) return '0';
  const parsed = values.map((value) => {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!match) return null;
    return { negative: match[1] === '-', whole: match[2], fraction: match[3] ?? '' };
  });
  if (parsed.some((value) => value === null)) return null;
  const decimals = parsed as Array<{ negative: boolean; whole: string; fraction: string }>;
  const scale = Math.max(...decimals.map((value) => value.fraction.length), 0);
  const factor = 10n ** BigInt(scale);
  const total = decimals.reduce((acc, value) => {
    const fraction = value.fraction.padEnd(scale, '0') || '0';
    const scaled = BigInt(value.whole) * factor + (scale ? BigInt(fraction) : 0n);
    return acc + (value.negative ? -scaled : scaled);
  }, 0n);
  const negative = total < 0n;
  const absolute = negative ? -total : total;
  const whole = absolute / factor;
  const fraction = scale
    ? (absolute % factor).toString().padStart(scale, '0').replace(/0+$/, '')
    : '';
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

/** Summarize proven executions opened within the trailing 24 hours. */
export function summarizeRecentExecutionActivity(
  trades: TradeExecutionView[],
  referenceTime: Date = new Date(),
): RecentExecutionActivitySummary {
  const referenceMs = referenceTime.getTime();
  const cutoffMs = referenceMs - 24 * 60 * 60_000;
  const executions = trades.filter((trade) => {
    if (!trade.openedAt) return false;
    const openedMs = Date.parse(trade.openedAt);
    return Number.isFinite(openedMs) && openedMs >= cutoffMs && openedMs <= referenceMs;
  });
  const closedWithPnl = executions.filter(
    (trade) => trade.status === 'CLOSED' && trade.realisedPnl !== null,
  );
  let wins = 0;
  let losses = 0;
  let flats = 0;
  for (const trade of closedWithPnl) {
    const value = Number(trade.realisedPnl);
    if (!Number.isFinite(value)) continue;
    if (value > 0) wins += 1;
    else if (value < 0) losses += 1;
    else flats += 1;
  }
  const currencies = [...new Set(closedWithPnl.map((trade) => trade.accountCurrency).filter(Boolean))];
  const accountCurrency = currencies.length === 1 ? currencies[0]! : null;
  const pnlValues = closedWithPnl.map((trade) => trade.realisedPnl!).filter(Boolean);
  const netRealisedPnl =
    closedWithPnl.length === 0 || (accountCurrency && pnlValues.length === closedWithPnl.length)
      ? sumExactDecimalStrings(pnlValues)
      : null;
  const latestOpenedAt = executions
    .map((trade) => trade.openedAt!)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  return {
    executionCount: executions.length,
    wins,
    losses,
    flats,
    netRealisedPnl,
    accountCurrency,
    latestOpenedAt,
  };
}

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
 * broad object shape. When brokerConnectionId is supplied, all three reads are
 * pinned to that broker so account currencies and execution histories cannot
 * bleed across the user's other broker connections.
 */
export async function loadTraderExecutionSnapshot(
  brokerConnectionId?: string,
): Promise<TraderExecutionSnapshot> {
  const [openResult, recentResult, closedResult] = await Promise.allSettled([
    executionApi.listOpenPositions(brokerConnectionId),
    executionApi.listRecentExecutions(100, brokerConnectionId),
    executionApi.listClosedExecutions(50, brokerConnectionId),
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
