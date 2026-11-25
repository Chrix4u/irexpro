import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Order } from './order.entity';
import {
  OrderFillEvidenceClass,
  OrderKind,
  OrderStatus,
  OrderTimeInForce,
  ORDER_KINDS,
  ORDER_TIME_IN_FORCES,
} from './order.enums';
import { OrderStateMachine } from './order-state-machine';
import { compareDecimal } from '../reconciliation/reconciliation-comparator';

/** Non-terminal order statuses the reconciliation cycle may still converge. */
const RECONCILABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.CREATED,
  OrderStatus.SUBMITTED,
  OrderStatus.DISPATCH_COMMITTED,
  OrderStatus.ACKNOWLEDGED,
  OrderStatus.PARTIALLY_FILLED,
  OrderStatus.RECONCILIATION_PENDING,
];

/** Input contract for idempotent order submission. */
export interface SubmitOrderInput {
  userId: string;
  brokerConnectionId: string;
  /** REQUIRED caller-supplied stable identifier — the idempotency surface. */
  clientOrderId: string;
  orderKind: OrderKind;
  timeInForce: OrderTimeInForce;
  instrument: string;
  direction: 'BUY' | 'SELL';
  /** Decimal string, > 0, scale ≤ 4. */
  requestedQuantity: string;
  /** Required for LIMIT/STOP_LIMIT. Decimal string, scale ≤ 8. */
  requestedPrice?: string | null;
  /** Required for STOP/STOP_LIMIT. Decimal string, scale ≤ 8. */
  stopPrice?: string | null;
  signalId?: string | null;
  tradeId?: string | null;
}

export type OrderSubmissionResult =
  | { status: 'RESERVED_NEW'; order: Order }
  | { status: 'DUPLICATE_EXISTING'; order: Order };

export interface ApplyFillInput {
  /** Fill quantity in lots (decimal string, > 0, scale ≤ 4). */
  quantity: string;
  /** Fill price (decimal string, > 0, scale ≤ 8). */
  price: string;
  providerOrderId?: string | null;
  /** Native broker POSITION id for MARKET fills (cTrader positionId). */
  providerPositionId?: string | null;
  /** Native broker DEAL id that proved this fill (cTrader dealId) — provider
   *  evidence only. Present → the fill is recorded in the immutable ledger
   *  as PROVIDER_DEAL grade (replay-detectable). Absent → recorded with a
   *  NULL deal id and its actual evidence class; never fabricated. */
  providerDealId?: string | null;
}

export interface ApplyFillOptions {
  /**
   * STATE-PREMISE FENCE — concurrent unidentified-evidence defence
   * (2026-11-25 continuation): the internal filled_quantity the caller
   * OBSERVED when it derived this fill from provider STATE — a
   * provider-order-state delta, a stranded-order convergence, or a
   * dispatch response that surfaced NO native deal id. Under the row
   * lock, applyFill refuses to book when the premise is stale: a
   * concurrent writer already changed this order's accounting, so the
   * derived delivery is a duplicate OF STATE, not new evidence — it
   * no-ops idempotently and the next reconciliation sweep re-evaluates
   * with a fresh premise. No identifier is fabricated to dedup on.
   *
   * Deal-grade deliveries (providerDealId present) must NOT carry the
   * fence: a genuinely NEW native deal must book regardless of
   * interleaving, and its duplicates are deduplicated by the ledger
   * instead — passing both fails closed (BadRequestException).
   */
  expectedFilledQuantity?: string;
}

/** Where a deal-ownership answer came from (findDealOwner). */
export type DealOwnershipSource = 'LEDGER_EVIDENCE' | 'ORDER_ROW_POINTER';

/**
 * Result of findDealOwner (review finding 2): the accounting-ownership
 * assessment of a native deal id against ALL available historical evidence
 * — the immutable ledger (complete history) and the order-row latest-deal
 * pointers (legacy population). `orderId` is the resolved owner ONLY when
 * unambiguous; `ambiguous` marks disagreeing evidence (e.g. the ledger
 * attributes the deal to one order while a legacy order-row pointer on the
 * same connection carries it too) — ambiguous cases expose every candidate
 * for accounting review instead of silently picking a winner.
 */
export interface DealOwnershipLookup {
  orderId: string | null;
  ambiguous: boolean;
  sources: DealOwnershipSource[];
  candidateOrderIds: string[];
}

