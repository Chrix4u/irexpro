import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository } from 'typeorm';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerAccount } from '../../broker/entities/broker-account.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CTRADER_FAMILY_BROKER_IDS } from '../../broker/registry/broker-catalog';
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
import { OrderKind, OrderStatus } from '../orders/order.enums';
import { OrderService } from '../orders/order.service';
// Round 7.1 (P0-5): pre-commitment crash recovery needs the intent (capital
// allocation release) and the grant (provability of DEFINITELY_NOT_SENT).
import { TradeIntent } from '../entities/trade-intent.entity';
import { RiskGrant } from '../entities/risk-grant.entity';
import { RiskGrantStatus } from '../interfaces/execution-authority';
import { AllocationService } from '../services/allocation.service';
import {
  compareDecimal,
  compareStates,
  InternalAccountSnapshot,
  InternalOrderSnapshot,
  InternalTradeSnapshot,
  ProviderStateSnapshot,
} from './reconciliation-comparator';
import { ReconciliationDiscrepancyType, ReconciliationRunStatus } from './reconciliation.enums';
import { ReconciliationPersistenceService } from './reconciliation-persistence.service';
import { ReconciliationResolutionService } from './reconciliation-resolution.service';
import { proveCtraderEntryOrderPositionRef } from './closed-demo-settlement-proof';
import {
  provePepperstoneDemoClosedOrderFill,
  proveAgedCtraderDemoClosedOrderFill,
  selectRecentDemoCloseOrders,
} from './closed-demo-order-deal-proof';
import {
  selectAgedDemoCloseRecoveryCandidates,
  agedTradeNeedsSettlementBackfill,
} from './closed-demo-order-recovery-sweep';
import { isProvenUnsentEntry } from '../trade-read-truth';
import { reconcileProvenUnsentEntry } from './proven-unsent-entry';
import { ProviderDispatchCertainty } from '../../broker/interfaces/provider-dispatch-certainty';
import {
  METAAPI_PROVIDER_QUOTA_COOLDOWN_MS,
  isMetaApiDeploymentFundingError,
  isMetaApiQuotaError,
} from '../../broker/utils/metaapi-quota';

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
const TIMED_OUT_POSITION_MATCH_WINDOW_MS = 2 * 60_000;
const TIMED_OUT_POSITION_CLOCK_SKEW_MS = 5_000;

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
const UUID_LIKE_RUN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const URL_LIKE_RUN = /https?:\/\/[^\s)]+/gi;
const RECONCILIATION_REASON_MAX_LENGTH = 500;

const PAPER_BROKER_ID = 'paper-broker';
const PAPER_STARTING_BALANCE = '10000.00';

function isZeroLikeDecimal(value: string | null | undefined): boolean {
  if (value == null) return false;
  return /^[-+]?0+(?:\.0+)?$/.test(value.trim());
}

function isPaperStartingBalance(value: string | null | undefined): boolean {
  if (value == null) return false;
  return compareDecimal(value, PAPER_STARTING_BALANCE) === 0;
}

