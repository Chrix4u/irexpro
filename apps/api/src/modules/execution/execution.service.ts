import * as crypto from 'crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, QueryDeepPartialEntity, Repository } from 'typeorm';
import { Trade, TradeCloseReason, TradeDirection, TradeStatus } from './entities/trade.entity';
import { TradingSession, TradingSessionStatus } from './entities/trading-session.entity';
import { RiskGrant } from './entities/risk-grant.entity';
import { ExecutionConfirmation } from './entities/execution-confirmation.entity';
import {
  ExecutionMode,
  ExecutionConfirmationStatus,
  ProviderOperationClass,
  RiskGrantStatus,
} from './interfaces/execution-authority';
import {
  ActiveSessionConflictException,
  BrokerConnectionNotConnectedException,
  BrokerConnectionNotExecutableException,
  BrokerConnectionOwnershipException,
  ExecutionSessionResolutionService,
  SessionAuthorityGenerationConflictException,
  SessionAuthorityNotActiveException,
} from './execution-session.resolution';
import { RiskDecision } from '../risk/interfaces/risk.interface';
import { BrokerService } from '../broker/broker.service';
import { BrokerConnectionStatus } from '../broker/interfaces/broker-adapter.interface';
import { ProviderDispatchCertainty } from '../broker/interfaces/provider-dispatch-certainty';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';
import { TradeLifecycleCasService } from './orders/trade-lifecycle-cas.service';
import { OrderKind, OrderTimeInForce } from './orders/order.enums';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import {
  FinalDispatchAuthorization,
  FinalDispatchBoundary,
} from './orchestration/final-dispatch-boundary';
import { ExecutionIntent } from './orchestration/execution-intent.interface';

/** Invalidation reason stamped on RiskGrants when the session authority
 *  generation advances (mode change / end / suspension — issue #298). */
