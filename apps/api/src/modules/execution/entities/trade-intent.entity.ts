import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * TradeIntentStatus — the durable lifecycle of a normalized trade intent.
 *
 * CREATED    — recorded at signal intake (pre-risk); the intent is usable.
 * EXECUTED   — a trade reservation was created from this intent (terminal).
 * REJECTED   — the pipeline definitively rejected the intent (risk/control
 *              rejection or invalid state) — a redelivery of the SAME AI
 *              decision can never re-enter exposure (§2/§13).
 * EXPIRED    — the intent's expiry elapsed before execution; a stale or
 *              replaced AI decision must not create new exposure (§2).
 * SUPERSEDED — a newer AI decision replaced this intent for the same
 *              logical position (reserved for explicit replacement flows).
 */
export enum TradeIntentStatus {
  CREATED = 'CREATED',
  EXECUTED = 'EXECUTED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
  SUPERSEDED = 'SUPERSEDED',
}

/**
 * TradeIntent — the durable, normalized form of ONE AI/model decision
 * (Round 6 live-execution completion §2).
 *
 * The intent is recorded at SIGNAL INTAKE (before risk evaluation) and
 * durably retains the full decision provenance:
 *   - source AI decision id (signalId) + its ORIGINAL generatedAt (from the
 *     signal-identity gate — a replay can never shift the timestamp);
 *   - user + broker connection + logical account identity at creation;
 *   - strategy code / model version / timeframe;
 *   - instrument, direction, entry type, requested (intended) exposure and
 *     protective parameters;
 *   - expiry — a stale/expired/replaced decision must not create exposure;
 *   - market-data reference at creation;
 *   - rationale/provenance text + structured metadata;
 *   - the authority/policy generations that were CURRENT at creation.
 *
 * IDENTITY: `intent_key` = `<userId>:<signalId>` with UNIQUE (user_id,
 * intent_key) — the same AI decision can NEVER produce duplicate equivalent
 * trade intents after retries, reconnects, worker restarts or queue
 * redelivery (§13 exactly-once chain step 1). Material sameness is enforced
 * upstream by the signal-identity digest; this table's uniqueness is the
 * durable backstop.
 */
@Entity({ name: 'trade_intents', schema: 'trading' })
@Index('uq_trade_intents_user_intent_key', ['userId', 'intentKey'], { unique: true })
@Index('ix_trade_intents_user_status', ['userId', 'status'])
export class TradeIntent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /**
   * Stable unique identity: `<userId>:<signalId>`. UNIQUE per user — the
   * database-level exactly-once guard for intent creation.
   */
  @Column({ name: 'intent_key', type: 'varchar', length: 255 })
  intentKey: string;

  /** Source AI decision id (the signal id). */
  @Column({ name: 'signal_id', type: 'varchar', length: 100 })
  signalId: string;

  /** The ORIGINAL producer generation timestamp (identity-gate-registered). */
  @Column({ name: 'signal_generated_at', type: 'timestamptz' })
  signalGeneratedAt: Date;

  @Column({ name: 'broker_connection_id', type: 'uuid' })
  brokerConnectionId: string;

  /** Logical account key resolved from the connection at creation. */
  @Column({ name: 'logical_account_key', type: 'varchar', length: 255, nullable: true })
  logicalAccountKey: string | null;

  @Column({ name: 'trading_session_id', type: 'uuid', nullable: true })
  tradingSessionId: string | null;

  @Column({ name: 'strategy_code', type: 'varchar', length: 100, nullable: true })
  strategyCode: string | null;

  @Column({ name: 'model_version', type: 'varchar', length: 100, nullable: true })
  modelVersion: string | null;

  @Column({ name: 'timeframe', type: 'varchar', length: 20, nullable: true })
  timeframe: string | null;

  @Column({ type: 'varchar', length: 30 })
  instrument: string;

  @Column({ type: 'varchar', length: 4 })
  direction: 'BUY' | 'SELL';

  /** Normalized entry type — MARKET unless the decision carried a price. */
  @Column({ name: 'entry_type', type: 'varchar', length: 20, default: 'MARKET' })
  entryType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';

  /** Requested (intended) exposure — the AI's suggested volume. */
  @Column({ name: 'requested_lot_size', type: 'numeric', precision: 10, scale: 4 })
  requestedLotSize: string;

  @Column({ name: 'requested_entry_price', type: 'numeric', precision: 18, scale: 8, nullable: true })
  requestedEntryPrice: string | null;

  @Column({ name: 'stop_loss', type: 'numeric', precision: 18, scale: 8, nullable: true })
  stopLoss: string | null;

  @Column({ name: 'take_profit', type: 'numeric', precision: 18, scale: 8, nullable: true })
  takeProfit: string | null;

  @Column({ name: 'trailing_stop_pips', type: 'numeric', precision: 10, scale: 2, nullable: true })
  trailingStopPips: string | null;

  /**
   * §2: intent expiry — after this instant the decision is STALE and must
   * not create new exposure (typed INTENT_EXPIRED at the risk gate).
   */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Market-data reference/version at creation (quoteRef when available). */
  @Column({ name: 'market_data_ref', type: 'jsonb', nullable: true })
  marketDataRef: Record<string, unknown> | null;

  /** Rationale / provenance text from the AI decision. */
  @Column({ type: 'text', nullable: true })
  rationale: string | null;

  /** Structured decision metadata (confidence, volatility, regime...). */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  /** Trading-authority generation CURRENT at intent creation (§2/§20). */
  @Column({ name: 'authority_generation', type: 'integer' })
  authorityGeneration: number;

  @Column({ name: 'trading_policy_revision', type: 'integer', nullable: true })
  tradingPolicyRevision: number | null;

  @Column({ name: 'provider_verification_revision', type: 'integer', nullable: true })
  providerVerificationRevision: number | null;

  @Column({ name: 'execution_control_revision', type: 'integer', nullable: true })
  executionControlRevision: number | null;

  @Column({ type: 'varchar', length: 20, default: TradeIntentStatus.CREATED })
  status: TradeIntentStatus;

  /** The trade reservation created from this intent (set on EXECUTED). */
  @Column({ name: 'trade_id', type: 'uuid', nullable: true })
  tradeId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
