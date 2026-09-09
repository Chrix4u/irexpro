import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * BrokerOAuthFlow — the replica-safe, persistent OAuth authorization-state
 * store for the cTrader-family connection flow (Sprint 56 correction round 2 /
 * architect finding 2).
 *
 * REPLACES the former process-local Map: the flow state must survive API
 * process restarts and be observable by EVERY load-balanced replica, so it
 * lives in the SAME PostgreSQL database as every other entity (this repo has
 * no Redis cache; PostgreSQL IS the shared store via TypeORM).
 *
 * SECURITY RULES (enforced by design + adversarially tested):
 * - `tokenCiphertext`/`tokenIv`/`tokenTag`/`tokenKeyId` hold the
 *   AES-256-GCM-encrypted { accessToken, refreshToken } bundle — tokens are
 *   NEVER stored in plaintext at rest, NEVER logged, NEVER returned in any
 *   response. NULL unless the flow reached AUTHORIZED/LINKING.
 * - `accounts` holds the SANITIZED discovery list only (ctid/isLive/login/
 *   brokerTitleShort) — NO token material.
 * - `handoffTokenHash` is the SHA-256 hex digest of the opaque one-time
 *   handoff token — the RAW token is never persisted (only its digest).
 * - State transitions are CONDITIONAL single-row UPDATEs (compare-and-set on
 *   the previous state) with an affected-rows check: exactly one winner per
 *   transition, everywhere (single instance, multiple replicas, restarts).
 * - No FK constraints (mirrors BrokerConnection). Bounded storage: rows are
 *   inert after CONSUMED/expiry and lazily swept (expires_at older than 1h).
 *
 * Column types: timestamps are declared with the portable `Date` constructor
 * (postgres → timestamp semantics at the TypeORM level) while migration
 * 1753800000000 creates them as `timestamptz` in PostgreSQL — the entity type
 * declaration only drives synchronize-mode DDL (production runs migrations),
 * and using `timestamptz` directly would make the entity unusable with the
 * sqlite in-memory test harness that proves cross-replica behavior.
 */
export const BROKER_OAUTH_FLOW_STATES = ['PENDING', 'AUTHORIZED', 'LINKING', 'CONSUMED'] as const;

export type BrokerOAuthFlowState = (typeof BROKER_OAUTH_FLOW_STATES)[number];

/**
 * Sanitized discovered account persisted on the flow (and returned to
 * clients) — ids/flags ONLY, never token material.
 */
export interface BrokerOAuthAccount {
  ctidTraderAccountId: string;
  isLive: boolean;
  traderLogin?: number;
  brokerTitleShort?: string;
}

@Entity({ name: 'broker_oauth_flows', schema: 'broker' })
export class BrokerOAuthFlow {
  /** Server-generated opaque flow identifier (never derived from user input). */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Owning user — cross-user lookups behave exactly like not-found. */
  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId: string;

  /** Broker (provider) the flow is for — cTrader family ids. */
  @Column({ name: 'broker_id', type: 'varchar', length: 50 })
  brokerId: string;

  /** Redirect URI bound to this flow (web callback page or mobile slot URI). */
  @Column({ name: 'redirect_uri', type: 'varchar', length: 500 })
  @Index()
  redirectUri: string;

  /** Explicit lifecycle state (see BROKER_OAUTH_FLOW_STATES). */
  @Column({ name: 'state', type: 'varchar', length: 20 })
  state: BrokerOAuthFlowState;

  /** Last state transition time (LINKING stale-claim recovery uses 60 s). */
  @Column({ name: 'state_changed_at', type: Date })
  stateChangedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: Date })
  createdAt: Date;

  /** Hard TTL boundary — expired flows fail closed and are swept later. */
  @Column({ name: 'expires_at', type: Date })
  @Index()
  expiresAt: Date;

  // ─── Encrypted token bundle — NULL unless AUTHORIZED/LINKING ──────────────

  /** AES-256-GCM ciphertext (hex) of the {accessToken, refreshToken} JSON. */
  @Column({ name: 'token_ciphertext', type: 'text', nullable: true })
  tokenCiphertext: string | null;

  /** AES-GCM IV (hex, 12 bytes = 24 hex chars). */
  @Column({ name: 'token_iv', type: 'varchar', length: 32, nullable: true })
  tokenIv: string | null;

  /** AES-GCM auth tag (hex, 16 bytes = 32 hex chars). */
  @Column({ name: 'token_tag', type: 'varchar', length: 48, nullable: true })
  tokenTag: string | null;

  /** Key reference (KMS/Vault rotation handle; dev: env-key id). */
  @Column({ name: 'token_key_id', type: 'varchar', length: 255, nullable: true })
  tokenKeyId: string | null;

  /** Provider access-token expiry (UTC) — drives pre-use refresh. */
  @Column({ name: 'access_token_expires_at', type: Date, nullable: true })
  accessTokenExpiresAt: Date | null;

  // ─── Sanitized discovery result — NO token material ───────────────────────

  /** BrokerOAuthAccount[] (sanitized: ids/flags only). simple-json for
   *  sqlite/PG portability. */
  @Column({ name: 'accounts', type: 'simple-json', nullable: true })
  accounts: BrokerOAuthAccount[] | null;

  // ─── Mobile handoff token (finding 4) — digest only, never the token ──────

  /** SHA-256 hex digest of the one-time opaque handoff token. */
  @Column({ name: 'handoff_token_hash', type: 'varchar', length: 64, nullable: true })
  handoffTokenHash: string | null;

  /** Handoff-token TTL boundary (120 s from issuance). */
  @Column({ name: 'handoff_expires_at', type: Date, nullable: true })
  handoffExpiresAt: Date | null;

  @Column({ name: 'completed_at', type: Date, nullable: true })
  completedAt: Date | null;

  @Column({ name: 'consumed_at', type: Date, nullable: true })
  consumedAt: Date | null;
}
