import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Trade, TradeCloseReason, TradeStatus } from '../entities/trade.entity';
import { Order } from '../orders/order.entity';
import { OrderKind, OrderStatus } from '../orders/order.enums';
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
  BrokerPosition,
} from '../../broker/interfaces/broker-adapter.interface';
import { compareDecimal } from './reconciliation-comparator';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { proveUniqueCtraderDemoSettlement } from './closed-demo-settlement-proof';

/**
 * Broker-reported CLOSE economics are a terminal, independently observed P&L
 * point. Durable 5-second OPEN telemetry can miss the final price movement,
 * particularly on TP/SL fills. Reconcile ONLY the sampled fallback path;
 * never overwrite a provider-supplied full path or fabricate live quote samples.
 * Figures are gross account-currency P&L; costs are stored separately.
 */
export function reconcileDurableProfitPathAtClose<
  T extends {
    maxFavorablePnl: string;
    maxAdversePnl: string;
    profitGiveback: string;
    peakObservedAt: Date | null;
  },
>(path: T, realisedPnl: string | null, closedAt: Date): T {
  const final = realisedPnl === null ? null : ExactDecimal.tryParse(realisedPnl);
  const peak = ExactDecimal.tryParse(path.maxFavorablePnl);
  const trough = ExactDecimal.tryParse(path.maxAdversePnl);
  if (!final || !peak || !trough || !Number.isFinite(closedAt.getTime())) return path;

  const best = ExactDecimal.max(ExactDecimal.ZERO, ExactDecimal.max(peak, final));
  const worst = ExactDecimal.min(ExactDecimal.ZERO, ExactDecimal.min(trough, final));
  const giveback = ExactDecimal.max(ExactDecimal.ZERO, best.sub(final));
  return {
    ...path,
    maxFavorablePnl: best.toFixed(8),
    maxAdversePnl: worst.toFixed(8),
    profitGiveback: giveback.toFixed(8),
    // The broker CLOSE, not a synthetic M1 candle, established a newer peak.
    // Leave sample count and last OPEN quote timestamp unchanged.
    peakObservedAt: final.gt(peak) && final.gt(ExactDecimal.ZERO) ? closedAt : path.peakObservedAt,
  };
}

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
 * NEVER AUTO-RESOLVES WHILE THE EXTERNAL ACTIVITY IS STILL PRESENT
 * (surfaced only — human/admin decision):
 * - MISSING_INTERNAL_ORDER / UNKNOWN_PROVIDER_POSITION (externally-placed
 *   activity: importing it would fabricate internal history). A historical
 *   UNKNOWN_PROVIDER_POSITION alert may be marked RESOLVED only after a later
 *   complete provider snapshot proves that provider position ref is absent;
 *   this closes stale alert state and never fabricates internal history.
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

  /**
   * Reconcile a formerly CLOSED, economically incomplete DEMO trade only
   * after obtaining exactly one complete, uniquely verified provider CLOSE
   * deal. A guarded NULL-only CAS prevents races, overrides or fabricated
   * P&L. No trade is reopened and no broker order is placed.
   */
  async backfillClosedDemoSettlement(input: {
    trade: Trade;
    brokerId: string;
    accountType: string;
    providerDeals: import('../../broker/interfaces/broker-adapter.interface').BrokerClosedTrade[];
    observedAt: Date;
  }): Promise<boolean> {
    const { trade } = input;
    if (
      trade.status !== TradeStatus.CLOSED ||
      trade.realisedPnl !== null ||
      trade.commission !== null ||
      trade.exitPrice !== null
    )
      return false;
    const proof = proveUniqueCtraderDemoSettlement(
      trade,
      input.providerDeals,
      input.brokerId,
      input.accountType,
      input.observedAt,
    );
    if (!proof.matched) return false;
    const p = proof.provider;
    const patch: Partial<Trade> = {
      exitPrice: p.closePrice,
      realisedPnl: p.realisedPnl,
      commission: p.commission,
      swap: p.swap,
    };
    if (
      (trade.pathObservationCount ?? 0) > 0 &&
      trade.maxFavorablePnl != null &&
      trade.maxAdversePnl != null &&
      trade.profitGiveback != null
    ) {
      const updatedPath = reconcileDurableProfitPathAtClose(
        {
          maxFavorablePnl: trade.maxFavorablePnl,
          maxAdversePnl: trade.maxAdversePnl,
          profitGiveback: trade.profitGiveback,
          peakObservedAt: trade.pathPeakObservedAt ?? null,
        },
        p.realisedPnl,
        p.closedAt,
      );
      patch.maxFavorablePnl = updatedPath.maxFavorablePnl;
      patch.maxAdversePnl = updatedPath.maxAdversePnl;
      patch.profitGiveback = updatedPath.profitGiveback;
      patch.pathPeakObservedAt = updatedPath.peakObservedAt;
    }
    const result = await this.tradeRepo.update(
      {
        id: trade.id,
        userId: trade.userId,
        brokerConnectionId: trade.brokerConnectionId,
        status: TradeStatus.CLOSED,
        realisedPnl: IsNull(),
        commission: IsNull(),
        exitPrice: IsNull(),
      },
      patch as never,
    );
    if (!result.affected) return false;
    await this.auditService.log({
      actorUserId: trade.userId,
      action: AuditAction.TRADE_RECONCILED,
      resourceType: 'Trade',
      resourceId: trade.id,
      metadata: {
        artifact: 'unique-ctrader-demo-closed-economics-recovery-v1',
        evidence: 'ONE_FULL_CLOSING_DEAL_EXACT_POSITION_ENTRY_VOLUME_AND_TIME',
        brokerId: input.brokerId,
        providerPositionId: p.externalOrderId,
        providerClosedAt: p.closedAt.toISOString(),
        closePrice: p.closePrice,
        realisedPnl: p.realisedPnl,
        commission: p.commission,
        swap: p.swap,
        priorStatus: TradeStatus.CLOSED,
        currentStatus: TradeStatus.CLOSED,
        originalCloseReasonPreserved: trade.closeReason,
        noBrokerOrder: true,
        noPositionMutation: true,
      },
    });
    this.logger.log(
      `Recovered missing provider closing economics for trade ${trade.id} from uniquely matched ${input.brokerId} DEMO deal`,
    );
    return true;
  }

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
    const commission = closedTrade?.commission ?? null;
    const swap = closedTrade?.swap ?? null;
    const closedAt = closedTrade?.closedAt ?? new Date();
    const providerCloseReason = closedTrade?.closeReason;
    const providerReasonSpecific =
      providerCloseReason === 'TP' ||
      providerCloseReason === 'SL' ||
      providerCloseReason === 'PROFIT_LOCK' ||
      providerCloseReason === 'TIME_TO_WORK';
    const mappedProviderCloseReason = this.mapProviderCloseReason(providerCloseReason);
    const appCloseIntentFallback =
      !providerReasonSpecific &&
      trade.status === TradeStatus.RECONCILIATION_PENDING &&
      trade.closeReason
        ? trade.closeReason
        : null;
    const closeReason = appCloseIntentFallback ?? mappedProviderCloseReason;
    const closeReasonSource = providerReasonSpecific
      ? 'PROVIDER_CLOSE_REASON'
      : appCloseIntentFallback
        ? 'APP_CLOSE_INTENT_FALLBACK'
        : 'PROVIDER_GENERIC';

    const providerPathDiagnostics = closedTrade?.pathDiagnostics ?? null;
    const durablePathDiagnostics =
      !providerPathDiagnostics &&
      (trade.pathObservationCount ?? 0) > 0 &&
      trade.maxFavorablePnl != null &&
      trade.maxAdversePnl != null &&
      trade.profitGiveback != null
        ? {
            maxFavorablePnl: trade.maxFavorablePnl,
            maxAdversePnl: trade.maxAdversePnl,
            profitGiveback: trade.profitGiveback,
            observationCount: trade.pathObservationCount ?? 0,
            sameBarProtectionAmbiguityCount: trade.sameBarProtectionAmbiguityCount ?? 0,
            lastSameBarProtectionAmbiguityAt: trade.lastSameBarProtectionAmbiguityAt ?? null,
            peakObservedAt: trade.pathPeakObservedAt ?? null,
            lastObservedAt: trade.pathLastObservedAt ?? null,
          }
        : null;
    const pathDiagnostics =
      providerPathDiagnostics ??
      (durablePathDiagnostics
        ? reconcileDurableProfitPathAtClose(durablePathDiagnostics, realisedPnl, closedAt)
        : null);
    const pathDiagnosticsSource = providerPathDiagnostics
      ? 'PROVIDER'
      : durablePathDiagnostics
        ? realisedPnl != null
          ? 'DURABLE_TRADE_TELEMETRY_WITH_PROVIDER_EXIT'
          : 'DURABLE_TRADE_TELEMETRY'
        : null;

    const result = await this.tradeRepo.update({ id: trade.id, status: trade.status }, {
      status: TradeStatus.CLOSED,
      exitPrice,
      realisedPnl,
      commission,
      swap,
      closedAt,
      closeReason,
      ...(pathDiagnostics
        ? {
            maxFavorablePnl: pathDiagnostics.maxFavorablePnl,
            maxAdversePnl: pathDiagnostics.maxAdversePnl,
            profitGiveback: pathDiagnostics.profitGiveback,
            pathObservationCount: pathDiagnostics.observationCount,
            sameBarProtectionAmbiguityCount: pathDiagnostics.sameBarProtectionAmbiguityCount,
            lastSameBarProtectionAmbiguityAt: pathDiagnostics.lastSameBarProtectionAmbiguityAt,
            pathPeakObservedAt: pathDiagnostics.peakObservedAt,
            pathLastObservedAt: pathDiagnostics.lastObservedAt,
          }
        : {}),
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
        closeReason,
        providerCloseReason: closedTrade?.closeReason ?? null,
        closeReasonSource,
        exitPrice,
        realisedPnl,
        commission,
        swap,
        providerClosedAt: closedAt.toISOString(),
        externalOrderId: trade.externalOrderId,
        pathDiagnosticsSource,
        pathDiagnostics: pathDiagnostics
          ? {
              maxFavorablePnl: pathDiagnostics.maxFavorablePnl,
              maxAdversePnl: pathDiagnostics.maxAdversePnl,
              profitGiveback: pathDiagnostics.profitGiveback,
              observationCount: pathDiagnostics.observationCount,
              sameBarProtectionAmbiguityCount: pathDiagnostics.sameBarProtectionAmbiguityCount,
              lastSameBarProtectionAmbiguityAt:
                pathDiagnostics.lastSameBarProtectionAmbiguityAt?.toISOString() ?? null,
              peakObservedAt: pathDiagnostics.peakObservedAt?.toISOString() ?? null,
              lastObservedAt: pathDiagnostics.lastObservedAt?.toISOString() ?? null,
            }
          : null,
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

    // Provider-observed close implies the linked orders converged. The old
    // status-only resolveLinkedOrder(FILLED) path THREW by design for
    // fill-bearing targets and was swallowed — leaving the closing order
    // RECONCILIATION_PENDING forever while the trade itself closed (the
    // stranded-bookkeeping defect). The broker deal in hand now converges the
    // stranded close order through the fill-bearing applyFill CAS.
    await this.convergeStrandedOrdersAfterProviderClose(trade, closedTrade);

    return true;
  }

  private mapProviderCloseReason(
    providerReason: BrokerClosedTrade['closeReason'] | undefined,
  ): TradeCloseReason {
    if (providerReason === 'TP') return TradeCloseReason.TAKE_PROFIT_HIT;
    if (providerReason === 'SL') return TradeCloseReason.STOP_LOSS_HIT;
    if (providerReason === 'PROFIT_LOCK') return TradeCloseReason.PROFIT_PROTECTION;
    if (providerReason === 'TIME_TO_WORK') return TradeCloseReason.TIME_TO_WORK;
    // MANUAL/SYSTEM/UNKNOWN from a provider observation cannot prove who or
    // what initiated the close. Keep the durable reason conservative.
    return TradeCloseReason.BROKER_CLOSE;
  }

  /**
   * RECONCILIATION_PENDING trade whose position the provider still holds —
   * recover to OPEN. Guarded; returns true when this call transitioned.
   */
  async recoverTradeToOpen(trade: Trade, providerPosition?: BrokerPosition): Promise<boolean> {
    // Round 7.1 (P0-5): recovery is legal from BOTH uncertain holding states
    // (RECONCILIATION_PENDING and the WORKING-outcome PENDING) — the state
    // machine is the single authority on legality, and the guarded CAS pins
    // the observed from-state (a concurrently-moved trade is never touched).
    TradeStateMachine.assertTransition(trade.status, TradeStatus.OPEN);

    const patch: Partial<Trade> = {
      status: TradeStatus.OPEN,
      ...(trade.status === TradeStatus.RECONCILIATION_PENDING
        ? {
            // The provider still holds the position, so any provisional
            // app-close attribution from an ambiguous close attempt is stale.
            closeReason: null,
            brokerRejectionReason: null,
          }
        : {}),
    };
    if (providerPosition) {
      patch.externalPositionId = providerPosition.externalOrderId;
      patch.fillPrice = providerPosition.openPrice;
      patch.openedAt = providerPosition.openedAt;
    }

    const result = await this.tradeRepo.update(
      { id: trade.id, status: trade.status },
      patch as never,
    );

    if (!result.affected) {
      this.logger.log(`Trade ${trade.id} no longer ${trade.status} — recovery skipped`);
      return false;
    }

    await this.auditService.log({
      actorUserId: trade.userId,
      action: AuditAction.TRADE_RECONCILED,
      resourceType: 'Trade',
      resourceId: trade.id,
      metadata: {
        recoveredTo: TradeStatus.OPEN,
        recoveredFrom: trade.status,
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
          // applyFill ITSELF transitions the order (RECONCILIATION_PENDING is
          // fillable) to PARTIALLY_FILLED/FILLED — the fill-bearing state is
          // reached atomically WITH its economic facts.
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

        if (order.status === OrderStatus.RECONCILIATION_PENDING && !ahead) {
          // CORRECTION ROUND 4 (architect finding 7): no fill delta to apply —
          // the recorded fill facts ALREADY agree with the provider; record
          // the provider-observed fill-bearing status through the dedicated
          // FILL-BEARING entry point. The OLD status-only call
          // (resolveReconciliation → FILLED/PARTIALLY_FILLED) threw by design
          // ("a status-only reconciliation must never invent a fill") and
          // broke the convergence of uncertain writes onto discovered fills.
          const target =
            providerOrder.status === 'FILLED' ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;
          await this.orderService.resolveReconciliationFillState(order.id, target, {
            providerOrderId: providerOrder.providerOrderId,
          });
        }
        // When `ahead`, applyFill above already performed the atomic
        // fill-bearing transition — no second write (exactly one convergence).

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
   * Converge the trade's stranded internal orders once the provider-observed
   * close has been booked (guarded CAS above). Two shapes, both fill-bearing:
   *
   * 1. CLOSE order — MARKET, direction OPPOSITE to the trade, no provider
   *    order id, zero recorded fill (the lost-acknowledgement shape of the
   *    375-record DEMO incident). The provider CLOSED DEAL in hand is the
   *    authoritative fill: exact quantity and close price are required, then
   *    applyFill books them atomically (overfill fail-closed, status CAS).
   * 2. ENTRY order — direction EQUAL to the trade's, zero recorded fill: the
   *    provider position (observed while open, now closed) established the
   *    trade's fill price and full lot size; applyFill books the entry fill.
   *
   * Anything that cannot be proven EXACTLY is left RECONCILIATION_PENDING
   * (surfaced for the next cycle / manual review) — never fabricated here.
   * Per-order failures never break the authoritative trade resolution above.
   */
  private async convergeStrandedOrdersAfterProviderClose(
    trade: Trade,
    closedDeal: BrokerClosedTrade | null,
  ): Promise<void> {
    let orders: Order[] = [];
    try {
      orders = await this.orderService.findReconcilableByTradeId(trade.id);
    } catch (err) {
      this.logger.warn(
        `Stranded-order lookup failed for trade ${trade.id} (retried next run): ` +
          `${(err as Error).message}`,
      );
      return;
    }
    for (const order of orders) {
      try {
        if (order.status !== OrderStatus.RECONCILIATION_PENDING) continue;
        const isCloseShape =
          order.orderKind === OrderKind.MARKET && order.direction !== trade.direction;
        const isEntryShape = order.direction === trade.direction;
        if (!isCloseShape && !isEntryShape) continue;

        const proof = isCloseShape
          ? this.proveCloseOrderFillFromClosedDeal(order, trade, closedDeal)
          : this.proveEntryOrderFillFromTrade(order, trade);
        if (!proof.matched) {
          this.logger.warn(
            `Stranded ${isCloseShape ? 'close' : 'entry'} order ${order.id} for trade ` +
              `${trade.id} not convergible from provider evidence (${proof.reason}) — ` +
              'left RECONCILIATION_PENDING for retry / manual review',
          );
          continue;
        }

        const completed = await this.orderService.applyFill(order.id, {
          quantity: proof.quantity,
          price: proof.price,
          ...(closedDeal?.externalOrderId != null
            ? { providerPositionId: closedDeal.externalOrderId }
            : {}),
          ...(closedDeal?.providerDealId != null
            ? { providerDealId: closedDeal.providerDealId }
            : {}),
        });
        if (completed.status !== OrderStatus.FILLED) {
          // Partial deal coverage — recorded, not terminal; surfaced, retried.
          this.logger.warn(
            `Stranded order ${order.id} for trade ${trade.id} recorded a partial ` +
              `fill (${completed.filledQuantity}/${completed.requestedQuantity}); ` +
              'terminal convergence deferred to further provider evidence',
          );
        }
        await this.auditService.log({
          actorUserId: trade.userId,
          action: AuditAction.ORDER_RECONCILED,
          resourceType: 'Order',
          resourceId: order.id,
          metadata: {
            clientOrderId: order.clientOrderId,
            leg: isCloseShape ? 'CLOSE' : 'ENTRY',
            resolvedTo: completed.status,
            evidence: proof.evidence,
            providerPositionId: closedDeal?.externalOrderId ?? null,
            providerClosePrice: proof.price,
            providerFillQuantity: proof.quantity,
            noBrokerOrderPlaced: true,
            noTradeMutation: true,
            source: 'reconciliation-resolution',
          },
        });
      } catch (err) {
        this.logger.warn(
          `Stranded order convergence failed for trade ${trade.id} order ` +
            `${order.id} (retried next run): ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Exact-decimal proof that a stranded MARKET CLOSE order was economically
   * filled by the provider's closing deal. The deal's quantity must equal the
   * requested quantity EXACTLY (a partial close is NOT proof of a terminal
   * fill); the close price must be a positive decimal; the instrument must
   * match. Missing deal evidence fails closed — nothing is inferred.
   */
  private proveCloseOrderFillFromClosedDeal(
    order: Order,
    trade: Trade,
    closedDeal: BrokerClosedTrade | null,
  ):
    | { matched: true; quantity: string; price: string; evidence: string }
    | { matched: false; reason: string } {
    if (!closedDeal) return { matched: false, reason: 'NO_PROVIDER_CLOSED_DEAL' };
    const decimal = /^\d+(?:\.\d+)?$/;
    if (closedDeal.instrument !== order.instrument)
      return { matched: false, reason: 'DEAL_INSTRUMENT_MISMATCH' };
    if (typeof closedDeal.closePrice !== 'string' || !decimal.test(closedDeal.closePrice))
      return { matched: false, reason: 'DEAL_CLOSE_PRICE_UNPROVEN' };
    if (typeof closedDeal.lotSize !== 'string' || !decimal.test(closedDeal.lotSize))
      return { matched: false, reason: 'DEAL_CLOSE_QUANTITY_UNPROVEN' };
    if (compareDecimal(closedDeal.lotSize, order.requestedQuantity) !== 0)
      return { matched: false, reason: 'DEAL_QUANTITY_NOT_FULL_CLOSE' };
    if (compareDecimal(closedDeal.closePrice, '0') <= 0)
      return { matched: false, reason: 'DEAL_CLOSE_PRICE_UNPROVEN' };
    if (order.providerOrderId !== null)
      return { matched: false, reason: 'ORDER_HAS_PROVIDER_ID_USE_STABLE_IDENTIFIER_PATH' };
    if (order.filledQuantity == null || compareDecimal(order.filledQuantity, '0') !== 0)
      return { matched: false, reason: 'ORDER_ALREADY_HAS_RECORDED_FILL' };
    if (order.avgFillPrice !== null)
      return { matched: false, reason: 'ORDER_ALREADY_HAS_FILL_PRICE' };
    return {
      matched: true,
      quantity: closedDeal.lotSize,
      price: closedDeal.closePrice,
      evidence: 'PROVIDER_CLOSED_DEAL_EXACT_QUANTITY_AND_PRICE',
    };
  }

  /**
   * Exact-decimal proof that a stranded ENTRY order was filled: the provider
   * position observation (persisted on the trade) carries the authoritative
   * fill price and the full lot size, and the order must have requested
   * exactly that quantity. Trade economics missing → fails closed.
   */
  private proveEntryOrderFillFromTrade(
    order: Order,
    trade: Trade,
  ):
    | { matched: true; quantity: string; price: string; evidence: string }
    | { matched: false; reason: string } {
    const decimal = /^\d+(?:\.\d+)?$/;
    if (order.providerOrderId !== null)
      return { matched: false, reason: 'ORDER_HAS_PROVIDER_ID_USE_STABLE_IDENTIFIER_PATH' };
    if (order.filledQuantity == null || compareDecimal(order.filledQuantity, '0') !== 0)
      return { matched: false, reason: 'ORDER_ALREADY_HAS_RECORDED_FILL' };
    if (order.avgFillPrice !== null)
      return { matched: false, reason: 'ORDER_ALREADY_HAS_FILL_PRICE' };
    if (typeof trade.fillPrice !== 'string' || !decimal.test(trade.fillPrice))
      return { matched: false, reason: 'TRADE_FILL_PRICE_UNPROVEN' };
    if (typeof trade.lotSize !== 'string' || !decimal.test(trade.lotSize))
      return { matched: false, reason: 'TRADE_LOT_SIZE_UNPROVEN' };
    if (compareDecimal(trade.lotSize, order.requestedQuantity) !== 0)
      return { matched: false, reason: 'TRADE_LOT_SIZE_NOT_FULL_ORDER_QUANTITY' };
    if (compareDecimal(trade.fillPrice, '0') <= 0)
      return { matched: false, reason: 'TRADE_FILL_PRICE_UNPROVEN' };
    return {
      matched: true,
      quantity: trade.lotSize,
      price: trade.fillPrice,
      evidence: 'PROVIDER_POSITION_OBSERVED_FILL_PRICE_AND_FULL_LOT_SIZE',
    };
  }

  /**
   * Resolve the trade's linked RECONCILIATION_PENDING order to a NON-FILL-BEARING
   * state only (ACKNOWLEDGED/CANCELLED/REJECTED/EXPIRED). Fill-bearing targets
   * must go through convergeStrandedOrdersAfterProviderClose / applyFill —
   * resolveReconciliation rejects them by design. DEFENSIVE: an order-resolution
   * failure is logged and retried next run — it NEVER breaks the
   * (authoritative) trade resolution.
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
