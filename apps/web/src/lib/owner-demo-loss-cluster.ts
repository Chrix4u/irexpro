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
  // Review the most recent 2–3 consecutive losses within a ten-minute
  // broker-close cluster. A later losing position must not hide an earlier
  // simultaneous two-loss incident merely because it closed minutes later.
  const latest = [...unique.values()].sort((a, b) =>
    Date.parse(b.closedAt!) - Date.parse(a.closedAt!)).slice(0, 3);
  if (latest.length < 2) return null;
  const newestMs = Date.parse(latest[0].closedAt!);
  const consecutive: Array<{ trade: TradeExecutionView; netUsd: number }> = [];
  for (const trade of latest) {
    const gap = newestMs - Date.parse(trade.closedAt!);
    if (gap < 0 || gap > 10 * 60_000) break;
    const net = costAdjustedNet(trade);
    if (net === null || net >= 0) break;
    consecutive.push({ trade, netUsd: net });
  }
  if (consecutive.length < 2) return null;
  const combined = Math.round(consecutive.reduce((total, x) =>
    total + x.netUsd, 0) * 100) / 100;
  if (combined > -25) return null;
  return {
    incidentId: consecutive.map(x =>
      x.trade.id + "|" + x.trade.closedAt).join("|"),
    latestClosedAt: latest[0].closedAt!,
    trades: consecutive.map(x => ({
      id: x.trade.id, instrument: x.trade.instrument,
      direction: x.trade.direction, netUsd: x.netUsd,
    })),
    netUsd: combined,
  };
}
