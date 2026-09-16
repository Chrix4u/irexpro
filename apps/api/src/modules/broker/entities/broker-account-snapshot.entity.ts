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
 * BrokerAccountSnapshot — versioned, monotonic financial snapshot authority
 * for a broker connection (architect issues #297/#312).
 *
 * All financial fields move together as ONE logical version:
 * balance, equity, margin, freeMargin, marginLevel, leverage,
 * openPositionsCount, currency, source, provider/account identity.
 *
 * Invariants:
 *  - generation is monotonic per connection: a stale worker can never
 *    overwrite a newer accepted snapshot (write guard: INSERT only with
 *    generation > current max; (connection_id, generation) is unique);
 *  - LIVE NEW-exposure requires a snapshot that is present, well-formed and
 *    within the configurable max age at the final pre-trade boundary;
 *  - connection health-check time is NOT snapshot freshness;
 *  - no long SQL transactions are held across provider network I/O — the
 *    provider read happens first, then a guarded INSERT.
 */
@Entity({ name: 'broker_account_snapshots', schema: 'broker' })
@Unique('uq_broker_account_snapshot_connection_generation', ['connectionId', 'generation'])
@Index('idx_broker_account_snapshots_connection_id', ['connectionId'])
@Index('idx_broker_account_snapshots_connection_accepted', ['connectionId', 'acceptedAt'])
export class BrokerAccountSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'connection_id', type: 'uuid' })
  connectionId: string;

  /** Monotonic logical version — all fields move together. */
  @Column({ name: 'generation', type: 'integer' })
  generation: number;

  /** Provider-observed timestamp where available. */
  @Column({ name: 'provider_observed_at', type: 'timestamptz', nullable: true })
  providerObservedAt: Date | null;

  /** Server accept time. */
  @Column({ name: 'accepted_at', type: 'timestamptz', default: () => 'NOW()' })
  acceptedAt: Date;

  @Column({ name: 'balance', type: 'numeric', precision: 20, scale: 8, nullable: true })
  balance: string | null;

  @Column({ name: 'equity', type: 'numeric', precision: 20, scale: 8, nullable: true })
  equity: string | null;

  @Column({ name: 'margin', type: 'numeric', precision: 20, scale: 8, nullable: true })
  margin: string | null;

  @Column({ name: 'free_margin', type: 'numeric', precision: 20, scale: 8, nullable: true })
  freeMargin: string | null;

  @Column({ name: 'margin_level', type: 'numeric', precision: 20, scale: 8, nullable: true })
  marginLevel: string | null;

  @Column({ name: 'leverage', type: 'integer', nullable: true })
  leverage: number | null;

  @Column({ name: 'open_positions_count', type: 'integer', nullable: true })
  openPositionsCount: number | null;

  @Column({ name: 'currency', type: 'varchar', length: 3, nullable: true })
  currency: string | null;

  /** Where the snapshot came from ('provider:<tech>' | 'reconciliation' | ...). */
  @Column({ name: 'source', type: 'varchar', length: 30 })
  source: string;

  /** Sanitized provider/account identity reference (never credentials). */
  @Column({ name: 'provider_account_identity', type: 'varchar', length: 200, nullable: true })
  providerAccountIdentity: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
