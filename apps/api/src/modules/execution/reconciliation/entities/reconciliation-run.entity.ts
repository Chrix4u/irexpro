import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ReconciliationRunStatus } from '../reconciliation.enums';

/**
 * ReconciliationRun — persisted record of ONE full state-reconciliation pass
 * over ONE broker connection (Directive §25 "persist or surface
 * discrepancies appropriately"; §29 "failed jobs require visibility").
 *
 * RULES:
 * - Created by the scheduled reconciliation worker (one run per connection
 *   per cycle); never manually triggered in PR-4.
 * - metadata must not contain credentials, secrets, or raw broker payloads.
 * - Counters are append-only facts about the run — never re-edited later.
 */
@Entity({ name: 'runs', schema: 'reconciliation' })
@Index(['userId'])
@Index(['brokerConnectionId', 'createdAt'])
@Index(['status'])
export class ReconciliationRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId: string;

  @Column({ name: 'broker_connection_id', type: 'uuid' })
  @Index()
  brokerConnectionId: string;

  /** Provider registry id (e.g. 'metatrader5', 'paper-broker'). */
  @Column({ name: 'broker_id', type: 'varchar', length: 50 })
  brokerId: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ReconciliationRunStatus,
    default: ReconciliationRunStatus.PENDING,
  })
  @Index()
  status: ReconciliationRunStatus;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  // ─── Comparison counters (Directive §25 compare sets) ─────────────────────

  @Column({ name: 'provider_orders_seen', type: 'integer', default: 0 })
  providerOrdersSeen: number;

  @Column({ name: 'internal_orders_compared', type: 'integer', default: 0 })
  internalOrdersCompared: number;

  @Column({ name: 'provider_positions_seen', type: 'integer', default: 0 })
  providerPositionsSeen: number;

  @Column({ name: 'internal_positions_compared', type: 'integer', default: 0 })
  internalPositionsCompared: number;

  @Column({ name: 'account_snapshot_compared', type: 'integer', default: 0 })
  accountSnapshotCompared: number;

  // ─── Outcome counters ─────────────────────────────────────────────────────

  @Column({ name: 'discrepancies_detected', type: 'integer', default: 0 })
  discrepanciesDetected: number;

  @Column({ name: 'discrepancies_new', type: 'integer', default: 0 })
  discrepanciesNew: number;

  @Column({ name: 'discrepancies_auto_resolved', type: 'integer', default: 0 })
  discrepanciesAutoResolved: number;

  @Column({ name: 'discrepancies_open', type: 'integer', default: 0 })
  discrepanciesOpen: number;

  @Column({ name: 'errors', type: 'integer', default: 0 })
  errors: number;

  @Column({ name: 'error_summary', type: 'text', nullable: true })
  errorSummary: string | null;

  /** Safe metadata only — no secrets, no raw broker payloads. */
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
