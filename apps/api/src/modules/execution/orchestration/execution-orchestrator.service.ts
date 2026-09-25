import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../../broker/services/credential-encryption.service';
import { BrokerCredentialLifecycle } from '../../broker/authorization/broker-credential-status';
import {
  BrokerMode,
  BrokerOrderRequest,
  BrokerOrderResult,
} from '../../broker/interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../../broker/interfaces/broker-adapter.errors';
import { ProviderDispatchCertainty } from '../../broker/interfaces/provider-dispatch-certainty';
import { ExecutionControlService } from '../../execution-control/execution-control.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { DomainEventBus } from '../../events/event-bus.service';
import { DomainEventType } from '../../events/enums/domain-event-type.enum';
import { OrderEventPayload } from '../../events/interfaces/domain-event.interface';
import { Order } from '../orders/order.entity';
import { OrderService } from '../orders/order.service';
import { OrderStatus } from '../orders/order.enums';
import { ExecutionIntent, ProviderDispatchOutcome } from './execution-intent.interface';
import { MarketSafetyGateService } from './market-safety-gate.service';
// Round 6 live-execution completion (§14): the per-account dispatch lease.
import { AccountDispatchLeaseService } from './account-dispatch-lease.service';
// Round 6 live-execution completion (§7): the order capability contract.
import {
  assertOrderWithinCapabilities,
  OrderCapabilityError,
} from '../../broker/interfaces/order-capability';
import { FinalDispatchBoundary, FinalDispatchBlockedException } from './final-dispatch-boundary';
// Round 7 (P1 metrics — audit R7-audit-C A6): dependency-free in-process
// counters (lazy ModuleRef seam — see the metrics getter below).
import { MetricsService } from '../../metrics/metrics.service';
import { METRIC_NAMES } from '../../metrics/metric-names';
import { mapProviderOrderResponse } from './provider-response.mapper';
import { classifyIntentOperation, isExposureIncreasingOperation } from './provider-operation-class';
import { ProviderOperationClass } from '../interfaces/execution-authority';

const EXECUTION_TIMEOUT_MS = 10_000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

/** Secret-like token runs (same heuristic as the admin live-ops sanitizer). */
const SECRET_LIKE_RUN = /[A-Za-z0-9]{16,}/g;
const PROVIDER_REASON_MAX_LENGTH = 500;

/**
 * Redact secret-like material from provider messages BEFORE they enter
 * order reject reasons, audit metadata, or realtime event payloads
 * (architect review Phase D: no credential material or secret-bearing
 * provider errors in logs/audits/events).
 */
function sanitizeProviderReason(reason: string | null | undefined): string {
  const bounded = (reason ?? 'Unknown provider reason').slice(0, PROVIDER_REASON_MAX_LENGTH);
  return bounded.replace(SECRET_LIKE_RUN, '[redacted]');
}

/**
 * ExecutionOrchestrator — Directive PHASE D "execution foundation".
 *
 * Owns the provider-dispatch slice of the execution pipeline:
 *
 *   1. VALIDATION PIPELINE (assertDispatchable) — fail-closed pre-dispatch
 *      gates, defense-in-depth against TOCTOU between risk approval and
 *      dispatch:
 *        a. Emergency control plane (GLOBAL → PROVIDER → USER → CONNECTION)
 *        b. LIVE authorization state machine (only ACTIVE is executable)
 *   2. IDEMPOTENCY (dispatchOrder) — every dispatch is preceded by an
 *      idempotent order reservation (OrderService.submitOrder). A duplicate
 *      clientOrderId NEVER re-dispatches to the provider.
 *   3. PROVIDER DISPATCH — retry/timeout-wrapped adapter call with
 *      credentials zeroed from memory immediately after connect.
 *   4. RESPONSE HANDLING — the pure mapProviderOrderResponse() decides the
 *      order-domain action (ack / fill / reject / reconcile).
 *   5. STATE TRANSITIONS — every order mutation passes through
 *      OrderStateMachine-guarded OrderService methods; order.* events and
 *      ORDER_* audit entries are emitted at each transition.
 *
 * The Risk Engine APPROVED gate lives UPSTREAM (ExecutionService.executeTrade)
 * and is never bypassed: dispatchOrder is only reachable with an approved,
 * reserved trade slot.
 *
 * See: docs/orders/order-domain.md, docs/architecture/12-execution-engine-architecture.md
 */
@Injectable()
export class ExecutionOrchestrator {
  private readonly logger = new Logger(ExecutionOrchestrator.name);

