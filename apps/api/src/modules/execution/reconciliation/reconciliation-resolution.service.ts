import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trade, TradeCloseReason, TradeStatus } from '../entities/trade.entity';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { OrderService } from '../orders/order.service';
import { TradeStateMachine } from '../orders/trade-state-machine';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { DomainEventBus } from '../../events/event-bus.service';
import { DomainEventType } from '../../events/enums/domain-event-type.enum';
import {
  BrokerClosedTrade,
  BrokerOrderState,
} from '../../broker/interfaces/broker-adapter.interface';
import { compareDecimal } from './reconciliation-comparator';

/**
 * ReconciliationResolutionService — SAFELY converges internal state onto
 * provider-observed truth (Directive PHASE G + §24/§25/§26).
 *
 * POLICY (fail-closed, provider-authoritative but never reckless):
 *
 * AUTO-RESOLVES (provider truth is unambiguous):
 * - POSITION_CLOSED_EXTERNALLY (full close): trade OPEN/RECONCILIATION_PENDING
 *   → CLOSED with best-effort provider exit economics; linked order resolved.
 * - RECONCILIATION_PENDING trade with provider position present → OPEN.
 * - STALE_ORDER_STATE / UNRESOLVED_EXECUTION_RESULT where the provider
 *   reports a TERMINAL order state (FILLED/PARTIAL/CANCELLED/REJECTED/
 *   EXPIRED): the order follows the provider state through the
 *   OrderStateMachine (fills applied atomically with exact-decimal math).
 *
 * NEVER AUTO-RESOLVES (surfaced only — human/admin decision):
 * - MISSING_INTERNAL_ORDER / UNKNOWN_PROVIDER_POSITION (externally-placed
 *   activity: importing it would fabricate internal history).
 * - MISSING_PROVIDER_ORDER when the provider cannot be queried for the id
 *   (transient provider outages must not close live positions).
 * - UNKNOWN provider order states (fail-closed: never guess).
 *
 * CONCURRENCY (Directive §30): every mutation is guarded —
 * - trades: conditional UPDATE WHERE status = expected (rowCount-gated);
 * - orders: OrderService's optimistic WHERE status = from transitions.
 * A racing execution/reconciliation/duplicate-provider-event therefore
 * either no-ops or fails loudly — never double-applies.
 */
