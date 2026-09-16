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
 *
 * COLUMN-TYPE PORTABILITY (Sprint 56 correction round 5, issue #332): the
 * timestamp columns use the portable `Date` constructor (and `status` is a
 * plain varchar) instead of `timestamptz`/`enum` — exactly the pattern the
 * BrokerOAuthFlow entity documents. Migration DDL owns the PRODUCTION types
 * (timestamptz / varchar(30)); the entity declaration only drives test-harness
 * DDL, and dialect-specific types made BrokerConnection unusable with the
 * sqlite in-memory harness that now proves durable-link idempotency.
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

  // ─── Server-derived provider identity (Sprint 56 correction round 4, ──────
  //     architect finding 9) ──────────────────────────────────────────────────

  /**
   * SANITIZED normalized identity of the actual broker behind this
   * connection (e.g. 'pepperstone', 'icmarkets', 'spotware'), as discovered
   * by the SERVER through cTrader account discovery (2149
   * brokerTitleShort) during OAuth linking.
   *
   * - SERVER-DERIVED ONLY: never client-submitted, never overwritten by API
   *   input (the public ConnectBrokerDto carries no such field).
   * - Not a secret; never credential material (lowercase alphanumeric
   *   normalization of the discovered title).
   * - NULL = unknown identity (no discovery evidence) — identity-scoped
   *   production-LIVE verification treats it FAIL-CLOSED (finding 10).
   * - Identity-scoped LIVE eligibility: one broker's verification NEVER
   *   authorizes another (the generic cTrader entry cannot blanket-authorize
   *   Pepperstone/IC Markets/unknown brokers).
   */
  @Column({ name: 'provider_broker_identity', type: 'varchar', length: 100, nullable: true })
  providerBrokerIdentity: string | null;

  /**
   * Logical broker-account identity key (Round 5, issue #332) —
   * SERVER-COMPUTED canonical key:
   *   `<providerTechnology>|<normalizedProviderIdentity|canonicalBrokerId>|<providerAccountId>`
   * Enforced UNIQUE per user (partial unique index over non-deleted rows)
   * so the same provider account cannot become duplicable by retrying an
   * OAuth link or by selecting cTrader alias broker ids
   * (ctrader / pepperstone-ctrader / icmarkets-ctrader).
   *
   * - SERVER-DERIVED ONLY (computed from provider discovery + connection
   *   row; clients never submit it).
   * - NULL = insufficient evidence (manual/legacy rows) — excluded from the
   *   unique constraint until evidence exists.
   * - Soft deletion frees the key for intentional relinking (documented
   *   semantics: deleted_at IS NULL scope).
   */
  @Column({ name: 'logical_account_key', type: 'varchar', length: 255, nullable: true })
  logicalAccountKey: string | null;

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
    // Round 5 (#332): portable 'varchar' — the production column is
    // varchar(30) (baseline migration) and the enum-declared type blocked the
    // sqlite test harness (see the portability note at the class bottom).
    type: 'varchar',
    length: 30,
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

  // ─── Concurrent OAuth refresh protection (Sprint 56 correction round 2, ────
  //     architect finding 3 — per-connection refresh serialization) ───────────

  /**
   * Monotonic credential rotation generation — CAS token for concurrent
   * refresh protection. Every successful token-pair rotation increments it;
   * a refresh that observed a stale generation can never overwrite a newer
   * one (conditional UPDATE on credential_generation = observed value).
   */
  @Column({ name: 'credential_generation', type: 'integer', default: 0 })
  credentialGeneration: number;

  /**
   * Refresh lease expiry (timestamptz, NULL = free) — DB-atomic claim that
   * serializes OAuth refreshes ACROSS API replicas (not merely an in-memory
   * mutex). Spotware rotates BOTH tokens on refresh and invalidates the
   * previous pair, so two concurrent refreshes of one credential generation
   * would permanently kill the credential.
   */
  @Column({ name: 'credential_refresh_lease_expires_at', type: Date, nullable: true })
  credentialRefreshLeaseExpiresAt: Date | null;

  /**
   * Round 6 (task 6-d, brief §20): UNIQUE lease-OWNER token (random UUID,
   * ≤ 64 chars) for the OAuth refresh lease. The claim atomically sets BOTH
   * `credential_refresh_lease_expires_at` AND this fresh owner token; a
   * takeover mints a NEW token. EVERY winner-only operation — successful
   * token-pair persistence, terminal INVALID transition, lease release —
   * additionally requires the EXACT owner token (plus connection id and
   * observed credential generation).
   *
   * `credential_refresh_lease_expires_at IS NULL` is NEVER treated as proof
   * that a stale owner regained ownership: a released lease clears BOTH
   * columns, so a stale replica's writes match ZERO rows.
   */
  @Column({ name: 'credential_refresh_lease_owner', type: 'varchar', length: 64, nullable: true })
  credentialRefreshLeaseOwner: string | null;

  @Column({ name: 'authorized_at', type: Date, nullable: true })
  authorizedAt: Date | null;

  @Column({ name: 'authorization_revoked_at', type: Date, nullable: true })
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

  @Column({ name: 'last_health_check_at', type: Date, nullable: true })
  lastHealthCheckAt: Date | null;

  @Column({ name: 'last_sync_at', type: Date, nullable: true })
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

  @CreateDateColumn({ name: 'created_at', type: Date })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: Date })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt: Date | null;
}
