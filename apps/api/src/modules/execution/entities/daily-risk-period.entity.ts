// TEMPORARY VERIFICATION STUB (task 6-c rebuild) — NOT part of the 6-c file
// scope. The Round-6 Phase A entity (destroyed by the sandbox reset, rebuilt
// by the orchestrator/Phase A agent) had NOT landed when task 6-c's spec
// needed to compile. This stub exists ONLY to run the 6-c sqlite-mirror spec
// against the real service code; it is deleted immediately after the run.
// The production entity lives at this exact path with the same class name.
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * DailyRiskPeriod — the durable per-day loss budget (architect issue #362).
 * One row per (userId, logicalAccountKey, riskPeriodDate): the day's budget
 * is bound to the LOGICAL BROKER ACCOUNT, never to a TradingSession.
 */
@Entity({ name: 'daily_risk_periods', schema: 'trading' })
@Unique('uq_daily_risk_periods_scope', ['userId', 'logicalAccountKey', 'riskPeriodDate'])
@Index('idx_daily_risk_periods_user_day', ['userId', 'riskPeriodDate'])
export class DailyRiskPeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'broker_connection_id', type: 'uuid' })
  brokerConnectionId: string;

  @Column({ name: 'logical_account_key', type: 'varchar', length: 200 })
  logicalAccountKey: string;

  @Column({ name: 'account_currency', type: 'varchar', length: 3 })
  accountCurrency: string;

  /** UTC calendar day 'YYYY-MM-DD'. */
  @Column({ name: 'risk_period_date', type: 'date' })
  riskPeriodDate: string;

  /** Opening balance EXACTLY from the first trusted snapshot of the day. */
  @Column({ name: 'opening_balance', type: 'numeric', precision: 20, scale: 8 })
  openingBalance: string;

  /** Opening equity EXACTLY from the first trusted snapshot of the day. */
  @Column({ name: 'opening_equity', type: 'numeric', precision: 20, scale: 8 })
  openingEquity: string;

  /** Immutable lineage: the snapshot the baseline came from. */
  @Column({ name: 'opening_snapshot_id', type: 'uuid', nullable: true })
  openingSnapshotId: string | null;

  @Column({ name: 'risk_profile_id', type: 'uuid', nullable: true })
  riskProfileId: string | null;

  @Column({ name: 'risk_profile_revision', type: 'integer', nullable: true })
  riskProfileRevision: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
