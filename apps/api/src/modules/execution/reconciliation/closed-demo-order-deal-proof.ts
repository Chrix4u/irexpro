import type { BrokerClosedTrade } from '../../broker/interfaces/broker-adapter.interface';
import type { Order } from '../orders/order.entity';
import type { Trade } from '../entities/trade.entity';
import { OrderStatus, OrderKind } from '../orders/order.enums';
import { TradeStatus } from '../entities/trade.entity';
import { compareDecimal } from './reconciliation-comparator';
import { CTRADER_FAMILY_BROKER_IDS } from '../../broker/registry/broker-catalog';

/**
 * Pepperstone USD DEMO: a closed POSITION in the broker's authenticated DealList
 * may prove the previously uncertain CLOSE ORDER economically filled, but
 * only after cross-checking the durable position, the unique closing deal,
 * and the exact same account/side/volume/exit/P&L/timestamp. A missing broker
 * order id is NEVER invented, and absent positions alone prove nothing.
 *
 * Returned evidence authorizes ONLY OrderService.applyFill on that exact
 * close-order row. It cannot mutate the closed trade or send broker orders.
 */
export type ClosedDemoOrderFillProof =
  | {
      matched: true;
      quantity: string;
      price: string;
      positionRef: string;
      /** Native closing-DEAL id when the provider surfaced one. */
      dealId?: string;
      /**
       * Native closing ORDER id (cTrader deal.orderId) when the provider
       * surfaced one — the closing order's OWN id, never the position id and
       * never the entry order's id. Absent when the broker does not expose
       * it; callers must not synthesize a substitute.
       */
      orderId?: string;
    }
  | { matched: false; reason: string };

/** Scope + freshness policy for the shared DEMO closed-order proof core. */
type ProofScope = {
  /** Broker ids whose DEMO accounts this proof path may authorize. */
  allowedBrokerIds: readonly string[];
  /**
   * Maximum age of the closing evidence (now − trade.closedAt) in ms, or
   * null when aged historical evidence is admissible. The exact-decimal
   * field matching itself does not degrade with age; the freshness cap is
   * a live-recovery fence only, so aged sweeps pass null.
   */
  maxCloseAgeMs: number | null;
};

/** Shared proof input shape (order/trade/provider-deal evidence). */
type ClosedDemoOrderFillProofInput = {
  brokerId: string;
  accountType: string;
  accountUserId: string;
  accountConnectionId: string;
  order: Pick<
    Order,
    | 'userId'
    | 'brokerConnectionId'
    | 'tradeId'
    | 'status'
    | 'providerOrderId'
    | 'orderKind'
    | 'instrument'
    | 'direction'
    | 'requestedQuantity'
    | 'filledQuantity'
    | 'avgFillPrice'
    | 'createdAt'
    | 'submittedAt'
  >;
  trade: Pick<
    Trade,
    | 'id'
    | 'userId'
    | 'brokerConnectionId'
    | 'status'
    | 'instrument'
    | 'direction'
    | 'externalPositionId'
    | 'externalOrderId'
    | 'lotSize'
    | 'openedAt'
    | 'closedAt'
    | 'exitPrice'
    | 'realisedPnl'
  >;
  providerClosedDeals: readonly BrokerClosedTrade[];
  observedAt: Date;
};