  constructor(
    private readonly orderService: OrderService,
    private readonly brokerService: BrokerService,
    private readonly executionControlService: ExecutionControlService,
    private readonly adapterRegistry: BrokerAdapterRegistry,
    private readonly encryptionService: CredentialEncryptionService,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
    // Round 6 (#365): the provider-dispatch commitment boundary — invoked
    // INSIDE dispatchOrder immediately before the provider state-changing
    // call, with NOTHING awaited in between.
    private readonly finalDispatchBoundary: FinalDispatchBoundary,
    // Round 6 live-execution completion (§5/§18): the final market-safety
    // gate — proven fresh quote + spread sanity + entry deviation, BEFORE
    // the commitment (zero provider calls on failure).
    private readonly marketSafetyGate: MarketSafetyGateService,
    // Round 6 live-execution completion (§14): the per-account dispatch
    // lease — the FULL dispatch critical section (reservation → gates →
    // commitment → provider call → outcome) runs strictly serialized per
    // broker account, in-process (entries, §10 exits, confirmations).
    private readonly accountDispatchLease: AccountDispatchLeaseService,
    /** Round 7 (P1 metrics): lazy MetricsService seam (never a constructor
     * injection — see the metrics getter for the DI decision). */
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Round 7 (P1 metrics — audit R7-audit-C A6): lazy metrics seam. Resolved
   * at CALL time via ModuleRef.get(..., { strict: false }) — the app-wide
   * lookup finds the MetricsModule singleton (registered once in AppModule).
   * Direct constructor injection was rejected: it would demand a
   * MetricsService provider in EVERY spec constructing this orchestrator
   * (incl. out-of-scope suites) plus module-file imports outside the approved
   * file scope. In isolated test contexts the lookup fails → null → the
   * `this.metrics?.increment(...)` call sites no-op. Never affects control
   * flow (MetricsService methods never throw).
   */
  private get metrics(): MetricsService | null {
    try {
      return this.moduleRef.get(MetricsService, { strict: false });
    } catch {
      return null;
    }
  }

  // ─── 1. Validation pipeline (fail-closed) ───────────────────────────────

  /**
   * Assert that a dispatch is permitted for this user + connection.
   * Throws ForbiddenException when any gate blocks — BEFORE any order is
   * persisted or any provider is contacted.
   *
   * Gate A — emergency control plane (OPERATION-AWARE, round 5 issue #303):
   * matches the Risk Engine's step 1a-pre check, closing the TOCTOU window
   * between risk approval and dispatch. The gate blocks EXPOSURE-INCREASING
   * operations (NEW_EXPOSURE / INCREASE_EXPOSURE / RISK_INCREASING_MODIFY)
   * while a kill-switch / emergency-stop control is active, while
   * CLOSE_POSITION / CANCEL_PENDING / RECONCILE_READ / risk-reducing
   * operations remain available (an active emergency must never prevent the
   * platform from REDUCING exposure or reading provider truth).
   * Gate B — LIVE authorization: a LIVE connection must be ACTIVE in the
   * BrokerAuthorizationStateMachine (fail-closed via isConnectionExecutable).
   * DEMO/PAPER connections pass Gate B (mirrors RiskService step 1c).
   */
  async assertDispatchable(ctx: {
    userId: string;
    connection: BrokerConnection;
    /** Operation class of the dispatch (default NEW_EXPOSURE — fail-closed). */
    operationClass?: ProviderOperationClass;
  }): Promise<void> {
    const operationClass = ctx.operationClass ?? ProviderOperationClass.NEW_EXPOSURE;

    // ── Gate A: emergency control plane (fail-closed on store errors) ──────
    const permission = await this.executionControlService.checkExecutionPermission({
      userId: ctx.userId,
      brokerId: ctx.connection.brokerId,
      brokerConnectionId: ctx.connection.id,
    });
    if (!permission.allowed && isExposureIncreasingOperation(operationClass)) {
      const blocked = permission.blockedBy;
      this.logger.warn(
        `Dispatch blocked by execution control plane for user ${ctx.userId} ` +
          `(scope: ${blocked?.scope ?? 'UNKNOWN'}, reason: ${blocked?.reason ?? 'UNKNOWN'})`,
      );
      await this.auditService.log({
        actorUserId: ctx.userId,
        action: AuditAction.ORDER_REJECTED,
        resourceType: 'Order',
        resourceId: 'not-dispatched',
        metadata: {
          reason: 'EXECUTION_CONTROL_BLOCKED',
          controlScope: blocked?.scope ?? 'UNKNOWN',
          controlScopeKey: blocked?.scopeKey ?? null,
          brokerConnectionId: ctx.connection.id,
          operationClass,
        },
        severity: AuditSeverity.WARNING,
      });
      this.metrics?.increment(METRIC_NAMES.DISPATCH_BLOCKS, {
        gate: 'EXECUTION_CONTROL',
      });
      throw new ForbiddenException(
        `Execution blocked by platform control plane (${blocked?.scope ?? 'UNKNOWN'} scope).`,
      );
    }
    // ── Re-load the PERSISTED connection (architect correction, Phase D):
    // the caller's snapshot can be stale — a concurrent revoke/suspend
    // between the caller's load and this boundary must NOT be bypassed.
    // Fail-closed when the row is gone or the store is unreadable.
    let connection: BrokerConnection;
    try {
      connection = await this.brokerService.findConnectionById(ctx.connection.id, ctx.userId);
    } catch (err) {
      this.logger.warn(
        `Dispatch blocked: connection ${ctx.connection.id} could not be re-loaded ` +
          `for user ${ctx.userId} (${(err as Error).message}) — fail-closed`,
      );
      throw new ForbiddenException(
        'Broker connection is no longer available for dispatch (fail-closed).',
      );
    }

    // ── Gate B: LIVE authorization state machine (fail-closed, checked
    // against the PERSISTED state — not the caller's snapshot).
    // Round 7 (§10 — OPERATION-AWARE): the authorization-state requirement
    // binds EXPOSURE-INCREASING operations only. Risk-REDUCING dispatches
    // (CLOSE_POSITION / CANCEL_PENDING / RISK_REDUCING_MODIFY /
    // REDUCE_EXPOSURE / RECONCILE_READ) deliberately bypass this gate:
    // de-risking must remain possible exactly when the connection's
    // authorization has degraded (health suspension, admin suspension) —
    // previously a suspended connection could not even be flattened. The
    // credential gate (Gate C) still applies to every operation (the
    // provider requires valid credentials for ANY call); a genuinely
    // inaccessible provider/account surfaces as an honest typed dispatch
    // failure + reconciliation — never a silently skipped de-risking. ─────
    if (
      connection.accountType === BrokerMode.LIVE &&
      !this.brokerService.isConnectionExecutable(connection) &&
      isExposureIncreasingOperation(operationClass)
    ) {
      this.logger.warn(
        `Dispatch blocked: LIVE connection ${ctx.connection.id} is not executable ` +
          `(authorizationStatus: ${connection.authorizationStatus ?? 'UNKNOWN'})`,
      );
      await this.auditService.log({
        actorUserId: ctx.userId,
        action: AuditAction.ORDER_REJECTED,
        resourceType: 'Order',
        resourceId: 'not-dispatched',
        metadata: {
          reason: 'LIVE_AUTHORIZATION_REQUIRED',
          authorizationStatus: connection.authorizationStatus ?? 'UNKNOWN',
          brokerConnectionId: ctx.connection.id,
        },
        severity: AuditSeverity.WARNING,
      });
      this.metrics?.increment(METRIC_NAMES.DISPATCH_BLOCKS, {
        gate: 'LIVE_AUTHORIZATION',
      });
      throw new ForbiddenException(
        'Live account is not authorized for execution (authorization state is not ACTIVE).',
      );
    }

    // ── Gate C: credential lifecycle (architect correction A3 enforced at
    // the downstream boundary): persisted credentials may only be decrypted
    // when the lifecycle state is usable AND the ciphertext is present.
    // INVALID / EXPIRED / REVOKED / missing states never reach the provider. ─
    if (!BrokerCredentialLifecycle.isUsable(connection.credentialStatus)) {
      this.logger.warn(
        `Dispatch blocked: connection ${ctx.connection.id} credential status is ` +
          `${connection.credentialStatus ?? 'MISSING'} — refusing to decrypt (fail-closed)`,
      );
      await this.auditService.log({
        actorUserId: ctx.userId,
        action: AuditAction.ORDER_REJECTED,
        resourceType: 'Order',
        resourceId: 'not-dispatched',
        metadata: {
          reason: 'CREDENTIAL_LIFECYCLE_BLOCKED',
          credentialStatus: connection.credentialStatus ?? 'MISSING',
          brokerConnectionId: ctx.connection.id,
        },
        severity: AuditSeverity.WARNING,
      });
      this.metrics?.increment(METRIC_NAMES.DISPATCH_BLOCKS, {
        gate: 'CREDENTIAL_LIFECYCLE',
      });
      throw new ForbiddenException(
        'Broker credentials are not usable for execution (credential lifecycle is not active).',
      );
    }
    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      this.logger.warn(
        `Dispatch blocked: connection ${ctx.connection.id} has no stored credential ` +
          'ciphertext — refusing provider dispatch (fail-closed)',
      );
      throw new ForbiddenException('Broker connection credentials unavailable (fail-closed).');
    }
  }

