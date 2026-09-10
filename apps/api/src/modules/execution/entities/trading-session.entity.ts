import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ExecutionMode } from '../interfaces/execution-authority';

export enum TradingSessionStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  SUSPENDED_RISK_LIMIT = 'SUSPENDED_RISK_LIMIT',
  SUSPENDED_BROKER = 'SUSPENDED_BROKER',
  ENDED = 'ENDED',
}

/**
 * TradingSession — THE authoritative execution target (Round 5, issue #295).
 *
 * (userId, sessionId, sessionGeneration, brokerConnectionId) identifies one
 * immutable execution target. RiskService and ExecutionService MUST use
 * session.brokerConnectionId — never findActiveConnectionForUser(). At most
 * one ACTIVE session per user is enforced by a partial unique index.
 *
 * authorityGeneration (issue #298): monotonic counter advanced on explicit,
 * audited changes (mode change, connection switch, suspension/resume).
 * Outstanding RiskGrants and SEMI_AUTO confirmations bind the generation at
 * issuance; a mismatch invalidates them (never revived when switching back).
 *
 * executionMode (issue #298): PAPER_ONLY | SEMI_AUTO | FULL_AUTO — durable,
 * never inferred from connection.accountType. PAPER_ONLY is
 * database-authoritatively incapable of producing LIVE NEW exposure.
 *
 * See: docs/architecture/11-risk-engine-architecture.md §5.1
 */
@Entity({ name: 'trading_sessions', schema: 'trading' })
export class TradingSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId: string;

  @Column({ name: 'broker_connection_id', type: 'uuid' })
  brokerConnectionId: string;

  /** Durable execution mode — part of the session authority (issue #298). */
  @Column({
    name: 'execution_mode',
    type: 'varchar',
    length: 20,
    default: ExecutionMode.PAPER_ONLY,
  })
  executionMode: ExecutionMode;

  /** Monotonic session authority generation — invalidates outstanding
   *  RiskGrants / SEMI_AUTO confirmations when advanced (issue #298). */
  @Column({ name: 'authority_generation', type: 'integer', default: 1 })
  authorityGeneration: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: TradingSessionStatus,
    default: TradingSessionStatus.ACTIVE,
  })
  @Index()
  status: TradingSessionStatus;

  /** Snapshot of opening account balance for daily loss % calculation. Decimal string. */
  @Column({
    name: 'opening_balance',
    type: 'numeric',
    precision: 15,
    scale: 2,
    nullable: true,
  })
  openingBalance: string | null;

  /** Peak equity seen during this session — used for drawdown calculation. Decimal string. */
  @Column({
    name: 'peak_equity',
    type: 'numeric',
    precision: 15,
    scale: 2,
    nullable: true,
  })
  peakEquity: string | null;

  /** Snapshot of the RiskProfile at session start for audit purposes. */
  @Column({ name: 'risk_profile_snapshot', type: 'jsonb', nullable: true })
  riskProfileSnapshot: Record<string, unknown> | null;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'NOW()' })
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
