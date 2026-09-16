import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerAccount } from '../../broker/entities/broker-account.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../../broker/services/credential-encryption.service';
import { BrokerCredentialLifecycle } from '../../broker/authorization/broker-credential-status';
import { ConflictException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { DomainEventBus } from '../../events/event-bus.service';
import { DomainEventType } from '../../events/enums/domain-event-type.enum';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { OrderService } from '../orders/order.service';
// Round 7.1 (P0-5): pre-commitment crash recovery needs the intent (capital
// allocation release) and the grant (provability of DEFINITELY_NOT_SENT).
import { TradeIntent } from '../entities/trade-intent.entity';
import { RiskGrant } from '../entities/risk-grant.entity';
import { RiskGrantStatus } from '../interfaces/execution-authority';
import { AllocationService } from '../services/allocation.service';
import {
  compareStates,
  InternalAccountSnapshot,
  InternalOrderSnapshot,
  InternalTradeSnapshot,
  ProviderStateSnapshot,
} from './reconciliation-comparator';
import { ReconciliationDiscrepancyType, ReconciliationRunStatus } from './reconciliation.enums';
import { ReconciliationPersistenceService } from './reconciliation-persistence.service';
import { ReconciliationResolutionService } from './reconciliation-resolution.service';
import { ProviderDispatchCertainty } from '../../broker/interfaces/provider-dispatch-certainty';

/** Public outcome of one reconciliation run (job aggregation + specs). */
export interface ReconciliationRunOutcome {
  runId: string;
  brokerConnectionId: string;
  status: ReconciliationRunStatus;
  discrepanciesDetected: number;
  discrepanciesNew: number;
  discrepanciesAutoResolved: number;
  discrepanciesOpen: number;
  errors: number;
}

/** Non-terminal order statuses reconciliation compares.
 *
 * Round 6 live-execution completion (§12/§19): DISPATCH_COMMITTED is
 * included — a hard crash between the provider-dispatch commitment and the
 * outcome write leaves the order committed-but-unresolved, and the sweep's
 * 7c crash-window convergence owns it from the next cycle (crash window
 * previously INVISIBLE to reconciliation). */
const RECONCILABLE_ORDER_STATUSES = [
  // Round 7.1 (P0-5): CREATED orders enter the sweep so the pre-commitment
  // recovery (step 7d) can converge crash-abandoned reservations. The
  // comparator itself skips CREATED (no provider expectation) — only 7d
  // acts on them.
  OrderStatus.CREATED,
  OrderStatus.SUBMITTED,
  OrderStatus.DISPATCH_COMMITTED,
  OrderStatus.ACKNOWLEDGED,
  OrderStatus.PARTIALLY_FILLED,
  OrderStatus.RECONCILIATION_PENDING,
] as const;

/**
 * Round 7.1 (P0-5): a normal dispatch crosses CREATED/SUBMITTED in seconds.
 * Pre-commitment recovery only converges orders that have been stuck past
 * this grace window (mirrors the comparator's unresolved-execution grace) —
 * never a dispatch that is merely in flight.
 */
const PRE_COMMITMENT_GRACE_MS = 5 * 60_000;

/** Trade statuses holding (or possibly holding) provider positions.
 *
 * Round 6 (§12/§19): PENDING is included — the trade reserved for a dispatch
 * that crashed after commitment but before the outcome write must enter the
 * sweep (previously an invisible crash-window state). */
const RECONCILABLE_TRADE_STATUSES = [
  TradeStatus.PENDING,
  TradeStatus.OPEN,
  TradeStatus.RECONCILIATION_PENDING,
] as const;

/** Keep reconciliation error handling aligned with the execution boundary. */
const SECRET_LIKE_RUN = /[A-Za-z0-9]{16,}/g;
const RECONCILIATION_REASON_MAX_LENGTH = 500;

/**
 * Provider/runtime errors can include credential material in their message.
 * Bound and redact them before they reach persistence, audits, or logs.
 */
function sanitizeReconciliationReason(reason: unknown): string {
  let raw = 'unknown error';
  if (reason instanceof Error) {
    raw = reason.message;
  } else if (typeof reason === 'string') {
    raw = reason;
  } else if (
    reason &&
    typeof reason === 'object' &&
    'message' in reason &&
    typeof (reason as { message?: unknown }).message === 'string'
  ) {
    raw = (reason as { message: string }).message;
  }
  return raw.slice(0, RECONCILIATION_REASON_MAX_LENGTH).replace(SECRET_LIKE_RUN, '[redacted]');
}

/**
 * StateReconciliationService — ONE authoritative reconciliation loop over
 * internal state vs provider state per broker connection (Directive PHASE G;
 * §25 compare/detect/persist, §26 uncertain results, §29/§30 concurrency).
 *
 * Run phases (all provider I/O happens OUTSIDE persistence transactions):
 *   1. Persist a RUNNING run row (visibility — §29).
 *   2. Connect the provider adapter (decrypt → connect → ZERO credentials).
 *   3. Read provider state: working orders + open positions + account info.
 *      Failure → run FAILED + CRITICAL audit (fail loudly, never fabricate).
 *   4. Read internal state: non-terminal orders, open/pending trades, the
 *      STORED account snapshot (pre-sync — mismatch detection observes
 *      drift BEFORE converging).
 *   5. Pure comparator diff → all directive §25 discrepancy candidates.
 *   6. Persist discrepancies (OPEN-row dedup; NEW rows → user events +
 *      WARNING/CRITICAL audits — never silently hidden).
 *   7. Safe auto-resolution: provider-authoritative converges (external
 *      closes, RECONCILIATION_PENDING recoveries, provider-terminal order
 *      states via stable-identifier lookup §26). Unresolvable findings stay
 *      OPEN for human/admin action (PR-5/6 surface them).
 *   8. Sync the account snapshot from provider truth.
 *   9. Finalize the run row + publish reconciliation.run.completed.
 *
 * CONCURRENCY (§30): mutations are guarded (optimistic status WHERE + row
 * locks in persistence); the BullMQ repeatable job dedups run scheduling;
 * per-connection persistence serializes on pg advisory locks. Provider I/O
 * never happens inside a transaction.
 */
@Injectable()
export class StateReconciliationService {
  private readonly logger = new Logger(StateReconciliationService.name);

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(BrokerAccount)
    private readonly accountRepo: Repository<BrokerAccount>,
    private readonly brokerService: BrokerService,
    private readonly adapterRegistry: BrokerAdapterRegistry,
    private readonly encryptionService: CredentialEncryptionService,
    private readonly persistence: ReconciliationPersistenceService,
    private readonly resolution: ReconciliationResolutionService,
    private readonly orderService: OrderService,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
    // Round 7.1 (P0-5): pre-commitment crash recovery dependencies — the
    // intent (capital-allocation release), the grant (DEFINITELY_NOT_SENT
    // provability) and the allocation service itself.
    @InjectRepository(TradeIntent)
    private readonly intentRepo: Repository<TradeIntent>,
    @InjectRepository(RiskGrant)
    private readonly riskGrantRepo: Repository<RiskGrant>,
    private readonly allocationService: AllocationService,
  ) {}

  async runForConnection(connection: BrokerConnection): Promise<ReconciliationRunOutcome> {
    const run = await this.persistence.createRun({
      userId: connection.userId,
      brokerConnectionId: connection.id,
      brokerId: connection.brokerId,
    });

    try {
      await this.auditService.log({
        actorUserId: connection.userId,
        action: AuditAction.RECONCILIATION_RUN_STARTED,
        resourceType: 'BrokerConnection',
        resourceId: connection.id,
        metadata: { runId: run.id, brokerId: connection.brokerId },
      });

      // ── Phase 2: connect the adapter (credentials zeroed after use) ────
      // #291 / correction round 3: reconciliation uses the connection-scoped
      // adapter context — isolated from any other connection's mutable state.
      const adapter = this.adapterRegistry.getAdapterForConnection(
        connection.id,
        connection.brokerId,
      );
      adapter.setMode(connection.accountType);
      const credentials = this.buildCredentials(connection);
      try {
        const connectResult = await adapter.connect(credentials);
        // Round 7.1 (P0-1 — reconciliation environment enforcement): a
        // reconciliation run re-establishes the provider session and reads
        // the account state it then PERSISTS as the authoritative snapshot
        // (Phase 8). The provider-observed environment must MATCH the
        // declared one BEFORE any provider truth from this session is
        // trusted: on mismatch the BrokerService seam suspends the
        // connection, invalidates trading authority and audits CRITICALLY,
        // then throws — this run records FAILED and NO provider snapshot
        // from the mislabeled session is ever persisted (fail-closed).
        await this.brokerService.assertConnectionEnvironment(
          connection,
          connectResult,
          'state-reconciliation',
        );
      } finally {
        this.zeroCredentials(credentials);
      }

      // ── Phase 3: provider state (fail loudly — never fabricate) ────────
      const [providerOrders, providerPositions, providerAccount] = await Promise.all([
        adapter.listOrders(),
        adapter.getOpenPositions(),
        adapter.getAccountInfo(),
      ]);
      const providerState: ProviderStateSnapshot = {
        orders: providerOrders,
        positions: providerPositions,
        account: providerAccount,
      };

      // ── Phase 4: internal state ─────────────────────────────────────────
      const [internalOrders, internalTrades, storedAccount] = await Promise.all([
        this.orderRepo.find({
          where: {
            brokerConnectionId: connection.id,
            status: In([...RECONCILABLE_ORDER_STATUSES] as OrderStatus[]),
          },
        }),
        this.tradeRepo.find({
          where: {
            brokerConnectionId: connection.id,
            status: In([...RECONCILABLE_TRADE_STATUSES] as TradeStatus[]),
          },
        }),
        this.accountRepo.findOne({ where: { brokerConnectionId: connection.id } }),
      ]);

      const internalState = {
        orders: internalOrders.map((o) => this.toOrderSnapshot(o)),
        trades: internalTrades.map((t) => this.toTradeSnapshot(t)),
        account: storedAccount ? this.toAccountSnapshot(storedAccount) : null,
      };

      // ── Phase 5: pure diff ──────────────────────────────────────────────
      const candidates = compareStates(internalState, providerState, new Date());

      // ── Phase 6: persist + surface NEW discrepancies ───────────────────
      const persisted = await this.persistence.persistDiscrepancies(
        { userId: connection.userId, brokerConnectionId: connection.id },
        run.id,
        candidates,
      );

      for (const row of persisted.newRows) {
        await this.auditDiscrepancy(
          AuditAction.RECONCILIATION_DISCREPANCY_DETECTED,
          connection,
          row.type,
          row.severity,
          row,
        );
        this.eventBus.publish(
          DomainEventType.RECONCILIATION_DISCREPANCY_DETECTED,
          connection.userId,
          {
            userId: connection.userId,
            discrepancyId: row.id,
            brokerConnectionId: connection.id,
            type: row.type,
            severity: row.severity,
            internalRefId: row.internalRefId,
            providerRef: row.providerRef,
            clientOrderId: row.clientOrderId,
            at: new Date().toISOString(),
          },
        );
      }

      // ── Phase 7: safe auto-resolution ──────────────────────────────────
      const resolutionRefs: Array<{
        type: string;
        internalRefId: string | null;
        providerRef: string | null;
        resolution: string;
      }> = [];
      let errors = 0;
      let autoResolvedCount = 0;

      // 7a. Positions: externally-closed + RECONCILIATION_PENDING recovery.
      const closedTrades =
        internalTrades.length > 0 ? await this.fetchClosedTrades(adapter, internalTrades) : [];
      for (const trade of internalTrades) {
        try {
          const position = trade.externalOrderId
            ? await adapter.getPositionById(trade.externalOrderId)
            : null;

          if (position === null && trade.externalOrderId) {
            const match = closedTrades.find((ct) => ct.externalOrderId === trade.externalOrderId);
            const closed = await this.resolution.closeTradeFromProvider(trade, match ?? null);
            if (closed) {
              resolutionRefs.push({
                type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
                internalRefId: trade.id,
                providerRef: trade.externalOrderId,
                resolution: 'Provider reports the position closed — trade converged to CLOSED',
              });
            }
          } else if (
            position !== null &&
            (trade.status === TradeStatus.RECONCILIATION_PENDING ||
              // Round 7.1 (P0-5): a WORKING dispatch outcome leaves the trade
              // PENDING with the position live at the provider — the provider
              // truth recovers it to OPEN (PENDING→OPEN is state-machine
              // legal; previously this case had NO convergence branch).
              trade.status === TradeStatus.PENDING)
          ) {
            const recovered = await this.resolution.recoverTradeToOpen(trade);
            if (recovered) {
              resolutionRefs.push({
                type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
                internalRefId: trade.id,
                providerRef: trade.externalOrderId,
                resolution: 'Provider-observed position open — trade recovered to OPEN',
              });
            }
          }
        } catch (err) {
          errors++;
          this.logger.warn(
            `Trade resolution failed for ${trade.id} (retried next run): ` +
              sanitizeReconciliationReason(err),
          );
        }
      }

      // 7b. Orders: resolve by stable identifier (Directive §26). Covers
      // RECONCILIATION_PENDING orders AND stale-state orders the comparator
      // flagged — the provider's own record is authoritative when it has one.
      for (const order of internalOrders) {
        if (!order.providerOrderId) continue;
        try {
          const providerOrder = await adapter.getOrderById(order.providerOrderId);
          if (!providerOrder) continue; // not found / history syncing — next run retries

          const changed = await this.resolution.resolveOrderFromProviderState(order, providerOrder);
          if (changed) {
            for (const type of [
              ReconciliationDiscrepancyType.STALE_ORDER_STATE,
              ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
              ReconciliationDiscrepancyType.MISSING_PROVIDER_ORDER,
            ]) {
              resolutionRefs.push({
                type,
                internalRefId: order.id,
                providerRef: order.providerOrderId,
                resolution: `Provider order state ${providerOrder.status} applied — internal order converged`,
              });
            }
          }
        } catch (err) {
          errors++;
          this.logger.warn(
            `Order resolution failed for ${order.id} (retried next run): ` +
              sanitizeReconciliationReason(err),
          );
        }
      }

      // 7c. Round 6 live-execution completion (§12/§19) — CRASH-WINDOW
      // CONVERGENCE: orders stuck in DISPATCH_COMMITTED without a provider
      // order id (a hard crash between the provider-dispatch commitment and
      // the outcome write — previously INVISIBLE to this sweep).
      for (const order of internalOrders) {
        if (order.status !== OrderStatus.DISPATCH_COMMITTED || order.providerOrderId) continue;
        try {
          // (a) §26 stable identifier: the provider echoes the clientOrderId
          //     on its own order record — a match PROVES the dispatch
          //     reached the provider; the provider state is the truth.
          const matched = providerOrders.find(
            (p) => p.clientOrderId && p.clientOrderId === order.clientOrderId,
          );
          if (matched) {
            const changed = await this.resolution.resolveOrderFromProviderState(order, matched);
            if (changed) {
              resolutionRefs.push({
                type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
                internalRefId: order.id,
                providerRef: matched.providerOrderId,
                resolution:
                  `Crash-window order recovered by clientOrderId — provider state ` +
                  `${matched.status} applied`,
              });
            }
            continue;
          }

          // (b) Not visible at the provider: the dispatch outcome is
          //     UNCERTAIN (absence from listOrders does NOT prove the call
          //     never left — fail-closed, never auto-close). Converge the
          //     order AND its reserved trade to RECONCILIATION_PENDING
          //     (state-machine-legal for both), stamp
          //     MAY_HAVE_REACHED_PROVIDER so uncertain-exposure accounting
          //     retains the capacity reservation, and let the comparator's
          //     MISSING_PROVIDER_ORDER discrepancy surface it. Every later
          //     cycle re-attempts (a) — sync lag heals; a truly-absent
          //     order stays visible for admin resolution.
          await this.orderService
            .resolveReconciliation(order.id, OrderStatus.RECONCILIATION_PENDING, {
              rejectReason:
                'Crash-window convergence: dispatch committed but provider outcome ' +
                'unprovable (absent from provider order list) — uncertain, surfaced',
            })
            .catch((err) => {
              // A concurrent writer (restarted pipeline re-driving the same
              // order, another resolver) won the transition — never fatal.
              this.logger.warn(
                `Crash-window order ${order.id} could not converge to ` +
                  `RECONCILIATION_PENDING (${sanitizeReconciliationReason(err)}) — guard held`,
              );
            });

          if (order.tradeId) {
            const pendingTrade = internalTrades.find(
              (t) => t.id === order.tradeId && t.status === TradeStatus.PENDING,
            );
            if (pendingTrade) {
              const guarded = await this.tradeRepo.update(
                { id: pendingTrade.id, status: TradeStatus.PENDING },
                {
                  status: TradeStatus.RECONCILIATION_PENDING,
                  brokerRejectionReason:
                    'Crash-window convergence: dispatch committed, provider outcome ' +
                    'unprovable — uncertain exposure retained (MAY_HAVE_REACHED_PROVIDER)',
                  dispatchCertainty: ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
                } as never,
              );
              if (guarded.affected) {
                resolutionRefs.push({
                  type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
                  internalRefId: pendingTrade.id,
                  providerRef: null,
                  resolution:
                    'Crash-window trade converged to RECONCILIATION_PENDING ' +
                    '(MAY_HAVE_REACHED_PROVIDER) — uncertain exposure retained',
                });
              }
            }
          }
        } catch (err) {
          errors++;
          this.logger.warn(
            `Crash-window resolution failed for ${order.id} (retried next run): ` +
              sanitizeReconciliationReason(err),
          );
        }
      }

      // 7d. Round 7.1 (P0-5) — PRE-COMMITMENT CONVERGENCE: a process crash
      // between the trade/order reservation and the provider-dispatch
      // commitment previously left CREATED/SUBMITTED orders + their PENDING
      // trades INVISIBLE forever (not in the sweep's candidate sets) with
      // their capital allocation leaked. The commitment transaction is the
      // provability anchor: the grant is consumed IN THE SAME TRANSACTION as
      // the order's SUBMITTED→DISPATCH_COMMITTED CAS, and the provider call
      // happens only AFTER that transaction. Therefore:
      //   - an order still CREATED/SUBMITTED past the grace window whose
      //     linked grant is NOT CONSUMED was PROVABLY never dispatched
      //     (DEFINITELY_NOT_SENT) → terminal REJECTED (order + PENDING
      //     trade) + capital allocation released. No exposure ever existed.
      //   - a SUBMITTED order WITHOUT a grant (close-position orders carry
      //     none — closes skip the commitment boundary) has NO provability
      //     anchor → conservatively RECONCILIATION_PENDING (uncertain), the
      //     position loop (7a) converges the underlying trade either way.
      //   - a SUBMITTED order with a CONSUMED grant is a corrupt
      //     impossibility (atomic transaction) → surfaced CRITICALLY,
      //     converged to RECONCILIATION_PENDING, never auto-rejected.
      for (const order of internalOrders) {
        if (
          (order.status !== OrderStatus.CREATED && order.status !== OrderStatus.SUBMITTED) ||
          order.providerOrderId
        ) {
          continue;
        }
        // Grace window: a live in-flight dispatch crosses these states in
        // seconds — never touch a dispatch that might still be running.
        const orderAgeMs = Date.now() - new Date(order.updatedAt).getTime();
        if (orderAgeMs < PRE_COMMITMENT_GRACE_MS) continue;

        try {
          const linkedTrade = order.tradeId
            ? await this.tradeRepo.findOne({ where: { id: order.tradeId } })
            : null;
          const grant = linkedTrade?.riskGrantId
            ? await this.riskGrantRepo.findOne({ where: { id: linkedTrade.riskGrantId } })
            : null;

          // Corrupt impossibility: grant consumed while the order never
          // reached DISPATCH_COMMITTED — surface loudly, converge
          // uncertainly, NEVER auto-reject.
          if (grant?.status === RiskGrantStatus.CONSUMED) {
            await this.orderService.resolveReconciliation(
              order.id,
              OrderStatus.RECONCILIATION_PENDING,
              {
                rejectReason:
                  'Pre-commitment recovery: grant consumed but order never committed — ' +
                  'corrupt state surfaced for manual resolution (fail-closed)',
              },
            );
            await this.auditService.log({
              actorUserId: connection.userId,
              action: AuditAction.RECONCILIATION_DISCREPANCY_DETECTED,
              resourceType: 'Order',
              resourceId: order.id,
              metadata: {
                runId: run.id,
                type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
                severity: 'CRITICAL',
                clientOrderId: order.clientOrderId,
                finding: 'CONSUMED_GRANT_WITHOUT_COMMITMENT',
              },
              severity: AuditSeverity.CRITICAL,
            });
            errors++;
            continue;
          }

          // Grant-bearing entry order with an unconsumed grant → provable
          // DEFINITELY_NOT_SENT (the commitment never ran; the provider call
          // only starts after it). CREATED orders of ANY kind are provable
          // the same way (provider I/O starts only after SUBMITTED).
          const provablyNotSent = order.status === OrderStatus.CREATED || grant !== null;
          if (!provablyNotSent) {
            // SUBMITTED close order (no grant): no provability anchor — the
            // close may have reached the provider. Uncertain, surfaced; the
            // position loop owns the trade truth.
            await this.orderService.resolveReconciliation(
              order.id,
              OrderStatus.RECONCILIATION_PENDING,
              {
                rejectReason:
                  'Pre-commitment recovery: close dispatch outcome unprovable ' +
                  '(no commitment anchor) — uncertain, surfaced for convergence',
              },
            );
            await this.auditService.log({
              actorUserId: connection.userId,
              action: AuditAction.RECONCILIATION_DISCREPANCY_DETECTED,
              resourceType: 'Order',
              resourceId: order.id,
              metadata: {
                runId: run.id,
                type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
                severity: 'WARNING',
                clientOrderId: order.clientOrderId,
                finding: 'UNPROVABLE_PRE_COMMITMENT_CLOSE',
              },
              severity: AuditSeverity.WARNING,
            });
            continue;
          }

          // Provable non-exposure: terminal REJECTED (DEFINITELY_NOT_SENT),
          // the reserved PENDING trade released, the capital allocation
          // returned to the budget. Auditable at every step.
          await this.orderService.resolveReconciliation(order.id, OrderStatus.REJECTED, {
            rejectReason:
              'Pre-commitment recovery: process crashed before the dispatch ' +
              'commitment — provably DEFINITELY_NOT_SENT (grant unconsumed), ' +
              'terminal rejection, no exposure ever existed',
          });
          if (linkedTrade && linkedTrade.status === TradeStatus.PENDING) {
            const guarded = await this.tradeRepo.update(
              { id: linkedTrade.id, status: TradeStatus.PENDING },
              {
                status: TradeStatus.REJECTED,
                brokerRejectionReason:
                  'Pre-commitment recovery: dispatch never started ' +
                  '(DEFINITELY_NOT_SENT) — trade released',
                dispatchCertainty: ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
              } as never,
            );
            if (guarded.affected) {
              resolutionRefs.push({
                type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
                internalRefId: linkedTrade.id,
                providerRef: null,
                resolution:
                  'Pre-commitment recovery: PENDING trade converged to REJECTED ' +
                  '(DEFINITELY_NOT_SENT — grant unconsumed)',
              });
            }
          }
          // Capital: the intent's ACTIVE allocation is terminally released
          // (definite non-exposure; the §3 aggregate self-heals).
          if (linkedTrade) {
            const intent = await this.intentRepo.findOne({
              where: { tradeId: linkedTrade.id },
            });
            if (intent) {
              await this.allocationService.releaseAllocationForIntent(
                intent.id,
                'PRE_COMMITMENT_RECOVERY',
              );
            }
          }
          await this.auditService.log({
            actorUserId: connection.userId,
            action: AuditAction.RECONCILIATION_DISCREPANCY_DETECTED,
            resourceType: 'Order',
            resourceId: order.id,
            metadata: {
              runId: run.id,
              type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
              severity: 'WARNING',
              clientOrderId: order.clientOrderId,
              finding: 'PRE_COMMITMENT_CRASH_RECOVERED',
              dispatchCertainty: ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
              tradeConverged: linkedTrade !== null && linkedTrade.status === TradeStatus.PENDING,
            },
            severity: AuditSeverity.WARNING,
          });
        } catch (err) {
          errors++;
          this.logger.warn(
            `Pre-commitment recovery failed for ${order.id} (retried next run): ` +
              sanitizeReconciliationReason(err),
          );
        }
      }

      // ── Phase 8: account snapshot sync ──────────────────────────────────
      await this.brokerService.applyProviderAccountSnapshot(
        connection.id,
        providerAccount,
        providerPositions.length,
      );
      // The account drift (if any) converged by the sync above.
      if (candidates.some((c) => c.type === ReconciliationDiscrepancyType.ACCOUNT_STATE_MISMATCH)) {
        resolutionRefs.push({
          type: ReconciliationDiscrepancyType.ACCOUNT_STATE_MISMATCH,
          internalRefId: null,
          providerRef: null,
          resolution: 'Account snapshot re-synced from provider account info',
        });
      }

      // ── Resolve the discrepancy rows this run actually converged ────────
      const resolvedRows = await this.persistence.resolveDiscrepanciesByRef(
        connection.id,
        resolutionRefs,
      );
      autoResolvedCount = resolvedRows.length;

      for (const row of resolvedRows) {
        await this.auditDiscrepancy(
          AuditAction.RECONCILIATION_DISCREPANCY_RESOLVED,
          connection,
          row.type,
          'INFO',
          row,
        );
        this.eventBus.publish(
          DomainEventType.RECONCILIATION_DISCREPANCY_RESOLVED,
          connection.userId,
          {
            userId: connection.userId,
            discrepancyId: row.id,
            brokerConnectionId: connection.id,
            type: row.type,
            severity: 'INFO',
            internalRefId: row.internalRefId,
            providerRef: row.providerRef,
            at: new Date().toISOString(),
          },
        );
      }

      // ── Phase 9: finalize ────────────────────────────────────────────────
      const openCount = await this.persistence.countOpenDiscrepancies(connection.id);
      const status: ReconciliationRunStatus =
        errors > 0 || openCount > 0
          ? ReconciliationRunStatus.COMPLETED_WITH_WARNINGS
          : ReconciliationRunStatus.COMPLETED;

      await this.persistence.completeRun(run.id, {
        status,
        counters: {
          providerOrdersSeen: providerOrders.length,
          internalOrdersCompared: internalOrders.length,
          providerPositionsSeen: providerPositions.length,
          internalPositionsCompared: internalTrades.length,
          accountSnapshotCompared: internalState.account ? 1 : 0,
          discrepanciesDetected: candidates.length,
          discrepanciesNew: persisted.inserted,
          discrepanciesAutoResolved: autoResolvedCount,
          discrepanciesOpen: openCount,
          errors,
        },
        errorSummary:
          errors > 0
            ? `${errors} resolution errors this run (see service logs; retried next run)`
            : null,
        metadata: {
          brokerId: connection.brokerId,
          accountType: connection.accountType,
          refreshedDiscrepancies: persisted.refreshed,
        },
      });

      await this.auditService.log({
        actorUserId: connection.userId,
        action: AuditAction.RECONCILIATION_RUN_COMPLETED,
        resourceType: 'BrokerConnection',
        resourceId: connection.id,
        severity:
          status === ReconciliationRunStatus.COMPLETED ? AuditSeverity.INFO : AuditSeverity.WARNING,
        metadata: {
          runId: run.id,
          status,
          discrepanciesDetected: candidates.length,
          discrepanciesNew: persisted.inserted,
          discrepanciesAutoResolved: autoResolvedCount,
          discrepanciesOpen: openCount,
          errors,
        },
      });

      this.eventBus.publish(DomainEventType.RECONCILIATION_RUN_COMPLETED, connection.userId, {
        userId: connection.userId,
        runId: run.id,
        brokerConnectionId: connection.id,
        brokerId: connection.brokerId,
        status,
        discrepanciesDetected: candidates.length,
        discrepanciesNew: persisted.inserted,
        discrepanciesOpen: openCount,
        completedAt: new Date().toISOString(),
      });

      return {
        runId: run.id,
        brokerConnectionId: connection.id,
        status,
        discrepanciesDetected: candidates.length,
        discrepanciesNew: persisted.inserted,
        discrepanciesAutoResolved: autoResolvedCount,
        discrepanciesOpen: openCount,
        errors,
      };
    } catch (err) {
      // Provider read failure or unexpected error → FAILED run, CRITICAL
      // audit, surfaced error summary (§29 "failed jobs require visibility").
      // Redact before the failure reaches any durable or observable sink.
      const message = sanitizeReconciliationReason(err);
      await this.persistence.failRun(run.id, message);
      await this.auditService
        .log({
          actorUserId: connection.userId,
          action: AuditAction.RECONCILIATION_RUN_FAILED,
          resourceType: 'BrokerConnection',
          resourceId: connection.id,
          severity: AuditSeverity.CRITICAL,
          metadata: { runId: run.id, brokerId: connection.brokerId, reason: message },
        })
        .catch(() => undefined);
      this.logger.error(`Reconciliation run ${run.id} FAILED: ${message}`);
      return {
        runId: run.id,
        brokerConnectionId: connection.id,
        status: ReconciliationRunStatus.FAILED,
        discrepanciesDetected: 0,
        discrepanciesNew: 0,
        discrepanciesAutoResolved: 0,
        discrepanciesOpen: 0,
        errors: 1,
      };
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Candidate connection discovery for the worker: every connection that
   * has internal state worth reconciling — non-terminal orders, live/pending
   * trades, or a stored account snapshot to keep fresh.
   */
  async findReconcilableConnections(): Promise<BrokerConnection[]> {
    const [orderIds, tradeIds, accountIds] = await Promise.all([
      this.orderRepo
        .createQueryBuilder('o')
        .select('DISTINCT o.broker_connection_id', 'id')
        .where('o.status IN (:...statuses)', { statuses: RECONCILABLE_ORDER_STATUSES })
        .getRawMany(),
      this.tradeRepo
        .createQueryBuilder('t')
        .select('DISTINCT t.broker_connection_id', 'id')
        .where('t.status IN (:...statuses)', { statuses: RECONCILABLE_TRADE_STATUSES })
        .getRawMany(),
      this.accountRepo
        .createQueryBuilder('a')
        .select('DISTINCT a.broker_connection_id', 'id')
        .getRawMany(),
    ]);

    const ids = new Set<string>();
    for (const rows of [orderIds, tradeIds, accountIds]) {
      for (const row of rows) {
        const id = (row as { id?: string }).id;
        if (id) ids.add(id);
      }
    }

    if (ids.size === 0) return [];
    return this.brokerService.findConnectionsByIds(Array.from(ids));
  }

  /**
   * Decrypt stored credentials; fall back to the safe account reference.
   *
   * A3 (architect correction): the credential lifecycle is AUTHORITATIVE —
   * reconciliation never bypasses it. Unusable lifecycle states (INVALID /
   * EXPIRED / REVOKED / missing) fail closed BEFORE any decryption or
   * provider call; the run is recorded FAILED with this honest reason and
   * the connection's discrepancies remain un-reconciled (surfaced, never
   * fabricated).
   */
  private buildCredentials(connection: BrokerConnection): {
    accountId: string;
    apiKey?: string;
    apiSecret?: string;
    serverUrl?: string;
  } {
    if (!BrokerCredentialLifecycle.isUsable(connection.credentialStatus)) {
      throw new ConflictException(
        `Reconciliation skipped for connection ${connection.id}: credential ` +
          `lifecycle state is ${connection.credentialStatus ?? 'MISSING'} ` +
          '(fail-closed — rotate credentials to restore reconciliation)',
      );
    }
    if (
      connection.encryptedCredentials &&
      connection.credentialIv &&
      connection.credentialTag &&
      connection.encryptionKeyId
    ) {
      return this.encryptionService.decrypt({
        ciphertext: connection.encryptedCredentials,
        iv: connection.credentialIv,
        tag: connection.credentialTag,
        keyId: connection.encryptionKeyId,
      }) as { accountId: string; apiKey?: string; apiSecret?: string; serverUrl?: string };
    }
    // No stored credential blob (e.g. paper connections) — the safe account
    // reference is all adapters need to address the account.
    return { accountId: connection.accountId ?? '' };
  }

  /** Zero in-memory credentials immediately after use (security invariant). */
  private zeroCredentials(credentials: Record<string, unknown>): void {
    for (const key of Object.keys(credentials)) {
      credentials[key] = null;
    }
  }

  /** Best-effort provider closed-trade economics for external closes. */
  private async fetchClosedTrades(
    adapter: {
      getClosedTrades(
        from: Date,
        to: Date,
      ): Promise<import('../../broker/interfaces/broker-adapter.interface').BrokerClosedTrade[]>;
    },
    trades: Trade[],
  ): Promise<import('../../broker/interfaces/broker-adapter.interface').BrokerClosedTrade[]> {
    try {
      const earliest = trades.reduce<Date | null>(
        (min, t) => (t.openedAt && (!min || t.openedAt < min) ? t.openedAt : min),
        null,
      );
      return await adapter.getClosedTrades(earliest ?? new Date(0), new Date());
    } catch (err) {
      this.logger.warn(`Closed-trade lookup unavailable: ${sanitizeReconciliationReason(err)}`);
      return [];
    }
  }

  private toOrderSnapshot(o: Order): InternalOrderSnapshot {
    return {
      orderId: o.id,
      clientOrderId: o.clientOrderId,
      providerOrderId: o.providerOrderId,
      status: o.status,
      orderKind: o.orderKind,
      instrument: o.instrument,
      requestedQuantity: o.requestedQuantity,
      filledQuantity: o.filledQuantity,
      avgFillPrice: o.avgFillPrice,
      submittedAt: o.submittedAt,
      tradeId: o.tradeId,
    };
  }

  private toTradeSnapshot(t: Trade): InternalTradeSnapshot {
    return {
      tradeId: t.id,
      externalOrderId: t.externalOrderId,
      externalPositionId: t.externalPositionId,
      status: t.status,
      instrument: t.instrument,
      lotSize: t.lotSize,
      fillPrice: t.fillPrice,
      openedAt: t.openedAt,
    };
  }

  private toAccountSnapshot(a: BrokerAccount): InternalAccountSnapshot {
    return {
      balance: a.balance,
      equity: a.equity,
      margin: a.margin,
      freeMargin: a.freeMargin,
      marginLevel: a.marginLevel,
      currency: a.currency,
      leverage: a.leverage,
    };
  }

  private async auditDiscrepancy(
    action: AuditAction,
    connection: BrokerConnection,
    type: string,
    severity: string,
    row: { id: string; internalRefId?: string | null; providerRef?: string | null },
  ): Promise<void> {
    try {
      await this.auditService.log({
        actorUserId: connection.userId,
        action,
        resourceType: 'ReconciliationDiscrepancy',
        resourceId: row.id,
        severity:
          severity === 'CRITICAL'
            ? AuditSeverity.CRITICAL
            : severity === 'WARNING'
              ? AuditSeverity.WARNING
              : AuditSeverity.INFO,
        metadata: {
          discrepancyType: type,
          brokerConnectionId: connection.id,
          brokerId: connection.brokerId,
          internalRefId: row.internalRefId ?? null,
          providerRef: row.providerRef ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`Discrepancy audit failed: ${sanitizeReconciliationReason(err)}`);
    }
  }
}