function proveDemoClosedOrderFillCore(
  input: ClosedDemoOrderFillProofInput,
  scope: ProofScope,
): ClosedDemoOrderFillProof {
  const no = (reason: string): ClosedDemoOrderFillProof => ({ matched: false, reason });
  const {
    brokerId,
    accountType,
    accountUserId,
    accountConnectionId,
    order,
    trade,
    providerClosedDeals,
    observedAt,
  } = input;
  if (
    !scope.allowedBrokerIds.includes(brokerId) ||
    accountType !== 'DEMO' ||
    !accountUserId ||
    !accountConnectionId ||
    order.userId !== accountUserId ||
    trade.userId !== accountUserId ||
    order.brokerConnectionId !== accountConnectionId ||
    trade.brokerConnectionId !== accountConnectionId ||
    !order.tradeId ||
    order.tradeId !== trade.id ||
    order.status !== OrderStatus.RECONCILIATION_PENDING ||
    order.orderKind !== OrderKind.MARKET ||
    order.providerOrderId !== null ||
    trade.status !== TradeStatus.CLOSED ||
    order.instrument !== trade.instrument ||
    order.direction === trade.direction
  )
    return no('SCOPE_OR_TERMINAL_TRADE_UNVERIFIED');
  if (
    !order.createdAt ||
    !order.submittedAt ||
    !trade.openedAt ||
    !trade.closedAt ||
    !Number.isFinite(observedAt.getTime())
  )
    return no('TIME_PROVENANCE_UNVERIFIED');
  const created = order.createdAt.getTime(),
    sent = order.submittedAt.getTime(),
    opened = trade.openedAt.getTime(),
    closed = trade.closedAt.getTime(),
    now = observedAt.getTime();
  if (
    ![created, sent, opened, closed].every(Number.isFinite) ||
    opened > created ||
    created > sent ||
    sent > closed ||
    closed > now ||
    closed - sent > 120_000 ||
    sent - created > 120_000 ||
    (scope.maxCloseAgeMs !== null && now - closed > scope.maxCloseAgeMs)
  )
    return no('CLOSE_DISPATCH_TIME_UNPROVEN');
  const ref = trade.externalPositionId || trade.externalOrderId;
  if (!ref || !/^\d+$/.test(ref)) return no('PROVIDER_POSITION_ID_UNPROVEN');
  const decimal = /^\d+(?:\.\d+)?$/;
  const qty = order.requestedQuantity,
    fill = order.filledQuantity,
    lots = trade.lotSize,
    price = trade.exitPrice,
    gross = trade.realisedPnl;
  // Report the first failed local premise without changing the proof,
  // revealing financial values, or accepting weaker evidence.
  if (typeof qty !== 'string' || !decimal.test(qty)) return no('CLOSE_REQUEST_QUANTITY_INVALID');
  if (typeof fill !== 'string' || !decimal.test(fill)) return no('CLOSE_FILLED_QUANTITY_INVALID');
  if (typeof lots !== 'string' || !decimal.test(lots)) return no('CLOSE_TRADE_LOT_SIZE_INVALID');
  if (typeof price !== 'string' || !decimal.test(price))
    return no('CLOSE_TRADE_EXIT_PRICE_INVALID');
  if (gross === null || gross === undefined || !/^-?\d+(?:\.\d+)?$/.test(gross))
    return no('CLOSE_TRADE_GROSS_PNL_INVALID');
  if (compareDecimal(qty, '0') <= 0) return no('CLOSE_REQUEST_QUANTITY_NONPOSITIVE');
  if (compareDecimal(fill, '0') !== 0) return no('CLOSE_FILL_ALREADY_RECORDED');
  if (order.avgFillPrice !== null) return no('CLOSE_AVERAGE_FILL_PRICE_PRESENT');
  if (compareDecimal(qty, lots) !== 0) return no('CLOSE_QUANTITY_LOT_MISMATCH');
  if (compareDecimal(price, '0') <= 0) return no('CLOSE_TRADE_EXIT_PRICE_NONPOSITIVE');
  const matches = providerClosedDeals.filter((d) => d.externalOrderId === ref);
  if (matches.length !== 1) return no('PROVIDER_DEAL_NOT_UNIQUE');
  const deal = matches[0];
  if (
    deal.instrument !== order.instrument ||
    deal.direction !== order.direction ||
    typeof deal.closePrice !== 'string' ||
    !decimal.test(deal.closePrice) ||
    typeof deal.lotSize !== 'string' ||
    !decimal.test(deal.lotSize) ||
    typeof deal.realisedPnl !== 'string' ||
    !/^-?\d+(?:\.\d+)?$/.test(deal.realisedPnl) ||
    compareDecimal(deal.lotSize, qty) !== 0 ||
    compareDecimal(deal.closePrice, price) !== 0 ||
    compareDecimal(deal.realisedPnl, gross) !== 0 ||
    !(deal.closedAt instanceof Date) ||
    !Number.isFinite(deal.closedAt.getTime()) ||
    Math.abs(deal.closedAt.getTime() - closed) > 999 ||
    deal.closedAt.getTime() < sent ||
    deal.closedAt.getTime() > now
  ) {
    return no('EXACT_BROKER_CLOSE_DEAL_ECONOMICS_MISMATCH');
  }
  return {
    matched: true,
    quantity: qty,
    price: deal.closePrice,
    positionRef: ref,
    ...(deal.providerDealId != null ? { dealId: deal.providerDealId } : {}),
    ...(deal.providerNativeOrderId != null ? { orderId: deal.providerNativeOrderId } : {}),
  };
}

/** Live-recovery scope: single Pepperstone DEMO account, six-hour freshness. */
export function provePepperstoneDemoClosedOrderFill(
  input: ClosedDemoOrderFillProofInput,
): ClosedDemoOrderFillProof {
  return proveDemoClosedOrderFillCore(input, {
    allowedBrokerIds: ['pepperstone-ctrader'],
    maxCloseAgeMs: 6 * 3600_000,
  });
}

/**
 * Aged historical scope: any cTrader-family DEMO account (pepperstone,
 * generic, icmarkets) with NO freshness cap on the closing evidence.
 *
 * Rationale: the stranded population (375 records) is historical; the
 * exact-decimal account/side/volume/exit/P&L/timestamp matching does not
 * degrade with age, and the broker DealList remains the authoritative
 * record. All other fail-closed guarantees are identical to the live path.
 * LIVE accounts remain out of scope for automated order-row recovery.
 */
export function proveAgedCtraderDemoClosedOrderFill(
  input: ClosedDemoOrderFillProofInput,
): ClosedDemoOrderFillProof {
  return proveDemoClosedOrderFillCore(input, {
    allowedBrokerIds: CTRADER_FAMILY_BROKER_IDS,
    maxCloseAgeMs: null,
  });
}

/** Fair, bounded selection for the existing DEMO ledger recovery only.
 * Ambiguous multiple orders are excluded before the two-read budget is used.
 * A cursor rotates past unresolved evidence; proof/authority stays unchanged.
 */
export function selectRecentDemoCloseOrders<
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
    .filter((o) => {
      if (
        !o.tradeId ||
        counts.get(o.tradeId) !== 1 ||
        o.status !== OrderStatus.RECONCILIATION_PENDING ||
        o.orderKind !== OrderKind.MARKET ||
        o.providerOrderId !== null ||
        typeof o.filledQuantity !== 'string' ||
        !/^[-+]?0+(?:\.0+)?$/.test(o.filledQuantity.trim()) ||
        o.avgFillPrice !== null ||
        !(o.submittedAt instanceof Date) ||
        !(o.createdAt instanceof Date)
      )
        return false;
      const age = now - o.submittedAt.getTime();
      return age >= 5_000 && age <= 6 * 3600_000;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const next = afterId === undefined ? 0 : eligible.findIndex((o) => o.id > afterId);
  const start = next < 0 ? 0 : next;
  return [...eligible.slice(start), ...eligible.slice(0, start)].slice(0, 2);
}
