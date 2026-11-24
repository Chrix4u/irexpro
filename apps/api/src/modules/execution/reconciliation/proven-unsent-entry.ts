import { EntityManager } from 'typeorm';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { Order } from '../orders/order.entity';
import { OrderKind, OrderStatus } from '../orders/order.enums';
import { OrderStateMachine } from '../orders/order-state-machine';
import { CapitalAllocation, CapitalAllocationStatus } from '../entities/capital-allocation.entity';
import { isProvenUnsentEntry } from '../trade-read-truth';
import { ExactDecimal } from '../../../common/utils/exact-decimal';

/**
 * Entry-only proof. Never infer non-execution from an empty provider snapshot.
 * A failed exit, ambiguous transport error, competing order or recorded fill
 * is outside this repair's authority.
 */
export function proveUnsentEntry(trade: Trade, orders: Order[]): boolean {
  if (!isProvenUnsentEntry(trade) || !trade.signalId || !trade.tradeIntentId ||
      !trade.riskGrantId || orders.length !== 1) return false;
  const o = orders[0];
  const requested = ExactDecimal.tryParse(o.requestedQuantity);
  const lots = ExactDecimal.tryParse(trade.lotSize);
  const filled = ExactDecimal.tryParse(o.filledQuantity);
  return o.status === OrderStatus.RECONCILIATION_PENDING &&
    o.orderKind === OrderKind.MARKET &&
    o.tradeId === trade.id &&
    o.userId === trade.userId &&
    o.brokerConnectionId === trade.brokerConnectionId &&
    o.signalId === trade.signalId &&
    o.clientOrderId === 'sig-' + trade.signalId &&
    o.instrument === trade.instrument && o.direction === trade.direction &&
    o.providerOrderId === null && o.avgFillPrice === null &&
    requested !== null && lots !== null && requested.isPositive() &&
    requested.eq(lots) && filled !== null && filled.isZero() &&
    typeof trade.brokerRejectionReason === 'string' &&
    trade.brokerRejectionReason.startsWith('Execution error: Dispatch error (DEFINITELY_NOT_SENT):');
}

/**
 * Special proof-bound terminal convergence, not a general trade-state edge.
 * Locks both records, rechecks the proof and changes the ledger atomically.
 * Preserves consumed risk grant and terminal intent: no retry/reopening.
 * No broker write or provider request.
 */
export async function reconcileProvenUnsentEntry(
  manager: EntityManager,
  tradeId: string,
  userId: string,
  brokerConnectionId: string,
  providerClientOrderIds: ReadonlySet<string>,
): Promise<string | null> {
  return manager.transaction(async tx => {
    const trade = await tx.getRepository(Trade).findOne({
      where: { id: tradeId, userId, brokerConnectionId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!trade || !isProvenUnsentEntry(trade)) return null;
    const orders = await tx.getRepository(Order).createQueryBuilder('o')
      .where('o.trade_id = :tradeId', { tradeId })
      .setLock('pessimistic_write').getMany();
    if (!proveUnsentEntry(trade, orders)) return null;
    const order = orders[0];
    if (providerClientOrderIds.has(order.clientOrderId)) return null;
    OrderStateMachine.assertTransition(order.status, OrderStatus.REJECTED);
    const orderResult = await tx.getRepository(Order).update(
      { id: order.id, status: OrderStatus.RECONCILIATION_PENDING },
      { status: OrderStatus.REJECTED, rejectReason: 'Proven local dispatch refusal (DEFINITELY_NOT_SENT)', finalizedAt: new Date() },
    );
    if (orderResult.affected !== 1) throw new Error('Unsent order convergence CAS failed');
    // The generic trade machine forbids RECONCILIATION_PENDING -> REJECTED.
    // This narrow exception requires the locked, never-opened entry proof above.
    const tradeResult = await tx.getRepository(Trade).update(
      { id: trade.id, status: TradeStatus.RECONCILIATION_PENDING },
      { status: TradeStatus.REJECTED },
    );
    if (tradeResult.affected !== 1) throw new Error('Unsent trade convergence CAS failed');
    await tx.getRepository(CapitalAllocation).update(
      { tradeIntentId: trade.tradeIntentId!, userId, brokerConnectionId, status: CapitalAllocationStatus.ACTIVE },
      { status: CapitalAllocationStatus.RELEASED, releasedReason: 'PROVEN_UNSENT_ENTRY' },
    );
    return order.id;
  });
}
