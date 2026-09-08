import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum TradeStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  RECONCILIATION_PENDING = 'RECONCILIATION_PENDING',
}

export enum TradeDirection {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum TradeCloseReason {
  STOP_LOSS_HIT = 'STOP_LOSS_HIT',
  TAKE_PROFIT_HIT = 'TAKE_PROFIT_HIT',
  MANUAL_CLOSE = 'MANUAL_CLOSE',
  AI_CLOSE_SIGNAL = 'AI_CLOSE_SIGNAL',
  KILL_SWITCH_FORCE_CLOSE = 'KILL_SWITCH_FORCE_CLOSE',
  BROKER_CLOSE = 'BROKER_CLOSE',
  RECONCILIATION = 'RECONCILIATION',
}

/**
 * Trade — Lifecycle record for every order placed via the Execution Engine.
 *
 * State machine:
 *   PENDING → OPEN → CLOSED
 *   PENDING → REJECTED (broker rejection)
 *   PENDING → CANCELLED (cancelled before fill)
 *   OPEN    → RECONCILIATION_PENDING (broker unresponsive)
 *
 * All monetary values are stored as decimal strings — never as floats.
 * See: docs/architecture/12-execution-engine-architecture.md §5
 */
@Entity({ name: 'trades', schema: 'trading' })
export class Trade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ─── Ownership ────────────────────────────────────────────────────────────

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId: string;

  @Column({ name: 'broker_connection_id', type: 'uuid' })
  brokerConnectionId: string;

  // ─── Signal lineage ───────────────────────────────────────────────────────

  @Column({ name: 'signal_id', type: 'uuid', nullable: true })
  signalId: string | null;

  /**
   * SHA-256 of (userId:instrument:direction:signalId).
   * Checked before every order submission to prevent duplicate trades.
   * Unique constraint enforced at DB level.
   */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255, unique: true })
  @Index({ unique: true })
  idempotencyKey: string;

  // ─── Order parameters (Risk Engine-validated values) ─────────────────────

  @Column({ name: 'instrument', type: 'varchar', length: 50 })
  @Index()
  instrument: string;

  @Column({ name: 'direction', type: 'varchar', length: 10, enum: TradeDirection })
  direction: TradeDirection;

  /** Lot size after Risk Engine position-size capping. Decimal string. */
  @Column({ name: 'lot_size', type: 'numeric', precision: 10, scale: 4 })
  lotSize: string;

  /** Requested entry price from the signal. Decimal string. */
  @Column({ name: 'requested_entry_price', type: 'numeric', precision: 18, scale: 8 })
  requestedEntryPrice: string;

  /** Actual fill price from broker. Null until broker confirms. Decimal string. */
  @Column({ name: 'fill_price', type: 'numeric', precision: 18, scale: 8, nullable: true })
  fillPrice: string | null;

  @Column({ name: 'stop_loss', type: 'numeric', precision: 18, scale: 8 })
  stopLoss: string;

  @Column({ name: 'take_profit', type: 'numeric', precision: 18, scale: 8 })
  takeProfit: string;

  @Column({ name: 'trailing_stop_pips', type: 'numeric', precision: 8, scale: 2, nullable: true })
  trailingStopPips: string | null;

  // ─── Broker-side identifiers ──────────────────────────────────────────────

  /** Order/position ID returned by the broker (MetaAPI positionId). */
  @Column({ name: 'external_order_id', type: 'varchar', length: 255, nullable: true })
  externalOrderId: string | null;

  /**
   * Sprint 50 PR-2 — provider POSITION identifier, distinct from the order
   * identifier on netting-style brokers where order and position IDs differ.
   * Conservative backfill: NULL (unknown) for all pre-existing rows.
   */
  @Column({ name: 'external_position_id', type: 'varchar', length: 255, nullable: true })
  externalPositionId: string | null;

  /**
   * Sprint 50 PR-2 — total commission charged for this position (account
   * currency, decimal string). NULL until the provider reports it.
   */
  @Column({ name: 'commission', type: 'numeric', precision: 18, scale: 8, nullable: true })
  commission: string | null;

  /**
   * Sprint 50 PR-2 — accumulated swap/financing (account currency, decimal
   * string). NULL until the provider reports it.
   */
  @Column({ name: 'swap', type: 'numeric', precision: 18, scale: 8, nullable: true })
  swap: string | null;

  // ─── Lifecycle state ──────────────────────────────────────────────────────

  @Column({ name: 'status', type: 'enum', enum: TradeStatus, default: TradeStatus.PENDING })
  @Index()
  status: TradeStatus;

  // ─── Closure data (populated on CLOSED) ──────────────────────────────────

  @Column({ name: 'exit_price', type: 'numeric', precision: 18, scale: 8, nullable: true })
  exitPrice: string | null;

  /**
   * Realised P&L in account currency. Decimal string.
   * Positive = profit, Negative = loss.
   * Critical for daily loss limit checks in the Risk Engine.
   */
  @Column({ name: 'realised_pnl', type: 'numeric', precision: 18, scale: 8, nullable: true })
  realisedPnl: string | null;

  @Column({
    name: 'close_reason',
    type: 'enum',
    enum: TradeCloseReason,
    nullable: true,
  })
  closeReason: TradeCloseReason | null;

  @Column({ name: 'broker_rejection_reason', type: 'text', nullable: true })
  brokerRejectionReason: string | null;

  // ─── Timestamps ───────────────────────────────────────────────────────────

  /** Set when broker confirms fill. */
  @Column({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  /** Set when trade reaches CLOSED status. */
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
