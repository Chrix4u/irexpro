import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * TradingPolicyState — the SHARED, cross-replica authoritative revision of the
 * embedded eligibility/disclosure trading policy (architect issue #363).
 *
 * ONE row, id = 1 (CHECK ck_trading_policy_state_singleton enforces it —
 * production DDL contract for migration 1754300000000):
 *
 *   CREATE TABLE platform.trading_policy_state (
 *     id                integer PRIMARY KEY DEFAULT 1,
 *     current_revision  integer NOT NULL DEFAULT 1,
 *     policy_fingerprint varchar(64) NOT NULL,
 *     last_reason       varchar(200),
 *     last_bumped_at    timestamptz,
 *     created_at        timestamptz NOT NULL DEFAULT NOW(),
 *     updated_at        timestamptz NOT NULL DEFAULT NOW(),
 *     CONSTRAINT ck_trading_policy_state_singleton CHECK (id = 1),
 *     CONSTRAINT ck_trading_policy_state_revision CHECK (current_revision >= 1)
 *   )
 *
 * WHY a durable row: during a rolling deployment replica A can still serve
 * policy revision R1 while replica B already runs R2. A "fresh" in-process
 * final recheck on A is stale the moment R2 revokes a jurisdiction or
 * disclosure rule. The row is the single shared truth; RiskGrants bind the
 * revision observed at issuance and the final dispatch boundary re-reads the
 * CURRENT revision — a mismatch invalidates NEW exposure (fail closed).
 *
 * Writes are ONLY performed by SharedControlRevisionService: monotonic
 * compare-and-set advances (never a decrement, never a resurrection of an
 * earlier fingerprint) plus the append-only TradingPolicyRevisionLog.
 */
@Entity({ name: 'trading_policy_state', schema: 'platform' })
export class TradingPolicyState {
  /** Singleton primary key — always the literal 1. */
  @PrimaryColumn({ name: 'id', type: 'integer', default: 1 })
  id: number;

  /** Monotonic shared revision — only ever advanced via guarded CAS. */
  @Column({ name: 'current_revision', type: 'integer', default: 1 })
  currentRevision: number;

  /** SHA-256 hex-64 fingerprint of the embedded policy this revision installed. */
  @Column({ name: 'policy_fingerprint', type: 'varchar', length: 64 })
  policyFingerprint: string;

  /** Human-readable reason for the last advance (audit correlation). */
  @Column({ name: 'last_reason', type: 'varchar', length: 200, nullable: true })
  lastReason: string | null;

  @Column({ name: 'last_bumped_at', type: 'timestamptz', nullable: true })
  lastBumpedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
