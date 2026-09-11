import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  AuthoritativeOrderPayload,
  ExecutionMode,
  RiskGrantStatus,
} from '../interfaces/execution-authority';

/**
 * RiskGrant — the durable, server-authoritative risk approval bound to ONE
 * exact order and ONE exact authority state (architect issue #301).
 *
 * ExecutionService accepts ONLY an opaque grant identifier issued by
 * RiskService. A caller-constructed plain object can never satisfy the
 * final dispatch boundary — the grant row must exist, be ACTIVE, match the
 * current session generation, connection, mode, authority generation,
 * control revisions, snapshot freshness requirements and the exact
 * validated order digest, and be consumed atomically before dispatch.
 *
 * Invariants:
 *  - issued ONLY by RiskService;
 *  - immutable after issuance (only lifecycle timestamps/status change);
 *  - short-lived (expiresAt enforced at consume time);
 *  - single-use for NEW exposure (CAS consume);
 *  - invalidated by any authority change (never revived);
 *  - never reusable after ambiguous provider dispatch.
 */
@Entity({ name: 'risk_grants', schema: 'trading' })
@Index('idx_risk_grants_user_id', ['userId'])
@Index('idx_risk_grants_session_id', ['sessionId'])
@Index('idx_risk_grants_signal_id', ['signalId'])
export class RiskGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** Stable producer-assigned signal identifier (issue #302). */
  @Column({ name: 'signal_id', type: 'varchar', length: 100 })
  signalId: string;

  /** SHA-256 canonical digest of the immutable signal payload. */
  @Column({ name: 'signal_payload_digest', type: 'varchar', length: 64 })
  signalPayloadDigest: string;

  /** Exact session this grant is bound to. */
  @Column({ name: 'session_id', type: 'uuid' })
  sessionId: string;

  /** Session authority generation at issuance — must still match at dispatch. */
  @Column({ name: 'session_generation', type: 'integer' })
  sessionGeneration: number;

  @Column({ name: 'execution_mode', type: 'varchar', length: 20 })
  executionMode: ExecutionMode;

  /** EXACT broker connection — never substituted at any stage. */
  @Column({ name: 'broker_connection_id', type: 'uuid' })
  brokerConnectionId: string;

  /**
   * Round 5 (#361 final-dispatch fencing): BrokerConnection.credentialGeneration
   * observed at issuance. NULL = the issuer (RiskService) did not observe it —
   * the final dispatch boundary then reads the CURRENT generation for the
   * returned authority context but cannot fence on it; whenever the value IS
   * present, ANY drift (credential rotation between approval and dispatch)
   * blocks NEW exposure fail-closed.
   */
  @Column({ name: 'credential_generation', type: 'integer', nullable: true })
  credentialGeneration: number | null;

  /** Server-derived persisted provider identity at issuance (NULL = unknown). */
  @Column({ name: 'provider_broker_identity', type: 'varchar', length: 100, nullable: true })
  providerBrokerIdentity: string | null;

  /** Identity-scoped LIVE-verification evidence fingerprint/model version at issuance. */
  @Column({
    name: 'provider_verification_fingerprint',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  providerVerificationFingerprint: string | null;

  @Column({ name: 'risk_profile_id', type: 'uuid', nullable: true })
  riskProfileId: string | null;

  @Column({ name: 'risk_profile_version', type: 'integer', nullable: true })
  riskProfileVersion: number | null;

  /** Digest of the RiskProfile at issuance. */
  @Column({ name: 'risk_profile_hash', type: 'varchar', length: 64, nullable: true })
  riskProfileHash: string | null;

  @Column({ name: 'account_snapshot_id', type: 'uuid', nullable: true })
  accountSnapshotId: string | null;

  @Column({ name: 'account_snapshot_generation', type: 'integer', nullable: true })
  accountSnapshotGeneration: number | null;

  @Column({ name: 'account_snapshot_observed_at', type: 'timestamptz', nullable: true })
  accountSnapshotObservedAt: Date | null;

  /** User trading-authority generation at issuance (issue #300). */
  @Column({ name: 'authority_generation', type: 'integer' })
  authorityGeneration: number;

  /** Kill-switch/execution-control revisions observed at issuance (issue #299). */
  @Column({ name: 'kill_switch_generation', type: 'integer', nullable: true })
  killSwitchGeneration: number | null;

  @Column({ name: 'execution_control_revision', type: 'integer', nullable: true })
  executionControlRevision: number | null;

  /** SHA-256 canonical digest of the EXACT validated order payload. */
  @Column({ name: 'order_payload_digest', type: 'varchar', length: 64 })
  orderPayloadDigest: string;

  /** The exact validated order payload (immutable). */
  @Column({ name: 'order_payload', type: 'jsonb' })
  orderPayload: AuthoritativeOrderPayload;

  /** Quote reference observed for MARKET geometry (price + timestamp + instrument metadata, issue #331). */
  @Column({ name: 'quote_ref', type: 'jsonb', nullable: true })
  quoteRef: Record<string, unknown> | null;

  @Column({ name: 'issued_at', type: 'timestamptz', default: () => 'NOW()' })
  issuedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  @Column({ name: 'invalidated_at', type: 'timestamptz', nullable: true })
  invalidatedAt: Date | null;

  @Column({ name: 'invalidation_reason', type: 'varchar', length: 200, nullable: true })
  invalidationReason: string | null;

  @Column({ name: 'status', type: 'varchar', length: 30, default: RiskGrantStatus.ACTIVE })
  status: RiskGrantStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
