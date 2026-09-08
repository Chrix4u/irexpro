import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  ReconciliationDiscrepancySeverity,
  ReconciliationDiscrepancyStatus,
  ReconciliationDiscrepancyType,
  ReconciliationRefType,
} from '../reconciliation.enums';

/**
 * ReconciliationDiscrepancy — one PERSISTED mismatch between internal state
 * and provider state (Directive §25: "Do not silently hide reconciliation
 * errors. Persist or surface discrepancies appropriately.").
 *
 * DEDUPLICATION: a partial unique index (see migration 1753700000000) makes
 * (connection, type, internal_ref, provider_ref) unique among OPEN rows, so
 * repeated runs re-detecting the same drift update `lastSeenAt` instead of
 * stacking duplicates. Resolving flips status to RESOLVED; if the same drift
 * reappears later a fresh OPEN row is created (honest history).
 *
 * SAFETY: `details` must only contain SAFE comparison facts (expected vs
 * observed values, decimal strings, enums) — never credentials or raw
 * provider payloads.
 */
@Entity({ name: 'discrepancies', schema: 'reconciliation' })
@Index(['userId', 'status'])
@Index(['brokerConnectionId', 'status'])
@Index(['type', 'status'])
@Index(['runId'])
export class ReconciliationDiscrepancy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId: string;

  @Column({ name: 'broker_connection_id', type: 'uuid' })
  @Index()
  brokerConnectionId: string;

  /** Run that first detected this discrepancy (lineage). */
  @Column({ name: 'run_id', type: 'uuid', nullable: true })
  runId: string | null;

  @Column({
    name: 'discrepancy_type',
    type: 'enum',
    enum: ReconciliationDiscrepancyType,
  })
  @Index()
  type: ReconciliationDiscrepancyType;

  @Column({
    name: 'severity',
    type: 'enum',
    enum: ReconciliationDiscrepancySeverity,
  })
  severity: ReconciliationDiscrepancySeverity;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ReconciliationDiscrepancyStatus,
    default: ReconciliationDiscrepancyStatus.OPEN,
  })
  @Index()
  status: ReconciliationDiscrepancyStatus;

  /** Which internal aggregate the mismatch refers to (ORDER/TRADE/ACCOUNT). */
  @Column({
    name: 'internal_ref_type',
    type: 'enum',
    enum: ReconciliationRefType,
    nullable: true,
  })
  internalRefType: ReconciliationRefType | null;

  /** Internal record id (order/trade) — null for provider-only findings. */
  @Column({ name: 'internal_ref_id', type: 'varchar', length: 255, nullable: true })
  internalRefId: string | null;

  /** Stable caller-supplied correlation id, when known. */
  @Column({ name: 'client_order_id', type: 'varchar', length: 100, nullable: true })
  clientOrderId: string | null;

  /** Provider-side identifier (order ticket / position id). */
  @Column({ name: 'provider_ref', type: 'varchar', length: 255, nullable: true })
  providerRef: string | null;

  /** SAFE comparison facts: expected vs observed (decimal strings, enums). */
  @Column({ name: 'details', type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;

  @Column({ name: 'first_detected_at', type: 'timestamptz' })
  firstDetectedAt: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  /** How the discrepancy was resolved (safe human-readable reason). */
  @Column({ name: 'resolution', type: 'varchar', length: 500, nullable: true })
  resolution: string | null;

  /** AUTO = resolution service acted; MANUAL = human/admin action. */
  @Column({ name: 'resolved_by', type: 'varchar', length: 20, nullable: true })
  resolvedBy: 'AUTO' | 'MANUAL' | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
