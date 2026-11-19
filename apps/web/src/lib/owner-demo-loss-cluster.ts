import type { TradeExecutionView } from "@irexpro/types/execution";

/**
 * Browser-only, read-only broker-loss alert. This does NOT pause the AI.
 * The caller must supply executions loaded with an exact brokerConnectionId.
 */
export interface OwnerDemoLossCluster {
  incidentId: string;
  latestClosedAt: string;
  trades: Array<{ id: string; instrument: string; direction: string; netUsd: number }>;
  netUsd: number;
}

function costAdjustedNet(trade: TradeExecutionView): number | null {
  if (trade.status !== "CLOSED" || trade.realisedPnl === null ||
      trade.commission === null || trade.swap === null) return null;
  const realised = Number(trade.realisedPnl);
  const commission = Number(trade.commission);
  const swap = Number(trade.swap);
  if (![realised, commission, swap].every(Number.isFinite)) return null;
  // The API may report commission as a signed debit or positive charge;
  // normalize it exactly once, matching existing settled-P&L UI conventions.
  return Math.round((realised - Math.abs(commission) + swap) * 100) / 100;
}

export function detectOwnerDemoLossCluster(
  brokerScopedTrades: TradeExecutionView[],
  now: Date = new Date(),
): OwnerDemoLossCluster | null {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;
  const unique = new Map<string, TradeExecutionView>();
  for (const trade of brokerScopedTrades) {
    const closedMs = trade.closedAt ? Date.parse(trade.closedAt) : Number.NaN;
    if (!trade.id || trade.accountCurrency !== "USD" ||
        !Number.isFinite(closedMs) || closedMs > nowMs ||
        nowMs - closedMs > 60 * 60_000 || trade.status !== "CLOSED") continue;
    unique.set(trade.id, trade);
  }
  const latest = [...unique.values()].sort((a, b) =>
    Date.parse(b.closedAt!) - Date.parse(a.closedAt!)).slice(0, 2);
  if (latest.length !== 2) return null;
  const [first, second] = latest;
  const gap = Date.parse(first.closedAt!) - Date.parse(second.closedAt!);
  const firstNet = costAdjustedNet(first);
  const secondNet = costAdjustedNet(second);
  if (gap < 0 || gap > 2 * 60_000 ||
      firstNet === null || secondNet === null ||
      firstNet >= 0 || secondNet >= 0 ||
      firstNet + secondNet > -25) return null;
  return {
    incidentId: [first.id, second.id, first.closedAt, second.closedAt].join("|"),
    latestClosedAt: first.closedAt!,
    trades: [first, second].map((trade, i) => ({
      id: trade.id, instrument: trade.instrument, direction: trade.direction,
      netUsd: i === 0 ? firstNet : secondNet,
    })),
    netUsd: Math.round((firstNet + secondNet) * 100) / 100,
  };
}
