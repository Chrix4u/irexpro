import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Sprint 29: allowed trading modes — the most permissive mode the user has
 * enabled. PAPER_ONLY is the safe default (no real orders). The user must
 * explicitly upgrade to SEMI_AUTO or FULL_AUTO after acknowledging risk.
 */
export enum AllowedTradingMode {
  PAPER_ONLY = 'PAPER_ONLY',
  SEMI_AUTO = 'SEMI_AUTO',
  FULL_AUTO = 'FULL_AUTO',
}

/**
 * RiskProfile — Per-user risk management configuration.
 *
 * One record per user. Created automatically with safe defaults on first use.
 * Users can adjust limits within admin-set boundaries.
 *
 * KILL SWITCH:
 * - killSwitchActive = true → ALL signals rejected immediately (checked first)
 * - Users toggle via POST /risk/kill-switch
 * - Admins can force-activate via admin panel
 *
 * See: docs/architecture/11-risk-engine-architecture.md §5.7
 */
@Entity({ name: 'risk_profiles', schema: 'trading' })
export class RiskProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  @Index()
  userId: string;

  // ─── Kill switch ────────────────────────────────────────────────────────────

  /**
   * Per-user kill switch. When true, ALL signals for this user are immediately REJECTED.
   * Checked FIRST in every risk validation — before any other rule.
   */
  @Column({ name: 'kill_switch_active', type: 'boolean', default: false })
  killSwitchActive: boolean;

  /** Reason for kill switch activation (audit trail). */
  @Column({ name: 'kill_switch_reason', type: 'text', nullable: true })
  killSwitchReason: string | null;

  // ─── Account-level limits ──────────────────────────────────────────────────

  /**
   * Maximum daily loss as percentage of opening balance.
   * Default: 5% — breach suspends session until next trading day.
   */
  @Column({
    name: 'max_daily_loss_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: '5.00',
  })
  maxDailyLossPercent: string;

  /**
   * Maximum drawdown as percentage of peak equity.
   * Default: 10% — breach suspends session and requires manual review.
   */
  @Column({
    name: 'max_drawdown_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: '10.00',
  })
  maxDrawdownPercent: string;

  // ─── Position-level limits ─────────────────────────────────────────────────

  /** Maximum number of simultaneously open trades. Default: 3. */
  @Column({ name: 'max_open_trades', type: 'integer', default: 3 })
  maxOpenTrades: number;

  /** Maximum number of new trades per calendar day. Default: 10. */
  @Column({ name: 'max_daily_trades', type: 'integer', default: 10 })
  maxDailyTrades: number;

  /**
   * Maximum position size in lots per single trade.
   * Default: 0.1 lots — AI-suggested sizes larger than this are reduced, not rejected,
   * unless reduction would be below broker's minimum lot size.
   */
  @Column({
    name: 'max_position_size_lot',
    type: 'numeric',
    precision: 8,
    scale: 4,
    default: '0.1000',
  })
  maxPositionSizeLot: string;

  /**
   * Minimum stop-loss distance in pips from entry price.
   * Default: 5 pips. Orders with tighter SL are rejected.
   */
  @Column({
    name: 'min_stop_loss_pips',
    type: 'numeric',
    precision: 8,
    scale: 2,
    default: '5.00',
  })
  minStopLossPips: string;

  // ─── Instrument restrictions ───────────────────────────────────────────────

  /**
   * JSON array of allowed trading instrument symbols.
   * NULL = all instruments allowed (default).
   * Example: ["EURUSD", "GBPUSD", "USDJPY"]
   */
  @Column({ name: 'allowed_instruments', type: 'jsonb', nullable: true })
  allowedInstruments: string[] | null;

  // ─── Volatility / regime filters ──────────────────────────────────────────

  /**
   * Maximum volatility score threshold (0.0–1.0).
   * Default: 0.85 — signals with higher volatility scores are rejected.
   */
  @Column({
    name: 'max_volatility_score',
    type: 'numeric',
    precision: 4,
    scale: 2,
    default: '0.85',
  })
  maxVolatilityScore: string;

  /** Whether to reject trades during LOW_LIQUIDITY regime. Default: true. */
  @Column({ name: 'reject_low_liquidity', type: 'boolean', default: true })
  rejectLowLiquidity: boolean;

  // ─── Sprint 29: onboarding gates ──────────────────────────────────────────

  /**
   * Sprint 29: explicit user acceptance of the risk disclosure.
   * This is the HARD GATE for canStartTrading — no automated trading is
   * allowed until the user has explicitly accepted the risk acknowledgement.
   * Separate from UserProfile.riskDisclosureAccepted (general KYC flag).
   */
  @Column({
    name: 'risk_acknowledgement_accepted',
    type: 'boolean',
    default: false,
  })
  riskAcknowledgementAccepted: boolean;

  /** Timestamp of the risk acknowledgement acceptance (audit trail). */
  @Column({ name: 'risk_acknowledgement_accepted_at', type: 'timestamptz', nullable: true })
  riskAcknowledgementAcceptedAt: Date | null;

  /**
   * Sprint 29: maximum risk per trade as a percentage of equity.
   * Default: 2.0% — conservative. Range: 0.5–10.
   */
  @Column({
    name: 'max_trade_risk_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: '2.00',
  })
  maxTradeRiskPercent: string;

  /**
   * Sprint 29: maximum leverage allowed.
   * Default: 30 — conservative. Range: 1–500.
   */
  @Column({ name: 'max_leverage_allowed', type: 'integer', default: 30 })
  maxLeverageAllowed: number;

  /**
   * Sprint 29: the most permissive trading mode the user has enabled.
   * Default: PAPER_ONLY — safest. The user must explicitly upgrade.
   */
  @Column({
    name: 'allowed_trading_modes',
    type: 'enum',
    enum: AllowedTradingMode,
    default: AllowedTradingMode.PAPER_ONLY,
  })
  allowedTradingModes: AllowedTradingMode;

  // ─── Round-6 risk-profile revision (issues #299/#301, brief §15) ─────────

  /**
   * Monotonic risk-profile REVISION — incremented atomically on EVERY
   * material risk-policy edit (any limit, allowed instruments, execution-mode
   * permission, risk acknowledgement, kill-switch change on OR off).
   *
   * Round-6 authority chain: RiskGrants bind (riskProfileId, revision,
   * riskProfileHash); the final dispatch boundary re-reads the CURRENT
   * revision and blocks NEW exposure on any mismatch. Turning the kill
   * switch OFF is another revision — a pre-kill-switch grant is never
   * resurrected by a boolean flipping back.
   *
   * Existing rows start at revision 1 (migration default) — no fabricated
   * history.
   */
  @Column({ name: 'revision', type: 'integer', default: 1 })
  revision: number;

  // ─── Timestamps ───────────────────────────────────────────────────────────

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
