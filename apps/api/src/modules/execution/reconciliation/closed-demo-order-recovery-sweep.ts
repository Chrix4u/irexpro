import type { Order } from '../orders/order.entity';
import { OrderKind, OrderStatus } from '../orders/order.enums';
import type { Trade } from '../entities/trade.entity';
import { TradeStatus } from '../entities/trade.entity';

/**
 * Aged stranded-close-order recovery selection (the 375-record DEMO incident).
 *
 * The live 7a2 recovery path is bounded to a six-hour freshness window, at
 * most two candidates per cycle, and the single Pepperstone scanner
 * account — by design, because it treats the broker DealList as *recent*
 * evidence for orders that just lost their acknowledgement. Historical
 * stranded rows (trades already CLOSED for days or weeks) fall outside that
 * window and had NO convergence path at all: the ordinary order sweep skips
 * orders without a provider order id, and the trade-close reconciliation
 * never converged the closing order.
 *
 * This selection identifies the stranded shape across ANY cTrader-family
 * DEMO account regardless of age, with a fair rotating budget so unresolved
 * historical rows cannot starve each other:
 *
 * - RECONCILIATION_PENDING MARKET order, provider order id NULL,
 *   recorded fill exactly zero, no average fill price;
 * - linked trade CLOSED with an opposite direction (the close leg);
 * - exactly one pending MARKET close order for that trade (ambiguity
 *   excludes the trade from automated recovery — surfaced instead);
 * - no upper age bound: the exact-decimal proof in
 *   proveAgedCtraderDemoClosedOrderFill carries all authority.
 *
 * LIVE accounts are never selected here; recovery of LIVE order rows
 * remains subject to independent operator review.
 */

/** Keep historical deal reads small so they cannot monopolize broker quota. */
export const AGED_DEMO_CLOSE_RECOVERY_BATCH = 2;

export function selectAgedDemoCloseRecoveryCandidates<
  T extends Pick<
    Order,
    | 'id'
    | 'tradeId'
    | 'status'
    | 'orderKind'
    | 'providerOrderId'
    | 'filledQuantity'
    | 'avgFillPrice'
    | 'submittedAt'
    | 'createdAt'
  >,
>(orders: readonly T[], asOf: Date, afterId: string | undefined): T[] {
  const now = asOf.getTime();
  if (!Number.isFinite(now)) return [];
  const counts = new Map<string, number>();
  for (const o of orders) {
    if (
      o.tradeId &&
      o.status === OrderStatus.RECONCILIATION_PENDING &&
      o.orderKind === OrderKind.MARKET
    )
      counts.set(o.tradeId, (counts.get(o.tradeId) ?? 0) + 1);
  }
  const eligible = orders
    .filter(
      (o) =>
        !!o.tradeId &&
        counts.get(o.tradeId) === 1 &&
        o.status === OrderStatus.RECONCILIATION_PENDING &&
        o.orderKind === OrderKind.MARKET &&
        o.providerOrderId === null &&
        typeof o.filledQuantity === 'string' &&
        /^[-+]?0+(?:\.0+)?$/.test(o.filledQuantity.trim()) &&
        o.avgFillPrice === null &&
        o.submittedAt instanceof Date &&
        o.createdAt instanceof Date &&
        now - o.submittedAt.getTime() >= 5_000,
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const next = afterId === undefined ? 0 : eligible.findIndex((o) => o.id > afterId);
  const start = next < 0 ? 0 : next;
  const rotated = [...eligible.slice(start), ...eligible.slice(0, start)];
  return rotated.slice(0, AGED_DEMO_CLOSE_RECOVERY_BATCH);
}

/**
 * The trade-side companion of the stranded shape: a CLOSED trade whose
 * close economics are still missing must be backfilled FIRST (unique-deal
 * settlement proof) so the order-row proof has exit price and realised P&L
 * to verify against. Returns true when the trade still lacks economics.
 */
export function agedTradeNeedsSettlementBackfill(
  trade: Pick<Trade, 'status' | 'realisedPnl' | 'commission' | 'exitPrice'>,
): boolean {
  return (
    trade.status === TradeStatus.CLOSED &&
    trade.realisedPnl === null &&
    trade.commission === null &&
    trade.exitPrice === null
  );
}
