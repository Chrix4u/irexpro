import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TradeDirection } from '../entities/trade.entity';
import { OrderKind, OrderStatus, OrderTimeInForce } from './order.enums';

/**
 * Order — normalized order-domain record (Directive PHASE C:
 * "normalized order model … provider identifiers … persistence").
 *
 * Separates the ORDER lifecycle (intent → routing → fills) from the POSITION
 * lifecycle (trading.trades). One order links to at most one trade
 * (position) via trade_id once execution has produced market exposure.
 *
 * IDENTIFIERS
 * - idempotency_key    — SHA-256(userId:client_order_id). Unique. Exactly-once
 *                        persistence for client-supplied idempotency (mirrors
 *                        the trade reservation pattern from Sprint 32 Gate 3).
 * - client_order_id    — caller-supplied stable identifier (deduplication
 *                        surface; unique per user via the idempotency key).
 * - provider_order_id  — broker-side order identifier (e.g. MetaAPI orderId).
 *
 * MONETARY VALUES ARE DECIMAL STRINGS — never floats. Fill accounting
 * (avg_fill_price) is computed inside PostgreSQL with exact numeric
 * arithmetic in OrderService.applyFill.
 *
 * Lifecycle guarded by OrderStateMachine; DB-level CHECK constraints
 * (migration 1753600000000) reject out-of-enum values and inconsistent
 * fill/price state even if application logic is bypassed.
 */
@Entity({ name: 'orders', schema: 'trading' })
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ─── Ownership ────────────────────────────────────────────────────────────

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId: string;

  @Column({ name: 'broker_connection_id', type: 'uuid' })
  @Index()
  brokerConnectionId: string;

  /** Position (trading.trades) produced by this order, once execution lands. */
  @Column({ name: 'trade_id', type: 'uuid', nullable: true })
  @Index()
  tradeId: string | null;

  /** AI signal that originated this order (automation lineage). */
  @Column({ name: 'signal_id', type: 'uuid', nullable: true })
  signalId: string | null;

  // ─── Identifiers ──────────────────────────────────────────────────────────

  /** Caller-supplied stable identifier (charset [A-Za-z0-9._-], ≤100 chars). */
  @Column({ name: 'client_order_id', type: 'varchar', length: 100 })
  clientOrderId: string;

  /**
   * SHA-256(userId:client_order_id). Unique constraint enforced at DB level;
   * duplicate submissions return the existing order (exactly-once semantics).
   */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255, unique: true })
  @Index({ unique: true })
  idempotencyKey: string;

  /** Broker-side order identifier, recorded on acknowledgement. */
  @Column({ name: 'provider_order_id', type: 'varchar', length: 255, nullable: true })
  providerOrderId: string | null;

  // ─── Order terms ──────────────────────────────────────────────────────────

  @Column({ name: 'order_kind', type: 'varchar', length: 20, enum: OrderKind })
  orderKind: OrderKind;

  @Column({ name: 'time_in_force', type: 'varchar', length: 10, enum: OrderTimeInForce })
  timeInForce: OrderTimeInForce;

  @Column({ name: 'instrument', type: 'varchar', length: 50 })
  @Index()
  instrument: string;

  @Column({ name: 'direction', type: 'varchar', length: 10, enum: TradeDirection })
  direction: TradeDirection;

  /** Requested quantity in lots. Decimal string, > 0, scale ≤ 4. */
  @Column({ name: 'requested_quantity', type: 'numeric', precision: 10, scale: 4 })
  requestedQuantity: string;

  /** Limit price for LIMIT/STOP_LIMIT. NULL for MARKET/STOP. Decimal string. */
  @Column({ name: 'requested_price', type: 'numeric', precision: 18, scale: 8, nullable: true })
  requestedPrice: string | null;

  /** Stop/trigger price for STOP/STOP_LIMIT. NULL for MARKET/LIMIT. Decimal string. */
  @Column({ name: 'stop_price', type: 'numeric', precision: 18, scale: 8, nullable: true })
  stopPrice: string | null;

  // ─── Fill tracking ────────────────────────────────────────────────────────

  /** Cumulative filled quantity in lots. 0 ≤ filled ≤ requested. Decimal string. */
  @Column({
    name: 'filled_quantity',
    type: 'numeric',
    precision: 10,
    scale: 4,
    default: '0',
  })
  filledQuantity: string;

  /** Volume-weighted average fill price. NULL while filled_quantity = 0. */
  @Column({ name: 'avg_fill_price', type: 'numeric', precision: 18, scale: 8, nullable: true })
  avgFillPrice: string | null;

  // ─── Lifecycle state ──────────────────────────────────────────────────────

  @Column({
    name: 'status',
    type: 'varchar',
    length: 30,
    enum: OrderStatus,
    default: OrderStatus.CREATED,
  })
  @Index()
  status: OrderStatus;

  /** Terminal rejection reason (risk engine or provider). ≤500 chars. */
  @Column({ name: 'reject_reason', type: 'varchar', length: 500, nullable: true })
  rejectReason: string | null;

  /** Set when the order is sent to the provider. */
  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  /** Set when the order reaches a terminal state (FILLED/REJECTED/CANCELLED/EXPIRED). */
  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
  finalizedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
