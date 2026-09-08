import * as crypto from 'crypto';
import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Trade, TradeCloseReason, TradeDirection, TradeStatus } from './entities/trade.entity';
import { TradingSession, TradingSessionStatus } from './entities/trading-session.entity';
import { RiskDecision } from '../risk/interfaces/risk.interface';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';
import { TradeStateMachine } from './orders/trade-state-machine';
import { OrderKind, OrderTimeInForce } from './orders/order.enums';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { ExecutionIntent } from './orchestration/execution-intent.interface';

/**
 * ExecutionService — Live trade execution engine (position aggregate owner).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CRITICAL RULE — NEVER BYPASS:
 *   executeTrade() only accepts RiskDecision with decision === 'APPROVED'.
 *   Any non-APPROVED decision throws ForbiddenException immediately.
 *   This gate cannot be removed or weakened.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Pipeline (Sprint 50 PR-3 — provider dispatch now flows through the
 * normalized order domain):
 *   1. Enforce Risk Engine APPROVED gate
 *   2. Idempotent trade-slot reservation (advisory lock + daily limit)
 *   3. ExecutionOrchestrator.assertDispatchable() — control-plane +
 *      LIVE-authorization gates (fail-closed, TOCTOU defense in depth)
 *   4. Create PENDING Trade record (atomic reservation)
 *   5. ExecutionOrchestrator.dispatchOrder() — idempotent order reservation,
 *      provider dispatch with retry/timeout, response handling, and
 *      OrderStateMachine-guarded order transitions
 *   6. Map ProviderDispatchOutcome → Trade transitions (all guarded by
 *      TradeStateMachine)
 *   7. Emit audit + domain events
 *
 * See: docs/architecture/12-execution-engine-architecture.md,
 *      docs/orders/order-domain.md
 */
