import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * ExecutionControlScope — the level at which an emergency control applies
 * (Directive §28: GLOBAL / PROVIDER / USER / BROKER_CONNECTION).
 */
export enum ExecutionControlScope {
  GLOBAL = 'GLOBAL',
  PROVIDER = 'PROVIDER',
  USER = 'USER',
  BROKER_CONNECTION = 'BROKER_CONNECTION',
}

/**
 * ExecutionControlStatus — persisted lifecycle of a control row.
 *
 * ACTIVE:   the control currently disables execution at its scope.
 * EXPIRED:  the control's expiry has passed; it is retained as a record,
 *           ignored by permission checks, and never blocks a future
 *           activation at the same (scope, scopeKey).
 */
export enum ExecutionControlStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
}

/**
 * ExecutionControl — server-side emergency control plane record.
 *
 * PRESENCE = EXECUTION DISABLED at the given scope, where "presence" means
 * status = ACTIVE and the expiry (if any) has not passed. A control is
 * removed (row deleted) when cleared — there is no "enabled" row to
 * misinterpret. Expired rows flip to status = EXPIRED (retained as records)
 * and reactivation at the same scope inserts a NEW ACTIVE row.
 *
 * SECURITY INVARIANTS:
 * - Effective authorization FAILS CLOSED: when the control store cannot be
 *   queried (DB error), execution is treated as disabled.
 * - The control plane affects newly submitted work IMMEDIATELY; in-flight
 *   provider requests are documented in the runbook (see
 *   docs/brokers/execution-control-plane.md).
 * - Only ADMIN / SUPER_ADMIN may activate or clear controls (RBAC enforced
 *   in the controller); every change is audited.
 * - The partial unique index uq_exec_controls_active_scope guarantees at
 *   most one ACTIVE row per (scope, scope_key), including under concurrent
 *   activations (the loser receives a 23505 → ConflictException).
 */
@Entity({ name: 'execution_controls', schema: 'platform' })
@Index('idx_exec_controls_scope_key', ['scope', 'scopeKey'])
export class ExecutionControl {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Control level (see ExecutionControlScope). */
  @Column({ type: 'varchar', length: 20 })
  scope: ExecutionControlScope;

  /**
   * Scope key: null for GLOBAL; brokerId for PROVIDER; userId for USER;
   * brokerConnectionId for BROKER_CONNECTION.
   */
  @Column({ name: 'scope_key', type: 'varchar', length: 100, nullable: true })
  scopeKey: string | null;

  /** Admin-provided human-readable reason (audited, never a secret). */
  @Column({ type: 'varchar', length: 500 })
  reason: string;

  /** Admin who activated the control. */
  @Column({ name: 'activated_by_user_id', type: 'uuid' })
  activatedByUserId: string;

  @Column({ name: 'activated_at', type: 'timestamptz' })
  activatedAt: Date;

  /**
   * Persisted lifecycle status. ACTIVE rows enforce a block; EXPIRED rows
   * are retained as records, ignored by checks, and never block a future
   * activation at the same (scope, scopeKey).
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: ExecutionControlStatus.ACTIVE,
  })
  status: ExecutionControlStatus;

  /**
   * Optional automatic expiry (e.g. maintenance windows). When the expiry
   * passes, reads ignore the control immediately and the next activation
   * at the same slot flips this row to status = EXPIRED (lazy flip).
   */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
