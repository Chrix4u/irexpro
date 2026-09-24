import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * CapitalAllocationStatus — the ledger state of one allocation reservation.
 *
 * ACTIVE   — the reservation counts against the account budget (the
 *            aggregate view further gates on the CURRENT durable truth:
 *            in-flight intent / PENDING / OPEN / RECONCILIATION_PENDING).
 * RELEASED — terminally released without exposure (definite dispatch
 *            failure, risk rejection) — never counts again.
 */
export enum CapitalAllocationStatus {
  ACTIVE = 'ACTIVE',
  RELEASED = 'RELEASED',
}

/**
 * CapitalAllocation (Round 6 live-execution completion §3) — one durable
 * allocation reservation of account capital for ONE TradeIntent.
 *
 * IDENTITY: UNIQUE (trade_intent_id) — the same AI decision can never hold
 * two allocations (double-allocation is impossible at the database level;
 * §13 step 2 of the exactly-once chain).
 *
 * ACCOUNTING: the aggregate view JOINs trade_intents + trades so a counted
 * commitment always reflects CURRENT durable truth (§9): an intent that
 * expired or was rejected, or a trade that closed/rejected/cancelled, stops
 * counting automatically — the aggregate self-heals from authoritative
 * state even if an explicit release hook is missed.
 *
 * MATH: allocated_lots / allocated_capital are ExactDecimal-computed decimal
 * strings. sizing_inputs persists the FULL §4 sizing reconstruction record.
 */
@Entity({ name: 'capital_allocations', schema: 'trading' })
@Index('uq_capital_allocations_intent', ['tradeIntentId'], { unique: true })
@Index('ix_capital_allocations_user_account', ['userId', 'logicalAccountKey', 'status'])
@Index('ix_capital_allocations_instrument', ['userId', 'logicalAccountKey', 'instrument', 'status'])
export class CapitalAllocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** The originating TradeIntent — one allocation per decision (exactly-once). */
  @Column({ name: 'trade_intent_id', type: 'uuid' })
  tradeIntentId: string;

  @Column({ name: 'broker_connection_id', type: 'uuid' })
  brokerConnectionId: string;

  /** The logical broker-account identity the capital is committed against. */
  @Column({ name: 'logical_account_key', type: 'varchar', length: 255 })
  logicalAccountKey: string;

  /** ISO-4217 — the currency of allocated_capital (never cross-summed). */
  @Column({ name: 'account_currency', type: 'varchar', length: 3 })
  accountCurrency: string;

  @Column({ type: 'varchar', length: 30 })
  instrument: string;

  @Column({ type: 'varchar', length: 4 })
  direction: 'BUY' | 'SELL';

  @Column({ name: 'strategy_code', type: 'varchar', length: 100, nullable: true })
  strategyCode: string | null;

  /** The §4-sized volume reserved (decimal string — never a float). */
  @Column({ name: 'allocated_lots', type: 'numeric', precision: 10, scale: 4 })
  allocatedLots: string;

  /** Broker-required margin/capital committed (account currency, decimal string).
   *  This is deliberately NOT gross leveraged position notional. */
  @Column({ name: 'allocated_capital', type: 'numeric', precision: 18, scale: 8 })
  allocatedCapital: string;

  @Column({ type: 'varchar', length: 20, default: CapitalAllocationStatus.ACTIVE })
  status: CapitalAllocationStatus;

  /** Full §4 sizing reconstruction record (all inputs + intermediates). */
  @Column({ name: 'sizing_inputs', type: 'jsonb' })
  sizingInputs: Record<string, unknown>;

  /** Terminal release reason (set when status = RELEASED). */
  @Column({ name: 'released_reason', type: 'varchar', length: 60, nullable: true })
  releasedReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