@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    @InjectRepository(Trade)
    private tradeRepo: Repository<Trade>,
    @InjectRepository(TradingSession)
    private sessionRepo: Repository<TradingSession>,
    private brokerService: BrokerService,
    private orchestrator: ExecutionOrchestrator,
    private auditService: AuditService,
    private dataSource: DataSource,
    private readonly eventBus: DomainEventBus,
  ) {}

  // ─── Main entry point ────────────────────────────────────────────────────

  /**
   * Execute a trade that has been APPROVED by the Risk Engine.
   *
   * @throws ForbiddenException if riskDecision is not APPROVED — ALWAYS.
   */
  async executeTrade(userId: string, riskDecision: RiskDecision): Promise<Trade> {
    // ── Non-bypassable Risk Engine gate ────────────────────────────────────
    if (riskDecision.decision !== 'APPROVED') {
      const code =
        riskDecision.decision === 'REJECTED' || riskDecision.decision === 'SUSPENDED'
          ? riskDecision.rejectionCode
          : 'UNKNOWN';

      this.logger.warn(
        `executeTrade() blocked non-APPROVED decision for user ${userId}. ` +
          `Decision: ${riskDecision.decision}, Code: ${code}`,
      );

      throw new ForbiddenException(
        `Trade blocked: Risk Engine decision was ${riskDecision.decision} [${code}]. ` +
          `Execution requires APPROVED status.`,
      );
    }

    const order = riskDecision.validatedOrder;
    const signalId = riskDecision.signalId;

    // ── Step 2: Get broker connection ──────────────────────────────────────
    const connection = await this.brokerService.findActiveConnectionForUser(userId);
    if (!connection) {
      throw new ForbiddenException('No active broker connection available for trade execution');
    }

    // ── Step 3: Pre-dispatch gates (fail-closed; BEFORE the trade-slot
    // reservation so blocked attempts never persist a PENDING trade).
    // Defense in depth against TOCTOU between risk approval and dispatch:
    // an emergency control activated in that window blocks here.
    await this.orchestrator.assertDispatchable({ userId, connection });

    // ── Step 4: ATOMIC reservation (advisory lock + idempotency + daily limit + PENDING INSERT)
    //
    // Sprint 32 Gate 3: the PENDING INSERT now happens INSIDE the advisory-lock
    // transaction. This closes the TOCTOU race from Gate 2 where the INSERT
    // occurred after the lock released.
    //
    // The transaction is short: lock → idempotency check → count → INSERT → COMMIT.
    // The broker network request happens AFTER this method returns — never
    // inside the transaction.
    const reservation = await this.atomicallyReserveTradeSlot(
      userId,
      riskDecision as RiskDecision & { decision: 'APPROVED' },
      connection.id,
    );

    // Handle the three possible outcomes:
    if (reservation.status === 'DUPLICATE_EXISTING') {
      // Same signalId already processed — return existing trade
      this.logger.log(
        `Duplicate signal suppressed (idempotency) — returning existing trade ${reservation.trade.id}`,
      );
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.TRADE_DUPLICATE_SUPPRESSED,
        resourceType: 'Trade',
        resourceId: reservation.trade.id,
        metadata: {
          signalId,
          instrument: order.instrument,
          direction: order.direction,
          existingTradeId: reservation.trade.id,
          existingTradeStatus: reservation.trade.status,
        },
        severity: AuditSeverity.WARNING,
      });
      return reservation.trade;
    }

    if (reservation.status === 'DAILY_LIMIT_REJECTED') {
      this.logger.warn(
        `Daily trade limit reached for user ${userId}: ${reservation.currentCount}/${reservation.maxDailyTrades} ` +
          `(signal ${signalId} rejected by atomic advisory-lock guard)`,
      );
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.TRADE_REJECTED,
        resourceType: 'Trade',
        resourceId: signalId,
        metadata: {
          signalId,
          reason: 'MAX_DAILY_TRADES_EXCEEDED',
          currentCount: reservation.currentCount,
          maxDailyTrades: reservation.maxDailyTrades,
          guard: 'advisory-lock',
        },
        severity: AuditSeverity.WARNING,
      });
      throw new ForbiddenException(
        `Daily trade limit reached (${reservation.currentCount}/${reservation.maxDailyTrades}). ` +
          `Cannot execute signal ${signalId}.`,
      );
    }

    // RESERVED_NEW: PENDING trade is persisted (reservation is durable).
    // The advisory lock has been released (transaction committed).
    // Now proceed to broker submission.
    const trade = reservation.trade;
    const idempotencyKey = this.generateIdempotencyKey(
      userId,
      order.instrument,
      order.direction,
      signalId,
    );

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.TRADE_PREPARED,
      resourceType: 'Trade',
      resourceId: trade.id,
      metadata: {
        instrument: order.instrument,
        direction: order.direction,
        lotSize: order.lotSize,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        idempotencyKey,
        signalId,
      },
    });

    this.eventBus.publish(DomainEventType.TRADE_PENDING, userId, {
      tradeId: trade.id,
      userId,
      instrument: order.instrument,
      direction: order.direction,
      volume: order.lotSize,
      status: 'PENDING',
    });

    // ── Step 5: Orchestrate the provider dispatch through the normalized
    // order domain (Sprint 50 PR-3): execution intent → idempotent order
    // reservation → provider dispatch (retry/timeout) → response handling →
    // machine-guarded order transitions. The signal path is always MARKET.
    const intent: ExecutionIntent = {
      userId,
      brokerConnectionId: connection.id,
      clientOrderId: `sig-${signalId}`,
      tradeId: trade.id,
      signalId,
      orderKind: OrderKind.MARKET,
      timeInForce: OrderTimeInForce.GTC,
      instrument: order.instrument,
      direction: order.direction,
      requestedQuantity: order.lotSize,
      requestedPrice: null,
      stopPrice: null,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      comment: order.idempotencyKey,
      providerAction: 'PLACE',
    };

    let dispatch;
    try {
      dispatch = await this.orchestrator.dispatchOrder(intent, connection);
    } catch (err) {
      // Orchestrator-level infrastructure failure (order store unavailable
      // before reservation, etc.) — the provider outcome is UNKNOWN.
      // Fail closed: flag for reconciliation, never silently drop.
      this.logger.error(
        `Execution orchestration error for trade ${trade.id}: ${(err as Error).message}`,
        (err as Error).stack,
      );

      // Sprint 50 PR-2: guard the transition (fail-closed — an illegal
      // transition surfaces loudly instead of silently corrupting state).
      TradeStateMachine.assertTransition(trade.status, TradeStatus.RECONCILIATION_PENDING);
      await this.tradeRepo.update(trade.id, {
        status: TradeStatus.RECONCILIATION_PENDING,
        brokerRejectionReason: `Execution error: ${(err as Error).message}`,
      });

      trade.status = TradeStatus.RECONCILIATION_PENDING;

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.TRADE_SUBMITTED,
        resourceType: 'Trade',
        resourceId: trade.id,
        metadata: { error: (err as Error).message, status: 'RECONCILIATION_PENDING' },
        severity: AuditSeverity.CRITICAL,
      });

      this.eventBus.publish(DomainEventType.TRADE_RECONCILIATION_PENDING, userId, {
        tradeId: trade.id,
        userId,
        instrument: order.instrument,
        direction: order.direction,
        volume: order.lotSize,
        status: 'RECONCILIATION_PENDING',
        reason: (err as Error).message,
      });

      return trade;
    }

    // ── Step 6: Map the dispatch outcome onto the position aggregate ───────
    switch (dispatch.outcome) {
      case 'FILLED': {
        // Provider executed the order — the position is OPEN.
        // Sprint 50 PR-2: every status mutation is guarded by the explicit
        // TradeStateMachine (no scattered unvalidated updates).
        TradeStateMachine.assertTransition(trade.status, TradeStatus.OPEN);
        await this.tradeRepo.update(trade.id, {
          status: TradeStatus.OPEN,
          externalOrderId: dispatch.providerOrderId,
          fillPrice: dispatch.avgFillPrice,
          openedAt: new Date(),
        });

        trade.status = TradeStatus.OPEN;
        trade.externalOrderId = dispatch.providerOrderId;

        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.TRADE_OPENED,
          resourceType: 'Trade',
          resourceId: trade.id,
          metadata: {
            externalOrderId: dispatch.providerOrderId,
            fillPrice: dispatch.avgFillPrice,
            instrument: order.instrument,
            direction: order.direction,
            lotSize: order.lotSize,
            signalId,
            orderId: dispatch.orderId,
          },
        });

        this.logger.log(
          `Trade OPENED: id=${trade.id} externalId=${dispatch.providerOrderId} ` +
            `${order.direction} ${order.instrument} ${order.lotSize} lots ` +
            `(order ${dispatch.orderId} FILLED)`,
        );

        this.eventBus.publish(DomainEventType.TRADE_OPENED, userId, {
          tradeId: trade.id,
          userId,
          instrument: order.instrument,
          direction: order.direction,
          volume: order.lotSize,
          entryPrice: dispatch.avgFillPrice,
          status: 'OPEN',
        });
        break;
      }

      case 'WORKING': {
        // Provider accepted the order (e.g. a resting market order); the fill
        // arrives asynchronously. The trade REMAINS PENDING with the provider
        // identifier recorded so reconciliation can track it to completion.
        await this.tradeRepo.update(trade.id, {
          externalOrderId: dispatch.providerOrderId,
        });
        trade.externalOrderId = dispatch.providerOrderId;

        this.logger.log(
          `Trade PENDING (order WORKING at provider): id=${trade.id} ` +
            `externalId=${dispatch.providerOrderId} order=${dispatch.orderId}`,
        );
        break;
      }

      case 'REJECTED': {
        TradeStateMachine.assertTransition(trade.status, TradeStatus.REJECTED);
        await this.tradeRepo.update(trade.id, {
          status: TradeStatus.REJECTED,
          brokerRejectionReason: dispatch.reason,
        });

        trade.status = TradeStatus.REJECTED;

        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.TRADE_REJECTED,
          resourceType: 'Trade',
          resourceId: trade.id,
          metadata: { brokerMessage: dispatch.reason, signalId, orderId: dispatch.orderId },
          severity: AuditSeverity.WARNING,
        });

        this.eventBus.publish(DomainEventType.TRADE_REJECTED, userId, {
          tradeId: trade.id,
          userId,
          instrument: order.instrument,
          direction: order.direction,
          volume: order.lotSize,
          status: 'REJECTED',
          reason: dispatch.reason,
        });
        break;
      }

      case 'UNKNOWN':
      case 'DUPLICATE': {
        // UNKNOWN — provider outcome could not be determined (dispatch
        // error/timeout): the order is RECONCILIATION_PENDING and the trade
        // must be too (fail-closed, never silently dropped).
        // DUPLICATE — defensive: the order existed while the trade slot was
        // new (inconsistent store state). Reconciliation resolves both.
        const reason =
          dispatch.outcome === 'UNKNOWN'
            ? dispatch.reason
            : 'Order already existed for a newly reserved trade slot — inconsistent state';
        TradeStateMachine.assertTransition(trade.status, TradeStatus.RECONCILIATION_PENDING);
        await this.tradeRepo.update(trade.id, {
          status: TradeStatus.RECONCILIATION_PENDING,
          brokerRejectionReason: `Execution error: ${reason}`,
        });

        trade.status = TradeStatus.RECONCILIATION_PENDING;

        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.TRADE_SUBMITTED,
          resourceType: 'Trade',
          resourceId: trade.id,
          metadata: {
            error: reason,
            status: 'RECONCILIATION_PENDING',
            orderId: dispatch.orderId,
          },
          severity: AuditSeverity.CRITICAL,
        });

        this.eventBus.publish(DomainEventType.TRADE_RECONCILIATION_PENDING, userId, {
          tradeId: trade.id,
          userId,
          instrument: order.instrument,
          direction: order.direction,
          volume: order.lotSize,
          status: 'RECONCILIATION_PENDING',
          reason,
        });
        break;
      }
    }

    return trade;
  }

  // ─── Trade close ──────────────────────────────────────────────────────────

  /**
   * Close an open trade. Called by AI signal, kill switch, or user action.
   * The Risk Engine must validate the CLOSE action before calling this.
   *
   * Sprint 50 PR-3: the close now flows through the normalized order domain
   * (a MARKET order with providerAction CLOSE_POSITION), so every close has
   * an auditable order lifecycle. Close attempts are idempotent per attempt
   * sequence — a definitively failed close (REJECTED) may be retried with a
   * fresh attempt id, while concurrent duplicate closes never double-dispatch.
   *
   * FAIL-CLOSED behavior (improvement over the legacy direct adapter call):
   * - Provider refuses the close → ConflictException, the trade REMAINS OPEN
   *   (previously a failed close still marked the trade CLOSED).
   * - Provider outcome unknown → trade moves to RECONCILIATION_PENDING for
   *   the reconciliation job to resolve (previously the error propagated and
   *   the trade silently stayed OPEN with a possibly-closed provider side).
   */
  async closeTrade(tradeId: string, userId: string, reason: TradeCloseReason): Promise<Trade> {
    const trade = await this.tradeRepo.findOne({ where: { id: tradeId, userId } });
    if (!trade) {
      throw new ForbiddenException(`Trade ${tradeId} not found or does not belong to user`);
    }
    if (trade.status !== TradeStatus.OPEN) {
      throw new ForbiddenException(`Trade ${tradeId} is not OPEN (status: ${trade.status})`);
    }
    if (!trade.externalOrderId) {
      throw new ForbiddenException(`Trade ${tradeId} has no externalOrderId — cannot close`);
    }

    // findConnectionById requires userId for ownership check
    const connection = await this.brokerService.findConnectionById(
      trade.brokerConnectionId,
      userId,
    );

    // Pre-dispatch gates (control plane + LIVE authorization) — fail-closed.
    await this.orchestrator.assertDispatchable({ userId, connection });

    // Idempotent close-attempt id: concurrent closes of the same trade race
    // for the SAME attempt id (one wins, the loser returns idempotently);
    // a definitively failed attempt mints the next sequence on retry.
    const attempt = (await this.countCloseAttempts(trade.id)) + 1;
    const closeIntent: ExecutionIntent = {
      userId,
      brokerConnectionId: connection.id,
      clientOrderId: `close-${trade.id}${attempt > 1 ? `-${attempt}` : ''}`,
      tradeId: trade.id,
      signalId: trade.signalId ?? null,
      orderKind: OrderKind.MARKET,
      timeInForce: OrderTimeInForce.GTC,
      instrument: trade.instrument,
      direction: trade.direction === TradeDirection.BUY ? 'SELL' : 'BUY',
      requestedQuantity: trade.lotSize,
      requestedPrice: null,
      stopPrice: null,
      stopLoss: '0',
      takeProfit: '0',
      providerAction: 'CLOSE_POSITION',
      providerReferenceId: trade.externalOrderId,
    };

    const dispatch = await this.orchestrator.dispatchOrder(closeIntent, connection);

    if (dispatch.outcome === 'FILLED') {
      // exit price = the close order's fill price; P&L populated by
      // reconciliation job.
      TradeStateMachine.assertTransition(trade.status, TradeStatus.CLOSED);
      await this.tradeRepo.update(trade.id, {
        status: TradeStatus.CLOSED,
        exitPrice: dispatch.avgFillPrice,
        closedAt: new Date(),
        closeReason: reason,
      });

      trade.status = TradeStatus.CLOSED;
      trade.closeReason = reason;

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.TRADE_CLOSED,
        resourceType: 'Trade',
        resourceId: trade.id,
        metadata: {
          exitPrice: dispatch.avgFillPrice,
          closeReason: reason,
          externalOrderId: trade.externalOrderId,
          closeOrderId: dispatch.orderId,
        },
      });

      this.logger.log(
        `Trade CLOSED: id=${trade.id} reason=${reason} exitPrice=${dispatch.avgFillPrice}`,
      );

      return trade;
    }

    if (dispatch.outcome === 'REJECTED') {
      // FAIL-CLOSED: the provider definitively refused the close — the
      // position remains OPEN and the caller sees an explicit conflict.
      this.logger.warn(`Close refused by provider for trade ${trade.id}: ${dispatch.reason}`);
      throw new ConflictException(
        `Broker refused to close position: ${dispatch.reason}. The trade remains OPEN.`,
      );
    }

    if (dispatch.outcome === 'DUPLICATE') {
      // A concurrent close request won the idempotency race for this attempt
      // — its dispatch is already closing the position. Idempotent semantics:
      // return the current trade state unchanged.
      this.logger.log(
        `Concurrent close suppressed (idempotent) for trade ${trade.id} — ` +
          `in-flight close order ${dispatch.orderId}`,
      );
      return trade;
    }

    // WORKING / UNKNOWN — the provider-side close outcome is unresolved.
    // Flag the trade for reconciliation instead of guessing (fail-closed).
    const reasonText =
      dispatch.outcome === 'UNKNOWN' ? dispatch.reason : 'Close order resting at provider';
    TradeStateMachine.assertTransition(trade.status, TradeStatus.RECONCILIATION_PENDING);
    await this.tradeRepo.update(trade.id, {
      status: TradeStatus.RECONCILIATION_PENDING,
      brokerRejectionReason: `Close outcome unresolved: ${reasonText}`,
    });

    trade.status = TradeStatus.RECONCILIATION_PENDING;

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.TRADE_SUBMITTED,
      resourceType: 'Trade',
      resourceId: trade.id,
      metadata: {
        error: `Close outcome unresolved: ${reasonText}`,
        status: 'RECONCILIATION_PENDING',
        closeOrderId: dispatch.orderId,
      },
      severity: AuditSeverity.CRITICAL,
    });

    this.eventBus.publish(DomainEventType.TRADE_RECONCILIATION_PENDING, userId, {
      tradeId: trade.id,
      userId,
      instrument: trade.instrument,
      direction: trade.direction,
      volume: trade.lotSize,
      status: 'RECONCILIATION_PENDING',
      reason: reasonText,
    });

    return trade;
  }

  // ─── Query helpers (used by Risk Engine) ─────────────────────────────────

  /** Count of currently open trades for a user. Used for Risk Engine Step 4a. */
  async countOpenTrades(userId: string): Promise<number> {
    return this.tradeRepo.count({ where: { userId, status: TradeStatus.OPEN } });
  }

  /**
   * Count of trades opened today (UTC day boundary) for a user.
   * Used for Risk Engine Step 4b (max daily trades enforcement).
   *
   * Sprint 32: counts trades that were actually OPENED today (have an
   * opened_at timestamp), excluding PENDING (not yet submitted to broker)
   * and REJECTED (broker refused). This avoids double-counting retries and
   * avoids counting risk-rejected attempts as executed trades.
   *
   * The trading-day boundary is UTC midnight — consistent with the existing
   * getTodayRealisedLoss() day boundary.
   */
  async countTodayTrades(userId: string): Promise<number> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const result = await this.dataSource.query<{ count: string }[]>(
      `SELECT COUNT(*) AS count
       FROM trading.trades
       WHERE user_id = $1
         AND opened_at >= $2
         AND status IN ('OPEN', 'CLOSED')`,
      [userId, todayStart.toISOString()],
    );

    return parseInt(result[0]?.count ?? '0', 10);
  }

  /**
   * Sprint 32 Gate 3 — Atomic trade-slot reservation.
   *
   * This is the SINGLE method that acquires the advisory lock, checks
   * idempotency, checks the daily-trade limit, and INSERTS the PENDING trade
   * — all inside ONE short DB transaction. The lock is released on COMMIT,
   * and the PENDING trade is already persisted when the lock releases.
   *
   * This closes the TOCTOU race from Gate 2 where the PENDING INSERT occurred
   * AFTER the advisory-lock transaction committed.
   *
   * Returns a discriminated union:
   *   - RESERVED_NEW: new PENDING trade persisted (broker submission follows)
   *   - DUPLICATE_EXISTING: same idempotency_key already exists (return existing)
   *   - DAILY_LIMIT_REJECTED: daily trade limit reached
   */
  async atomicallyReserveTradeSlot(
    userId: string,
    riskDecision: RiskDecision & { decision: 'APPROVED' },
    connectionId: string,
  ): Promise<
    | { status: 'RESERVED_NEW'; trade: Trade }
    | { status: 'DUPLICATE_EXISTING'; trade: Trade }
    | { status: 'DAILY_LIMIT_REJECTED'; currentCount: number; maxDailyTrades: number }
  > {
    const order = riskDecision.validatedOrder;
    const signalId = riskDecision.signalId;
    const maxDailyTrades = riskDecision.maxDailyTrades;

    const idempotencyKey = this.generateIdempotencyKey(
      userId,
      order.instrument,
      order.direction,
      signalId,
    );

    const todayStr = new Date().toISOString().slice(0, 10);
    const lockKey = this.computeDailyTradeLockKey(userId, todayStr);

    return this.dataSource.transaction(async (manager) => {
      // 1. Acquire advisory lock scoped to (userId + UTC day)
      await manager.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      // 2. Idempotency check: if a trade with this idempotency_key already
      //    exists, return it as DUPLICATE_EXISTING. This check is inside the
      //    transaction so the unique constraint + advisory lock together
      //    guarantee exactly-once persistence.
      const existingRows = await manager.query(
        `SELECT * FROM trading.trades WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey],
      );
      if (existingRows.length > 0) {
        const existing = this.hydrateTradeRow(existingRows[0] as Record<string, unknown>);
        return { status: 'DUPLICATE_EXISTING' as const, trade: existing };
      }

      // 3. Daily-trade-limit count: OPEN+CLOSED (opened today) + PENDING
      //    (created today — reservations). REJECTED/CANCELLED don't count.
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);

      const countResult = await manager.query(
        `SELECT COUNT(*) AS count
         FROM trading.trades
         WHERE user_id = $1
           AND (
             (opened_at >= $2 AND status IN ('OPEN', 'CLOSED'))
             OR
             (created_at >= $2 AND status = 'PENDING')
           )`,
        [userId, todayStart.toISOString()],
      );

      const currentCount = parseInt(countResult[0]?.count ?? '0', 10);

      // 4. If limit reached, reject
      if (currentCount >= maxDailyTrades) {
        return {
          status: 'DAILY_LIMIT_REJECTED' as const,
          currentCount,
          maxDailyTrades,
        };
      }

      // 5. INSERT the PENDING trade INSIDE this transaction.
      //    The unique constraint on idempotency_key is the final safety net
      //    for same-signalId duplicates — if two concurrent transactions
      //    somehow both reach this point (impossible due to advisory lock),
      //    the DB rejects the second INSERT with SQLSTATE 23505.
      let insertResult: Record<string, unknown>[];
      try {
        insertResult = await manager.query(
          `INSERT INTO trading.trades
            (id, user_id, broker_connection_id, signal_id, idempotency_key,
             instrument, direction, lot_size, requested_entry_price,
             stop_loss, take_profit, trailing_stop_pips, status, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', NOW(), NOW())
           RETURNING *`,
          [
            userId,
            connectionId,
            signalId,
            idempotencyKey,
            order.instrument,
            order.direction,
            order.lotSize,
            order.entryPrice,
            order.stopLoss,
            order.takeProfit,
            order.trailingStopPips ?? null,
          ],
        );
      } catch (err) {
        if (this.isUniqueConstraintViolation(err)) {
          const duplicateRows = await manager.query(
            `SELECT * FROM trading.trades WHERE idempotency_key = $1 LIMIT 1`,
            [idempotencyKey],
          );
          if (duplicateRows.length > 0) {
            return {
              status: 'DUPLICATE_EXISTING' as const,
              trade: this.hydrateTradeRow(duplicateRows[0] as Record<string, unknown>),
            };
          }
        }
        throw err;
      }

      const trade = this.hydrateTradeRow(insertResult[0]);
      return { status: 'RESERVED_NEW' as const, trade };
    });
  }

  /**
   * Sum of today's realised losses (negative P&L only) for daily loss limit check.
   * Returns a negative number (e.g., -250.00) or 0 if no losses today.
   * Used for Risk Engine Step 3a.
   */
  async getTodayRealisedLoss(userId: string): Promise<number> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const result = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(realised_pnl), 0) AS total
       FROM trading.trades
       WHERE user_id = $1
         AND status = 'CLOSED'
         AND closed_at >= $2
         AND realised_pnl < 0`,
      [userId, todayStart.toISOString()],
    );

    return parseFloat(result[0]?.total ?? '0');
  }

  async getOpenTrades(userId: string): Promise<Trade[]> {
    return this.tradeRepo.find({ where: { userId, status: TradeStatus.OPEN } });
  }

  async findTradeById(tradeId: string): Promise<Trade | null> {
    return this.tradeRepo.findOne({ where: { id: tradeId } });
  }

  /**
   * Find a trade by its signalId for a given user.
   *
   * Sprint 32: used by the Risk Engine's idempotency check (Step 7) to detect
   * duplicate signal processing. If a trade already exists for this signalId,
   * the signal is a duplicate and the Risk Engine rejects with DUPLICATE_SIGNAL.
   *
   * Scoped by userId so a signalId from one user doesn't collide with another.
   */
  async findTradeBySignalId(signalId: string, userId: string): Promise<Trade | null> {
    return this.tradeRepo.findOne({ where: { signalId, userId } });
  }

  // ─── Session management ───────────────────────────────────────────────────

  async startSession(
    userId: string,
    brokerConnectionId: string,
    openingBalance: string,
    riskProfileSnapshot?: Record<string, unknown> | null,
  ): Promise<TradingSession> {
    const existing = await this.sessionRepo.findOne({
      where: { userId, status: TradingSessionStatus.ACTIVE },
    });
    if (existing) return existing;

    return this.sessionRepo.save(
      this.sessionRepo.create({
        userId,
        brokerConnectionId,
        status: TradingSessionStatus.ACTIVE,
        openingBalance,
        peakEquity: openingBalance,
        startedAt: new Date(),
        // Sprint 32: snapshot the risk profile at session start so future
        // edits don't rewrite history. The snapshot is a deterministic JSON
        // object of risk-relevant fields (no credentials/secrets/PII).
        riskProfileSnapshot: riskProfileSnapshot ?? null,
      }),
    );
  }

  async endSession(userId: string, status = TradingSessionStatus.ENDED): Promise<void> {
    await this.sessionRepo.update(
      { userId, status: TradingSessionStatus.ACTIVE },
      { status, endedAt: new Date() },
    );
  }

  async getActiveSession(userId: string): Promise<TradingSession | null> {
    return this.sessionRepo.findOne({ where: { userId, status: TradingSessionStatus.ACTIVE } });
  }

  async findSessionById(sessionId: string): Promise<TradingSession | null> {
    return this.sessionRepo.findOne({ where: { id: sessionId } });
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private generateIdempotencyKey(
    userId: string,
    instrument: string,
    direction: string,
    signalId: string,
  ): string {
    return crypto
      .createHash('sha256')
      .update(`${userId}:${instrument}:${direction}:${signalId}`)
      .digest('hex');
  }

  /**
   * Count prior close attempts for a trade (Sprint 50 PR-3 close idempotency:
   * each retry after a definitive failure mints the next attempt sequence).
   */
  private async countCloseAttempts(tradeId: string): Promise<number> {
    const result = await this.dataSource.query<{ count: string }[]>(
      `SELECT COUNT(*) AS count
       FROM trading.orders
       WHERE trade_id = $1
         AND client_order_id LIKE 'close-%'`,
      [tradeId],
    );
    return parseInt(result[0]?.count ?? '0', 10);
  }

  /**
   * Detect a PostgreSQL unique-constraint violation (SQLSTATE 23505).
   *
   * Sprint 32: used by the atomic idempotency check. When two concurrent
   * executeTrade() calls race to INSERT a trade with the same idempotency_key,
   * the DB unique constraint rejects one of the INSERTs. This helper reliably
   * detects that condition so we can return the existing trade instead of
   * surfacing an unhandled QueryFailedError.
   *
   * TypeORM wraps the pg error in a QueryFailedError; the original pg error's
   * `code` property is '23505'. We check both the `code` property and the error
   * message for the SQLSTATE to be defensive across driver versions.
   */
  private isUniqueConstraintViolation(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const code = (err as { code?: string }).code;
    if (code === '23505') return true;
    // Fallback: check the message for the SQLSTATE or the constraint name.
    const msg = err.message ?? '';
    return msg.includes('23505') || msg.includes('duplicate key value');
  }

  /** Convert a raw PostgreSQL snake_case row into the Trade entity shape. */
  private hydrateTradeRow(row: Record<string, unknown>): Trade {
    const trade = new Trade();
    const target = trade as unknown as Record<string, unknown>;
    const mappings: Array<[string, string]> = [
      ['id', 'id'],
      ['user_id', 'userId'],
      ['broker_connection_id', 'brokerConnectionId'],
      ['signal_id', 'signalId'],
      ['idempotency_key', 'idempotencyKey'],
      ['instrument', 'instrument'],
      ['direction', 'direction'],
      ['lot_size', 'lotSize'],
      ['requested_entry_price', 'requestedEntryPrice'],
      ['fill_price', 'fillPrice'],
      ['stop_loss', 'stopLoss'],
      ['take_profit', 'takeProfit'],
      ['trailing_stop_pips', 'trailingStopPips'],
      ['external_order_id', 'externalOrderId'],
      ['status', 'status'],
      ['exit_price', 'exitPrice'],
      ['realised_pnl', 'realisedPnl'],
      ['close_reason', 'closeReason'],
      ['broker_rejection_reason', 'brokerRejectionReason'],
      ['opened_at', 'openedAt'],
      ['closed_at', 'closedAt'],
      ['created_at', 'createdAt'],
      ['updated_at', 'updatedAt'],
    ];
    for (const [dbKey, entityKey] of mappings) {
      if (Object.prototype.hasOwnProperty.call(row, dbKey)) target[entityKey] = row[dbKey];
    }
    if (target.direction !== undefined) target.direction = target.direction as TradeDirection;
    if (target.status !== undefined) target.status = target.status as TradeStatus;
    return trade;
  }

  /**
   * Compute a stable 32-bit integer advisory lock key from userId + date.
   * PostgreSQL advisory lock keys are bigint; we use a single 32-bit key
   * for simplicity (sufficient for user+day scoping).
   *
   * Sprint 50 PR-3: derived from a SHA-256 digest instead of the legacy
   * char-code loop — CodeQL flagged the unbounded-length iteration over
   * user-controlled input; the digest also distributes better. Lock-key
   * VALUES change vs. the legacy hash, which only affects transient
   * in-flight locks (never persisted state).
   */
  private computeDailyTradeLockKey(userId: string, dateStr: string): number {
    const digest = crypto.createHash('sha256').update(`${userId}:${dateStr}`).digest();
    return digest.readUInt32BE(0) & 0x7fffffff;
  }
}