  // ─── 2-5. Idempotent dispatch + response handling + transitions ─────────

  /**
   * Orchestrate ONE provider dispatch for the given intent:
   * reserve (idempotent) → submit → dispatch → map response → transition.
   *
   * Guarantees:
   * - exactly-once dispatch per clientOrderId (duplicates return DUPLICATE)
   * - every outcome is durably recorded on the order before returning
   * - UNKNOWN outcomes leave the order RECONCILIATION_PENDING (fail-closed)
   *
   * Round 6 §14: the FULL critical section runs under the per-account
   * dispatch lease — dispatches against one broker account are strictly
   * serialized in-process (an entry, a §10 exit, a SEMI_AUTO confirmation
   * dispatch, or a reconciliation repair can never interleave on the same
   * account). Different accounts proceed concurrently. The lease is the
   * in-process complement of the durable exactly-once surfaces
   * (advisory locks, clientOrderId idempotency, CAS transitions).
   */
  async dispatchOrder(
    intent: ExecutionIntent,
    connection: BrokerConnection,
    commitment?: {
      /** The RiskGrant authorizing this dispatch (consumed AT the commitment). */
      grantId: string;
      /** The SEMI_AUTO one-time confirmation driving this dispatch, if any. */
      confirmationId?: string | null;
      origin?: 'PIPELINE' | 'USER_CONFIRMATION';
    },
  ): Promise<ProviderDispatchOutcome> {
    return this.accountDispatchLease.withAccountDispatchLease(intent.brokerConnectionId, () =>
      this.dispatchOrderUnderLease(intent, connection, commitment),
    );
  }

