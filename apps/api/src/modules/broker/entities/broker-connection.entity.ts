import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { BrokerConnectionStatus, BrokerMode } from '../interfaces/broker-adapter.interface';
import { BrokerAuthorizationStatus } from '../authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../authorization/broker-credential-status';

/**
 * BrokerConnection — persisted broker integration record per user.
 *
 * SECURITY RULES (enforced by design):
 * - `encryptedCredentials`, `credentialIv`, `credentialTag` are ALWAYS @Exclude()
 *   from API responses — they must NEVER reach the frontend
 * - Raw API keys/secrets are NEVER stored in plaintext — only AES-256-GCM ciphertext
 * - Decryption happens only inside CredentialEncryptionService, never in controllers
 *
 * See: docs/architecture/09-broker-integration-architecture.md §6
 */
@Entity({ name: 'broker_connections', schema: 'broker' })
export class BrokerConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId: string;

  @Column({ name: 'broker_id', type: 'varchar', length: 50 })
  brokerId: string;

  @Column({ name: 'broker_name', type: 'varchar', length: 100 })
  brokerName: string;

  @Column({ name: 'display_name', type: 'varchar', length: 100, nullable: true })
  displayName: string | null;

  /** Broker-side account identifier — safe to store, not a secret. */
  @Column({ name: 'account_id', type: 'varchar', length: 100, nullable: true })
  accountId: string | null;

  @Column({
    name: 'account_type',
    type: 'varchar',
    length: 10,
    enum: BrokerMode,
    default: BrokerMode.DEMO,
  })
  accountType: BrokerMode;

  @Column({ name: 'account_currency', type: 'varchar', length: 3, nullable: true })
  accountCurrency: string | null;

  @Column({ name: 'account_leverage', type: 'integer', nullable: true })
  accountLeverage: number | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: BrokerConnectionStatus,
    default: BrokerConnectionStatus.DISCONNECTED,
  })
  status: BrokerConnectionStatus;

  // ─── Authorization state machine (Sprint 50, Directive §15) ───────────────

  /**
   * AUTHORITATIVE automation gate. Only ACTIVE permits execution.
   * Transitions validated server-side by BrokerAuthorizationStateMachine —
   * the frontend can never enable execution by mutating view state.
   * Legacy booleans below are dual-written for backward compatibility.
   */
  @Column({
    name: 'authorization_status',
    type: 'varchar',
    length: 30,
    default: BrokerAuthorizationStatus.NOT_CONNECTED,
  })
  authorizationStatus: BrokerAuthorizationStatus;

  /** Lifecycle of the stored (encrypted) credential set (Directive §14). */
  @Column({
    name: 'credential_status',
    type: 'varchar',
    length: 20,
    default: BrokerCredentialStatus.CREATED,
  })
  credentialStatus: BrokerCredentialStatus;

  @Column({ name: 'authorized_at', type: 'timestamptz', nullable: true })
  authorizedAt: Date | null;

  @Column({ name: 'authorization_revoked_at', type: 'timestamptz', nullable: true })
  authorizationRevokedAt: Date | null;

  // ─── Encrypted credential fields — NEVER exposed in responses ────────────

  /**
   * AES-256-GCM ciphertext of the credentials JSON blob.
   * Shape before encryption: { apiKey, apiSecret, accountId, serverUrl, ... }
   */
  @Column({ name: 'encrypted_credentials', type: 'text', nullable: true })
  @Exclude()
  encryptedCredentials: string | null;

  /** AES-GCM Initialisation Vector (hex-encoded, 12 bytes = 24 hex chars). */
  @Column({ name: 'credential_iv', type: 'varchar', length: 32, nullable: true })
  @Exclude()
  credentialIv: string | null;

  /** AES-GCM authentication tag (hex-encoded, 16 bytes = 32 hex chars). */
  @Column({ name: 'credential_tag', type: 'varchar', length: 48, nullable: true })
  @Exclude()
  credentialTag: string | null;

  /**
   * Key reference for KMS-managed key rotation.
   * In dev: env-var key identifier string.
   * In prod: AWS KMS key ARN or Vault path.
   */
  @Column({ name: 'encryption_key_id', type: 'varchar', length: 255, nullable: true })
  @Exclude()
  encryptionKeyId: string | null;

  // ─── Health and sync state ────────────────────────────────────────────────

  @Column({ name: 'last_health_check_at', type: 'timestamptz', nullable: true })
  lastHealthCheckAt: Date | null;

  @Column({ name: 'last_sync_at', type: 'timestamptz', nullable: true })
  lastSyncAt: Date | null;

  @Column({ name: 'consecutive_failure_count', type: 'integer', default: 0 })
  consecutiveFailureCount: number;

  @Column({ name: 'last_error_message', type: 'text', nullable: true })
  lastErrorMessage: string | null;

  /** LEGACY (dual-written): DEMO mode must be tested before LIVE mode is enabled. */
  @Column({ name: 'demo_validated', type: 'boolean', default: false })
  demoValidated: boolean;

  /** LEGACY (dual-written): mirrors authorizationStatus === ACTIVE. */
  @Column({ name: 'live_trading_enabled', type: 'boolean', default: false })
  liveTradingEnabled: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
