import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * TradingPolicyRevisionLog — append-only history of every installed shared
 * trading-policy revision (architect issue #363).
 *
 * One row per revision; the revision number is UNIQUE so concurrent
 * bootstrap/sync writers converge on exactly one row per revision
 * (losers' unique violations are swallowed by SharedControlRevisionService).
 *
 * Production DDL contract (migration 1754300000000):
 *
 *   CREATE TABLE platform.trading_policy_revision_logs (
 *     id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     revision           integer NOT NULL,
 *     policy_fingerprint varchar(64) NOT NULL,
 *     reason             varchar(200) NOT NULL,
 *     description        varchar(500),
 *     created_at         timestamptz NOT NULL DEFAULT NOW(),
 *     CONSTRAINT ck_trading_policy_revision_logs_revision CHECK (revision >= 1),
 *     CONSTRAINT uq_trading_policy_revision_logs_revision UNIQUE (revision)
 *   )
 *
 * Rows are NEVER updated or deleted — reproducibility and audit require the
 * full fingerprint transition history (revision N's row carries the
 * fingerprint that revision N installed; revision N-1's row carries the
 * previous one).
 */
@Entity({ name: 'trading_policy_revision_logs', schema: 'platform' })
@Unique('uq_trading_policy_revision_logs_revision', ['revision'])
export class TradingPolicyRevisionLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The shared revision this row describes (1 = initial seeded policy). */
  @Column({ name: 'revision', type: 'integer' })
  revision: number;

  /** Fingerprint the revision installed (hex-64). */
  @Column({ name: 'policy_fingerprint', type: 'varchar', length: 64 })
  policyFingerprint: string;

  /** Why the revision was appended ('embedded policy initialized/changed' or caller-supplied). */
  @Column({ name: 'reason', type: 'varchar', length: 200 })
  reason: string;

  /** Optional caller-supplied detail about the change. */
  @Column({ name: 'description', type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
