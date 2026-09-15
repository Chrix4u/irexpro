import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * ProviderLiveVerificationRevisionLog — append-only history of every installed
 * shared provider LIVE-verification catalog revision (architect issue #363).
 *
 * One row per revision; the revision number is UNIQUE so concurrent
 * bootstrap/sync writers converge on exactly one row per revision.
 *
 * Production DDL contract (migration 1754300000000):
 *
 *   CREATE TABLE platform.provider_live_verification_revision_logs (
 *     id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     revision            integer NOT NULL,
 *     catalog_fingerprint varchar(64) NOT NULL,
 *     reason              varchar(200) NOT NULL,
 *     description         varchar(500),
 *     created_at          timestamptz NOT NULL DEFAULT NOW(),
 *     CONSTRAINT ck_provider_live_verification_revision_logs_revision
 *       CHECK (revision >= 1),
 *     CONSTRAINT uq_provider_live_verification_revision_logs_revision
 *       UNIQUE (revision)
 *   )
 *
 * Rows are NEVER updated or deleted — the full catalog transition history is
 * required for reproducibility (which verification evidence was authoritative
 * at any point in time) and audit.
 */
@Entity({ name: 'provider_live_verification_revision_logs', schema: 'platform' })
@Unique('uq_provider_live_verification_revision_logs_revision', ['revision'])
export class ProviderLiveVerificationRevisionLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The shared revision this row describes (1 = initial seeded catalog). */
  @Column({ name: 'revision', type: 'integer' })
  revision: number;

  /** Catalog fingerprint the revision installed (hex-64). */
  @Column({ name: 'catalog_fingerprint', type: 'varchar', length: 64 })
  catalogFingerprint: string;

  /** Why the revision was appended ('embedded verification catalog initialized/changed' or caller-supplied). */
  @Column({ name: 'reason', type: 'varchar', length: 200 })
  reason: string;

  /** Optional caller-supplied detail about the change. */
  @Column({ name: 'description', type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
