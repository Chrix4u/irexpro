import { createExecutionApi } from '@irexpro/api-client/execution';
import type {
  ClosedTradeReportQuery,
  ClosedTradeReportView,
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

export async function loadClosedTradeReport(
  query: ClosedTradeReportQuery = {},
): Promise<ClosedTradeReportView> {
  return executionApi.getClosedTradeReport(query);
}

export interface RecentExecutionActivitySummary {
  executionCount: number;
  realisedTradeCount: number;
  wins: number;
  losses: number;
  flats: number;
  netRealisedPnl: string | null;
  grossProfit: string | null;
  grossLoss: string | null;
  averageWin: string | null;
  averageLoss: string | null;
  expectancyPerTrade: string | null;
  profitFactor: number | null;
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

function divideDecimalString(
  value: string | null,
  divisor: number,
  fractionDigits = 2,
): string | null {
  if (value === null || !Number.isInteger(divisor) || divisor <= 0) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;

  const sourceFraction = match[3] ?? '';
  const sourceScale = 10n ** BigInt(sourceFraction.length);
  const sourceAbsolute =
    BigInt(match[2]) * sourceScale + BigInt(sourceFraction || '0');
  const targetScale = 10n ** BigInt(fractionDigits);
  const denominator = sourceScale * BigInt(divisor);
  const numerator = sourceAbsolute * targetScale;
  let rounded = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) rounded += 1n;

  const negative = match[1] === '-' && rounded !== 0n;
  const whole = rounded / targetScale;
  const fraction =
    fractionDigits > 0
      ? (rounded % targetScale).toString().padStart(fractionDigits, '0')
      : '';
  return `${negative ? '-' : ''}${whole.toString()}${fractionDigits ? `.${fraction}` : ''}`;
}

/** Summarize recent execution activity and realised trades closed within the trailing 24 hours. */
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
  const realisedTrades = trades.filter((trade) => {
    if (trade.status !== 'CLOSED' || trade.realisedPnl === null || !trade.closedAt) {
      return false;
    }
    const closedMs = Date.parse(trade.closedAt);
    return (
      Number.isFinite(closedMs) &&
      closedMs >= cutoffMs &&
      closedMs <= referenceMs &&
      Number.isFinite(Number(trade.realisedPnl))
    );
  });
  const wins = realisedTrades.filter((trade) => Number(trade.realisedPnl) > 0).length;
  const losses = realisedTrades.filter((trade) => Number(trade.realisedPnl) < 0).length;
  const flats = realisedTrades.length - wins - losses;
  const currencies = [...new Set(realisedTrades.map((trade) => trade.accountCurrency).filter(Boolean))];
  const accountCurrency = currencies.length === 1 ? currencies[0]! : null;
  const pnlValues = realisedTrades.map((trade) => trade.realisedPnl!).filter(Boolean);
  const netRealisedPnl =
    realisedTrades.length === 0 || (accountCurrency && pnlValues.length === realisedTrades.length)
      ? sumExactDecimalStrings(pnlValues)
      : null;
  const winningPnlValues = realisedTrades
    .filter((trade) => Number(trade.realisedPnl) > 0)
    .map((trade) => trade.realisedPnl!);
  const losingPnlValues = realisedTrades
    .filter((trade) => Number(trade.realisedPnl) < 0)
    .map((trade) => trade.realisedPnl!.replace(/^-/, ''));
  const grossProfit = sumExactDecimalStrings(winningPnlValues);
  const grossLoss = sumExactDecimalStrings(losingPnlValues);
  const averageWin = wins > 0 ? divideDecimalString(grossProfit, wins) : null;
  const averageLoss = losses > 0 ? divideDecimalString(grossLoss, losses) : null;
  const expectancyPerTrade =
    realisedTrades.length > 0
      ? divideDecimalString(netRealisedPnl, realisedTrades.length)
      : null;
  const grossProfitNumber = grossProfit === null ? Number.NaN : Number(grossProfit);
  const grossLossNumber = grossLoss === null ? Number.NaN : Number(grossLoss);
  const profitFactor =
    Number.isFinite(grossProfitNumber) && Number.isFinite(grossLossNumber)
      ? grossLossNumber > 0
        ? grossProfitNumber / grossLossNumber
        : grossProfitNumber > 0
          ? Number.POSITIVE_INFINITY
          : null
      : null;
  const latestOpenedAt = executions
    .map((trade) => trade.openedAt!)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  return {
    executionCount: executions.length,
    realisedTradeCount: realisedTrades.length,
    wins,
    losses,
    flats,
    netRealisedPnl,
    grossProfit,
    grossLoss,
    averageWin,
    averageLoss,
    expectancyPerTrade,
    profitFactor,
    accountCurrency,
    latestOpenedAt,
  };
}

export interface RealisedExecutionWindowSummary {
  tradeCount: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
}

/** Summarize the most recent realised trades used by the cumulative P&L chart. */
export function summarizeRealisedExecutionWindow(
  trades: TradeExecutionView[],
  limit = 20,
): RealisedExecutionWindowSummary {
  const safeLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 20));
  const realised = [...trades]
    .filter(
      (trade) =>
        trade.status === 'CLOSED' &&
        trade.realisedPnl !== null &&
        Number.isFinite(Number(trade.realisedPnl)),
    )
    .sort(
      (a, b) =>
        Date.parse(a.closedAt ?? a.updatedAt) - Date.parse(b.closedAt ?? b.updatedAt),
    )
    .slice(-safeLimit);

  const wins = realised.filter((trade) => Number(trade.realisedPnl) > 0).length;
  const losses = realised.filter((trade) => Number(trade.realisedPnl) < 0).length;
  const flats = realised.length - wins - losses;

  return {
    tradeCount: realised.length,
    wins,
    losses,
    flats,
    winRate: realised.length > 0 ? wins / realised.length : null,
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
 * broad object shape.
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
