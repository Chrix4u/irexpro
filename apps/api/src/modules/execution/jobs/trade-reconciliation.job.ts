import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Trade, TradeCloseReason, TradeStatus } from '../entities/trade.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../../broker/services/credential-encryption.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { TradeStateMachine } from '../orders/trade-state-machine';
import { OrderService } from '../orders/order.service';
import { OrderStatus } from '../orders/order.enums';

export const TRADE_RECONCILIATION_QUEUE = 'trade-reconciliation';
export const TRADE_RECONCILIATION_JOB = 'reconcile-open-trades';
export const RECONCILIATION_INTERVAL_MS = 60_000; // 60 seconds

/**
 * TradeReconciliationJob — Periodic sync of OPEN/PENDING_RECONCILIATION
 * trades with broker-side state.
 *
 * Runs every 60 seconds. For each OPEN trade:
 *   1. Calls broker adapter to check if position still exists
 *   2. If position closed by broker (SL/TP hit): updates trade to CLOSED with P&L
 *   3. If position still open: no-op
 *   4. For RECONCILIATION_PENDING trades: retry submission
 *
 * Sprint 50 PR-3: when a provider-observed trade outcome resolves a trade,
 * the linked order (if RECONCILIATION_PENDING) is resolved to the matching
 * order-domain state — the order and position aggregates never diverge.
 *
 * See: docs/architecture/12-execution-engine-architecture.md §7.1
 */
@Injectable()
@Processor(TRADE_RECONCILIATION_QUEUE)
export class TradeReconciliationJob extends WorkerHost {
  private readonly logger = new Logger(TradeReconciliationJob.name);

  constructor(
    @InjectRepository(Trade)
    private tradeRepo: Repository<Trade>,
    private brokerService: BrokerService,
    private adapterRegistry: BrokerAdapterRegistry,
    private encryptionService: CredentialEncryptionService,
    private auditService: AuditService,
    private orderService: OrderService,
  ) {
    super();
  }

  async process(job: Job): Promise<{ reconciled: number; closed: number; errors: number }> {
    this.logger.debug(`Running trade reconciliation job ${job.id}`);

    const openTrades = await this.tradeRepo.find({
      where: [{ status: TradeStatus.OPEN }, { status: TradeStatus.RECONCILIATION_PENDING }],
    });

    if (openTrades.length === 0) {
      return { reconciled: 0, closed: 0, errors: 0 };
    }

    this.logger.log(`Reconciling ${openTrades.length} open/pending trades`);

    let closed = 0;
    let errors = 0;

    await Promise.allSettled(
      openTrades.map(async (trade) => {
        try {
          const wasClosed = await this.reconcileTrade(trade);
          if (wasClosed) closed++;
        } catch (err) {
          errors++;
          this.logger.error(
            `Reconciliation error for trade ${trade.id}: ${(err as Error).message}`,
          );
        }
      }),
    );

    this.logger.log(
      `Reconciliation complete: ${openTrades.length} checked, ${closed} closed, ${errors} errors`,
    );

    return { reconciled: openTrades.length, closed, errors };
  }

