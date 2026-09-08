import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Order } from './order.entity';
import {
  OrderKind,
  OrderStatus,
  OrderTimeInForce,
  ORDER_KINDS,
  ORDER_TIME_IN_FORCES,
} from './order.enums';
import { OrderStateMachine } from './order-state-machine';

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
  async markAcknowledged(orderId: string, providerOrderId: string): Promise<Order> {
    if (!providerOrderId || providerOrderId.trim().length === 0) {
      throw new BadRequestException('providerOrderId is required to acknowledge an order');
    }
    return this.applyTransition(orderId, OrderStatus.ACKNOWLEDGED, { providerOrderId });
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
   * RECONCILIATION_PENDING → resolvedTo (any state the machine allows from it).
   * Provider-observed fill state is authoritative.
   */
  async resolveReconciliation(
    orderId: string,
    resolvedTo: OrderStatus,
    data: { providerOrderId?: string | null; rejectReason?: string | null } = {},
  ): Promise<Order> {
    return this.applyTransition(orderId, resolvedTo, {
      providerOrderId: data.providerOrderId ?? null,
      rejectReason: data.rejectReason ? data.rejectReason.slice(0, 500) : null,
    });
  }

  /**
   * Atomic fill application with EXACT decimal arithmetic (computed in
   * PostgreSQL, never in JS floats).
   *
   * - Atomically increments filled_quantity.
   * - Recomputes avg_fill_price as the volume-weighted average.
   * - Moves status to PARTIALLY_FILLED or FILLED (terminal) exactly when the
   *   requested quantity is reached, and stamps finalized_at on FILLED.
   * - FAIL-CLOSED on overfill: WHERE filled_quantity + $qty <= requested_quantity.
   * - Only fillable states (per OrderStateMachine.isFillable) may receive fills.
   * - Optimistic concurrency: WHERE status = current status.
   */
  async applyFill(orderId: string, fill: ApplyFillInput): Promise<Order> {
    this.validateFill(fill);

    const current = await this.findOrderById(orderId);
    if (!current) throw new NotFoundException(`Order ${orderId} not found`);
    if (!OrderStateMachine.isFillable(current.status)) {
      throw new ConflictException(`Order ${orderId} is not fillable (status: ${current.status})`);
    }

    const rows = await this.dataSource.query(
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
         finalized_at = CASE
           WHEN filled_quantity + $2::numeric = requested_quantity THEN NOW()
           ELSE finalized_at
         END,
         updated_at = NOW()
       WHERE id = $1
         AND status = $5
         AND filled_quantity + $2::numeric <= requested_quantity
       RETURNING *`,
      [orderId, fill.quantity, fill.price, fill.providerOrderId ?? null, current.status],
    );

    if (rows.length === 0) {
      // Either a concurrent state change or an overfill — both fail closed.
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

    return this.hydrateOrderRow(rows[0]);
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async findOrderById(orderId: string): Promise<Order | null> {
    return this.orderRepo.findOne({ where: { id: orderId } });
  }

  async findByClientOrderId(userId: string, clientOrderId: string): Promise<Order | null> {
    const key = this.generateIdempotencyKey(userId, clientOrderId);
    return this.orderRepo.findOne({ where: { idempotencyKey: key } });
  }

  async listOrdersByUser(userId: string, limit = 50): Promise<Order[]> {
    return this.orderRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
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
      rejectReason?: string | null;
      setSubmittedAt?: boolean;
    },
  ): Promise<Order> {
    const current = await this.findOrderById(orderId);
    if (!current) throw new NotFoundException(`Order ${orderId} not found`);

    OrderStateMachine.assertTransition(current.status, to);

    const patch: Partial<Order> = { status: to };
    if (extras.providerOrderId != null) patch.providerOrderId = extras.providerOrderId;
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

  /** Deterministic client-facing idempotency key. */
  private generateIdempotencyKey(userId: string, clientOrderId: string): string {
    return crypto.createHash('sha256').update(`${userId}:${clientOrderId}`).digest('hex');
  }

  /** Advisory lock key scoped to a single user (positive 32-bit). */
  private computeUserLockKey(userId: string): number {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash * 31 + userId.charCodeAt(i)) & 0x7fffffff;
    }
    return hash;
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
