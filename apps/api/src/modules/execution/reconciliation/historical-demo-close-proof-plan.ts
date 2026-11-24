import type { BrokerClosedTrade } from '../../broker/interfaces/broker-adapter.interface';
import type { Order } from '../orders/order.entity';
import type { Trade } from '../entities/trade.entity';
import { OrderKind, OrderStatus } from '../orders/order.enums';
import { TradeStatus } from '../entities/trade.entity';
import { compareDecimal } from './reconciliation-comparator';

/**
 * Read-only, operator-reviewed historical close evidence. This is a PLAN
 * ONLY: it cannot send orders, change a status, reconcile account balances,
 * or authorize real-money trading.
 *
 * Standard (recent) reconciliation keeps its existing strict 6h guard.
 * This separate, deliberately non-executing proof has a 30-day ceiling to
 * analyze an older DEMO backlog without relaxing the runtime loop.
 */
export type HistoricalDemoCloseOrder = Pick<
  Order,
  | 'id'
  | 'tradeId'
  | 'userId'
  | 'brokerConnectionId'
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

export type HistoricalDemoClosedTrade = Pick<
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

export interface HistoricalDemoCloseRawDeal {
  positionId: string;
  dealId: string;
  orderId: string;
  executionTimestamp: number;
}

export interface HistoricalDemoProofInput {
  brokerId: string;
  accountType: string;
  accountUserId: string;
  accountConnectionId: string;
  brokerAccountFlat: boolean;
  historyPageComplete: boolean;
  uniquePendingCloseOrdersForTrade: number;
  uniqueProviderClosingDealsForPosition: number;
  order: HistoricalDemoCloseOrder;
  trade: HistoricalDemoClosedTrade;
  brokerClosingDeal: BrokerClosedTrade;
  rawBrokerClosingDeal: HistoricalDemoCloseRawDeal;
  observedAt: Date;
}

export type HistoricalDemoProof =
  | {
      eligible: true;
      reason: 'EXACT_BROKER_DEMO_CLOSE_PROVEN_PLAN_ONLY';
      orderId: string;
      tradeId: string;
      positionId: string;
      nativeDealId: string;
      nativeOrderId: string;
      quantity: string;
      price: string;
    }
  | { eligible: false; reason: string };

const POSITIVE_PROVIDER_ID = /^[1-9]\d*$/;
const UNSIGNED_DECIMAL = /^\d+(?:\.\d+)?$/;
const SIGNED_DECIMAL = /^-?\d+(?:\.\d+)?$/;
const MAX_HISTORY_AGE_MS = 30 * 86_400_000;
const DISPATCH_WINDOW_MS = 120_000;

function validProviderId(v: string): boolean {
  return POSITIVE_PROVIDER_ID.test(v) && Number.isSafeInteger(Number(v));
}