  /** The dispatch critical section (§14: ALWAYS under the account lease). */
  private async dispatchOrderUnderLease(
    intent: ExecutionIntent,
    connection: BrokerConnection,
    commitment?: {
      grantId: string;
      confirmationId?: string | null;
      origin?: 'PIPELINE' | 'USER_CONFIRMATION';
    },
  ): Promise<ProviderDispatchOutcome> {
    // Round 5 (#303): the operation class of THIS provider-bound dispatch —
    // classified from the intent, audited on every submission, and used by
    // the operation-aware control gate.
    const operationClass = classifyIntentOperation(intent);

    // Round 7 (P1 metrics): every dispatch entering the critical section
    // (the outcome-specific counters below sub-classify how it resolved).
    this.metrics?.increment(METRIC_NAMES.DISPATCH_ATTEMPTS, { operationClass });

    // ── Idempotent reservation ────────────────────────────────────────────
    const submission = await this.orderService.submitOrder({
      userId: intent.userId,
      brokerConnectionId: intent.brokerConnectionId,
      clientOrderId: intent.clientOrderId,
      orderKind: intent.orderKind,
      timeInForce: intent.timeInForce,
      instrument: intent.instrument,
      direction: intent.direction,
      requestedQuantity: intent.requestedQuantity,
      requestedPrice: intent.requestedPrice ?? null,
      stopPrice: intent.stopPrice ?? null,
      signalId: intent.signalId ?? null,
      tradeId: intent.tradeId ?? null,
    });

    if (submission.status === 'DUPLICATE_EXISTING') {
      // Exactly-once dispatch guarantee: NEVER re-dispatch a duplicate.
      this.logger.warn(
        `Duplicate order submission suppressed (clientOrderId=${intent.clientOrderId}) — ` +
          `no provider dispatch for existing order ${submission.order.id}`,
      );
      await this.auditService.log({
        actorUserId: intent.userId,
        action: AuditAction.ORDER_DUPLICATE_SUPPRESSED,
        resourceType: 'Order',
        resourceId: submission.order.id,
        metadata: {
          clientOrderId: intent.clientOrderId,
          existingStatus: submission.order.status,
          tradeId: intent.tradeId ?? null,
          signalId: intent.signalId ?? null,
        },
        severity: AuditSeverity.WARNING,
      });
      this.metrics?.increment(METRIC_NAMES.DUPLICATE_SUPPRESSIONS);
      return { outcome: 'DUPLICATE', order: submission.order, orderId: submission.order.id };
    }

    let order = submission.order;

    // ── SUBMITTED: we are about to contact the provider ───────────────────
    order = await this.orderService.markSubmitted(order.id);
    await this.emitOrderEvent(DomainEventType.ORDER_SUBMITTED, intent, order, {
      status: OrderStatus.SUBMITTED,
    });
    await this.auditService.log({
      actorUserId: intent.userId,
      action: AuditAction.ORDER_SUBMITTED,
      resourceType: 'Order',
      resourceId: order.id,
      metadata: {
        clientOrderId: intent.clientOrderId,
        providerAction: intent.providerAction,
        operationClass,
        instrument: intent.instrument,
        direction: intent.direction,
        orderKind: intent.orderKind,
        timeInForce: intent.timeInForce,
        requestedQuantity: intent.requestedQuantity,
        tradeId: intent.tradeId ?? null,
        signalId: intent.signalId ?? null,
      },
    });

    // ── ROUND 6 live-execution completion (§7): the ORDER CAPABILITY
    // CONTRACT — enforced BEFORE the market-safety gate and BEFORE the
    // commitment: an intent the connection's adapter can NEVER fulfill
    // (unsupported order kind / missing required price) is a typed terminal
    // REJECTION with ZERO provider calls and NOTHING consumed. The check is
    // against the adapter's DECLARED capability matrix (in-memory registry
    // lookup — no provider I/O).
    if (intent.providerAction === 'PLACE') {
      try {
        const capabilityAdapter = this.adapterRegistry.getAdapterForConnection(
          connection.id,
          connection.brokerId,
        );
        assertOrderWithinCapabilities(
          {
            orderKind: intent.orderKind,
            limitPrice: intent.requestedPrice ?? undefined,
            stopPrice: intent.stopPrice ?? undefined,
          },
          capabilityAdapter.getOrderCapabilities(),
        );
      } catch (err) {
        if (err instanceof OrderCapabilityError) {
          this.logger.warn(
            `Order capability contract rejected order ${order.id} ` +
              `(${intent.instrument} ${intent.orderKind}): ${err.message}`,
          );
          await this.orderService
            .rejectOrder(order.id, `ORDER_CAPABILITY_${err.code}: ${err.message}`)
            .catch((rejectErr) =>
              this.logger.error(
                `Order ${order.id} could not be marked REJECTED after the capability ` +
                  `violation (${(rejectErr as Error).message}) — reconciliation will converge it`,
              ),
            );
          await this.auditService.log({
            actorUserId: intent.userId,
            action: AuditAction.ORDER_REJECTED,
            resourceType: 'Order',
            resourceId: order.id,
            severity: AuditSeverity.WARNING,
            metadata: {
              blockedReason: err.code,
              gate: 'ORDER_CAPABILITY',
              brokerId: err.brokerId,
              clientOrderId: intent.clientOrderId,
              instrument: intent.instrument,
              orderKind: intent.orderKind,
              tradeId: intent.tradeId ?? null,
              signalId: intent.signalId ?? null,
              message: err.message,
            },
          });
          this.metrics?.increment(METRIC_NAMES.DISPATCH_BLOCKS, {
            gate: 'ORDER_CAPABILITY',
          });
        }
        throw err;
      }
    }

    // ── ROUND 6 live-execution completion (§5/§18): the FINAL MARKET-SAFETY
    // GATE — runs between the SUBMITTED mark and the PROVIDER-DISPATCH
    // COMMITMENT. Scope: NEW-EXPOSURE PLACE intents only (risk-REDUCING
    // dispatches stay possible during market anomalies — §10/§17). A typed
    // failure terminally REJECTS the order with ZERO provider calls and
    // NOTHING consumed (no grant, no confirmation). The gate proves CURRENT
    // market facts (fresh quote, sane spread, bounded deviation from the
    // risk-validated reference) — when market state cannot be proven it
    // NEVER invents one (§18).
    if (
      operationClass === ProviderOperationClass.NEW_EXPOSURE &&
      intent.providerAction === 'PLACE'
    ) {
      await this.marketSafetyGate.assertMarketSafeForDispatch(intent, connection, order.id);
    }

    // ── ROUND 6 (#365): the PROVIDER-DISPATCH COMMITMENT ─────────────────
    // ONE short DB transaction re-verifying the CURRENT unified authority
    // chain (user TradingAuthorityGeneration, shared cross-replica revisions,
    // risk-profile revision, session, connection, credential generation) and
    // ATOMICALLY consuming the RiskGrant (+ the SEMI_AUTO confirmation)
    // while transitioning this order to DISPATCH_COMMITTED. NOTHING is
    // awaited between this commitment and the provider state-changing call
    // below — that gap is the honest boundary between zero-provider-calls
    // (any authority change before it blocks with ZERO provider calls) and
    // in-flight (resolved through ProviderDispatchCertainty + reconciliation,
    // never replayed).
    if (commitment?.grantId) {
      try {
        await this.finalDispatchBoundary.commitProviderDispatch({
          userId: intent.userId,
          grantId: commitment.grantId,
          confirmationId: commitment.confirmationId ?? null,
          orderId: order.id,
          origin: commitment.origin ?? 'PIPELINE',
        });
      } catch (err) {
        // Round 7 (P1 — commitment-block outcome separation): a
        // FinalDispatchBlockedException PROVES zero provider calls (the
        // boundary threw BEFORE dispatchToProvider with nothing consumed).
        // The reserved order must converge to a TERMINAL REJECTED state —
        // never be left SUBMITTED to be mistaken for an uncertain dispatch.
        // The typed exception still propagates so executeTrade can apply the
        // DEFINITELY_NOT_SENT trade outcome (CAS-protected, newer truth
        // preserved). Non-boundary errors propagate untouched.
        if (err instanceof FinalDispatchBlockedException) {
          const reason = `DISPATCH_BOUNDARY_${err.code}: ${err.message}`;
          await this.orderService
            .rejectOrder(order.id, reason)
            .catch((rejectErr) =>
              this.logger.error(
                `Order ${order.id} could not be marked REJECTED after the dispatch ` +
                  `boundary block [${err.code}] (${(rejectErr as Error).message}) — ` +
                  'reconciliation will converge it',
              ),
            );
          await this.emitOrderEvent(DomainEventType.ORDER_REJECTED, intent, order, {
            status: OrderStatus.REJECTED,
            reason: `${reason} [${err.code}]`,
          });
          await this.auditService.log({
            actorUserId: intent.userId,
            action: AuditAction.ORDER_REJECTED,
            resourceType: 'Order',
            resourceId: order.id,
            metadata: {
              clientOrderId: intent.clientOrderId,
              reason,
              blockedReason: err.code,
              orderStatus: OrderStatus.REJECTED,
              dispatchCertainty: ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
              gate: 'FINAL_DISPATCH_BOUNDARY',
            },
            severity: AuditSeverity.WARNING,
          });
          this.metrics?.increment(METRIC_NAMES.DISPATCH_BLOCKS, {
            gate: 'FINAL_DISPATCH_BOUNDARY',
          });
        }
        throw err;
      }
    }

    // ── Provider dispatch (retry/timeout-wrapped) ─────────────────────────
    try {
      const result = await this.dispatchToProvider(intent, connection);
      const action = mapProviderOrderResponse(result);

      switch (action.action) {
        case 'ACKNOWLEDGE_AND_FILL': {
          if (action.providerOrderId) {
            order = await this.orderService.markAcknowledged(order.id, action.providerOrderId);
            await this.emitAcknowledged(intent, order, action.providerOrderId);
          }
          const filled = await this.orderService.applyFill(order.id, {
            quantity: action.fillQuantity ?? intent.requestedQuantity,
            price: action.fillPrice,
            providerOrderId: action.providerOrderId ?? null,
          });
          await this.emitOrderEvent(DomainEventType.ORDER_FILLED, intent, filled, {
            status: filled.status,
            filledQuantity: filled.filledQuantity,
            avgFillPrice: filled.avgFillPrice ?? action.fillPrice,
          });
          await this.auditService.log({
            actorUserId: intent.userId,
            action: AuditAction.ORDER_FILLED,
            resourceType: 'Order',
            resourceId: filled.id,
            metadata: {
              clientOrderId: intent.clientOrderId,
              providerOrderId: filled.providerOrderId ?? null,
              filledQuantity: filled.filledQuantity,
              avgFillPrice: filled.avgFillPrice,
              orderStatus: filled.status,
            },
          });
          this.metrics?.increment(METRIC_NAMES.PROVIDER_ACKNOWLEDGEMENTS, {
            outcome: 'FILLED',
          });
          return {
            outcome: 'FILLED',
            order: filled,
            orderId: filled.id,
            providerOrderId: filled.providerOrderId ?? action.providerOrderId ?? '',
            filledQuantity: filled.filledQuantity,
            avgFillPrice: filled.avgFillPrice ?? action.fillPrice,
            realisedPnl: action.realisedPnl,
            commission: action.commission,
            swap: action.swap,
          };
        }

        case 'ACKNOWLEDGE': {
          order = await this.orderService.markAcknowledged(order.id, action.providerOrderId);
          await this.emitAcknowledged(intent, order, action.providerOrderId);
          this.metrics?.increment(METRIC_NAMES.PROVIDER_ACKNOWLEDGEMENTS, {
            outcome: 'WORKING',
          });
          return {
            outcome: 'WORKING',
            order,
            orderId: order.id,
            providerOrderId: action.providerOrderId,
          };
        }

        case 'REJECT': {
          // Provider messages are sanitized BEFORE persisting/ordering —
          // no secret-bearing material in reject reasons (Phase D).
          const sanitizedReason = sanitizeProviderReason(action.reason);
          order = await this.orderService.rejectOrder(order.id, sanitizedReason);
          await this.emitOrderEvent(DomainEventType.ORDER_REJECTED, intent, order, {
            status: OrderStatus.REJECTED,
            reason: sanitizedReason,
          });
          await this.auditService.log({
            actorUserId: intent.userId,
            action: AuditAction.ORDER_REJECTED,
            resourceType: 'Order',
            resourceId: order.id,
            metadata: {
              clientOrderId: intent.clientOrderId,
              reason: sanitizedReason,
              orderStatus: OrderStatus.REJECTED,
            },
            severity: AuditSeverity.WARNING,
          });
          this.metrics?.increment(METRIC_NAMES.PROVIDER_REJECTS);
          return { outcome: 'REJECTED', order, orderId: order.id, reason: sanitizedReason };
        }

        case 'RECONCILIATION_PENDING': {
          order = await this.orderService.markReconciliationPending(order.id);
          await this.emitOrderEvent(DomainEventType.ORDER_RECONCILIATION_PENDING, intent, order, {
            status: OrderStatus.RECONCILIATION_PENDING,
            reason: action.reason,
          });
          await this.auditService.log({
            actorUserId: intent.userId,
            action: AuditAction.ORDER_RECONCILIATION_PENDING,
            resourceType: 'Order',
            resourceId: order.id,
            metadata: {
              clientOrderId: intent.clientOrderId,
              reason: action.reason,
              dispatchCertainty: ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
              operationClass,
              orderStatus: OrderStatus.RECONCILIATION_PENDING,
            },
            severity: AuditSeverity.CRITICAL,
          });
          this.metrics?.increment(METRIC_NAMES.AMBIGUOUS_PROVIDER_OUTCOMES, {
            source: 'PROVIDER_RESPONSE',
          });
          return {
            outcome: 'UNKNOWN',
            order,
            orderId: order.id,
            reason: action.reason,
            // A provider-ANSWERED but malformed/ambiguous response cannot
            // prove non-execution — conservatively uncertain (#314).
            certainty: ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
          };
        }
      }
    } catch (err) {
      // ── UNKNOWN outcome: provider outcome cannot be determined ─────────
      // CORRECTION ROUND 4 (finding 7): an uncertain write is NOT failure and
      // is NOT permission to resend — it is an UNRESOLVED PROVIDER OUTCOME.
      // The certainty classification is persisted with the reason and
      // emitted in the sanitized audit/event evidence.
      const message = (err as Error).message ?? 'Unknown dispatch error';
      const certainty = this.certaintyOf(err);
      const reason = this.uncertaintyReason(message, certainty);
      this.logger.error(
        `Provider dispatch error for order ${order.id} (clientOrderId=${intent.clientOrderId}): ${message}`,
        (err as Error).stack,
      );
      try {
        order = await this.orderService.markReconciliationPending(order.id);
        await this.emitOrderEvent(DomainEventType.ORDER_RECONCILIATION_PENDING, intent, order, {
          status: OrderStatus.RECONCILIATION_PENDING,
          reason,
        });
        await this.auditService.log({
          actorUserId: intent.userId,
          action: AuditAction.ORDER_RECONCILIATION_PENDING,
          resourceType: 'Order',
          resourceId: order.id,
          metadata: {
            clientOrderId: intent.clientOrderId,
            reason,
            dispatchCertainty: certainty,
            operationClass,
            orderStatus: OrderStatus.RECONCILIATION_PENDING,
          },
          severity: AuditSeverity.CRITICAL,
        });
        this.metrics?.increment(METRIC_NAMES.AMBIGUOUS_PROVIDER_OUTCOMES, {
          source: 'DISPATCH_ERROR',
        });
      } catch (transitionErr) {
        // The order row may already have moved (e.g. a terminal state won in a
        // concurrent race) — the error is logged, never swallowed silently.
        this.logger.error(
          `Could not move order ${order.id} to RECONCILIATION_PENDING: ${(transitionErr as Error).message}`,
        );
      }
      return { outcome: 'UNKNOWN', order, orderId: order.id, reason, certainty };
    }
  }