const QUANTITY_PATTERN = /^\d+(\.\d{1,4})?$/;
const PRICE_PATTERN = /^\d+(\.\d{1,8})?$/;
const CLIENT_ORDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * OrderService — normalized order domain: idempotent submission, explicit
 * state-machine transitions, and atomic exact-decimal fill accounting.
 *
 * IDEMPOTENCY (Directive PHASE C / PR-2 scope "idempotency"):
 * Mirrors the Sprint 32 Gate 3 reservation pattern — a single short DB
 * transaction acquires a per-user advisory lock, checks the idempotency key,
 * and INSERTs the CREATED order. The unique constraint on idempotency_key is
 * the final safety net. The INSERT runs behind a savepoint so a PostgreSQL
 * 23505 can be rolled back locally before reading the winning row; without
 * that savepoint PostgreSQL would leave the whole transaction aborted.
 * Broker network I/O happens AFTER this method returns — never inside the
 * transaction.
 *
 * DECIMAL SAFETY: avg-fill-price is computed inside PostgreSQL numeric
 * arithmetic (exact) — never in JS floats.
 *
 * This is the DOMAIN layer. Execution orchestration (risk-gating, adapter
 * dispatch, trade linking) arrives in the PR-3 slice; HTTP surface in PR-5.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    private readonly dataSource: DataSource,
  ) {}

  // ─── Idempotent submission ────────────────────────────────────────────────

  async submitOrder(input: SubmitOrderInput): Promise<OrderSubmissionResult> {
    this.validateSubmission(input);

    const idempotencyKey = this.generateIdempotencyKey(input.userId, input.clientOrderId);
    const lockKey = this.computeUserLockKey(input.userId);

    const result = await this.dataSource.transaction(async (manager) => {
      // 1. Advisory lock scoped to the user — serializes concurrent
      //    submissions from the same user so the idempotency check and the
      //    INSERT are atomic with respect to each other.
      await manager.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      // 2. Idempotency check inside the transaction.
      const existing = await manager.query(
        `SELECT * FROM trading.orders WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey],
      );
      if (existing.length > 0) {
        return {
          status: 'DUPLICATE_EXISTING' as const,
          order: this.hydrateOrderRow(existing[0] as Record<string, unknown>),
        };
      }

      // 3. INSERT the CREATED order inside a savepoint. PostgreSQL marks a
      //    transaction aborted after a constraint error, so the savepoint is
      //    mandatory if we want to recover from a 23505 and read the winner.
      await manager.query('SAVEPOINT order_insert');
      try {
        const inserted = await manager.query(
          `INSERT INTO trading.orders
             (id, user_id, broker_connection_id, trade_id, signal_id,
              client_order_id, idempotency_key, provider_order_id,
              order_kind, time_in_force, instrument, direction,
              requested_quantity, requested_price, stop_price,
              filled_quantity, avg_fill_price, status,
              submitted_at, finalized_at, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NULL,
                   $7, $8, $9, $10, $11, $12, $13,
                   0, NULL, 'CREATED', NULL, NULL, NOW(), NOW())
           RETURNING *`,
          [
            input.userId,
            input.brokerConnectionId,
            input.tradeId ?? null,
            input.signalId ?? null,
            input.clientOrderId,
            idempotencyKey,
            input.orderKind,
            input.timeInForce,
            input.instrument,
            input.direction,
            input.requestedQuantity,
            input.requestedPrice ?? null,
            input.stopPrice ?? null,
          ],
        );
        await manager.query('RELEASE SAVEPOINT order_insert');
        return { status: 'RESERVED_NEW' as const, order: this.hydrateOrderRow(inserted[0]) };
      } catch (err) {
        if (this.isUniqueConstraintViolation(err)) {
          await manager.query('ROLLBACK TO SAVEPOINT order_insert');
          const duplicate = await manager.query(
            `SELECT * FROM trading.orders WHERE idempotency_key = $1 LIMIT 1`,
            [idempotencyKey],
          );
          if (duplicate.length > 0) {
            await manager.query('RELEASE SAVEPOINT order_insert');
            return {
              status: 'DUPLICATE_EXISTING' as const,
              order: this.hydrateOrderRow(duplicate[0]),
            };
          }
        }
        throw err;
      }
    });

    if (result.status === 'DUPLICATE_EXISTING') {
      this.logger.debug(
        `Duplicate order submission (clientOrderId=${input.clientOrderId}) — returning existing ${result.order.id}`,
      );
    }
    return result;
  }

  // ─── Lifecycle transitions ────────────────────────────────────────────────

  /** CREATED → SUBMITTED. Records provider order ID if already known. */
  async markSubmitted(orderId: string, providerOrderId?: string | null): Promise<Order> {
    return this.applyTransition(orderId, OrderStatus.SUBMITTED, {
      providerOrderId: providerOrderId ?? null,
      setSubmittedAt: true,
    });
  }

  /** SUBMITTED → ACKNOWLEDGED. Records the broker-side order identifier. */
  async markAcknowledged(
    orderId: string,
    providerOrderId: string,
    extras: { providerPositionId?: string | null } = {},
  ): Promise<Order> {
    if (!providerOrderId || providerOrderId.trim().length === 0) {
      throw new BadRequestException('providerOrderId is required to acknowledge an order');
    }
    const order = await this.applyTransition(orderId, OrderStatus.ACKNOWLEDGED, {
      providerOrderId,
      ...(extras.providerPositionId != null
        ? { providerPositionId: extras.providerPositionId }
        : {}),
    });
    return order;
  }

  /** Any non-terminal state → REJECTED (terminal). Reason is required. */
  async rejectOrder(orderId: string, reason: string): Promise<Order> {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('reject reason is required');
    }
    return this.applyTransition(orderId, OrderStatus.REJECTED, {
      rejectReason: reason.slice(0, 500),
    });
  }

  /** Working state → CANCELLED (terminal). Filled quantity (if any) stands. */
  async cancelOrder(orderId: string, reason?: string | null): Promise<Order> {
    return this.applyTransition(orderId, OrderStatus.CANCELLED, {
      rejectReason: reason ? reason.slice(0, 500) : null,
    });
  }

  /** Working state → EXPIRED (terminal). E.g. DAY TIF at end of session. */
  async expireOrder(orderId: string): Promise<Order> {
    return this.applyTransition(orderId, OrderStatus.EXPIRED, {});
  }

  /** Fillable state → RECONCILIATION_PENDING (provider outcome unknown). */
  async markReconciliationPending(orderId: string): Promise<Order> {
    return this.applyTransition(orderId, OrderStatus.RECONCILIATION_PENDING, {});
  }

  /**
   * Resolve a reconciliation-held order to a NON-FILL-BEARING state.
   *
   * FILLED / PARTIALLY_FILLED are intentionally rejected here. Those states
   * carry economic facts (filled quantity + average fill price) and therefore
   * must be reached through applyFill(), which performs exact-decimal atomic
   * accounting. A status-only reconciliation must never invent a fill.
   */
  async resolveReconciliation(
    orderId: string,
    resolvedTo: OrderStatus,
    data: { providerOrderId?: string | null; rejectReason?: string | null } = {},
  ): Promise<Order> {
    if (resolvedTo === OrderStatus.FILLED || resolvedTo === OrderStatus.PARTIALLY_FILLED) {
      throw new ConflictException(
        'Fill-bearing reconciliation must use applyFill with authoritative quantity and price',
      );
    }

    return this.applyTransition(orderId, resolvedTo, {
      providerOrderId: data.providerOrderId ?? null,
      rejectReason: data.rejectReason ? data.rejectReason.slice(0, 500) : null,
    });
  }

  /**
   * FILL-BEARING reconciliation resolution (Sprint 56 correction round 4,
   * architect finding 7): resolves a RECONCILIATION_PENDING order onto a
   * provider-observed FILLED / PARTIALLY_FILLED state WITHOUT inventing
   * economic facts.
   *
   * The caller (reconciliation) applies any MISSING fill delta through
   * applyFill() FIRST — that atomic path itself transitions the order to
   * PARTIALLY_FILLED/FILLED. This entry point is for the remaining case: the
   * internal fill facts ALREADY agree with the provider (no delta) and only
   * the provider-observed STATUS must be recorded. Guards:
   * - target FILLED requires the recorded fill to have reached the requested
   *   quantity;
   * - target PARTIALLY_FILLED requires a non-zero recorded fill;
   * - the order must currently be RECONCILIATION_PENDING (CAS via the state
   *   machine transition).
   * A pending order with no recorded fill CANNOT reach a fill-bearing state
   * here — its delta must be applied through applyFill (fail-closed).
   */
  async resolveReconciliationFillState(
    orderId: string,
    target: OrderStatus,
    data: { providerOrderId?: string | null } = {},
  ): Promise<Order> {
    if (target !== OrderStatus.FILLED && target !== OrderStatus.PARTIALLY_FILLED) {
      throw new ConflictException(
        'Fill-bearing reconciliation resolution targets are FILLED/PARTIALLY_FILLED only',
      );
    }
    const current = await this.findOrderById(orderId);
    if (!current) throw new NotFoundException(`Order ${orderId} not found`);
    if (current.status !== OrderStatus.RECONCILIATION_PENDING) {
      throw new ConflictException(
        `Order ${orderId} is not RECONCILIATION_PENDING (status: ${current.status})`,
      );
    }
    const filled = current.filledQuantity ?? '0';
    if (target === OrderStatus.FILLED && compareDecimal(filled, current.requestedQuantity) < 0) {
      throw new ConflictException(
        `Order ${orderId} cannot resolve to FILLED — the recorded fill ${filled} has not ` +
          `reached the requested quantity ${current.requestedQuantity}; apply the provider ` +
          'fill delta through applyFill first (fail-closed — a status write never invents a fill).',
      );
    }
    if (target === OrderStatus.PARTIALLY_FILLED && compareDecimal(filled, '0') <= 0) {
      throw new ConflictException(
        `Order ${orderId} cannot resolve to PARTIALLY_FILLED — no fill is recorded; apply ` +
          'the provider fill delta through applyFill first (fail-closed).',
      );
    }
    return this.applyTransition(orderId, target, {
      providerOrderId: data.providerOrderId ?? null,
      rejectReason: `Reconciliation resolved by provider fill-bearing state ${target}`,
    });
  }

  /**
   * Atomic fill application with EXACT decimal arithmetic (computed in
   * PostgreSQL, never in JS floats) — booked against the IMMUTABLE per-fill
   * accounting evidence ledger (trading.order_fill_evidence, migrations
   * 1795564800000 + hardening 1795628400000).
   *
   * - ONE transaction, all-or-nothing: the append-only ledger row(s) and the
   *   order-row update commit together or not at all (a refused fill leaves
   *   no accounting event behind).
   * - SELECT ... FOR UPDATE serializes concurrent fill accounting for the
   *   same order; the ledger dedup read happens under that lock.
   * - DEAL-GRADE REPLAY DETECTION: the fill's provider deal id is looked up
   *   in the ledger — EVERY historical fill identifier is retained forever
   *   (the per-fill rows, plus the retained legacy pointer via the
   *   LEGACY_BASELINE row), so a replayed delivery of an EARLIER partial
   *   fill (whose identifier the order-row pointer has since overwritten)
   *   is an idempotent no-op, never a second booking. This closes the
   *   confirmed partial-fill accounting defect (0.10 + 0.10 + replayed
   *   0.10 = 0.30).
   * - CONTRADICTORY-EVIDENCE DEFENCE (review finding 3): a redelivery of an
   *   already-booked native deal whose quantity/price (or associated native
   *   order/position ids, when both sides carry them) DIFFER from the booked
   *   evidence row is NOT an identical replay — it is refused with a typed
   *   Conflict stating both facts. Inconsistent financial information is
   *   never silently accepted; the booked evidence row stands immutable.
   * - LEGACY BASELINE CAPTURE (review finding 1): when a MIXED-ERA order
   *   (quantity booked before the ledger existed) books its FIRST
   *   ledger-era fill, the pre-ledger cumulative accounting state is
   *   transcribed into one LEGACY_BASELINE row in the same transaction — a
   *   baseline summary (retained legacy pointer, cumulative quantity,
   *   cumulative average price), NOT a reconstructed per-fill deal. The
   *   retained identifier stays in the dedup surface FOREVER, so replays of
   *   the pre-ledger latest deal remain detected even after the order-row
   *   pointer moves to newer fills. The per-fill identifiers destroyed by
   *   the old overwrite defect are NOT recoverable and are NOT invented.
   * - LEGACY-COMPAT pointer check: fills booked before the ledger existed
   *   (no ledger row — history was never fabricated) remain
   *   replay-protected by comparing against the order-row provider_deal_id
   *   until the baseline row takes over that duty.
   * - One native broker deal may be credited to at most ONE internal order:
   *   a ledger row attributed to a different order fails closed
   *   (ConflictException); the concurrent cross-order case is refused by the
   *   partial unique index uq_order_fill_evidence_deal (23505 → typed
   *   Conflict, transaction rolled back).
   * - INCOMPLETE EVIDENCE (review finding 4): fills with no native deal id
   *   are recorded with provider_deal_id NULL and their derived
   *   evidence_class — identifiers are never fabricated; such rows carry no
   *   replay protection (the honest limit of unidentified evidence: each
   *   delivery books as a new accounting event).
   * - Atomically increments filled_quantity; recomputes avg_fill_price as
   *   the volume-weighted average; moves status to PARTIALLY_FILLED or
   *   FILLED (terminal) exactly when the requested quantity is reached, and
   *   stamps finalized_at on FILLED.
   * - FAIL-CLOSED on overfill: WHERE filled_quantity + $qty <= requested_quantity.
   * - Only fillable states (per OrderStateMachine.isFillable) may receive fills.
   * - TERMINAL-STATE REDELIVERY CLASSIFICATION (2026-11-25 continuation):
   *   the dedup classification (ledger + legacy pointer) runs BEFORE the
   *   fillable gate, so a redelivered already-booked deal is an idempotent
   *   no-op EVEN AFTER the order reached FILLED/CANCELLED/EXPIRED/REJECTED
   *   — a duplicate delivery of booked evidence must never surface as a
   *   fake "not fillable" conflict (broker event redelivery on reconnect,
   *   repeated or concurrent reconciliation). A genuinely NEW deal on a
   *   non-fillable state still fails closed with a typed Conflict.
   * - STATE-PREMISE FENCE (2026-11-25 continuation): state-derived
   *   unidentified deliveries may pass the filled_quantity premise they
   *   were derived from (ApplyFillOptions.expectedFilledQuantity); a stale
   *   premise (a concurrent writer already moved the accounting) makes the
   *   delivery a duplicate OF STATE — an idempotent no-op, never a second
   *   booking, and never a fabricated identifier.
   */
  async applyFill(
    orderId: string,
    fill: ApplyFillInput,
    options: ApplyFillOptions = {},
  ): Promise<Order> {
    this.validateFill(fill);
    this.validateFillOptions(fill, options);

    const current = await this.findOrderById(orderId);
    if (!current) throw new NotFoundException(`Order ${orderId} not found`);
    const identifiedDelivery = fill.providerDealId != null && fill.providerDealId !== '';
    // Fail fast ONLY for deliveries that cannot be a recognized duplicate:
    // an identified delivery must reach the locked classification below —
    // a redelivered already-booked deal is an idempotent no-op even after
    // the order reached a terminal state (duplicate delivery after FILLED).
    if (!identifiedDelivery && !OrderStateMachine.isFillable(current.status)) {
      throw new ConflictException(`Order ${orderId} is not fillable (status: ${current.status})`);
    }

    return this.dataSource.transaction(async (manager) => {
      // 1. Lock the order row — serializes concurrent fill accounting for
      //    THIS order and re-reads the authoritative in-transaction state.
      const lockedRows: Record<string, unknown>[] = await manager.query(
        `SELECT * FROM trading.orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      if (lockedRows.length === 0) throw new NotFoundException(`Order ${orderId} not found`);
      const locked = this.hydrateOrderRow(lockedRows[0]!);

      // 0. STATE-PREMISE FENCE (concurrent unidentified-evidence defence):
      //    the caller derived this fill from provider state observed when the
      //    order's filled_quantity was `options.expectedFilledQuantity`. If a
      //    concurrent writer changed the accounting since, this delivery is a
      //    duplicate OF STATE — an idempotent no-op; the next sweep
      //    re-evaluates. Only valid for unidentified deliveries (validated
      //    up front: a deal-grade delivery never carries the fence — the
      //    ledger owns its dedup, and a genuinely new native deal must book
      //    regardless of interleaving).
      if (options.expectedFilledQuantity != null) {
        if (compareDecimal(locked.filledQuantity ?? '0', options.expectedFilledQuantity) !== 0) {
          this.logger.log(
            `Fill for order ${orderId} skipped — the state premise ${options.expectedFilledQuantity} ` +
              `is stale (locked filled_quantity ${locked.filledQuantity ?? '0'}): a concurrent ` +
              'writer already changed the accounting, so the derived delivery is a duplicate of ' +
              'state; the next reconciliation sweep re-evaluates',
          );
          return locked;
        }
      }

      // 2. Ledger dedup — deal-grade replay detection WITH
      //    contradictory-evidence defence (review finding 3). The immutable
      //    ledger retains EVERY historical fill identifier (per-fill rows +
      //    the retained legacy pointer via LEGACY_BASELINE), so this catches
      //    replays of earlier partial fills whose identifier the order-row
      //    pointer has since overwritten. A deal already booked on THIS
      //    order is an idempotent no-op — for PROVIDER_DEAL evidence the
      //    delivered economics must MATCH the booked evidence row exactly,
      //    otherwise the redelivery is contradictory evidence and fails
      //    closed; a deal attributed to a DIFFERENT order of the same broker
      //    connection fails closed.
      if (fill.providerDealId != null && fill.providerDealId !== '') {
        const booked: Record<string, unknown>[] = await manager.query(
          `SELECT order_id, quantity, price, provider_order_id, provider_position_id, evidence_class
           FROM trading.order_fill_evidence
           WHERE broker_connection_id = $1 AND provider_deal_id = $2
           LIMIT 1`,
          [locked.brokerConnectionId, fill.providerDealId],
        );
        if (booked.length > 0) {
          const bookedRow = booked[0]!;
          const ownerOrderId = bookedRow.order_id as string;
          if (ownerOrderId !== orderId) {
            throw new ConflictException(
              `Provider deal ${fill.providerDealId} is already attributed to order ` +
                `${ownerOrderId} — a single broker deal cannot be credited to multiple ` +
                'internal orders',
            );
          }
          if (String(bookedRow.evidence_class) === 'PROVIDER_DEAL') {
            // Genuine duplicate ⟺ identical economics. The same native deal
            // redelivered with a DIFFERENT quantity/price — or with different
            // associated native identifiers when both deliveries carry them —
            // is NOT an identical replay: it is contradictory accounting
            // evidence. Refused stating both facts; the booked row is
            // immutable and stands.
            const bookedQuantity = String(bookedRow.quantity ?? '');
            const bookedPrice = String(bookedRow.price ?? '');
            const bookedOrderId = (bookedRow.provider_order_id as string | null) ?? null;
            const bookedPositionId = (bookedRow.provider_position_id as string | null) ?? null;
            const quantityMatches = compareDecimal(fill.quantity, bookedQuantity) === 0;
            const priceMatches = compareDecimal(fill.price, bookedPrice) === 0;
            const orderIdsAgree =
              bookedOrderId == null ||
              fill.providerOrderId == null ||
              bookedOrderId === fill.providerOrderId;
            const positionIdsAgree =
              bookedPositionId == null ||
              fill.providerPositionId == null ||
              bookedPositionId === fill.providerPositionId;
            if (!quantityMatches || !priceMatches || !orderIdsAgree || !positionIdsAgree) {
              throw new ConflictException(
                `Contradictory accounting evidence for provider deal ${fill.providerDealId}: ` +
                  `booked quantity ${bookedQuantity} at price ${bookedPrice}` +
                  `${bookedOrderId ? ` (provider order ${bookedOrderId})` : ''}` +
                  `${bookedPositionId ? ` (provider position ${bookedPositionId})` : ''} ` +
                  `vs delivered quantity ${fill.quantity} at price ${fill.price}` +
                  `${fill.providerOrderId ? ` (provider order ${fill.providerOrderId})` : ''}` +
                  `${fill.providerPositionId ? ` (provider position ${fill.providerPositionId})` : ''} — ` +
                  'the same native deal cannot carry two different economic facts; the ' +
                  'inconsistent delivery is refused (the booked evidence row stands immutable)',
              );
            }
          }
          // LEGACY_BASELINE (or any weaker class): identity-level replay
          // only — the per-deal economics of pre-ledger history are NOT
          // recorded (only the cumulative baseline is), so quantities cannot
          // be re-verified against it. The identifier is deduped; the
          // economics are not — the documented insufficiency of pre-ledger
          // evidence (review findings 1 and 4).
          this.logger.log(
            `Fill for order ${orderId} already booked from provider deal ` +
              `${fill.providerDealId} (${String(bookedRow.evidence_class)} ledger replay) — ` +
              'duplicate deal fill ignored',
          );
          return locked;
        }
      }

      // 2b. Legacy row-pointer dedup — the pre-ledger population that has
      //     not yet booked a ledger-era fill (and so has no baseline row).
      //     Once the first ledger-era fill books, the LEGACY_BASELINE row
      //     retains this pointer inside the ledger and step 2 owns the
      //     check — the pointer move no longer orphans the identifier.
      if (
        fill.providerDealId != null &&
        fill.providerDealId !== '' &&
        locked.providerDealId === fill.providerDealId
      ) {
        this.logger.log(
          `Fill for order ${orderId} already booked from provider deal ` +
            `${fill.providerDealId} (order-row pointer) — duplicate deal fill ignored`,
        );
        return locked;
      }

      // 2c. Fillable gate AFTER the dedup classification (terminal-state
      //     redelivery, 2026-11-25 continuation): a delivery the ledger or
      //     the legacy pointer recognized as an already-booked duplicate has
      //     returned above REGARDLESS of the order's status — a redelivered
      //     booked deal is a no-op even after FILLED. Anything reaching this
      //     gate is NEW evidence, so a non-fillable (terminal) state fails
      //     closed: a late/unattributed new fill must never silently mutate a
      //     terminal order's accounting.
      if (!OrderStateMachine.isFillable(locked.status)) {
        throw new ConflictException(
          `Order ${orderId} is not fillable (status: ${locked.status}) — the delivered ` +
            `${
              identifiedDelivery
                ? `deal ${fill.providerDealId} is not booked evidence for this order`
                : 'fill is unidentified and not booked evidence for this order'
            }; new fills cannot be booked on this state`,
        );
      }

      // 2d. LEGACY BASELINE CAPTURE (review finding 1) — one-time, in this
      //     transaction: when a MIXED-ERA order (quantity booked BEFORE the
      //     ledger existed) books its first ledger-era fill, transcribe the
      //     pre-ledger cumulative accounting state into ONE LEGACY_BASELINE
      //     row. A baseline summary — NOT a reconstructed per-fill deal: the
      //     retained legacy pointer (when any) is preserved AS the pointer,
      //     keeping its identifier in the dedup surface FOREVER (step 2
      //     catches later replays even after the order-row pointer moves to
      //     newer fills), and the accounting invariant
      //     SUM(ledger.quantity) == orders.filled_quantity holds from the
      //     first ledger-era fill onward (review finding 5).
      if (compareDecimal(locked.filledQuantity ?? '0', '0') > 0) {
        const existing: Array<{ present: boolean }> = await manager.query(
          `SELECT EXISTS (
             SELECT 1 FROM trading.order_fill_evidence WHERE order_id = $1
           ) AS present`,
          [orderId],
        );
        if (!existing[0]?.present) {
          if (locked.avgFillPrice == null) {
            // Pathological legacy row: quantity booked but no average price
            // (the invariant "avg_fill_price present iff filled_quantity > 0"
            // is already broken on the order row). No baseline is written —
            // a price would have to be invented — and the insufficiency is
            // surfaced, never silently repaired. For such rows the ledger
            // sum will NOT equal filled_quantity; diagnostics must flag them.
            this.logger.error(
              `Order ${orderId} carries filled_quantity ${locked.filledQuantity} ` +
                'without avg_fill_price — its pre-ledger baseline cannot be transcribed ' +
                'honestly; the ledger-sum invariant does not hold for this row (diagnose ' +
                'the order row before relying on the invariant)',
            );
          } else {
            await manager.query(
              `INSERT INTO trading.order_fill_evidence
                 (id, order_id, broker_connection_id, provider_deal_id,
                  provider_order_id, provider_position_id, quantity, price,
                  evidence_class, recorded_at)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'LEGACY_BASELINE', clock_timestamp())`,
              [
                orderId,
                locked.brokerConnectionId,
                locked.providerDealId ?? null,
                locked.providerOrderId ?? null,
                locked.providerPositionId ?? null,
                locked.filledQuantity,
                locked.avgFillPrice,
              ],
            );
            this.logger.log(
              `Legacy baseline transcribed for order ${orderId}: pre-ledger cumulative ` +
                `${locked.filledQuantity} @ ${locked.avgFillPrice}` +
                `${locked.providerDealId ? ` (retained pointer ${locked.providerDealId})` : ' (no retained pointer)'}` +
                ' — a baseline summary, never reconstructed per-fill evidence',
            );
          }
        }
      }

      // 3. Append the immutable per-fill accounting evidence row — in the
      //    SAME transaction as the quantity update (all-or-nothing). Fills
      //    whose provider evidence carried no native deal id are recorded
      //    with a NULL provider_deal_id and their derived evidence_class;
      //    missing identifiers are never fabricated. recorded_at uses
      //    clock_timestamp() (statement time, monotonically increasing
      //    within the transaction) so the baseline row always precedes the
      //    fill row of the same transaction in the ordered ledger view.
      try {
        await manager.query(
          `INSERT INTO trading.order_fill_evidence
             (id, order_id, broker_connection_id, provider_deal_id,
              provider_order_id, provider_position_id, quantity, price,
              evidence_class, recorded_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())`,
          [
            orderId,
            locked.brokerConnectionId,
            fill.providerDealId ?? null,
            fill.providerOrderId ?? null,
            fill.providerPositionId ?? null,
            fill.quantity,
            fill.price,
            this.deriveEvidenceClass(fill),
          ],
        );
      } catch (err) {
        // A concurrent writer booked the same native deal onto ANOTHER
        // order row between the ledger read above and this INSERT — the
        // partial unique index uq_order_fill_evidence_deal refuses it and
        // the transaction rolls back (no partial accounting state).
        if (fill.providerDealId != null && this.isUniqueConstraintViolation(err)) {
          throw new ConflictException(
            `Provider deal ${fill.providerDealId} was concurrently attributed to another order — ` +
              'a single broker deal cannot be credited to multiple internal orders',
          );
        }
        throw err;
      }

      // 4. The order-row update — exact-decimal PostgreSQL arithmetic,
      //    overfill fail-closed, status CAS, latest-deal pointer refresh.
      let result: unknown;
      try {
        result = await manager.query(
          `UPDATE trading.orders
           SET
             filled_quantity = filled_quantity + $2::numeric,
             avg_fill_price = CASE
               WHEN filled_quantity = 0 THEN $3::numeric
               ELSE (avg_fill_price * filled_quantity + $3::numeric * $2::numeric)
                    / (filled_quantity + $2::numeric)
             END,
             status = CASE
               WHEN filled_quantity + $2::numeric = requested_quantity THEN 'FILLED'
               ELSE 'PARTIALLY_FILLED'
             END,
             provider_order_id = COALESCE($4, provider_order_id),
             provider_position_id = COALESCE($6, provider_position_id),
             provider_deal_id = COALESCE($7, provider_deal_id),
             finalized_at = CASE
               WHEN filled_quantity + $2::numeric = requested_quantity THEN NOW()
               ELSE finalized_at
             END,
             updated_at = NOW()
           WHERE id = $1
             AND status = $5
             AND filled_quantity + $2::numeric <= requested_quantity
           RETURNING *`,
          [
            orderId,
            fill.quantity,
            fill.price,
            fill.providerOrderId ?? null,
            locked.status,
            fill.providerPositionId ?? null,
            fill.providerDealId ?? null,
          ],
        );
      } catch (err) {
        // A concurrent writer booked the same native deal onto another order
        // row between the ledger read above and this UPDATE — the partial
        // unique index on (broker_connection_id, provider_deal_id) refuses
        // the pointer write.
        if (fill.providerDealId != null && this.isUniqueConstraintViolation(err)) {
          throw new ConflictException(
            `Provider deal ${fill.providerDealId} was concurrently attributed to another order — ` +
              'a single broker deal cannot be credited to multiple internal orders',
          );
        }
        throw err;
      }

      // TypeORM's Postgres driver returns [rows, rowCount] for UPDATE queries
      // (even with RETURNING *) — unwrap the nested rows array before use.
      // INSERT/SELECT queries return the flat rows array directly.
      const rows: Record<string, unknown>[] =
        Array.isArray(result) && Array.isArray(result[0])
          ? (result[0] as Record<string, unknown>[])
          : (result as unknown as Record<string, unknown>[]);

      if (rows.length === 0) {
        // Either an overfill or a concurrent state change — both fail
        // closed and roll back the transaction (including the evidence
        // row: a refused fill leaves no accounting event behind).
        const recheck = await this.findOrderById(orderId);
        if (recheck && OrderStateMachine.isFillable(recheck.status)) {
          // Overfill attempt: current filled + qty > requested.
          throw new ConflictException(
            `Fill of ${fill.quantity} exceeds remaining quantity for order ${orderId} ` +
              `(filled ${recheck.filledQuantity} of ${recheck.requestedQuantity})`,
          );
        }
        throw new ConflictException(
          `Order ${orderId} state changed concurrently (status: ${recheck?.status ?? 'UNKNOWN'}) — retry`,
        );
      }

      return this.hydrateOrderRow(rows[0]!);
    });
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async findOrderById(orderId: string): Promise<Order | null> {
    return this.orderRepo.findOne({ where: { id: orderId } });
  }

  async findByClientOrderId(userId: string, clientOrderId: string): Promise<Order | null> {
    const key = this.generateIdempotencyKey(userId, clientOrderId);
    return this.orderRepo.findOne({ where: { idempotencyKey: key } });
  }

  /**
   * Find the order linked to a position (trade). Used by the trade
   * reconciliation job to resolve order-side RECONCILIATION_PENDING states
   * once the provider-observed position state is known.
   */
  async findByTradeId(tradeId: string): Promise<Order | null> {
    return this.orderRepo.findOne({ where: { tradeId } });
  }

  /**
   * ALL still-reconcilable orders linked to a trade. A trade can carry an
   * ENTRY order and a CLOSE order simultaneously (both linked via trade_id);
   * the singular findByTradeId is ambiguous between them. Callers that must
   * act on a specific leg (entry vs close) classify by direction/kind and
   * MUST use this plural read — never the ambiguous single row.
   */
  async findReconcilableByTradeId(tradeId: string): Promise<Order[]> {
    return this.orderRepo.find({
      where: {
        tradeId,
        status: In([...RECONCILABLE_ORDER_STATUSES] as OrderStatus[]),
      },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Ownership lookup for a native provider deal id on a broker connection
   * (review finding 2): consults the COMPLETE historical accounting evidence
   * — first the immutable ledger (every retained identifier, including the
   * legacy pointers preserved by LEGACY_BASELINE rows), then the order-row
   * latest-deal pointers (the pre-ledger population).
   *
   * Reports ambiguity explicitly instead of silently picking one owner: if
   * the ledger and a legacy order-row pointer attribute the deal to
   * DIFFERENT internal orders (or multiple rows disagree), the lookup is
   * flagged ambiguous with every candidate exposed for accounting review.
   * `orderId` is non-null ONLY when the evidence is unambiguous.
   */
  async findDealOwner(
    brokerConnectionId: string,
    providerDealId: string,
  ): Promise<DealOwnershipLookup> {
    const ledgerRows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT DISTINCT order_id FROM trading.order_fill_evidence
       WHERE broker_connection_id = $1 AND provider_deal_id = $2`,
      [brokerConnectionId, providerDealId],
    );
    const pointerRows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT id FROM trading.orders
       WHERE broker_connection_id = $1 AND provider_deal_id = $2`,
      [brokerConnectionId, providerDealId],
    );
    const ledgerOwners = [...new Set(ledgerRows.map((r) => r.order_id as string))];
    const pointerOwners = [...new Set(pointerRows.map((r) => r.id as string))];
    const sources: DealOwnershipSource[] = [];
    if (ledgerOwners.length > 0) sources.push('LEDGER_EVIDENCE');
    if (pointerOwners.length > 0) sources.push('ORDER_ROW_POINTER');
    const candidateOrderIds = [...new Set([...ledgerOwners, ...pointerOwners])];
    const ambiguous = candidateOrderIds.length > 1;
    return {
      orderId: ambiguous ? null : (candidateOrderIds[0] ?? null),
      ambiguous,
      sources,
      candidateOrderIds,
    };
  }

  async listOrdersByUser(userId: string, limit = 50): Promise<Order[]> {
    return this.orderRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  /**
   * Read-only view of the immutable per-fill accounting evidence ledger for
   * an order, oldest first. Diagnostics and audit use this to re-derive the
   * accounting invariant — WHICH HOLDS FOR LEDGER-MANAGED ORDERS ONLY
   * (review finding 5):
   *
   *   orders.filled_quantity = (pre-ledger cumulative quantity, transcribed
   *   as the single LEGACY_BASELINE row at the first ledger-era fill, when
   *   applicable) + SUM(quantity of the PROVIDER_DEAL/POSITION_FACTS/
   *   PROVIDER_RESPONSE/PROVIDER_ORDER_STATE rows).
   *
   * Orders whose quantity was booked BEFORE the ledger existed and never
   * booked a ledger-era fill have NO ledger rows at all — the ledger alone
   * does NOT establish their historical total (migration deliberately does
   * not backfill); their quantity lives only on the order row. The ledger is
   * append-only — no service path may edit or delete these rows (the
   * database trigger enforces UPDATE/DELETE; TRUNCATE is refused by the
   * statement trigger of migration 1795628400000).
   */
  async findFillEvidenceByOrderId(orderId: string): Promise<
    Array<{
      id: string;
      orderId: string;
      brokerConnectionId: string;
      providerDealId: string | null;
      providerOrderId: string | null;
      providerPositionId: string | null;
      quantity: string;
      price: string;
      evidenceClass: string;
      recordedAt: Date;
    }>
  > {
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT id, order_id, broker_connection_id, provider_deal_id,
              provider_order_id, provider_position_id, quantity, price,
              evidence_class, recorded_at
       FROM trading.order_fill_evidence
       WHERE order_id = $1
       ORDER BY recorded_at ASC, id ASC`,
      [orderId],
    );
    return rows.map((row) => ({
      id: row.id as string,
      orderId: row.order_id as string,
      brokerConnectionId: row.broker_connection_id as string,
      providerDealId: (row.provider_deal_id as string | null) ?? null,
      providerOrderId: (row.provider_order_id as string | null) ?? null,
      providerPositionId: (row.provider_position_id as string | null) ?? null,
      quantity: String(row.quantity ?? '0'),
      price: String(row.price ?? '0'),
      evidenceClass: row.evidence_class as string,
      recordedAt: row.recorded_at as Date,
    }));
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Generic state-machine-guarded transition with optimistic concurrency:
   * fetch → assertTransition → conditional UPDATE WHERE status = from.
   */
  private async applyTransition(
    orderId: string,
    to: OrderStatus,
    extras: {
      providerOrderId?: string | null;
      providerPositionId?: string | null;
      rejectReason?: string | null;
      setSubmittedAt?: boolean;
    },
  ): Promise<Order> {
    const current = await this.findOrderById(orderId);
    if (!current) throw new NotFoundException(`Order ${orderId} not found`);

    OrderStateMachine.assertTransition(current.status, to);

    const patch: Partial<Order> = { status: to };
    if (extras.providerOrderId != null) patch.providerOrderId = extras.providerOrderId;
    if (extras.providerPositionId != null) patch.providerPositionId = extras.providerPositionId;
    if (extras.rejectReason != null) patch.rejectReason = extras.rejectReason;
    if (extras.setSubmittedAt) patch.submittedAt = new Date();
    if (OrderStateMachine.isTerminal(to)) patch.finalizedAt = new Date();

    const result = await this.orderRepo.update(
      { id: orderId, status: current.status },
      patch as never,
    );
    if (result.affected === 0) {
      throw new ConflictException(
        `Order ${orderId} state changed concurrently (expected ${current.status}) — retry`,
      );
    }
    return (await this.findOrderById(orderId)) as Order;
  }

  private validateSubmission(input: SubmitOrderInput): void {
    if (!input.userId) throw new BadRequestException('userId is required');
    if (!input.brokerConnectionId) throw new BadRequestException('brokerConnectionId is required');
    if (!CLIENT_ORDER_ID_PATTERN.test(input.clientOrderId ?? '')) {
      throw new BadRequestException(
        'clientOrderId is required (1-100 chars, allowed: letters, digits, dot, underscore, hyphen)',
      );
    }
    if (!ORDER_KINDS.includes(input.orderKind)) {
      throw new BadRequestException(`orderKind must be one of ${ORDER_KINDS.join(', ')}`);
    }
    if (!ORDER_TIME_IN_FORCES.includes(input.timeInForce)) {
      throw new BadRequestException(
        `timeInForce must be one of ${ORDER_TIME_IN_FORCES.join(', ')}`,
      );
    }
    if (!input.instrument || input.instrument.trim().length === 0 || input.instrument.length > 50) {
      throw new BadRequestException('instrument is required (≤50 chars)');
    }
    if (input.direction !== 'BUY' && input.direction !== 'SELL') {
      throw new BadRequestException('direction must be BUY or SELL');
    }
    if (
      !QUANTITY_PATTERN.test(input.requestedQuantity ?? '') ||
      parseFloat(input.requestedQuantity) <= 0
    ) {
      throw new BadRequestException(
        'requestedQuantity must be a positive decimal string (scale ≤ 4)',
      );
    }

    const priceRules: Record<OrderKind, { price: boolean; stop: boolean }> = {
      [OrderKind.MARKET]: { price: false, stop: false },
      [OrderKind.LIMIT]: { price: true, stop: false },
      [OrderKind.STOP]: { price: false, stop: true },
      [OrderKind.STOP_LIMIT]: { price: true, stop: true },
    };
    const rules = priceRules[input.orderKind];
    if (rules.price) {
      if (
        !input.requestedPrice ||
        !PRICE_PATTERN.test(input.requestedPrice) ||
        parseFloat(input.requestedPrice) <= 0
      ) {
        throw new BadRequestException(
          `${input.orderKind} requires a positive requestedPrice (scale ≤ 8)`,
        );
      }
    } else if (input.requestedPrice != null) {
      throw new BadRequestException(`${input.orderKind} must not carry a requestedPrice`);
    }
    if (rules.stop) {
      if (
        !input.stopPrice ||
        !PRICE_PATTERN.test(input.stopPrice) ||
        parseFloat(input.stopPrice) <= 0
      ) {
        throw new BadRequestException(
          `${input.orderKind} requires a positive stopPrice (scale ≤ 8)`,
        );
      }
    } else if (input.stopPrice != null) {
      throw new BadRequestException(`${input.orderKind} must not carry a stopPrice`);
    }
  }

  private validateFill(fill: ApplyFillInput): void {
    if (!QUANTITY_PATTERN.test(fill.quantity ?? '') || parseFloat(fill.quantity) <= 0) {
      throw new BadRequestException('fill quantity must be a positive decimal string (scale ≤ 4)');
    }
    if (!PRICE_PATTERN.test(fill.price ?? '') || parseFloat(fill.price) <= 0) {
      throw new BadRequestException('fill price must be a positive decimal string (scale ≤ 8)');
    }
  }

  /**
   * State-premise fence validation (ApplyFillOptions): the premise must be a
   * well-formed non-negative decimal, and it applies to UNIDENTIFIED
   * state-derived deliveries only — a deal-grade delivery is deduplicated
   * by the immutable ledger and must book regardless of interleaving, so
   * combining both is a programming contract violation that fails closed.
   */
  private validateFillOptions(fill: ApplyFillInput, options: ApplyFillOptions): void {
    if (options.expectedFilledQuantity == null) return;
    if (!QUANTITY_PATTERN.test(options.expectedFilledQuantity)) {
      throw new BadRequestException(
        'expectedFilledQuantity must be a non-negative decimal string (scale ≤ 4)',
      );
    }
    if (fill.providerDealId != null && fill.providerDealId !== '') {
      throw new BadRequestException(
        'Deal-grade deliveries (providerDealId present) are deduplicated by the immutable ' +
          'ledger; the state-premise fence applies to unidentified state-derived fills only',
      );
    }
  }

  /**
   * Evidence-grade classification of a fill, derived ONLY from the
   * identifiers the provider evidence actually carried — a classification
   * of supplied facts, never a fabricated identifier:
   * native deal id → PROVIDER_DEAL; else position id → POSITION_FACTS;
   * else provider order id → PROVIDER_RESPONSE; else PROVIDER_ORDER_STATE.
   * The DB CHECK ck_order_fill_evidence_class_consistent enforces the
   * PROVIDER_DEAL ↔ provider_deal_id IS NOT NULL parity at rest.
   */
  private deriveEvidenceClass(fill: ApplyFillInput): OrderFillEvidenceClass {
    if (fill.providerDealId != null && fill.providerDealId !== '') {
      return OrderFillEvidenceClass.PROVIDER_DEAL;
    }
    if (fill.providerPositionId != null && fill.providerPositionId !== '') {
      return OrderFillEvidenceClass.POSITION_FACTS;
    }
    if (fill.providerOrderId != null && fill.providerOrderId !== '') {
      return OrderFillEvidenceClass.PROVIDER_RESPONSE;
    }
    return OrderFillEvidenceClass.PROVIDER_ORDER_STATE;
  }

  /**
   * Deterministic client-facing idempotency key (SHA-256(userId:clientOrderId)).
   * Public: the execution orchestrator embeds the same key in the provider
   * order request for broker-side deduplication.
   */
  generateIdempotencyKey(userId: string, clientOrderId: string): string {
    return crypto.createHash('sha256').update(`${userId}:${clientOrderId}`).digest('hex');
  }

  /**
   * Advisory lock key scoped to a single user (positive 32-bit).
   *
   * Sprint 50 PR-3: derived from a SHA-256 digest instead of the legacy
   * char-code loop — CodeQL flagged the unbounded-length iteration over
   * user-controlled input; the digest also distributes better. Lock-key
   * VALUES change vs. the legacy hash, which only affects transient
   * in-flight locks (never persisted state).
   */
  private computeUserLockKey(userId: string): number {
    const digest = crypto.createHash('sha256').update(userId).digest();
    return digest.readUInt32BE(0) & 0x7fffffff;
  }

  /** SQLSTATE 23505 — unique constraint violation. */
  private isUniqueConstraintViolation(err: unknown): boolean {
    const candidate = err as { code?: string; message?: string };
    if (candidate?.code === '23505') return true;
    const msg = candidate?.message ?? '';
    return msg.includes('23505') || msg.includes('duplicate key value');
  }

  /** Map a raw snake_case row to the camel-cased Order entity shape. */
  private hydrateOrderRow(row: Record<string, unknown>): Order {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      brokerConnectionId: row.broker_connection_id as string,
      tradeId: (row.trade_id as string | null) ?? null,
      signalId: (row.signal_id as string | null) ?? null,
      clientOrderId: row.client_order_id as string,
      idempotencyKey: row.idempotency_key as string,
      providerOrderId: (row.provider_order_id as string | null) ?? null,
      providerPositionId: (row.provider_position_id as string | null) ?? null,
      providerDealId: (row.provider_deal_id as string | null) ?? null,
      orderKind: row.order_kind as OrderKind,
      timeInForce: row.time_in_force as OrderTimeInForce,
      instrument: row.instrument as string,
      direction: row.direction as 'BUY' | 'SELL',
      requestedQuantity: String(row.requested_quantity ?? '0'),
      requestedPrice: row.requested_price != null ? String(row.requested_price) : null,
      stopPrice: row.stop_price != null ? String(row.stop_price) : null,
      filledQuantity: String(row.filled_quantity ?? '0'),
      avgFillPrice: row.avg_fill_price != null ? String(row.avg_fill_price) : null,
      status: row.status as OrderStatus,
      rejectReason: (row.reject_reason as string | null) ?? null,
      submittedAt: (row.submitted_at as Date | null) ?? null,
      finalizedAt: (row.finalized_at as Date | null) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    } as Order;
  }
}