function looksLikeResetPaperProviderState(params: {
  connection: BrokerConnection;
  providerOrders: import('../../broker/interfaces/broker-adapter.interface').BrokerOrderState[];
  providerPositions: import('../../broker/interfaces/broker-adapter.interface').BrokerPosition[];
  providerAccount: import('../../broker/interfaces/broker-adapter.interface').BrokerAccountInfo;
  internalOrders: Order[];
  internalTrades: Trade[];
  closedTrades: import('../../broker/interfaces/broker-adapter.interface').BrokerClosedTrade[];
  storedAccount: BrokerAccount | null;
}): boolean {
  const {
    connection,
    providerOrders,
    providerPositions,
    providerAccount,
    internalOrders,
    internalTrades,
    closedTrades,
    storedAccount,
  } = params;

  if (connection.brokerId !== PAPER_BROKER_ID) return false;
  if (providerOrders.length !== 0 || providerPositions.length !== 0) return false;

  const pristineProviderAccount =
    isPaperStartingBalance(providerAccount.balance) &&
    isPaperStartingBalance(providerAccount.equity) &&
    isZeroLikeDecimal(providerAccount.margin) &&
    isPaperStartingBalance(providerAccount.freeMargin);

  if (!pristineProviderAccount) return false;

  const durableTradeEvidence =
    internalOrders.length === 0 &&
    internalTrades.some((trade) => trade.status === TradeStatus.OPEN) &&
    closedTrades.length === 0;
  const durableFinancialEvidence =
    storedAccount !== null &&
    (!isPaperStartingBalance(storedAccount.balance) ||
      !isPaperStartingBalance(storedAccount.equity));

  return durableTradeEvidence || durableFinancialEvidence;
}

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
  return raw
    .slice(0, RECONCILIATION_REASON_MAX_LENGTH)
    .replace(URL_LIKE_RUN, '[redacted-url]')
    .replace(UUID_LIKE_RUN, '[redacted-id]')
    .replace(SECRET_LIKE_RUN, '[redacted]');
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
  private readonly providerQuotaCooldownUntilByConnection = new Map<string, number>();
  // The existing reconciliation loop ignores CLOSED trades, meaning a deal
  // arriving after its position disappears would otherwise never repair P&L.
  // Keep a separate bounded DEMO-only 15-minute late-settlement lookup,
  // never repeated on every 60s general reconciliation sweep.
  private readonly closedEconomicsLookupAtByConnection = new Map<string, number>();
  private readonly demoCloseRecoveryCursor = new Map<string, string>();
  /** Fair-rotation cursor for the aged (historical) DEMO close-order sweep. */
  private readonly agedDemoCloseRecoveryCursor = new Map<string, string>();

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

  private async recoverTimedOutProviderPositions(
    connection: BrokerConnection,
    internalTrades: Trade[],
    providerPositions: import('../../broker/interfaces/broker-adapter.interface').BrokerPosition[],
  ): Promise<
    Array<{
      type: string;
      internalRefId: string | null;
      providerRef: string | null;
      resolution: string;
    }>
  > {
    if (!CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId)) return [];

    const claimedPositionIds = new Set<string>();
    for (const trade of internalTrades) {
      if (trade.externalOrderId) claimedPositionIds.add(trade.externalOrderId);
      if (trade.externalPositionId) claimedPositionIds.add(trade.externalPositionId);
    }

    const unresolvedTrades = internalTrades.filter(
      (trade) =>
        (trade.status === TradeStatus.PENDING ||
          trade.status === TradeStatus.RECONCILIATION_PENDING) &&
        trade.dispatchCertainty === ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER &&
        !trade.externalOrderId &&
        !trade.externalPositionId &&
        trade.createdAt instanceof Date,
    );

    const matchingPositions = (trade: Trade) =>
      providerPositions.filter((position) => {
        if (claimedPositionIds.has(position.externalOrderId)) return false;
        if (position.instrument.toUpperCase() !== trade.instrument.toUpperCase()) return false;
        if (position.direction !== trade.direction) return false;
        if (compareDecimal(position.lotSize, trade.lotSize) !== 0) return false;
        const deltaMs = position.openedAt.getTime() - trade.createdAt.getTime();
        return (
          deltaMs >= -TIMED_OUT_POSITION_CLOCK_SKEW_MS &&
          deltaMs <= TIMED_OUT_POSITION_MATCH_WINDOW_MS
        );
      });

    const resolutionRefs: Array<{
      type: string;
      internalRefId: string | null;
      providerRef: string | null;
      resolution: string;
    }> = [];

    for (const trade of unresolvedTrades) {
      const candidates = matchingPositions(trade);
      if (candidates.length !== 1) continue;
      const position = candidates[0];

      const competingTrades = unresolvedTrades.filter((other) =>
        matchingPositions(other).some(
          (candidate) => candidate.externalOrderId === position.externalOrderId,
        ),
      );
      if (competingTrades.length !== 1) continue;

      const recovered = await this.resolution.recoverTradeToOpen(trade, position);
      if (!recovered) continue;

      trade.status = TradeStatus.OPEN;
      trade.externalPositionId = position.externalOrderId;
      trade.fillPrice = position.openPrice;
      trade.openedAt = position.openedAt;
      trade.brokerRejectionReason = null;
      trade.closeReason = null;
      claimedPositionIds.add(position.externalOrderId);

      resolutionRefs.push(
        {
          type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
          internalRefId: trade.id,
          providerRef: null,
          resolution:
            'Timed-out cTrader dispatch uniquely matched provider position — trade recovered to OPEN',
        },
        {
          type: ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION,
          internalRefId: null,
          providerRef: position.externalOrderId,
          resolution:
            'Provider-only cTrader position uniquely correlated to timed-out internal dispatch',
        },
      );

      this.logger.warn(
        `Recovered timed-out cTrader trade ${trade.id}: provider position ${position.externalOrderId} ` +
          `${position.instrument} ${position.direction} ${position.lotSize} lots`,
      );
    }

    return resolutionRefs;
  }

  getProviderQuotaCooldownUntil(connectionId: string, now = Date.now()): Date | null {
    const cooldownUntil = this.providerQuotaCooldownUntilByConnection.get(connectionId) ?? 0;
    if (cooldownUntil <= now) {
      if (cooldownUntil) this.providerQuotaCooldownUntilByConnection.delete(connectionId);
      return null;
    }
    return new Date(cooldownUntil);
  }

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
      // Capture the cutoff BEFORE snapshot acquisition. Cleanup later may only
      // resolve discrepancies last seen before this point, so a newer concurrent
      // run refreshing a provider position can never be erased by this snapshot.
      const providerSnapshotStartedAt = new Date();
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

      const lateEconomicsNow = Date.now();
      const shouldInspectLateEconomics =
        CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId) &&
        String(connection.accountType).toUpperCase() === 'DEMO' &&
        lateEconomicsNow - (this.closedEconomicsLookupAtByConnection.get(connection.id) ?? 0) >=
          15 * 60_000;
      let closedUnsettledTrades: Trade[] = [];
      if (shouldInspectLateEconomics) {
        this.closedEconomicsLookupAtByConnection.set(connection.id, lateEconomicsNow);
        closedUnsettledTrades = await this.tradeRepo.find({
          where: {
            brokerConnectionId: connection.id,
            userId: connection.userId,
            status: TradeStatus.CLOSED,
            realisedPnl: IsNull(),
            commission: IsNull(),
            exitPrice: IsNull(),
            closedAt: MoreThan(new Date(lateEconomicsNow - 7 * 86400_000)),
          },
          order: { closedAt: 'DESC' },
          take: 10,
        });
      }
      const closedTrades =
        internalTrades.length + closedUnsettledTrades.length > 0
          ? await this.fetchClosedTrades(adapter, [...internalTrades, ...closedUnsettledTrades])
          : [];

      // A provider close without economics can remain CLOSED safely; if a
      // complete uniquely matched full closing deal later becomes visible,
      // fill ONLY the three NULL economics via a guarded CAS. Never create a
      // synthetic profit/commission or reorder an already closed trade.
      for (const settled of closedUnsettledTrades) {
        try {
          let tradeForProof = settled;
          // The durable FILLED market-order row may already contain the native
          // position ID even when the trade row only retained its entry order ID.
          // Use an exact, unique, ownership-bound order link for settlement proof
          // only; never copy an unverified position ID into the trade record.
          if (!settled.externalPositionId && settled.externalOrderId) {
            const storedPositionRef = await this.findVerifiedStoredPositionRef(settled);
            if (storedPositionRef) {
              tradeForProof = { ...settled, externalPositionId: storedPositionRef };
            } else if (
              !closedTrades.some((deal) => deal.externalOrderId === settled.externalOrderId)
            ) {
              // Otherwise obtain the relationship from the authenticated broker.
              const providerEntryOrder = await adapter.getOrderById(settled.externalOrderId);
              const positionRef = proveCtraderEntryOrderPositionRef(settled, providerEntryOrder);
              if (positionRef) {
                tradeForProof = { ...settled, externalPositionId: positionRef };
              }
            }
          }
          await this.resolution.backfillClosedDemoSettlement({
            trade: tradeForProof,
            brokerId: connection.brokerId,
            accountType: String(connection.accountType),
            providerDeals: closedTrades,
            observedAt: new Date(),
          });
        } catch (error) {
          this.logger.warn(
            'Late cTrader DEMO settlement proof deferred: ' + sanitizeReconciliationReason(error),
          );
        }
      }

      const preDiffResolutionRefs = await this.recoverTimedOutProviderPositions(
        connection,
        internalTrades,
        providerPositions,
      );

      const internalState = {
        orders: internalOrders.map((o) => this.toOrderSnapshot(o)),
        trades: internalTrades.map((t) => this.toTradeSnapshot(t)),
        account: storedAccount ? this.toAccountSnapshot(storedAccount) : null,
      };

      // PAPER_ONLY restart guard: the in-process simulator starts from a
      // pristine 10,000.00 account after an API process restart. Durable DB
      // state must never be overwritten by that reset fingerprint, and open
      // trades must never be falsely auto-closed with null economics simply
      // because the simulator's in-memory positions/history were lost.
      if (
        looksLikeResetPaperProviderState({
          connection,
          providerOrders,
          providerPositions,
          providerAccount,
          internalOrders,
          internalTrades,
          closedTrades,
          storedAccount,
        })
      ) {
        throw new Error(
          'PAPER_SIMULATOR_STATE_RESET: provider memory is pristine while durable account/trade ' +
            'state proves prior paper activity; reconciliation refused to overwrite durable truth',
        );
      }

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
      }> = [...preDiffResolutionRefs];
      let errors = 0;
      let autoResolvedCount = 0;

      // Resolve explicit local non-dispatch evidence without creating a fill,
      // closing a real position, retrying an order or reviving a risk grant.
      const providerClientOrderIds = new Set(
        providerOrders
          .map((o) => o.clientOrderId)
          .filter((id): id is string => typeof id === 'string'),
      );
      for (const trade of internalTrades) {
        if (!isProvenUnsentEntry(trade)) continue;
        try {
          const age = Date.now() - new Date(trade.updatedAt).getTime();
          if (!Number.isFinite(age) || age < PRE_COMMITMENT_GRACE_MS) continue;
          const orderId = await reconcileProvenUnsentEntry(
            this.tradeRepo.manager,
            trade.id,
            connection.userId,
            connection.id,
            providerClientOrderIds,
          );
          if (!orderId) continue;
          for (const internalRefId of [trade.id, orderId]) {
            resolutionRefs.push({
              type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
              internalRefId,
              providerRef: null,
              resolution: 'Proven unsent entry; order and trade rejected, allocation released',
            });
          }
        } catch (err) {
          errors++;
          this.logger.warn(
            'Proven-unsent entry convergence deferred: ' + sanitizeReconciliationReason(err),
          );
        }
      }

      // 7a. Positions: externally-closed + async-fill recovery.
      for (const trade of internalTrades) {
        try {
          // Providers such as cTrader assign a working ORDER id first and a
          // distinct POSITION id when the market order fills asynchronously.
          // Resolve that mapping before asking for the live position; treating
          // the order id as a position id leaves real exposure invisible.
          let providerPositionRef = trade.externalPositionId ?? null;
          // A known distinct native position ID must win over the legacy
          // order-ID fallback. In DEMO, the filled entry order is already
          // durable evidence; do not mark a position closed merely because
          // a native ORDER ID is absent from the provider position list.
          const storedDemoPositionRef =
            !providerPositionRef &&
            trade.status === TradeStatus.OPEN &&
            CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId) &&
            String(connection.accountType).toUpperCase() === 'DEMO'
              ? await this.findVerifiedStoredPositionRef(trade)
              : null;
          if (storedDemoPositionRef) providerPositionRef = storedDemoPositionRef;
          if (
            !providerPositionRef &&
            trade.status === TradeStatus.PENDING &&
            trade.externalOrderId
          ) {
            const providerOrder = await adapter.getOrderById(trade.externalOrderId);
            if (
              providerOrder &&
              (providerOrder.status === 'FILLED' || providerOrder.status === 'PARTIALLY_FILLED') &&
              providerOrder.providerPositionId
            ) {
              providerPositionRef = providerOrder.providerPositionId;
            }
          }
          // Legacy providers historically stored the provider position id in
          // externalOrderId. Keep that compatibility path for non-async/open
          // rows and for adapters where order and position identifiers match.
          if (!providerPositionRef) providerPositionRef = trade.externalOrderId;

          const position = providerPositionRef
            ? await adapter.getPositionById(providerPositionRef)
            : null;

          if (position === null && providerPositionRef) {
            // A PENDING trade whose provider order has not yet yielded a live
            // position is still unresolved, NOT proven closed. Never attempt
            // the illegal PENDING→CLOSED transition from mere absence.
            if (trade.status === TradeStatus.PENDING) continue;

            // Closed-trade adapters normalize their stable trade/position id
            // into externalOrderId. Match the same provider reference we used
            // for the position lookup, with a legacy order-id fallback.
            const match = closedTrades.find(
              (ct) =>
                ct.externalOrderId === providerPositionRef ||
                (!storedDemoPositionRef &&
                  trade.externalOrderId !== null &&
                  ct.externalOrderId === trade.externalOrderId),
            );
            const closed = await this.resolution.closeTradeFromProvider(trade, match ?? null);
            if (closed) {
              if (trade.tradeIntentId) {
                await this.allocationService.releaseAllocationForIntent(
                  trade.tradeIntentId,
                  'PROVIDER_POSITION_CLOSED',
                );
              }
              resolutionRefs.push({
                type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
                internalRefId: trade.id,
                providerRef: providerPositionRef,
                resolution: 'Provider reports the position closed — trade converged to CLOSED',
              });
            }
          } else if (
            position !== null &&
            (trade.status === TradeStatus.RECONCILIATION_PENDING ||
              trade.status === TradeStatus.PENDING)
          ) {
            const recovered = await this.resolution.recoverTradeToOpen(trade, position);
            if (recovered) {
              resolutionRefs.push({
                type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
                internalRefId: trade.id,
                providerRef: providerPositionRef,
                resolution: 'Provider-observed position open — trade recovered to OPEN',
              });
            }
          }

          // cTrader MARKET orders cannot carry absolute SL/TP on the new-order
          // request. Immediate fills attach them synchronously in the adapter;
          // async fills (and transient failed amendments) are repaired from
          // provider truth here. OPEN rows remain eligible so a transient
          // protection failure is retried on the next reconciliation cycle.
          if (
            position !== null &&
            connection.brokerId === 'ctrader' &&
            (trade.status === TradeStatus.PENDING ||
              trade.status === TradeStatus.RECONCILIATION_PENDING ||
              trade.status === TradeStatus.OPEN)
          ) {
            const modifications: { newStopLoss?: string; newTakeProfit?: string } = {};
            if (trade.stopLoss && trade.stopLoss !== '0' && position.stopLoss === '0') {
              modifications.newStopLoss = trade.stopLoss;
            }
            if (trade.takeProfit && trade.takeProfit !== '0' && position.takeProfit === '0') {
              modifications.newTakeProfit = trade.takeProfit;
            }
            if (modifications.newStopLoss || modifications.newTakeProfit) {
              await adapter.modifyOrder(position.externalOrderId, modifications);
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

      // Orders already attempted by the 7a2 live recovery in THIS cycle —
      // excluded from the 7a3 aged sweep below so a single cycle never
      // attempts the same order twice through two scopes (the proofs differ
      // only by the freshness fence; a retry adds nothing until the next
      // cycle re-reads the persisted status).
      const liveRecoveryAttemptedOrderIds = new Set<string>();
      // Diagnostic-only counters: no identifiers, amounts, raw provider
      // payloads or changes to recovery authority. Counts refer to candidates
      // selected this cycle, not the entire unresolved order population.
      const demoCloseRecovery = {
        recent: { selected: 0, outcomes: {} as Record<string, number> },
        aged: { selected: 0, outcomes: {} as Record<string, number> },
      };
      const recordCloseRecovery = (scope: 'recent' | 'aged', outcome: string): void => {
        const outcomes = demoCloseRecovery[scope].outcomes;
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      };

      // 7a2. Pepperstone USD DEMO only: exact broker DealList recovery for a
      // fully CLOSED position whose associated MARKET close order remained
      // RECONCILIATION_PENDING with zero fill and no provider order ID.
      // Previously closedTrades was not fetched when all trade economics were
      // already populated, leaving recent genuine closes stranded forever.
      // This is account-scoped, bounded to recent terminal evidence, and
      // uses ONLY OrderService.applyFill (exact-decimal domain CAS). No provider
      // order, no invented ticket, no mutation of trade equity/realised P&L.
      if (
        connection.brokerId === 'pepperstone-ctrader' &&
        String(connection.accountType).toUpperCase() === 'DEMO' &&
        !!process.env.VPS_FOREX_SCANNER_USER_ID &&
        connection.userId === process.env.VPS_FOREX_SCANNER_USER_ID
      ) {
        const asOf = new Date();
        const recentCloseOrders = selectRecentDemoCloseOrders(
          internalOrders,
          asOf,
          this.demoCloseRecoveryCursor.get(connection.id),
        );
        demoCloseRecovery.recent.selected = recentCloseOrders.length;
        if (recentCloseOrders.length === 0) this.demoCloseRecoveryCursor.delete(connection.id);
        else
          this.demoCloseRecoveryCursor.set(
            connection.id,
            recentCloseOrders[recentCloseOrders.length - 1].id,
          );
        for (const order of recentCloseOrders) {
          liveRecoveryAttemptedOrderIds.add(order.id);
          let recoveryStage = 'RECOVERY_TRADE_LOOKUP_ERROR';
          try {
            // An order cannot be inferred from a closed position if another
            // close order for that trade might have caused the same deal.
            if (
              internalOrders.filter(
                (o) =>
                  o.tradeId === order.tradeId &&
                  o.status === OrderStatus.RECONCILIATION_PENDING &&
                  o.orderKind === OrderKind.MARKET,
              ).length !== 1
            ) {
              recordCloseRecovery('recent', 'COMPETING_CLOSE_ORDERS');
              continue;
            }
            const trade = await this.tradeRepo.findOne({
              where: {
                id: order.tradeId!,
                userId: connection.userId,
                brokerConnectionId: connection.id,
                status: TradeStatus.CLOSED,
              },
            });
            if (
              !trade ||
              !trade.openedAt ||
              !Number.isFinite(trade.openedAt.getTime()) ||
              asOf.getTime() - trade.openedAt.getTime() > 6 * 3600_000 ||
              !trade.closedAt
            ) {
              recordCloseRecovery('recent', 'TERMINAL_TRADE_OR_TIME_UNAVAILABLE');
              continue;
            }
            // Closing deals are keyed by the native position, not the entry order.
            // Reuse the unique, ownership-bound FILLED entry proof without
            // persisting a guessed identifier or weakening the deal predicates.
            recoveryStage = 'RECOVERY_POSITION_EVIDENCE_ERROR';
            const verifiedPositionRef = trade.externalPositionId
              ? null
              : await this.findVerifiedStoredPositionRef(trade);
            const tradeForProof = verifiedPositionRef
              ? { ...trade, externalPositionId: verifiedPositionRef }
              : trade;
            if (
              providerPositions.some(
                (p) =>
                  p.externalOrderId === (tradeForProof.externalPositionId || trade.externalOrderId),
              )
            ) {
              recordCloseRecovery('recent', 'POSITION_STILL_OPEN');
              continue;
            }
            // Bounded to this specific position's original entry: querying
            // from only the close order timestamp could hide partial deals.
            recoveryStage = 'RECOVERY_PROVIDER_HISTORY_ERROR';
            const providerDeals = await adapter.getClosedTrades(
              new Date(Math.max(0, trade.openedAt.getTime() - 60_000)),
              asOf,
            );
            recoveryStage = 'RECOVERY_PROOF_EVALUATION_ERROR';
            const proof = provePepperstoneDemoClosedOrderFill({
              brokerId: connection.brokerId,
              accountType: String(connection.accountType).toUpperCase(),
              accountUserId: connection.userId,
              accountConnectionId: connection.id,
              order,
              trade: tradeForProof,
              providerClosedDeals: providerDeals,
              observedAt: asOf,
            });
            if (!proof.matched) {
              recordCloseRecovery('recent', proof.reason);
              this.logger.debug('DEMO closed-order proof deferred: ' + proof.reason);
              continue;
            }
            // The OrderService itself enforces fill <= requested and an
            // optimistic status CAS, and refuses to book a fill whose native
            // deal id is already attributed to another order row. If a
            // concurrent worker won, no duplicate fill can be booked; retry
            // rather than overwriting anything. Deal-less proofs (no native
            // deal id surfaced) are fenced on the filled_quantity premise the
            // proof was derived from: a concurrent worker that already moved
            // the accounting makes this delivery an idempotent no-op — no
            // identifier is fabricated to dedup on.
            recoveryStage = 'RECOVERY_FILL_ACCOUNTING_ERROR';
            const completed = await this.orderService.applyFill(
              order.id,
              {
                quantity: proof.quantity,
                price: proof.price,
                providerOrderId: proof.orderId ?? null,
                providerPositionId: proof.positionRef,
                ...(proof.dealId != null ? { providerDealId: proof.dealId } : {}),
              },
              proof.dealId != null ? {} : { expectedFilledQuantity: order.filledQuantity ?? '0' },
            );
            if (completed.status !== OrderStatus.FILLED)
              throw new Error('Broker-deal-proven close order was not terminally reconciled');
            recordCloseRecovery('recent', 'FILLED_WITH_PROOF');
            resolutionRefs.push({
              type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
              internalRefId: order.id,
              providerRef: null,
              resolution:
                'Pepperstone DEMO uniquely matched closed deal: ' +
                'exact position, side, lots, exit, gross P&L and timestamp; ' +
                'close order fill booked via exact-decimal domain CAS',
            });
            autoResolvedCount++;
          } catch (error) {
            recordCloseRecovery('recent', recoveryStage);
            errors++;
            this.logger.warn(
              'Pepperstone DEMO closed-order deal convergence ' +
                'deferred for order ' +
                order.id +
                ': ' +
                sanitizeReconciliationReason(error),
            );
          }
        }
      }

      // 7a3. cTrader-family DEMO, aged historical scope: the same exact
      // DealList proof WITHOUT the six-hour freshness fence, across every
      // family DEMO account (generic ctrader included), with a fair rotating
      // budget. This is the convergence path for stranded close orders whose
      // trades closed days or weeks ago (the 375-record incident): the
      // ordinary order sweep skips orders without a provider order id, so
      // without this path they would remain RECONCILIATION_PENDING forever.
      // LIVE accounts are excluded — LIVE order-row recovery stays subject
      // to independent operator review. No identifiers are invented; the
      // proof re-verifies the full account/side/volume/exit/P&L/timestamp.
      if (
        CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId) &&
        String(connection.accountType).toUpperCase() === 'DEMO'
      ) {
        const agedAsOf = new Date();
        const agedCandidates = selectAgedDemoCloseRecoveryCandidates(
          internalOrders,
          agedAsOf,
          this.agedDemoCloseRecoveryCursor.get(connection.id),
        ).filter((candidate) => !liveRecoveryAttemptedOrderIds.has(candidate.id));
        demoCloseRecovery.aged.selected = agedCandidates.length;
        if (agedCandidates.length === 0) this.agedDemoCloseRecoveryCursor.delete(connection.id);
        else
          this.agedDemoCloseRecoveryCursor.set(
            connection.id,
            agedCandidates[agedCandidates.length - 1].id,
          );
        for (const order of agedCandidates) {
          let recoveryStage = 'RECOVERY_TRADE_LOOKUP_ERROR';
          try {
            const trade = await this.tradeRepo.findOne({
              where: {
                id: order.tradeId!,
                userId: connection.userId,
                brokerConnectionId: connection.id,
                status: TradeStatus.CLOSED,
              },
            });
            if (
              !trade ||
              !trade.openedAt ||
              !Number.isFinite(trade.openedAt.getTime()) ||
              !trade.closedAt
            ) {
              recordCloseRecovery('aged', 'TERMINAL_TRADE_OR_TIME_UNAVAILABLE');
              continue;
            }
            // Closing deals are keyed by the native position, not the entry order.
            // Reuse the unique, ownership-bound FILLED entry proof without
            // persisting a guessed identifier or weakening the deal predicates.
            recoveryStage = 'RECOVERY_POSITION_EVIDENCE_ERROR';
            const verifiedPositionRef = trade.externalPositionId
              ? null
              : await this.findVerifiedStoredPositionRef(trade);
            const tradeForProof = verifiedPositionRef
              ? { ...trade, externalPositionId: verifiedPositionRef }
              : trade;
            if (
              providerPositions.some(
                (p) =>
                  p.externalOrderId === (tradeForProof.externalPositionId || trade.externalOrderId),
              )
            ) {
              recordCloseRecovery('aged', 'POSITION_STILL_OPEN');
              continue;
            }
            // Bounded to this specific position's original entry: querying
            // from only the close order timestamp could hide partial deals.
            recoveryStage = 'RECOVERY_PROVIDER_HISTORY_ERROR';
            const providerDeals = await adapter.getClosedTrades(
              new Date(Math.max(0, trade.openedAt.getTime() - 60_000)),
              agedAsOf,
            );
            // Aged trades with NULL close economics need the settlement
            // backfilled FIRST (NULL-only CAS, unique-deal proof) so the
            // order-row proof has exit price / realised P&L to verify.
            recoveryStage = 'RECOVERY_SETTLEMENT_BACKFILL_ERROR';
            if (agedTradeNeedsSettlementBackfill(trade)) {
              const backfilled = await this.resolution.backfillClosedDemoSettlement({
                trade: tradeForProof,
                brokerId: connection.brokerId,
                accountType: String(connection.accountType).toUpperCase(),
                providerDeals,
                observedAt: agedAsOf,
              });
              if (backfilled) {
                const refreshed = await this.tradeRepo.findOne({
                  where: { id: trade.id, status: TradeStatus.CLOSED },
                });
                if (refreshed) Object.assign(trade, refreshed);
              }
            }
            recoveryStage = 'RECOVERY_PROOF_EVALUATION_ERROR';
            const proof = proveAgedCtraderDemoClosedOrderFill({
              brokerId: connection.brokerId,
              accountType: String(connection.accountType).toUpperCase(),
              accountUserId: connection.userId,
              accountConnectionId: connection.id,
              order,
              trade: verifiedPositionRef
                ? { ...trade, externalPositionId: verifiedPositionRef }
                : trade,
              providerClosedDeals: providerDeals,
              observedAt: agedAsOf,
            });
            if (!proof.matched) {
              recordCloseRecovery('aged', proof.reason);
              this.logger.debug('DEMO closed-order proof deferred: ' + proof.reason);
              continue;
            }
            // The OrderService itself enforces fill <= requested and an
            // optimistic status CAS, and refuses to book a fill whose native
            // deal id is already attributed to another order row. If a
            // concurrent worker won, no duplicate fill can be booked; retry
            // rather than overwriting anything. Deal-less proofs (no native
            // deal id surfaced) are fenced on the filled_quantity premise the
            // proof was derived from: a concurrent worker that already moved
            // the accounting makes this delivery an idempotent no-op — no
            // identifier is fabricated to dedup on.
            recoveryStage = 'RECOVERY_FILL_ACCOUNTING_ERROR';
            const completed = await this.orderService.applyFill(
              order.id,
              {
                quantity: proof.quantity,
                price: proof.price,
                providerOrderId: proof.orderId ?? null,
                providerPositionId: proof.positionRef,
                ...(proof.dealId != null ? { providerDealId: proof.dealId } : {}),
              },
              proof.dealId != null ? {} : { expectedFilledQuantity: order.filledQuantity ?? '0' },
            );
            if (completed.status !== OrderStatus.FILLED)
              throw new Error('Aged DEMO close order was not terminally reconciled');
            recordCloseRecovery('aged', 'FILLED_WITH_PROOF');
            resolutionRefs.push({
              type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
              internalRefId: order.id,
              providerRef: null,
              resolution:
                'Aged cTrader DEMO uniquely matched closed deal: ' +
                'exact position, side, lots, exit, gross P&L and timestamp ' +
                '(historical scope, no freshness fence); ' +
                'close order fill booked via exact-decimal domain CAS',
            });
            autoResolvedCount++;
          } catch (error) {
            recordCloseRecovery('aged', recoveryStage);
            errors++;
            this.logger.warn(
              'Aged DEMO closed-order recovery deferred for order ' +
                order.id +
                ': ' +
                sanitizeReconciliationReason(error),
            );
          }
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

      // A provider-only position discrepancy remains CRITICAL while the
      // provider still reports that position. Once a complete successful
      // provider snapshot no longer contains the provider ref, only the stale
      // alert is converged to RESOLVED — no internal trade/order is invented.
      const currentProviderPositionRefs = providerPositions
        .map((position) => position.externalOrderId)
        .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
      const staleUnknownProviderRows = await this.persistence.resolveAbsentUnknownProviderPositions(
        connection.id,
        currentProviderPositionRefs,
        providerSnapshotStartedAt,
      );

      // ── Resolve the discrepancy rows this run actually converged ────────
      const resolvedRows = [
        ...(await this.persistence.resolveDiscrepanciesByRef(connection.id, resolutionRefs)),
        ...staleUnknownProviderRows,
      ];
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
          demoCloseRecovery,
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

      this.providerQuotaCooldownUntilByConnection.delete(connection.id);

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
      // Provider read failure or unexpected error → FAILED run. MetaAPI quota
      // exhaustion and deployment-funding blocks are operational rather than
      // state-corruption: record the failed run once, then cool down only the
      // read-heavy reconciliation sweep for this connection. Stop-AI flattening
      // and protective-order safety remain owned by the job and continue every cycle.
      const metaApiConnection = ['metatrader4', 'metatrader5'].includes(connection.brokerId);
      const metaApiQuotaLimited = metaApiConnection && isMetaApiQuotaError(err);
      const metaApiDeploymentFundingBlocked =
        metaApiConnection && isMetaApiDeploymentFundingError(err);
      const metaApiProviderBackoff = metaApiQuotaLimited || metaApiDeploymentFundingBlocked;
      const cooldownUntil = metaApiProviderBackoff
        ? Date.now() + METAAPI_PROVIDER_QUOTA_COOLDOWN_MS
        : null;
      if (cooldownUntil) {
        this.providerQuotaCooldownUntilByConnection.set(connection.id, cooldownUntil);
      }

      // Redact before the failure reaches any durable or observable sink.
      const message = sanitizeReconciliationReason(err);
      await this.persistence.failRun(run.id, message);
      await this.auditService
        .log({
          actorUserId: connection.userId,
          action: AuditAction.RECONCILIATION_RUN_FAILED,
          resourceType: 'BrokerConnection',
          resourceId: connection.id,
          severity: metaApiProviderBackoff ? AuditSeverity.WARNING : AuditSeverity.CRITICAL,
          metadata: {
            runId: run.id,
            brokerId: connection.brokerId,
            reason: message,
            providerQuotaCooldownUntil: cooldownUntil
              ? new Date(cooldownUntil).toISOString()
              : null,
          },
        })
        .catch(() => undefined);
      if (cooldownUntil) {
        this.logger.warn(
          `Reconciliation run ${run.id} provider-backoff; connection=${connection.id} ` +
            `full sweep cooling down until ${new Date(cooldownUntil).toISOString()}: ${message}`,
        );
      } else {
        this.logger.error(`Reconciliation run ${run.id} FAILED: ${message}`);
      }
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

  /** Read only an exact, unique, ownership-bound FILLED market order. */
  private async findVerifiedStoredPositionRef(trade: Trade): Promise<string | null> {
    if (!trade.externalOrderId) return null;
    const linkedOrders = await this.orderRepo.find({
      where: {
        tradeId: trade.id,
        userId: trade.userId,
        brokerConnectionId: trade.brokerConnectionId,
        providerOrderId: trade.externalOrderId,
        orderKind: OrderKind.MARKET,
        status: OrderStatus.FILLED,
      },
      take: 2,
    });
    const linked = linkedOrders.length === 1 ? linkedOrders[0] : null;
    const decimal = /^\d+(?:\.\d+)?$/;
    if (
      !linked ||
      linked.tradeId !== trade.id ||
      linked.userId !== trade.userId ||
      linked.brokerConnectionId !== trade.brokerConnectionId ||
      linked.providerOrderId !== trade.externalOrderId ||
      linked.orderKind !== OrderKind.MARKET ||
      linked.status !== OrderStatus.FILLED ||
      !/^\d+$/.test(linked.providerOrderId ?? '') ||
      !/^\d+$/.test(linked.providerPositionId ?? '') ||
      linked.providerPositionId === '0' ||
      linked.instrument !== trade.instrument ||
      linked.direction !== trade.direction ||
      ![linked.filledQuantity, linked.avgFillPrice, trade.lotSize, trade.fillPrice].every(
        (value) => typeof value === 'string' && decimal.test(value),
      ) ||
      compareDecimal(linked.filledQuantity, trade.lotSize) !== 0 ||
      compareDecimal(linked.avgFillPrice!, trade.fillPrice!) !== 0
    )
      return null;
    return linked.providerPositionId;
  }

  /** Best-effort provider closed-trade economics for external closes. */
  private async fetchClosedTrades(
    adapter: {
      readonly brokerId?: string;
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
      // The PAPER_ONLY provider uses a deterministic/replay clock whose
      // timestamps intentionally do not share wall-clock chronology with
      // trading.trades.openedAt. Fetch its complete durable close history and
      // match by provider id. Real brokers retain the bounded time window.
      const from = adapter.brokerId === 'paper-broker' ? new Date(0) : (earliest ?? new Date(0));
      return await adapter.getClosedTrades(from, new Date());
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