  /** Sanitized certainty classification of a dispatch error (never UNKNOWN-certainty). */
  private certaintyOf(err: unknown): ProviderDispatchCertainty {
    if (err instanceof BrokerAdapterError && err.dispatchCertainty) {
      return err.dispatchCertainty;
    }
    // Unclassified — conservatively uncertain: the request MAY have reached
    // the provider (never auto-resent; reconciliation resolves it).
    return ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER;
  }

  /** Reconciliation reason carrying the certainty classification. */
  private uncertaintyReason(message: string, certainty: ProviderDispatchCertainty): string {
    const bounded = message.slice(0, PROVIDER_REASON_MAX_LENGTH);
    return `Dispatch error (${certainty}): ${sanitizeProviderReason(bounded)}`;
  }

  // ─── Provider dispatch mechanics ────────────────────────────────────────

  /**
   * Connect the provider adapter and perform the intent's provider action
   * with retry + timeout. Credentials are decrypted in-memory, used for the
   * connect handshake, and zeroed immediately afterwards.
   */
  private async dispatchToProvider(
    intent: ExecutionIntent,
    connection: BrokerConnection,
  ): Promise<BrokerOrderResult> {
    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials!,
      iv: connection.credentialIv!,
      tag: connection.credentialTag!,
      keyId: connection.encryptionKeyId!,
    });

    // #291 / correction round 3: dispatch uses the connection-scoped adapter
    // context — the same mutable context connectBroker/healthCheck operate on,
    // never a process-global singleton's setMode/current-account state.
    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );
    adapter.setMode(connection.accountType);
    const connectResult = await adapter.connect(credentials);
    const connectionReference = credentials.accountId;

    // Zero credentials from memory immediately after connection — BEFORE the
    // environment fence below, so the hygiene guarantee is exception-safe: a
    // fence rejection (or any later failure) can never leave plaintext
    // credential material alive on the stack.
    (Object.keys(credentials) as (keyof typeof credentials)[]).forEach((k) => {
      (credentials as unknown as Record<string, unknown>)[k] = null;
    });

    // Round 7.1 (P0-1 — pre-dispatch environment fence): the dispatch
    // connection's provider-observed environment must MATCH the declared one
    // BEFORE any state-changing provider call. A provider-side relabel
    // (LIVE→DEMO or DEMO→LIVE) must never execute an order under the other
    // environment's authority semantics. The fence throws BEFORE
    // placeOrder/closeOrder — provably DEFINITELY_NOT_SENT — so the order
    // fails closed into reconciliation (never resent; the health check or
    // next observation performs the suspension + authority invalidation on
    // its own cadence, and every subsequent dispatch re-fences).
    if (connectResult.success && connectResult.accountType !== connection.accountType) {
      throw new BrokerAdapterError(
        BrokerErrorCode.ENVIRONMENT_MISMATCH,
        `Environment mismatch at dispatch: the provider reports a ` +
          `${connectResult.accountType} account, but this connection was declared ` +
          `${connection.accountType} — refusing to dispatch (fail-closed).`,
        undefined,
        false,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }

    const execute = async (): Promise<BrokerOrderResult> => {
      if (intent.providerAction === 'CLOSE_POSITION') {
        if (!intent.providerReferenceId) {
          throw new Error('CLOSE_POSITION intent requires providerReferenceId');
        }
        return adapter.closeOrder(intent.providerReferenceId, intent.requestedQuantity);
      }
      // Round 7.1 (P0-4 — fail-closed action router): the only entry action
      // that reaches the provider as an OPEN is PLACE. Any other/unknown
      // providerAction previously fell through to placeOrder below — a
      // future caller minting e.g. a CANCEL_PENDING intent here would have
      // OPENED exposure under an exit label. Fail closed BEFORE any provider
      // call (provably DEFINITELY_NOT_SENT) instead.
      if (intent.providerAction !== 'PLACE') {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_REQUEST,
          `Unsupported providerAction '${intent.providerAction}' at the dispatch ` +
            'boundary — refusing to dispatch (fail-closed action router)',
          undefined,
          false,
          ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
        );
      }
      const request: BrokerOrderRequest = {
        idempotencyKey: this.orderIdempotencyKey(intent),
        instrument: intent.instrument,
        direction: intent.direction,
        lotSize: intent.requestedQuantity,
        stopLoss: intent.stopLoss,
        takeProfit: intent.takeProfit,
        comment: intent.comment,
        connectionReference,
        orderKind: intent.orderKind,
        timeInForce: intent.timeInForce,
        limitPrice: intent.requestedPrice ?? undefined,
        stopPrice: intent.stopPrice ?? undefined,
        clientOrderId: intent.clientOrderId,
      };
      return adapter.placeOrder(request);
    };

    return this.withRetry(execute);
  }

  /**
   * Retry/timeout wrapper for STATE-CHANGING provider dispatches (PLACE,
   * CLOSE_POSITION — every dispatchToProvider action is state-changing).
   *
   * CORRECTION ROUND 4 (architect findings 5 + 6) — PROVIDER-DISPATCH
   * CERTAINTY: automatic retry of a state-changing provider operation is
   * allowed ONLY when the failure PROVABLY never left iRexPro
   * (dispatchCertainty === DEFINITELY_NOT_SENT — local validation/control
   * rejection, pre-send rate-limit, queue-overflow before enqueue,
   * known-closed connection before write). Everything else — a provider
   * response timeout AFTER write, a connection loss after an attempted
   * write, an ambiguous WebSocket write, an UNCLASSIFIED error, or a plain
   * race-timeout while the provider call is still in flight — surfaces
   * IMMEDIATELY so the order transitions RECONCILIATION_PENDING: an
   * uncertain write is an unresolved provider outcome, NEVER permission to
   * resend. (A lost PLACE response may mean the broker EXECUTED the order;
   * resending could double a live position. cTrader clientOrderId/label and
   * MetaTrader/OANDA request ids are NOT assumed to be broker-side
   * exactly-once guarantees — no provider documentation evidence exists.)
   *
   * Read-only operations never pass through this wrapper — they keep their
   * own transport-level retry policy (duplicate reads create no financial
   * side effects).
   *
   * `call` is a FACTORY — each attempt invokes it afresh (never re-await a
   * settled promise).
   */
  private async withRetry(call: () => Promise<BrokerOrderResult>): Promise<BrokerOrderResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const result = await Promise.race([
          call(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Broker order timeout')), EXECUTION_TIMEOUT_MS),
          ),
        ]);
        return result;
      } catch (err) {
        lastError = err as Error;

        // CERTAINTY GATE: only failures the adapter PROVED never reached the
        // provider may be retried. Unclassified errors are conservatively
        // uncertain — surfaced, never resent.
        if (!this.isDefinitelyNotSent(err) || attempt === MAX_RETRY_ATTEMPTS - 1) {
          throw err;
        }

        const delay = RETRY_DELAYS_MS[attempt] ?? 9_000;
        this.logger.warn(
          `Broker order attempt ${attempt + 1} failed (${lastError.message}) — the request ` +
            'provably never reached the provider (DEFINITELY_NOT_SENT); retrying in ' +
            `${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error('All retry attempts exhausted');
  }

  /** True only for adapter failures PROVEN to have never left iRexPro. */
  private isDefinitelyNotSent(err: unknown): boolean {
    return (
      err instanceof BrokerAdapterError &&
      err.dispatchCertainty === ProviderDispatchCertainty.DEFINITELY_NOT_SENT
    );
  }

  // ─── Event + audit helpers ──────────────────────────────────────────────

  private orderIdempotencyKey(intent: ExecutionIntent): string {
    const key = this.orderService.generateIdempotencyKey(intent.userId, intent.clientOrderId);
    return key;
  }

  private async emitAcknowledged(
    intent: ExecutionIntent,
    order: Order,
    providerOrderId: string,
  ): Promise<void> {
    await this.emitOrderEvent(DomainEventType.ORDER_ACKNOWLEDGED, intent, order, {
      status: OrderStatus.ACKNOWLEDGED,
      providerOrderId,
    });
    await this.auditService.log({
      actorUserId: intent.userId,
      action: AuditAction.ORDER_ACKNOWLEDGED,
      resourceType: 'Order',
      resourceId: order.id,
      metadata: {
        clientOrderId: intent.clientOrderId,
        providerOrderId,
        orderStatus: OrderStatus.ACKNOWLEDGED,
      },
    });
  }

  private async emitOrderEvent(
    type: DomainEventType,
    intent: ExecutionIntent,
    order: Order,
    extras: {
      status: string;
      filledQuantity?: string;
      avgFillPrice?: string;
      providerOrderId?: string | null;
      reason?: string;
    },
  ): Promise<void> {
    const payload: OrderEventPayload = {
      orderId: order.id,
      userId: intent.userId,
      clientOrderId: intent.clientOrderId,
      tradeId: intent.tradeId ?? null,
      signalId: intent.signalId ?? null,
      instrument: intent.instrument,
      direction: intent.direction,
      orderKind: intent.orderKind,
      status: extras.status,
      requestedQuantity: intent.requestedQuantity,
      filledQuantity: extras.filledQuantity,
      avgFillPrice: extras.avgFillPrice,
      providerOrderId: extras.providerOrderId ?? null,
      reason: extras.reason,
    };
    this.eventBus.publish(type, intent.userId, payload as unknown as Record<string, unknown>);
  }
}