  private async reconcileTrade(trade: Trade): Promise<boolean> {
    if (!trade.externalOrderId) {
      return false;
    }

    const connection = await this.brokerService.findConnectionById(
      trade.brokerConnectionId,
      trade.userId,
    );

    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials!,
      iv: connection.credentialIv!,
      tag: connection.credentialTag!,
      keyId: connection.encryptionKeyId!,
    });

    const adapter = this.adapterRegistry.getAdapter(connection.brokerId);
    adapter.setMode(connection.accountType);
    await adapter.connect(credentials);

    // Zero credentials immediately after use
    (Object.keys(credentials) as (keyof typeof credentials)[]).forEach((k) => {
      (credentials as unknown as Record<string, unknown>)[k] = null;
    });

    // Check if position still open at broker: null = closed/not found
    const position = await adapter.getPositionById(trade.externalOrderId);

    if (position === null) {
      // Position not found at broker — it was closed (SL/TP hit or manual)
      let exitPrice: string | null = null;
      let realisedPnl: string | null = null;

      try {
        const closedTrades = await adapter.getClosedTrades(
          trade.openedAt ?? new Date(0),
          new Date(),
        );
        const match = closedTrades.find((ct) => ct.externalOrderId === trade.externalOrderId);
        if (match) {
          exitPrice = match.closePrice;
          realisedPnl = match.realisedPnl;
        }
      } catch (err) {
        this.logger.warn(
          `Could not fetch closed trade details for ${trade.id}: ${(err as Error).message}`,
        );
      }

      // Sprint 50 PR-2: guard the transition (OPEN/RECONCILIATION_PENDING →
      // CLOSED are both legal; any other state surfaces loudly).
      TradeStateMachine.assertTransition(trade.status, TradeStatus.CLOSED);
      await this.tradeRepo.update(trade.id, {
        status: TradeStatus.CLOSED,
        exitPrice,
        realisedPnl,
        closedAt: new Date(),
        closeReason: TradeCloseReason.BROKER_CLOSE,
      });

      // Sprint 50 PR-3: the position existed and is now provider-observed
      // closed — the linked entry order (if unresolved) must have FILLED.
      await this.resolveLinkedOrder(trade.id, OrderStatus.FILLED, {
        reason: 'Provider-observed position closed — entry order resolved FILLED',
      });

      await this.auditService.log({
        actorUserId: trade.userId,
        action: AuditAction.TRADE_CLOSED,
        resourceType: 'Trade',
        resourceId: trade.id,
        metadata: {
          closeReason: TradeCloseReason.BROKER_CLOSE,
          exitPrice,
          realisedPnl,
          externalOrderId: trade.externalOrderId,
          source: 'reconciliation',
        },
      });

      this.logger.log(
        `Trade ${trade.id} reconciled as CLOSED. ` +
          `exitPrice=${exitPrice ?? 'unknown'} pnl=${realisedPnl ?? 'unknown'}`,
      );

      return true;
    }

    // Position still open — recover RECONCILIATION_PENDING → OPEN
    if (trade.status === TradeStatus.RECONCILIATION_PENDING) {
      // Sprint 50 PR-2: guard the recovery transition.
      TradeStateMachine.assertTransition(trade.status, TradeStatus.OPEN);
      await this.tradeRepo.update(trade.id, { status: TradeStatus.OPEN });

      // Sprint 50 PR-3: the position is provider-observed open — the linked
      // order (if unresolved) is acknowledged at the provider.
      await this.resolveLinkedOrder(trade.id, OrderStatus.ACKNOWLEDGED, {
        reason: 'Provider-observed position open — order resolved ACKNOWLEDGED',
      });

      this.logger.log(`Trade ${trade.id} recovered: RECONCILIATION_PENDING → OPEN`);
    }

    return false;
  }

  /**
   * Sprint 50 PR-3 — resolve the trade's linked order when reconciliation
   * observes the provider-side truth. DEFENSIVE: an order-resolution failure
   * is logged but NEVER breaks trade reconciliation (the trade outcome is
   * authoritative; the next run retries the order resolution).
   */
  private async resolveLinkedOrder(
    tradeId: string,
    resolvedTo: OrderStatus,
    context: { reason: string },
  ): Promise<void> {
    try {
      const order = await this.orderService.findByTradeId(tradeId);
      if (!order || order.status !== OrderStatus.RECONCILIATION_PENDING) {
        return; // no linked order, or already resolved
      }

      await this.orderService.resolveReconciliation(order.id, resolvedTo, {
        rejectReason: context.reason.slice(0, 500),
      });

      await this.auditService.log({
        actorUserId: order.userId,
        action: AuditAction.ORDER_RECONCILED,
        resourceType: 'Order',
        resourceId: order.id,
        metadata: {
          clientOrderId: order.clientOrderId,
          resolvedTo,
          reason: context.reason,
          source: 'trade-reconciliation',
        },
      });

      this.logger.log(`Order ${order.id} (trade ${tradeId}) reconciled → ${resolvedTo}`);
    } catch (err) {
      this.logger.warn(
        `Order resolution failed for trade ${tradeId} (will retry next run): ` +
          `${(err as Error).message}`,
      );
    }
  }
}
