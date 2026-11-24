import type { BrokerClosedTrade } from '../../broker/interfaces/broker-adapter.interface';
import type { Order } from '../orders/order.entity';
import type { Trade } from '../entities/trade.entity';
import { OrderStatus, OrderKind } from '../orders/order.enums';
import { TradeStatus } from '../entities/trade.entity';
import { compareDecimal } from './reconciliation-comparator';

/**
 * Pepperstone DEMO: a closed POSITION in the broker's authenticated DealList
 * may prove the previously uncertain CLOSE ORDER economically filled, but
 * only after cross-checking the durable position, the unique closing deal,
 * and the exact same account/side/volume/exit/P&L/timestamp. A missing broker
 * order id is NEVER invented, and absent positions alone prove nothing.
 *
 * Returned evidence authorizes ONLY OrderService.applyFill on that exact
 * close-order row. It cannot mutate the closed trade or send broker orders.
 */
export type ClosedDemoOrderFillProof =
  | { matched: true; quantity: string; price: string; positionRef: string }
  | { matched: false; reason: string };

export function provePepperstoneDemoClosedOrderFill(input: {
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
}): ClosedDemoOrderFillProof {
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
    brokerId !== 'pepperstone-ctrader' ||
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
    now - closed > 6 * 3600_000 ||
    sent - created > 120_000
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
  if (
    ![qty, fill, lots].every((x) => typeof x === 'string' && decimal.test(x)) ||
    typeof price !== 'string' ||
    !decimal.test(price) ||
    gross === null ||
    gross === undefined ||
    !/^-?\d+(?:\.\d+)?$/.test(gross) ||
    compareDecimal(qty, '0') <= 0 ||
    compareDecimal(fill, '0') !== 0 ||
    order.avgFillPrice !== null ||
    compareDecimal(qty, lots) !== 0 ||
    compareDecimal(price, '0') <= 0
  )
    return no('CLOSE_ORDER_ECONOMICS_UNPROVEN');
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
  return { matched: true, quantity: qty, price: deal.closePrice, positionRef: ref };
}
