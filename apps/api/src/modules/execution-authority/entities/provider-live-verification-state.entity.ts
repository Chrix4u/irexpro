import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * ProviderLiveVerificationState — the SHARED, cross-replica authoritative
 * revision of the embedded provider LIVE-verification catalog (architect
 * issue #363).
 *
 * ONE row, id = 1 (CHECK ck_provider_live_verification_state_singleton
 * enforces it — production DDL contract for migration 1754300000000):
 *
 *   CREATE TABLE platform.provider_live_verification_state (
 *     id                  integer PRIMARY KEY DEFAULT 1,
 *     current_revision    integer NOT NULL DEFAULT 1,
 *     catalog_fingerprint varchar(64) NOT NULL,
 *     last_reason         varchar(200),
 *     last_bumped_at      timestamptz,
 *     created_at          timestamptz NOT NULL DEFAULT NOW(),
 *     updated_at          timestamptz NOT NULL DEFAULT NOW(),
 *     CONSTRAINT ck_provider_live_verification_state_singleton CHECK (id = 1),
 *     CONSTRAINT ck_provider_live_verification_state_revision
 *       CHECK (current_revision >= 1)
 *   )
 *
 * The catalog fingerprint covers the validated LIVE-verification evidence set
 * (provider technology, exact provider identity where required, environment,
 * evidence reference, verification status, validated timestamp, evidence/model
 * revision). Any safety-relevant catalog change advances the revision —
 * replica skew can never keep serving a revoked provider verification as
 * "fresh".
 *
 * Writes are ONLY performed by SharedControlRevisionService: monotonic
 * compare-and-set advances plus the append-only
 * ProviderLiveVerificationRevisionLog.
 */
@Entity({ name: 'provider_live_verification_state', schema: 'platform' })
export class ProviderLiveVerificationState {
  /** Singleton primary key — always the literal 1. */
  @PrimaryColumn({ name: 'id', type: 'integer', default: 1 })
  id: number;

  /** Monotonic shared revision — only ever advanced via guarded CAS. */
  @Column({ name: 'current_revision', type: 'integer', default: 1 })
  currentRevision: number;

  /** SHA-256 hex-64 fingerprint of the embedded verification catalog this revision installed. */
  @Column({ name: 'catalog_fingerprint', type: 'varchar', length: 64 })
  catalogFingerprint: string;

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