export function proveHistoricalPepperstoneDemoClose(
  input: HistoricalDemoProofInput,
): HistoricalDemoProof {
  const no = (reason: string): HistoricalDemoProof => ({ eligible: false, reason });
  const { order, trade, brokerClosingDeal: deal, rawBrokerClosingDeal: raw } = input;

  if (
    input.brokerId !== 'pepperstone-ctrader' ||
    input.accountType !== 'DEMO' ||
    !input.accountUserId ||
    !input.accountConnectionId ||
    !input.brokerAccountFlat ||
    !input.historyPageComplete ||
    input.uniquePendingCloseOrdersForTrade !== 1 ||
    input.uniqueProviderClosingDealsForPosition !== 1
  )
    return no('DEMO_SCOPE_OR_BROKER_HISTORY_COMPLETENESS_UNPROVEN');

  if (
    !order.id ||
    !order.tradeId ||
    order.tradeId !== trade.id ||
    order.userId !== input.accountUserId ||
    trade.userId !== input.accountUserId ||
    order.brokerConnectionId !== input.accountConnectionId ||
    trade.brokerConnectionId !== input.accountConnectionId ||
    order.status !== OrderStatus.RECONCILIATION_PENDING ||
    order.orderKind !== OrderKind.MARKET ||
    order.providerOrderId !== null ||
    order.avgFillPrice !== null ||
    trade.status !== TradeStatus.CLOSED ||
    order.instrument !== trade.instrument ||
    order.direction === trade.direction
  )
    return no('ORDER_OWNER_TERMINAL_TRADE_OR_CLOSE_SIDE_UNPROVEN');

  const positionId = trade.externalPositionId || trade.externalOrderId;
  if (
    !positionId ||
    !validProviderId(positionId) ||
    raw.positionId !== positionId ||
    !validProviderId(raw.dealId) ||
    !validProviderId(raw.orderId)
  )
    return no('EXACT_NATIVE_DEAL_AND_POSITION_ID_UNPROVEN');

  if (
    !order.createdAt ||
    !order.submittedAt ||
    !trade.openedAt ||
    !trade.closedAt ||
    !(input.observedAt instanceof Date)
  )
    return no('HISTORICAL_TIMESTAMP_UNPROVEN');

  const opened = trade.openedAt.getTime();
  const created = order.createdAt.getTime();
  const submitted = order.submittedAt.getTime();
  const closed = trade.closedAt.getTime();
  const observed = input.observedAt.getTime();
  const executed = raw.executionTimestamp;

  if (
    ![opened, created, submitted, closed, observed, executed].every(Number.isSafeInteger) ||
    opened > created ||
    created > submitted ||
    submitted > closed ||
    closed > observed ||
    observed - closed > MAX_HISTORY_AGE_MS ||
    submitted - created > DISPATCH_WINDOW_MS ||
    closed - submitted > DISPATCH_WINDOW_MS ||
    executed < submitted ||
    executed > observed ||
    Math.abs(executed - closed) > 999
  )
    return no('HISTORICAL_CLOSE_DISPATCH_OR_BROKER_TIME_UNPROVEN');

  if (trade.exitPrice === null) return no('HISTORICAL_CLOSE_FILL_QUANTITY_OR_PRICE_UNPROVEN');
  if (
    ![
      order.requestedQuantity,
      order.filledQuantity,
      trade.lotSize,
      trade.exitPrice,
      deal.lotSize,
      deal.closePrice,
    ].every((value) => typeof value === 'string' && UNSIGNED_DECIMAL.test(value)) ||
    typeof trade.realisedPnl !== 'string' ||
    typeof deal.realisedPnl !== 'string' ||
    !SIGNED_DECIMAL.test(trade.realisedPnl) ||
    !SIGNED_DECIMAL.test(deal.realisedPnl) ||
    compareDecimal(order.requestedQuantity, '0') <= 0 ||
    compareDecimal(order.filledQuantity, '0') !== 0 ||
    compareDecimal(order.requestedQuantity, trade.lotSize) !== 0 ||
    compareDecimal(deal.lotSize, order.requestedQuantity) !== 0 ||
    compareDecimal(trade.exitPrice, '0') <= 0
  )
    return no('HISTORICAL_CLOSE_FILL_QUANTITY_OR_PRICE_UNPROVEN');

  if (
    deal.externalOrderId !== positionId ||
    deal.instrument !== order.instrument ||
    deal.direction !== order.direction ||
    compareDecimal(deal.closePrice, trade.exitPrice) !== 0 ||
    compareDecimal(deal.realisedPnl, trade.realisedPnl) !== 0 ||
    !(deal.closedAt instanceof Date) ||
    !Number.isSafeInteger(deal.closedAt.getTime()) ||
    Math.abs(deal.closedAt.getTime() - closed) > 999 ||
    Math.abs(deal.closedAt.getTime() - executed) > 999
  )
    return no('EXACT_BROKER_CLOSE_ECONOMICS_OR_TIME_MISMATCH');

  return {
    eligible: true,
    reason: 'EXACT_BROKER_DEMO_CLOSE_PROVEN_PLAN_ONLY',
    orderId: order.id,
    tradeId: trade.id,
    positionId,
    nativeDealId: raw.dealId,
    nativeOrderId: raw.orderId,
    quantity: order.requestedQuantity,
    price: deal.closePrice,
  };
}

export interface HistoricalDemoProofBatch {
  eligible: Array<Extract<HistoricalDemoProof, { eligible: true }>>;
  withheld: Array<{ orderId: string; reason: string }>;
}

/** Deduplicate trade, native deal and position IDs ACROSS the entire batch. */
export function planHistoricalPepperstoneDemoCloses(
  inputs: readonly HistoricalDemoProofInput[],
): HistoricalDemoProofBatch {
  const eligible: HistoricalDemoProofBatch['eligible'] = [];
  const withheld: HistoricalDemoProofBatch['withheld'] = [];
  const counts = (values: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const value of values) m.set(value, (m.get(value) ?? 0) + 1);
    return m;
  };
  const orderCounts = counts(inputs.map((x) => x.order.id));
  const tradeCounts = counts(inputs.map((x) => x.trade.id));
  const positionCounts = counts(
    inputs.map((x) => x.trade.externalPositionId || x.trade.externalOrderId || ''),
  );
  const dealCounts = counts(inputs.map((x) => x.rawBrokerClosingDeal.dealId));
  for (const input of inputs) {
    const proof = proveHistoricalPepperstoneDemoClose(input);
    if (!proof.eligible) {
      withheld.push({ orderId: input.order.id, reason: proof.reason });
    } else if (
      orderCounts.get(proof.orderId) !== 1 ||
      tradeCounts.get(proof.tradeId) !== 1 ||
      positionCounts.get(proof.positionId) !== 1 ||
      dealCounts.get(proof.nativeDealId) !== 1
    ) {
      withheld.push({ orderId: proof.orderId, reason: 'DUPLICATE_IDENTITY_IN_HISTORICAL_BATCH' });
    } else {
      eligible.push(proof);
    }
  }
  return { eligible, withheld };
}
