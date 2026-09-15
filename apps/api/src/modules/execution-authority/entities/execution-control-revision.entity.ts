import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * ExecutionControlRevisionState — the GLOBAL monotonic revision of the
 * emergency execution-control plane (architect issue #299).
 *
 * ONE row, id = 1 (CHECK ck_execution_control_revision_state_singleton
 * enforces it — production DDL contract for migration 1754300000000):
 *
 *   CREATE TABLE platform.execution_control_revision_state (
 *     id               integer PRIMARY KEY DEFAULT 1,
 *     current_revision integer NOT NULL DEFAULT 1,
 *     last_reason      varchar(200),
 *     last_bumped_at   timestamptz,
 *     created_at       timestamptz NOT NULL DEFAULT NOW(),
 *     updated_at       timestamptz NOT NULL DEFAULT NOW(),
 *     CONSTRAINT ck_execution_control_revision_state_singleton CHECK (id = 1),
 *     CONSTRAINT ck_execution_control_revision_state_revision
 *       CHECK (current_revision >= 1)
 *   )
 *
 * NO-AUTHORITY-RESURRECTION INVARIANT (issue #299): the revision advances on
 * EVERY safety-relevant emergency-control mutation — activation AND
 * deactivation AND expiry/replacement. Deactivation is another revision, so a
 * boolean flipping back to false can never resurrect a pre-control grant:
 *
 *   control active    → old grant blocked
 *   control deactivated → old grant REMAINS blocked
 *
 * RiskGrants bind the revision observed at issuance; the final dispatch
 * boundary re-reads the current revision and blocks NEW exposure on any
 * mismatch (fail closed; risk-reducing operations remain available).
 *
 * Writes are ONLY performed by SharedControlRevisionService
 * (bumpExecutionControlRevision): unconditional monotonic CAS.
 */
@Entity({ name: 'execution_control_revision_state', schema: 'platform' })
export class ExecutionControlRevisionState {
  /** Singleton primary key — always the literal 1. */
  @PrimaryColumn({ name: 'id', type: 'integer', default: 1 })
  id: number;

  /** Monotonic global revision — only ever advanced via CAS. */
  @Column({ name: 'current_revision', type: 'integer', default: 1 })
  currentRevision: number;

  /** Human-readable reason for the last bump (audit correlation). */
  @Column({ name: 'last_reason', type: 'varchar', length: 200, nullable: true })
  lastReason: string | null;

  @Column({ name: 'last_bumped_at', type: 'timestamptz', nullable: true })
  lastBumpedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
