import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * BrokerLinkOutbox — durable outbox for post-commit broker-link side effects
 * (Sprint 56 correction round 5, architect issue #332 — P0).
 *
 * WHY: BrokerService.createConnection previously persisted the
 * BrokerConnection BEFORE awaiting its audit operation. Persistence could
 * succeed, the audit (or any other post-save await) could fail, and
 * createConnection would THROW with the row already committed — the OAuth
 * flow then returned to AUTHORIZED and a retry created a DUPLICATE durable
 * connection.
 *
 * THE FIX (transactional outbox): the connection INSERT and its post-commit
 * audit/event work are committed in ONE transaction. The audit/event
 * delivery happens asynchronously (BrokerLinkOutboxService.sweep, scheduled
 * by the broker health-check job) with retries and backoff:
 * - an audit/event failure can NEVER make a committed connection look
 *   uncommitted (the flow converges to CONSUMED — see
 *   BrokerOAuthService.linkAccount);
 * - the delivery work is NEVER lost (the row IS the work: `payload`).
 *
 * DELIVERY SEMANTICS: at-least-once with a claim-then-deliver CAS — a
 * sweeper increments `attempts` (the claim) before delivering and sets
 * `processedAt` after. Two replicas sweeping concurrently never both mark a
 * row processed; a crash mid-delivery leaves the claim counted and the row
 * is retried after the backoff derived from `attempts` (measured from
 * `updatedAt`, the last-attempt timestamp). Rows exceeding the max attempt
 * count stay unprocessed and operator-visible (poison rows — never silently
 * dropped).
 *
 * Column types follow the BrokerOAuthFlow entity's portability pattern: the
 * portable `Date` constructor + `simple-json` payload keep the entity usable
 * with the sqlite in-memory test harness, while migration 1754100000000 owns
 * the production DDL (timestamptz / jsonb).
 */
export const BROKER_LINK_OUTBOX_EVENT_TYPES = [
  /** Deliver a BROKER_CONNECTION_CREATED audit entry via AuditService. */
  'connection-created-audit',
  /** Deliver a BROKER_OAUTH_ACCOUNT_LINKED audit entry via AuditService. */
  'oauth-account-linked-audit',
  /** Deliver a broker connection status event via DomainEventBus. */
  'broker-status-event',
] as const;

export type BrokerLinkOutboxEventType = (typeof BROKER_LINK_OUTBOX_EVENT_TYPES)[number];

/** Audit-entry payload (delivered via AuditService.log — no token material). */
export interface BrokerLinkOutboxAuditPayload extends Record<string, unknown> {
  /** AuditAction value (string — jsonb-safe). */
  action: string;
  actorUserId: string;
  ipAddress?: string | null;
  metadata?: Record<string, unknown> | null;
  /** AuditSeverity value (string — jsonb-safe). */
  severity?: string | null;
}

/** Domain-event payload (delivered via DomainEventBus.publish). */
export interface BrokerLinkOutboxEventPayload extends Record<string, unknown> {
  /** DomainEventType value (string — jsonb-safe). */
  domainEventType: string;
  userId: string;
  payload: Record<string, unknown>;
}

@Entity({ name: 'broker_link_outbox', schema: 'broker' })
export class BrokerLinkOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The durable BrokerConnection this side effect belongs to. */
  @Index()
  @Column({ name: 'connection_id', type: 'uuid' })
  connectionId: string;

  /** Originating OAuth flow (traceability only; null for manual connects). */
  @Column({ name: 'flow_id', type: 'varchar', length: 64, nullable: true })
  flowId: string | null;

  /** Discriminator for the sweep's delivery dispatch. */
  @Column({ name: 'event_type', type: 'varchar', length: 50 })
  eventType: BrokerLinkOutboxEventType;

  /** The delivery work itself (audit/event payload — jsonb in production). */
  @Column({ name: 'payload', type: 'simple-json' })
  payload: Record<string, unknown>;

  /** Delivery attempt count (claim-then-deliver CAS + backoff exponent). */
  @Column({ name: 'attempts', type: 'integer', default: 0 })
  attempts: number;

  /** Set when the side effect has been delivered (NULL = pending). */
  @Index()
  @Column({ name: 'processed_at', type: Date, nullable: true })
  processedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: Date })
  createdAt: Date;

  /** Last-attempt timestamp (drives the retry backoff). */
  @UpdateDateColumn({ name: 'updated_at', type: Date })
  updatedAt: Date;
}