export const SESSION_AUTHORITY_GENERATION_CHANGED = 'SESSION_AUTHORITY_GENERATION_CHANGED';

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
 *   1b. FINAL DISPATCH BOUNDARY (Round 5, task 50-c): a server-issued
 *       RiskGrant is REQUIRED (RiskApprovalResult.grantId) and consumed
 *       atomically at the boundary — grant/session/connection/mode/
 *       confirmation/control re-verified from CURRENT durable state, ZERO
 *       provider calls on any drift (#361/#301/#294/#298/#299/#303)
 *   2. Idempotent trade-slot reservation (advisory lock + daily limit)
 *   3. ExecutionOrchestrator.assertDispatchable() — control-plane +
 *      LIVE-authorization gates (fail-closed, TOCTOU defense in depth,
 *      operation-aware)
 *   4. Create PENDING Trade record (atomic reservation)
 *   5. ExecutionOrchestrator.dispatchOrder() — idempotent order reservation,
 *      provider dispatch with retry/timeout, response handling, and
 *      OrderStateMachine-guarded order transitions
 *   6. Map ProviderDispatchOutcome → Trade transitions (EVERY provider-bound
 *      Trade mutation is a compare-and-swap via TradeLifecycleCasService —
 *      issue #315: 0-affected → reload authoritative, preserve newer
 *      terminal truth, never regress a proved-CLOSED trade)
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
    @InjectRepository(RiskGrant)
    private readonly riskGrantRepo: Repository<RiskGrant>,
    @InjectRepository(ExecutionConfirmation)
    private readonly confirmationRepo: Repository<ExecutionConfirmation>,
    private readonly sessionResolution: ExecutionSessionResolutionService,
    private readonly finalDispatchBoundary: FinalDispatchBoundary,
    private readonly tradeCas: TradeLifecycleCasService,
  ) {}

  // ─── Main entry point ────────────────────────────────────────────────────

  /**
   * Execute a trade that has been APPROVED by the Risk Engine.
   *
   * @throws ForbiddenException if riskDecision is not APPROVED — ALWAYS.
   * @throws ForbiddenException if the approval carries no server-issued
   *         RiskGrant (grantId) — a caller-constructed approval object can
   *         NEVER satisfy the final dispatch boundary (fail-closed).
   */
  async executeTrade(
    userId: string,
    riskDecision: RiskDecision,
    preAuthorization?: FinalDispatchAuthorization,
  ): Promise<Trade> {
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

    // ── Step 1b: FINAL DISPATCH BOUNDARY (Round 5, task 50-c) ──────────────
    // The exact execution authority is bound to the SERVER-ISSUED RiskGrant
    // (sessionId + sessionGeneration + executionMode + the EXACT
    // brokerConnectionId — never re-discovered). The boundary re-reads every
    // authority fact from CURRENT durable state and consumes the grant
    // atomically: exactly ONE winner proceeds to any provider call, and any
    // late-arriving change (session ended, mode changed, connection
    // suspended, credential rotation, kill switch, LIVE-verification
    // downgrade, grant consumed by a replica) yields ZERO provider calls
    // with a typed blocked reason.
    let authorization: FinalDispatchAuthorization;
    if (preAuthorization) {
      // Server-produced pre-authorization (the SEMI_AUTO user-confirmation
      // endpoint consumed the confirmation + grant through the SAME
      // boundary). It must match THIS decision — a mismatched pairing is
      // fail-closed, never a substitution.
      if (
        preAuthorization.context.riskGrantId !== riskDecision.grantId ||
        preAuthorization.context.userId !== userId
      ) {
        throw new ForbiddenException(
          'Pre-authorization does not match this risk decision — refusing dispatch (fail-closed).',
        );
      }
      authorization = preAuthorization;
    } else {
      const grantId = riskDecision.grantId;
      if (!grantId) {
        this.logger.warn(
          `executeTrade() blocked APPROVED decision without a RiskGrant for user ${userId} ` +
            `(signal ${signalId}) — fail-closed`,
        );
        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.EXECUTION_AUTHORITY_BLOCKED,
          resourceType: 'RiskGrant',
          resourceId: 'not-issued',
          severity: AuditSeverity.WARNING,
          metadata: {
            blockedReason: 'GRANT_REQUIRED',
            signalId,
            message:
              'Risk approval carried no grantId — a server-issued RiskGrant is required for dispatch.',
          },
        });
        throw new ForbiddenException(
          'Risk approval carried no server-issued grant — execution requires a durable RiskGrant.',
        );
      }
      authorization = await this.finalDispatchBoundary.authorizeNewExposureDispatch({
        userId,
        grantId,
        operationClass: ProviderOperationClass.NEW_EXPOSURE,
      });
    }

    // The connection is the EXACT one the boundary re-verified (the same id
    // the grant binds — never discovered another way, never re-discovered
    // here: the authority context is the single source downstream).
    const connection = authorization.connection;

    // ── Step 3: Pre-dispatch gates (fail-closed; BEFORE the trade-slot
    // reservation so blocked attempts never persist a PENDING trade).
    // Defense in depth against TOCTOU between risk approval and dispatch:
    // an emergency control activated in that window blocks here (the boundary
    // already checked the CURRENT control state — this is the SAME-store
    // defense-in-depth gate).
    await this.orchestrator.assertDispatchable({
      userId,
      connection,
      operationClass: ProviderOperationClass.NEW_EXPOSURE,
    });

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
        sessionId: authorization.context.sessionId,
        sessionGeneration: authorization.context.sessionGeneration,
        executionMode: authorization.context.executionMode,
        brokerConnectionId: authorization.context.brokerConnectionId,
        riskGrantId: authorization.context.riskGrantId,
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

      // Issue #315: CAS transition — a concurrent winner (e.g. the
      // reconciliation path) is never overwritten; newer terminal truth is
      // preserved. The certainty of an orchestration-level failure is
      // conservatively uncertain: the provider call MAY have been attempted
      // (the capacity reservation is RETAINED — issue #314).
      const outcome = await this.tradeCas.applyCasTransition({
        tradeId: trade.id,
        expectedFrom: TradeStatus.PENDING,
        target: TradeStatus.RECONCILIATION_PENDING,
        patch: {
          status: TradeStatus.RECONCILIATION_PENDING,
          brokerRejectionReason: `Execution error: ${(err as Error).message}`,
          dispatchCertainty: ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
        },
        context: {
          userId,
          source: 'executeTrade:orchestration-error',
          reason: (err as Error).message,
        },
      });
      trade.status = outcome.trade?.status ?? TradeStatus.RECONCILIATION_PENDING;

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.TRADE_SUBMITTED,
        resourceType: 'Trade',
        resourceId: trade.id,
        metadata: {
          error: (err as Error).message,
          status: 'RECONCILIATION_PENDING',
          casOutcome: outcome.outcome,
          dispatchCertainty: ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
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
        reason: (err as Error).message,
      });

      return trade;
    }

    // ── Step 6: Map the dispatch outcome onto the position aggregate ───────
    // Issue #315: EVERY provider-bound trade transition below is a
    // compare-and-swap (expected status + affected-rows check). A 0-affected
    // outcome reloads the AUTHORITATIVE row: newer terminal truth is
    // PRESERVED (never regressed), an already-reached target is idempotent,
    // and an illegal convergence records a discrepancy.
    switch (dispatch.outcome) {
      case 'FILLED': {
        // Provider executed the order — the position is OPEN.
        const outcome = await this.tradeCas.applyCasTransition({
          tradeId: trade.id,
          expectedFrom: TradeStatus.PENDING,
          target: TradeStatus.OPEN,
          patch: {
            status: TradeStatus.OPEN,
            externalOrderId: dispatch.providerOrderId,
            fillPrice: dispatch.avgFillPrice,
            openedAt: new Date(),
          },
          context: {
            userId,
            source: 'executeTrade:FILLED',
            reason: `order ${dispatch.orderId} FILLED`,
          },
        });
        Object.assign(trade, outcome.trade ?? {});

        if (outcome.outcome === 'APPLIED' || outcome.outcome === 'ALREADY_AT_TARGET') {
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
              casOutcome: outcome.outcome,
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
        } else {
          // PRESERVED_NEWER_TRUTH / STATE_CONFLICT: the authoritative trade
          // state already advanced past OPEN (e.g. reconciliation proved it
          // CLOSED) — the late FILLED mapping must not regress it.
          this.logger.warn(
            `Trade ${trade.id} FILLED mapping deferred to authoritative state ` +
              `(${outcome.outcome}, status ${outcome.trade?.status ?? 'UNKNOWN'}) — never regressed`,
          );
        }
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
        const outcome = await this.tradeCas.applyCasTransition({
          tradeId: trade.id,
          expectedFrom: TradeStatus.PENDING,
          target: TradeStatus.REJECTED,
          patch: {
            status: TradeStatus.REJECTED,
            brokerRejectionReason: dispatch.reason,
          },
          context: {
            userId,
            source: 'executeTrade:REJECTED',
            reason: dispatch.reason,
          },
        });
        Object.assign(trade, outcome.trade ?? {});

        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.TRADE_REJECTED,
          resourceType: 'Trade',
          resourceId: trade.id,
          metadata: {
            brokerMessage: dispatch.reason,
            signalId,
            orderId: dispatch.orderId,
            casOutcome: outcome.outcome,
          },
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
        // Issue #314: the round-4 write-certainty of the uncertain dispatch
        // is PERSISTED on the trade so uncertain-exposure accounting retains
        // the capacity reservation (MAY_HAVE_REACHED_PROVIDER) or releases it
        // once (DEFINITELY_NOT_SENT). A DUPLICATE outcome is conservatively
        // uncertain (the pre-existing order's provider state is unknown).
        const certainty =
          dispatch.outcome === 'UNKNOWN'
            ? dispatch.certainty
            : ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER;
        const outcome = await this.tradeCas.applyCasTransition({
          tradeId: trade.id,
          expectedFrom: TradeStatus.PENDING,
          target: TradeStatus.RECONCILIATION_PENDING,
          patch: {
            status: TradeStatus.RECONCILIATION_PENDING,
            brokerRejectionReason: `Execution error: ${reason}`,
            dispatchCertainty: certainty,
          },
          context: {
            userId,
            source: `executeTrade:${dispatch.outcome}`,
            reason,
          },
        });
        Object.assign(trade, outcome.trade ?? {});

        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.TRADE_SUBMITTED,
          resourceType: 'Trade',
          resourceId: trade.id,
          metadata: {
            error: reason,
            status: 'RECONCILIATION_PENDING',
            orderId: dispatch.orderId,
            casOutcome: outcome.outcome,
            dispatchCertainty: certainty,
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
    // Round 5 (#303): the close is a CLOSE_POSITION operation — the control
    // plane does NOT block it while an emergency control is active (risk-
    // reducing operations remain available); the authorization/credential
    // gates still apply (the provider must be reachable with valid creds).
    await this.orchestrator.assertDispatchable({
      userId,
      connection,
      operationClass: ProviderOperationClass.CLOSE_POSITION,
    });

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
      // Issue #315: CAS OPEN → CLOSED — a concurrent reconciliation close is
      // never double-applied; a reload already showing CLOSED is idempotent.
      const outcome = await this.tradeCas.applyCasTransition({
        tradeId: trade.id,
        expectedFrom: TradeStatus.OPEN,
        target: TradeStatus.CLOSED,
        patch: {
          status: TradeStatus.CLOSED,
          exitPrice: dispatch.avgFillPrice,
          closedAt: new Date(),
          closeReason: reason,
        },
        context: {
          userId,
          source: 'closeTrade:FILLED',
          reason: `close order ${dispatch.orderId} FILLED`,
        },
      });
      Object.assign(trade, outcome.trade ?? {});

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
          casOutcome: outcome.outcome,
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
    // Issue #314: an AMBIGUOUS CLOSE keeps the underlying exposure — the
    // trade's uncertain-exposure classification retains the capacity
    // reservation until closure is PROVEN (terminal CLOSED / reconciliation).
    const closeCertainty =
      dispatch.outcome === 'UNKNOWN'
        ? dispatch.certainty
        : ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER;
    const outcome = await this.tradeCas.applyCasTransition({
      tradeId: trade.id,
      expectedFrom: TradeStatus.OPEN,
      target: TradeStatus.RECONCILIATION_PENDING,
      patch: {
        status: TradeStatus.RECONCILIATION_PENDING,
        brokerRejectionReason: `Close outcome unresolved: ${reasonText}`,
        dispatchCertainty: closeCertainty,
      },
      context: {
        userId,
        source: `closeTrade:${dispatch.outcome}`,
        reason: reasonText,
      },
    });
    Object.assign(trade, outcome.trade ?? {});

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.TRADE_SUBMITTED,
      resourceType: 'Trade',
      resourceId: trade.id,
      metadata: {
        error: `Close outcome unresolved: ${reasonText}`,
        status: 'RECONCILIATION_PENDING',
        closeOrderId: dispatch.orderId,
        casOutcome: outcome.outcome,
        dispatchCertainty: closeCertainty,
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

  /**
   * Count of currently OPEN-LIKE trades for a user. Used for Risk Engine
   * Step 4a (max concurrent positions).
   *
   * UNCERTAIN-EXPOSURE ACCOUNTING (Round 5, issue #314): a trade left
   * RECONCILIATION_PENDING by an ambiguous PLACE **RETAINS its NEW-exposure
   * capacity reservation** when its dispatch MAY have reached the provider
   * (dispatchCertainty = MAY_HAVE_REACHED_PROVIDER) — or when the certainty
   * is unknown (NULL — legacy rows, conservatively uncertain). A
   * DEFINITELY_NOT_SENT dispatch (provably never left iRexPro) or a
   * reconciliation-proved non-execution (terminal REJECTED/CANCELLED)
   **releases** the reservation once — never counted here. An AMBIGUOUS CLOSE
   * keeps the same uncertain classification, so the underlying exposure is
   * NOT released until closure is proven (terminal CLOSED).
   */
  async countOpenTrades(userId: string): Promise<number> {
    return this.tradeRepo
      .createQueryBuilder('trade')
      .where('trade.userId = :userId', { userId })
      .andWhere(
        new Brackets((qb) =>
          qb.where('trade.status = :open', { open: TradeStatus.OPEN }).orWhere(
            new Brackets((qb2) =>
              qb2
                .where('trade.status = :rp', { rp: TradeStatus.RECONCILIATION_PENDING })
                // NULL certainty (legacy rows) is conservatively uncertain:
                // COALESCE to the uncertain classification — fail closed.
                .andWhere('COALESCE(trade.dispatchCertainty, :uncertain) <> :released', {
                  uncertain: ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
                  released: ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
                }),
            ),
          ),
        ),
      )
      .getCount();
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
   * Round 5 (issue #314): RECONCILIATION_PENDING trades whose dispatch MAY
   * have reached the provider (or NULL — conservatively uncertain) count as
   * today's executed capacity: the reservation is retained until the provider
   * truth is proven. DEFINITELY_NOT_SENT ambiguous placements are excluded
   * (released once).
   *
   * The trading-day boundary is UTC midnight — consistent with the existing
   * getTodayRealisedLoss() day boundary.
   */
  async countTodayTrades(userId: string): Promise<number> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    return this.tradeRepo
      .createQueryBuilder('trade')
      .where('trade.userId = :userId', { userId })
      .andWhere(
        new Brackets((qb) =>
          qb
            .where(
              new Brackets((qb2) =>
                qb2
                  .where('trade.openedAt >= :today', { today: todayStart })
                  .andWhere('trade.status IN (:...openOrClosed)', {
                    openOrClosed: [TradeStatus.OPEN, TradeStatus.CLOSED],
                  }),
              ),
            )
            .orWhere(
              new Brackets((qb2) =>
                qb2
                  .where('trade.status = :pending', { pending: TradeStatus.PENDING })
                  .andWhere('trade.createdAt >= :today', { today: todayStart }),
              ),
            )
            .orWhere(
              new Brackets((qb2) =>
                qb2
                  .where('trade.status = :rp', { rp: TradeStatus.RECONCILIATION_PENDING })
                  .andWhere('COALESCE(trade.dispatchCertainty, :uncertain) <> :released', {
                    uncertain: ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
                    released: ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
                  })
                  .andWhere('(trade.createdAt >= :today OR trade.openedAt >= :today)', {
                    today: todayStart,
                  }),
              ),
            ),
        ),
      )
      .getCount();
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
      //    Round 5 (issue #314) uncertain-exposure accounting: a trade left
      //    RECONCILIATION_PENDING by a dispatch that MAY have reached the
      //    provider (or NULL — legacy, conservatively uncertain) RETAINS its
      //    daily capacity reservation; DEFINITELY_NOT_SENT is released once.
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
             OR
             (
               (created_at >= $2 OR opened_at >= $2)
               AND status = 'RECONCILIATION_PENDING'
               AND COALESCE(dispatch_certainty, 'MAY_HAVE_REACHED_PROVIDER') <> 'DEFINITELY_NOT_SENT'
             )
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

  // ─── Session management (Round 5 — session is the authoritative target) ───

  /**
   * Start (or idempotently return) the user's ACTIVE TradingSession bound to
   * the EXACT requested broker connection (architect issue #295).
   *
   * Round 5 invariants enforced here (single writer for session rows):
   *   1. The EXACT connection is resolved by id and must be OWNED by the user
   *      (typed rejection otherwise). NEVER findActiveConnectionForUser.
   *   2. The connection must be CONNECTED and LIVE-authorization-executable
   *      (brokerService.isConnectionExecutable — fail-closed state machine).
   *   3. Same ACTIVE session + same connection + same mode → return existing.
   *   4. ACTIVE session on ANOTHER connection (or another mode) → typed domain
   *      conflict — switching accounts requires an explicit audited end+start.
   *   5. Creation is protected by the DB partial unique index
   *      uq_trading_sessions_one_active_per_user: a unique-violation on INSERT
   *      re-reads the winner (not find-then-insert alone).
   *   6. executionMode (default PAPER_ONLY) + authorityGeneration: 1 persist.
   */
  async startSession(
    userId: string,
    brokerConnectionId: string,
    openingBalance: string,
    riskProfileSnapshot?: Record<string, unknown> | null,
    executionMode: ExecutionMode = ExecutionMode.PAPER_ONLY,
  ): Promise<TradingSession> {
    // ── 1+2: exact-connection ownership + eligibility ─────────────────────
    const [connection] = await this.brokerService.findConnectionsByIds([brokerConnectionId]);
    if (!connection) {
      throw new NotFoundException('Broker connection not found');
    }
    if (connection.userId !== userId) {
      throw new BrokerConnectionOwnershipException();
    }
    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw new BrokerConnectionNotConnectedException(connection.status);
    }
    if (!this.brokerService.isConnectionExecutable(connection)) {
      throw new BrokerConnectionNotExecutableException(connection.authorizationStatus);
    }

    // ── 3+4: idempotency / typed conflict against an existing ACTIVE session ─
    const existing = await this.findActiveSessionOrdered(userId);
    if (existing) {
      this.assertStartMatchesExistingAuthority(existing, brokerConnectionId, executionMode);
      return existing;
    }

    // ── 5+6: create, protected by the partial unique (one ACTIVE per user) ──
    // A plain INSERT (no transaction) so the DB partial unique index is the
    // arbiter under concurrency: a unique-violation re-reads the winner.
    const sessionId = crypto.randomUUID();
    const sessionEntity = this.sessionRepo.create({
      id: sessionId,
      userId,
      brokerConnectionId,
      executionMode,
      authorityGeneration: 1,
      status: TradingSessionStatus.ACTIVE,
      openingBalance,
      peakEquity: openingBalance,
      startedAt: new Date(),
      // Sprint 32: snapshot the risk profile at session start so future
      // edits don't rewrite history. The snapshot is a deterministic JSON
      // object of risk-relevant fields (no credentials/secrets/PII).
      riskProfileSnapshot: riskProfileSnapshot ?? null,
    });
    try {
      await this.sessionRepo.insert(sessionEntity as QueryDeepPartialEntity<TradingSession>);
      const created = await this.sessionRepo.findOne({ where: { id: sessionId } });
      if (!created) {
        throw new Error(`Trading session ${sessionId} vanished right after insertion`);
      }
      return created;
    } catch (err) {
      if (this.isUniqueConstraintViolation(err)) {
        // A concurrent start won the partial-unique race — re-read the winner
        // (bounded retry: the winner's commit can trail the violation by a
        // few milliseconds on some drivers) and apply the same
        // idempotency/conflict decision against it.
        const winner = await this.findActiveSessionOrderedWithRetry(userId);
        if (winner) {
          this.assertStartMatchesExistingAuthority(winner, brokerConnectionId, executionMode);
          return winner;
        }
      }
      throw err;
    }
  }

  /**
   * Explicit + audited execution-mode change (architect issue #298).
   *
   * CAS bump: authority_generation = authority_generation + 1 guarded by
   * (id, status='ACTIVE', authority_generation = observed). Zero affected
   * rows → reload + typed conflict (never a blind retry). Outstanding ACTIVE
   * RiskGrants bound to the observed generation are INVALIDATED (reason
   * SESSION_AUTHORITY_GENERATION_CHANGED — never revived when switching back);
   * PENDING SEMI_AUTO confirmations are REVOKED. New risk evaluation is
   * required for any further NEW exposure.
   */
  async changeExecutionMode(
    userId: string,
    sessionId: string,
    newMode: ExecutionMode,
  ): Promise<TradingSession> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId, userId } });
    if (!session) {
      throw new NotFoundException(`Trading session ${sessionId} not found`);
    }
    if (session.status !== TradingSessionStatus.ACTIVE) {
      throw new SessionAuthorityNotActiveException(userId);
    }

    const observed = session.authorityGeneration;
    const bump = await this.sessionRepo
      .createQueryBuilder()
      .update()
      .set({
        executionMode: newMode,
        authorityGeneration: () => 'authority_generation + 1',
        updatedAt: new Date(),
      })
      .where(
        'id = :id AND user_id = :userId AND status = :status AND authority_generation = :observed',
        {
          id: sessionId,
          userId,
          status: TradingSessionStatus.ACTIVE,
          observed,
        },
      )
      .execute();
    if (!bump.affected) {
      const current = await this.sessionRepo.findOne({ where: { id: sessionId, userId } });
      throw new SessionAuthorityGenerationConflictException({
        sessionId,
        observedGeneration: observed,
        currentGeneration: current?.authorityGeneration ?? null,
        currentExecutionMode: current?.executionMode ?? null,
        currentStatus: current?.status ?? null,
      });
    }

    // Invalidate outstanding authority bound to the observed generation
    // (CAS: only rows still ACTIVE/PENDING with that generation).
    const invalidated = await this.invalidateOutstandingAuthority(
      sessionId,
      observed,
      SESSION_AUTHORITY_GENERATION_CHANGED,
    );

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.TRADING_SESSION_MODE_CHANGED,
      severity: AuditSeverity.WARNING,
      resourceType: 'TradingSession',
      resourceId: sessionId,
      metadata: {
        previousExecutionMode: session.executionMode,
        newExecutionMode: newMode,
        previousAuthorityGeneration: observed,
        newAuthorityGeneration: observed + 1,
        invalidationReason: SESSION_AUTHORITY_GENERATION_CHANGED,
        invalidatedRiskGrants: invalidated.invalidatedGrants,
        revokedExecutionConfirmations: invalidated.revokedConfirmations,
      },
    });

    const reloaded = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!reloaded) {
      throw new NotFoundException(`Trading session ${sessionId} not found after mode change`);
    }
    return reloaded;
  }

  /**
   * End (or suspend) the user's ACTIVE session. The status transition is a
   * CAS on (id, status='ACTIVE', authority_generation = observed) and bumps
   * the generation; outstanding ACTIVE RiskGrants / PENDING confirmations for
   * the session are invalidated/revoked in the same CAS style (issue #298).
   */
  async endSession(userId: string, status = TradingSessionStatus.ENDED): Promise<void> {
    const session = await this.findActiveSessionOrdered(userId);
    if (!session) {
      // Idempotent no-op — no ACTIVE session to end (legacy behavior).
      return;
    }

    const observed = session.authorityGeneration;
    const ended = await this.sessionRepo
      .createQueryBuilder()
      .update()
      .set({
        status,
        endedAt: new Date(),
        authorityGeneration: () => 'authority_generation + 1',
        updatedAt: new Date(),
      })
      .where(
        'id = :id AND user_id = :userId AND status = :active AND authority_generation = :observed',
        {
          id: session.id,
          userId,
          active: TradingSessionStatus.ACTIVE,
          observed,
        },
      )
      .execute();
    if (!ended.affected) {
      // Lost the race to another end/suspend/mode-change — the winner owns
      // the outstanding-authority invalidation. Idempotent return.
      return;
    }

    await this.invalidateOutstandingAuthority(
      session.id,
      observed,
      SESSION_AUTHORITY_GENERATION_CHANGED,
    );
  }

  async getActiveSession(userId: string): Promise<TradingSession | null> {
    return this.findActiveSessionOrdered(userId);
  }

  async findSessionById(sessionId: string): Promise<TradingSession | null> {
    return this.sessionRepo.findOne({ where: { id: sessionId } });
  }

  // ─── Internal helpers (session authority) ───────────────────────────────

  /**
   * The user's ACTIVE session ordered by authorityGeneration/startedAt desc
   * (single row) — deterministic even for legacy multi-ACTIVE data.
   */
  private async findActiveSessionOrdered(userId: string): Promise<TradingSession | null> {
    return this.sessionRepo.findOne({
      where: { userId, status: TradingSessionStatus.ACTIVE },
      order: { authorityGeneration: 'DESC', startedAt: 'DESC' },
    });
  }

  /**
   * Bounded re-read of the ACTIVE session after a unique-violation on INSERT:
   * the winning concurrent start can commit a few milliseconds after the
   * loser's violation surfaces on some drivers.
   */
  private async findActiveSessionOrderedWithRetry(
    userId: string,
    attempts = 3,
    delayMs = 10,
  ): Promise<TradingSession | null> {
    let session = await this.findActiveSessionOrdered(userId);
    for (let attempt = 1; attempt < attempts && !session; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      session = await this.findActiveSessionOrdered(userId);
    }
    return session;
  }

  /**
   * A start request must match the existing ACTIVE session's exact execution
   * target (connection + mode); anything else is a typed domain conflict —
   * never a silent substitution.
   */
  private assertStartMatchesExistingAuthority(
    existing: TradingSession,
    requestedConnectionId: string,
    requestedMode: ExecutionMode,
  ): void {
    if (
      existing.brokerConnectionId !== requestedConnectionId ||
      existing.executionMode !== requestedMode
    ) {
      throw new ActiveSessionConflictException({
        existingSessionId: existing.id,
        existingBrokerConnectionId: existing.brokerConnectionId,
        existingExecutionMode: existing.executionMode,
        requestedBrokerConnectionId: requestedConnectionId,
        requestedExecutionMode: requestedMode,
      });
    }
  }

  /**
   * Invalidate outstanding authority bound to a session generation (CAS):
   * ACTIVE RiskGrants → INVALIDATED with the given reason; PENDING
   * ExecutionConfirmations → REVOKED. Grants are NEVER revived — a new risk
   * evaluation is always required after an authority change.
   */
  private async invalidateOutstandingAuthority(
    sessionId: string,
    observedGeneration: number,
    reason: string,
  ): Promise<{ invalidatedGrants: number; revokedConfirmations: number }> {
    const grants = await this.riskGrantRepo
      .createQueryBuilder()
      .update()
      .set({
        status: RiskGrantStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: reason,
      })
      .where('session_id = :sessionId AND status = :active AND session_generation = :observed', {
        sessionId,
        active: RiskGrantStatus.ACTIVE,
        observed: observedGeneration,
      })
      .execute();

    const confirmations = await this.confirmationRepo
      .createQueryBuilder()
      .update()
      .set({
        status: ExecutionConfirmationStatus.REVOKED,
        revokedAt: new Date(),
      })
      .where('session_id = :sessionId AND status = :pending AND session_generation = :observed', {
        sessionId,
        pending: ExecutionConfirmationStatus.PENDING,
        observed: observedGeneration,
      })
      .execute();

    return {
      invalidatedGrants: grants.affected ?? 0,
      revokedConfirmations: confirmations.affected ?? 0,
    };
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
    // sqlite (test harness): SQLITE_CONSTRAINT unique violations.
    if (code === 'SQLITE_CONSTRAINT') return true;
    // Fallback: check the message for the SQLSTATE or the constraint text
    // (PostgreSQL 'duplicate key value' / SQLite 'UNIQUE constraint failed').
    const msg = err.message ?? '';
    return (
      msg.includes('23505') ||
      msg.includes('duplicate key value') ||
      msg.includes('UNIQUE constraint failed')
    );
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