@Injectable()
export class ReconciliationResolutionService {
  private readonly logger = new Logger(ReconciliationResolutionService.name);

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    private readonly orderService: OrderService,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
  ) {}

  // ─── Position-side resolution ─────────────────────────────────────────────

  /**
   * Position gone at the provider (externally closed: SL/TP/manual).
   * Guarded OPEN/RECONCILIATION_PENDING → CLOSED; returns true when THIS
   * call performed the transition (concurrent resolvers get false).
   */
  async closeTradeFromProvider(
    trade: Trade,
    closedTrade: BrokerClosedTrade | null,
  ): Promise<boolean> {
    TradeStateMachine.assertTransition(trade.status, TradeStatus.CLOSED);

    const exitPrice = closedTrade?.closePrice ?? null;
    const realisedPnl = closedTrade?.realisedPnl ?? null;

    const result = await this.tradeRepo.update({ id: trade.id, status: trade.status }, {
      status: TradeStatus.CLOSED,
      exitPrice,
      realisedPnl,
      closedAt: new Date(),
      closeReason: TradeCloseReason.BROKER_CLOSE,
    } as never);

    if (!result.affected) {
      // Lost the race (execution closed it / another resolver won).
      this.logger.log(`Trade ${trade.id} state changed concurrently — close skipped (guard held)`);
      return false;
    }

    await this.auditService.log({
      actorUserId: trade.userId,
      action: AuditAction.TRADE_CLOSED,
      resourceType: 'Trade',
      resourceId: trade.id,
      severity: AuditSeverity.WARNING,
      metadata: {
        closeReason: TradeCloseReason.BROKER_CLOSE,
        exitPrice,
        realisedPnl,
        externalOrderId: trade.externalOrderId,
        source: 'state-reconciliation',
      },
    });

    this.eventBus.publish(DomainEventType.TRADE_CLOSED, trade.userId, {
      tradeId: trade.id,
      userId: trade.userId,
      instrument: trade.instrument,
      direction: trade.direction,
      volume: trade.lotSize,
      status: 'CLOSED',
      reason: 'Provider reports the position closed',
    });

    // Provider-observed close implies the linked entry order FILLED.
    await this.resolveLinkedOrder(trade.id, trade.userId, OrderStatus.FILLED, {
      reason: 'Provider-observed position closed — entry order resolved FILLED',
    });

    return true;
  }

  /**
   * RECONCILIATION_PENDING trade whose position the provider still holds —
   * recover to OPEN. Guarded; returns true when this call transitioned.
   */
  async recoverTradeToOpen(trade: Trade): Promise<boolean> {
    TradeStateMachine.assertTransition(TradeStatus.RECONCILIATION_PENDING, TradeStatus.OPEN);

    const result = await this.tradeRepo.update(
      { id: trade.id, status: TradeStatus.RECONCILIATION_PENDING },
      { status: TradeStatus.OPEN } as never,
    );

    if (!result.affected) {
      this.logger.log(`Trade ${trade.id} no longer RECONCILIATION_PENDING — recovery skipped`);
      return false;
    }

    await this.auditService.log({
      actorUserId: trade.userId,
      action: AuditAction.TRADE_RECONCILED,
      resourceType: 'Trade',
      resourceId: trade.id,
      metadata: {
        recoveredTo: TradeStatus.OPEN,
        externalOrderId: trade.externalOrderId,
        source: 'state-reconciliation',
      },
    });

    this.eventBus.publish(DomainEventType.TRADE_OPENED, trade.userId, {
      tradeId: trade.id,
      userId: trade.userId,
      instrument: trade.instrument,
      direction: trade.direction,
      volume: trade.lotSize,
      status: 'OPEN',
      reason: 'Reconciliation confirmed the position is open at the provider',
    });

    await this.resolveLinkedOrder(trade.id, trade.userId, OrderStatus.ACKNOWLEDGED, {
      reason: 'Provider-observed position open — order resolved ACKNOWLEDGED',
    });

    return true;
  }

  // ─── Order-side resolution ────────────────────────────────────────────────

  /**
   * Resolve an order from provider-observed order state (Directive §26
   * stable-identifier query result). Terminal provider states are applied
   * through the OrderStateMachine; WORKING/PARTIALLY_FILLED applies missed
   * fill deltas atomically. Returns true when internal state CHANGED.
   */
  async resolveOrderFromProviderState(
    order: Order,
    providerOrder: BrokerOrderState,
  ): Promise<boolean> {
    // Never mutate terminal internal orders (nothing to converge).
    if (providerOrder.status === 'UNKNOWN') return false;

    switch (providerOrder.status) {
      case 'WORKING': {
        if (order.status === OrderStatus.RECONCILIATION_PENDING) {
          await this.orderService.resolveReconciliation(order.id, OrderStatus.ACKNOWLEDGED, {
            providerOrderId: providerOrder.providerOrderId,
            rejectReason: 'Reconciliation found the order working at the provider',
          });
          await this.auditResolved(order, `Provider state WORKING → ACKNOWLEDGED`);
          return true;
        }
        return false;
      }

      case 'FILLED':
      case 'PARTIALLY_FILLED': {
        const providerFilled = providerOrder.filledQuantity;
        const ahead = compareDecimal(providerFilled, order.filledQuantity ?? '0') > 0;
        if (!ahead && order.status !== OrderStatus.RECONCILIATION_PENDING) return false;

        if (ahead) {
          // Apply the missed fill delta through the exact-decimal atomic
          // path (guarded WHERE status = current + overfill fail-closed).
          const delta = subtractDecimal(providerFilled, order.filledQuantity ?? '0');
          const price = providerOrder.avgFillPrice ?? order.requestedPrice ?? '0';
          if (parseFloat(delta) > 0 && parseFloat(price) > 0) {
            await this.orderService.applyFill(order.id, {
              quantity: delta,
              price,
              providerOrderId: providerOrder.providerOrderId,
            });
          }
        }

        if (order.status === OrderStatus.RECONCILIATION_PENDING) {
          // A PARTIAL/FILLED provider state also resolves the pending state.
          const target =
            providerOrder.status === 'FILLED' ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;
          await this.orderService.resolveReconciliation(order.id, target, {
            providerOrderId: providerOrder.providerOrderId,
            rejectReason: `Reconciliation resolved by provider state ${providerOrder.status}`,
          });
        }

        await this.auditResolved(order, `Provider state ${providerOrder.status} applied`);
        return true;
      }

      case 'CANCELLED':
      case 'REJECTED':
      case 'EXPIRED': {
        if (
          order.status === OrderStatus.FILLED ||
          order.status === OrderStatus.CANCELLED ||
          order.status === OrderStatus.REJECTED ||
          order.status === OrderStatus.EXPIRED
        ) {
          return false; // already terminal — internal is at least as advanced
        }

        const target =
          providerOrder.status === 'CANCELLED'
            ? OrderStatus.CANCELLED
            : providerOrder.status === 'REJECTED'
              ? OrderStatus.REJECTED
              : OrderStatus.EXPIRED;

        await this.orderService.resolveReconciliation(order.id, target, {
          providerOrderId: providerOrder.providerOrderId,
          rejectReason: `Reconciliation resolved by provider state ${providerOrder.status}`,
        });

        await this.auditResolved(order, `Provider state ${providerOrder.status} → ${target}`);
        return true;
      }

      default:
        return false;
    }
  }

  // ─── Shared ───────────────────────────────────────────────────────────────

  /**
   * Resolve the trade's linked RECONCILIATION_PENDING order. DEFENSIVE: an
   * order-resolution failure is logged and retried next run — it NEVER
   * breaks the (authoritative) trade resolution.
   */
  private async resolveLinkedOrder(
    tradeId: string,
    userId: string,
    resolvedTo: OrderStatus,
    context: { reason: string },
  ): Promise<void> {
    try {
      const order = await this.orderService.findByTradeId(tradeId);
      if (!order || order.status !== OrderStatus.RECONCILIATION_PENDING) return;

      await this.orderService.resolveReconciliation(order.id, resolvedTo, {
        rejectReason: context.reason.slice(0, 500),
      });

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.ORDER_RECONCILED,
        resourceType: 'Order',
        resourceId: order.id,
        metadata: {
          clientOrderId: order.clientOrderId,
          resolvedTo,
          reason: context.reason,
          source: 'state-reconciliation',
        },
      });
    } catch (err) {
      this.logger.warn(
        `Order resolution failed for trade ${tradeId} (retried next run): ` +
          `${(err as Error).message}`,
      );
    }
  }

  private async auditResolved(order: Order, resolution: string): Promise<void> {
    try {
      await this.auditService.log({
        actorUserId: order.userId,
        action: AuditAction.ORDER_RECONCILED,
        resourceType: 'Order',
        resourceId: order.id,
        metadata: {
          clientOrderId: order.clientOrderId,
          providerOrderId: order.providerOrderId,
          resolution,
          source: 'state-reconciliation',
        },
      });
    } catch (err) {
      this.logger.warn(`Audit write failed: ${(err as Error).message}`);
    }
  }
}

/** Decimal-string subtraction (a - b) with scale normalization; no floats. */
function subtractDecimal(a: string, b: string, scale = 8): string {
  const toScaled = (v: string): bigint => {
    const s = String(v ?? '0').trim();
    const [i = '0', f = ''] = s.split('.');
    const frac = (f + '0'.repeat(scale)).slice(0, scale);
    const neg = s.startsWith('-');
    const val = BigInt(i || '0') * 10n ** BigInt(scale) + BigInt(frac || '0');
    return neg ? -val : val;
  };
  const result = toScaled(a) - toScaled(b);
  const negative = result < 0n;
  const abs = negative ? -result : result;
  const base = 10n ** BigInt(scale);
  const int = abs / base;
  const frac = abs % base;
  // Minimal representation: trim trailing fraction zeros ('1.00000000' → '1').
  let fracStr = frac.toString().padStart(scale, '0');
  fracStr = fracStr.replace(/0+$/, '');
  const value = fracStr.length > 0 ? `${int}.${fracStr}` : `${int}`;
  return negative ? `-${value}` : value;
}
