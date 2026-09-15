import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { BrokerAccountSnapshot } from '../entities/broker-account-snapshot.entity';
import { BrokerAccount } from '../entities/broker-account.entity';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { isUniqueViolation } from '../../broker/utils/db-unique-violation';

/**
 * BrokerAccountSnapshotService — the versioned, monotonic financial snapshot
 * authority for broker connections (Sprint 56 correction round 6, architect
 * issues #297/#312).
 *
 * DESIGN CONTRACT
 * ───────────────
 *  - ALL financial fields move together as ONE logical version: a snapshot row
 *    is immutable after insert; a newer observation NEVER partially overwrites
 *    an older accepted one.
 *  - `generation` is monotonic per connection: an accepted snapshot is written
 *    with generation = current max + 1 inside a SHORT guarded transaction
 *    (SELECT max ... FOR UPDATE on PostgreSQL; the suffix is NOT emitted for
 *    drivers whose SQL parser rejects it — sqlite). INSERT-only: an older run
 *    can never overwrite newer accepted truth.
 *  - The UNIQUE (connection_id, generation) constraint is the hard backstop:
 *    a lost generation race surfaces as a unique violation, which is retried
 *    ONCE in a FRESH transaction (PostgreSQL aborted-transaction semantics —
 *    a failed statement poisons its transaction, so the retry can never
 *    continue inside it). A second collision means another writer keeps
 *    winning; the outcome is the typed STALE_GENERATION result, never a
 *    guessed write.
 *  - In-process per-connection WRITE LEASE (architect-preferred): overlapping
 *    acceptSnapshot() calls for the same connection serialize inside this
 *    process, so the guarded transaction stays SHORT and the unique backstop
 *    only fires for genuine multi-process races. The provider network I/O is
 *    NEVER performed inside the guarded transaction — the observation is
 *    fully materialized by the caller first.
 *  - Freshness is NEVER derived from write time: the observation instant of a
 *    snapshot is providerObservedAt ?? acceptedAt (documented fallback — when
 *    the provider reports no timestamp, the server accept time is the best
 *    available evidence of when the facts held). Connection health-check time
 *    is NOT snapshot freshness.
 *  - No synthetic currency: an unknown account currency stays unknown; a
 *    LIVE NEW-exposure decision that cannot prove currency fails closed
 *    (SNAPSHOT_CURRENCY_UNKNOWN), it is never defaulted to 'USD'.
 *  - projectToLegacyAccount() maintains ONLY the legacy compat current-view
 *    (broker.broker_accounts). It is a projection, not an authority: the
 *    guard `existing.last_snapshot_generation >= snapshot.generation` skips
 *    stale projections so the legacy view never moves backwards, synced_at is
 *    the snapshot's acceptedAt (never now()), and last_snapshot_generation
 *    only ever moves forward.
 */

/**
 * NEW_EXPOSURE_SNAPSHOT_MAX_AGE_MS — maximum age of the observation instant
 * (providerObservedAt ?? acceptedAt) for a snapshot to authorise LIVE NEW
 * exposure (architect issue #312: 30 seconds). Configurable per call for
 * tests and stricter call sites.
 */
export const NEW_EXPOSURE_SNAPSHOT_MAX_AGE_MS = 30_000;

/** A provider account observation, fully materialized BEFORE any DB work. */
export interface ProviderAccountObservation {
  connectionId: string;
  balance: string | null;
  equity: string | null;
  margin: string | null;
  freeMargin: string | null;
  marginLevel: string | null;
  leverage: number | null;
  openPositionsCount: number | null;
  currency: string | null;
  providerObservedAt: Date | null;
  providerAccountIdentity: string | null;
  source: string;
}

/** acceptSnapshot either won a generation, or lost to a live writer. */
export type SnapshotAcceptOutcome =
  | { accepted: true; snapshot: BrokerAccountSnapshot }
  | { accepted: false; reason: 'STALE_GENERATION'; currentGeneration: number };

/** Typed fail-closed reasons a snapshot cannot authorise NEW exposure. */
export type SnapshotFreshnessFailure =
  | { code: 'SNAPSHOT_MISSING' }
  | { code: 'SNAPSHOT_STALE'; ageMs: number; maxAgeMs: number }
  | { code: 'SNAPSHOT_MALFORMED'; field: string }
  | { code: 'SNAPSHOT_CURRENCY_UNKNOWN' };

/** Typed freshness rejection — the caller NEVER falls back to a guess. */
export class SnapshotNotFreshError extends Error {
  constructor(
    readonly failure: SnapshotFreshnessFailure,
    readonly connectionId: string,
  ) {
    super(
      `Snapshot for connection ${connectionId} is not fresh enough for NEW exposure: ` +
        `${failure.code}` +
        ('ageMs' in failure ? ` (ageMs=${failure.ageMs}, maxAgeMs=${failure.maxAgeMs})` : '') +
        ('field' in failure ? ` (field=${failure.field})` : ''),
    );
    this.name = 'SnapshotNotFreshError';
  }
}

/** Malformed decimal string in an observation — rejected BEFORE any insert. */
export class MalformedSnapshotFieldError extends Error {
  constructor(
    readonly field: keyof ProviderAccountObservation,
    readonly value: string,
  ) {
    super(
      `Malformed decimal string in provider account observation field "${String(field)}": "${value}"`,
    );
    this.name = 'MalformedSnapshotFieldError';
  }
}

/** Options for resolveFreshSnapshotForNewExposure. */
export interface SnapshotFreshnessOptions {
  maxAgeMs?: number;
  /** Deterministic clock for tests. */
  now?: Date;
}

@Injectable()
export class BrokerAccountSnapshotService {
  private readonly logger = new Logger(BrokerAccountSnapshotService.name);

  /** In-process per-connection write lease (tail promise chain per key). */
  private readonly connectionWriteLeases = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(BrokerAccountSnapshot)
    private readonly snapshotRepo: Repository<BrokerAccountSnapshot>,
    @InjectRepository(BrokerAccount)
    private readonly legacyRepo: Repository<BrokerAccount>,
    private readonly dataSource: DataSource,
  ) {}

  // ─── Read path ─────────────────────────────────────────────────────────────

  /**
   * Latest ACCEPTED snapshot for the connection — ordered by generation
   * (the logical version), NEVER by write time: a delayed write of an older
   * observation can never masquerade as newer truth.
   */
  async readLatestAcceptedSnapshot(connectionId: string): Promise<BrokerAccountSnapshot | null> {
    return this.snapshotRepo.findOne({
      where: { connectionId },
      order: { generation: 'DESC' },
    });
  }

  /**
   * Resolve the snapshot that authorises LIVE NEW exposure (issue #312).
   * Fail-closed precedence (checked in this exact order):
   *   1. SNAPSHOT_MISSING — nothing accepted for the connection;
   *   2. SNAPSHOT_STALE — observation instant (providerObservedAt ??
   *      acceptedAt) older than maxAgeMs (default 30s);
   *   3. SNAPSHOT_MALFORMED — balance or equity absent/unparseable (the two
   *      fields every exposure computation needs);
   *   4. SNAPSHOT_CURRENCY_UNKNOWN — currency null or not /^[A-Z]{3}$/.
   *      NO synthetic 'USD' is ever fabricated.
   */
  async resolveFreshSnapshotForNewExposure(
    connectionId: string,
    opts?: SnapshotFreshnessOptions,
  ): Promise<BrokerAccountSnapshot> {
    const maxAgeMs = opts?.maxAgeMs ?? NEW_EXPOSURE_SNAPSHOT_MAX_AGE_MS;
    const now = opts?.now ?? new Date();

    const snapshot = await this.readLatestAcceptedSnapshot(connectionId);
    if (!snapshot) {
      throw new SnapshotNotFreshError({ code: 'SNAPSHOT_MISSING' }, connectionId);
    }

    // Observation instant: provider time where reported, else server accept
    // time (documented fallback — freshness is NEVER the write time itself).
    const observedAt = snapshot.providerObservedAt ?? snapshot.acceptedAt;
    const ageMs = now.getTime() - observedAt.getTime();
    if (ageMs > maxAgeMs) {
      throw new SnapshotNotFreshError({ code: 'SNAPSHOT_STALE', ageMs, maxAgeMs }, connectionId);
    }

    for (const field of ['balance', 'equity'] as const) {
      const raw = snapshot[field];
      if (raw === null || raw === undefined || !ExactDecimal.tryParse(raw)) {
        throw new SnapshotNotFreshError({ code: 'SNAPSHOT_MALFORMED', field }, connectionId);
      }
    }

    if (!snapshot.currency || !/^[A-Z]{3}$/.test(snapshot.currency)) {
      // Unknown stays unknown — never a synthetic USD fallback.
      throw new SnapshotNotFreshError({ code: 'SNAPSHOT_CURRENCY_UNKNOWN' }, connectionId);
    }

    return snapshot;
  }

  // ─── Write path (monotonic, INSERT-only) ───────────────────────────────────

  /**
   * Accept ONE provider account observation as the next logical snapshot.
   *
   * The five decimal fields are validated typed BEFORE anything touches the
   * database (MalformedSnapshotFieldError; nothing inserted). The insert runs
   * in a SHORT guarded transaction: read the current max generation (row-locked
   * on PostgreSQL via SELECT ... FOR UPDATE — emitted only for drivers that
   * support it; the sqlite parser rejects FOR UPDATE), then INSERT the next
   * generation. The UNIQUE (connection_id, generation) backstop converts a
   * lost race into ONE fresh-transaction retry; a second collision returns
   * the typed STALE_GENERATION outcome (another writer keeps winning — the
   * observation is NOT silently dropped on the floor: the caller decides).
   *
   * When `tx` is provided the first attempt joins the caller's transaction;
   * a unique violation poisons it on PostgreSQL (aborted-tx semantics), so
   * the documented backstop retry still runs in a FRESH transaction.
   */
  async acceptSnapshot(
    observation: ProviderAccountObservation,
    tx?: EntityManager,
  ): Promise<SnapshotAcceptOutcome> {
    this.assertConnectionId(observation.connectionId);
    this.assertWellFormedDecimals(observation);

    // Serialize overlapping in-process writers per connection so the guarded
    // transaction stays short and only genuine multi-process races hit the
    // unique backstop.
    return this.withConnectionWriteLease(observation.connectionId, async () => {
      if (tx) {
        try {
          return {
            accepted: true as const,
            snapshot: await this.insertNextGeneration(observation, tx),
          };
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          this.logger.warn(
            `Snapshot generation race inside caller transaction for connection ` +
              `${observation.connectionId} — falling back to a fresh-transaction retry`,
          );
        }
      }

      // Attempt 1: short guarded transaction.
      try {
        return {
          accepted: true as const,
          snapshot: await this.dataSource.transaction((em) =>
            this.insertNextGeneration(observation, em),
          ),
        };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        this.logger.warn(
          `Snapshot generation race for connection ${observation.connectionId} — ` +
            `retrying once in a FRESH transaction`,
        );
      }

      // Attempt 2 (final): fresh transaction. A second collision means a
      // concurrent writer keeps winning the generation slot.
      try {
        return {
          accepted: true as const,
          snapshot: await this.dataSource.transaction((em) =>
            this.insertNextGeneration(observation, em),
          ),
        };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const currentGeneration = await this.readCurrentGeneration(observation.connectionId);
        this.logger.warn(
          `Snapshot STALE_GENERATION for connection ${observation.connectionId}: ` +
            `current generation is ${currentGeneration}`,
        );
        return { accepted: false, reason: 'STALE_GENERATION' as const, currentGeneration };
      }
    });
  }

  // ─── Legacy compat projection ──────────────────────────────────────────────

  /**
   * Project an accepted snapshot into the legacy broker.broker_accounts
   * current-view (compat only — the snapshot table is the authority).
   *
   *  - SKIP when the existing row's last_snapshot_generation >= the snapshot's
   *    generation (older or equal projections never move the view backwards);
   *  - synced_at = snapshot.acceptedAt (the moment the facts were accepted —
   *    NEVER now());
   *  - last_snapshot_generation only moves forward;
   *  - NULL snapshot fields never erase known-good legacy values
   *    (COALESCE keeps the previous value).
   */
  async projectToLegacyAccount(snapshot: BrokerAccountSnapshot, tx?: EntityManager): Promise<void> {
    const runner = tx ?? this.legacyRepo.manager;
    const table = this.legacyAccountsTableName();

    const existingRows: Array<Record<string, unknown>> = await runner.query(
      `SELECT id, last_snapshot_generation FROM ${table} WHERE broker_connection_id = $1`,
      [snapshot.connectionId],
    );
    const existing = existingRows[0];

    if (!existing) {
      // No legacy row yet — create the compat current-view from this snapshot.
      // synced_at = the snapshot's acceptedAt (never now()); the not-null
      // legacy money columns fall back to their '0' default when the snapshot
      // field is unknown (NULL never erases — nothing known exists yet).
      const nowIso = new Date().toISOString();
      await runner.query(
        `INSERT INTO ${table}
           (id, broker_connection_id, balance, equity, margin, free_margin,
            margin_level, currency, leverage, open_positions_count,
            synced_at, last_snapshot_generation, created_at, updated_at)
         VALUES ($1, $2, COALESCE($3, '0'), COALESCE($4, '0'), COALESCE($5, '0'),
                 COALESCE($6, '0'), COALESCE($7, '0'), $8, $9, COALESCE($10, 0),
                 $11, $12, $13, $13)`,
        [
          randomUUID(),
          snapshot.connectionId,
          snapshot.balance,
          snapshot.equity,
          snapshot.margin,
          snapshot.freeMargin,
          snapshot.marginLevel,
          snapshot.currency,
          snapshot.leverage,
          snapshot.openPositionsCount,
          snapshot.acceptedAt.toISOString(),
          snapshot.generation,
          nowIso,
        ],
      );
      return;
    }

    const lastGen = Number(existing.last_snapshot_generation ?? 0);
    if (lastGen >= snapshot.generation) {
      // Stale projection — the legacy view already reflects this generation
      // or newer. Never moves backwards.
      return;
    }

    // The WHERE guard re-checks monotonicity at write time (TOCTOU-safe):
    // last_snapshot_generation only moves forward, and NULL snapshot fields
    // never erase known-good legacy values (COALESCE keeps the previous).
    const nowIso = new Date().toISOString();
    await runner.query(
      `UPDATE ${table}
       SET balance = COALESCE($1, balance),
           equity = COALESCE($2, equity),
           margin = COALESCE($3, margin),
           free_margin = COALESCE($4, free_margin),
           margin_level = COALESCE($5, margin_level),
           currency = COALESCE($6, currency),
           leverage = COALESCE($7, leverage),
           open_positions_count = COALESCE($8, open_positions_count),
           synced_at = $9,
           last_snapshot_generation = $10,
           updated_at = $11
       WHERE broker_connection_id = $12
         AND (last_snapshot_generation IS NULL OR last_snapshot_generation < $10)`,
      [
        snapshot.balance,
        snapshot.equity,
        snapshot.margin,
        snapshot.freeMargin,
        snapshot.marginLevel,
        snapshot.currency,
        snapshot.leverage,
        snapshot.openPositionsCount,
        snapshot.acceptedAt.toISOString(),
        snapshot.generation,
        nowIso,
        snapshot.connectionId,
      ],
    );
  }

  // ─── Protected seams (test override points) ────────────────────────────────

  /** Production snapshot authority table (schema-qualified). */
  protected snapshotsTableName(): string {
    return 'broker.broker_account_snapshots';
  }

  /** Production legacy current-view table (schema-qualified). */
  protected legacyAccountsTableName(): string {
    return 'broker.broker_accounts';
  }

  /**
   * Guarded max-generation read inside the accept transaction.
   * Row-locks the current max row on PostgreSQL (FOR UPDATE); the suffix is
   * NOT emitted for drivers whose parser rejects it (sqlite).
   */
  protected async readMaxGeneration(em: EntityManager, connectionId: string): Promise<number> {
    const lockSuffix = this.dataSource.options.type === 'postgres' ? ' FOR UPDATE' : '';
    const rows: Array<{ generation: number | string | null }> = await em.query(
      `SELECT generation FROM ${this.snapshotsTableName()}
       WHERE connection_id = $1
       ORDER BY generation DESC
       LIMIT 1${lockSuffix}`,
      [connectionId],
    );
    const raw = rows[0]?.generation;
    return raw === null || raw === undefined ? 0 : Number(raw);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Plain (unguarded, unlocked) current max generation — outcome reporting. */
  private async readCurrentGeneration(connectionId: string): Promise<number> {
    const latest = await this.readLatestAcceptedSnapshot(connectionId);
    return latest ? latest.generation : 0;
  }

  private assertConnectionId(connectionId: string): void {
    if (typeof connectionId !== 'string' || connectionId.trim() === '') {
      throw new Error('ProviderAccountObservation.connectionId must be a non-empty string');
    }
  }

  /** Typed pre-insert validation of every decimal string (fail-closed). */
  private assertWellFormedDecimals(observation: ProviderAccountObservation): void {
    const decimalFields = [
      'balance',
      'equity',
      'margin',
      'freeMargin',
      'marginLevel',
    ] as const;
    for (const field of decimalFields) {
      const raw = observation[field];
      if (raw === null || raw === undefined) continue;
      if (!ExactDecimal.tryParse(raw)) {
        throw new MalformedSnapshotFieldError(field, raw);
      }
    }
  }

  /**
   * INSERT the next generation (max + 1) as ONE logical snapshot, inside the
   * given entity manager's transaction, then read the row back.
   */
  private async insertNextGeneration(
    observation: ProviderAccountObservation,
    em: EntityManager,
  ): Promise<BrokerAccountSnapshot> {
    const currentMax = await this.readMaxGeneration(em, observation.connectionId);
    const generation = currentMax + 1;
    const id = randomUUID();
    const acceptedAt = new Date();
    const acceptedAtIso = acceptedAt.toISOString();

    await em.query(
      `INSERT INTO ${this.snapshotsTableName()}
         (id, connection_id, generation, provider_observed_at, accepted_at,
          balance, equity, margin, free_margin, margin_level, leverage,
          open_positions_count, currency, source, provider_account_identity,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)`,
      [
        id,
        observation.connectionId,
        generation,
        observation.providerObservedAt ? observation.providerObservedAt.toISOString() : null,
        acceptedAtIso,
        observation.balance,
        observation.equity,
        observation.margin,
        observation.freeMargin,
        observation.marginLevel,
        observation.leverage,
        observation.openPositionsCount,
        observation.currency,
        observation.source,
        observation.providerAccountIdentity,
        acceptedAtIso,
      ],
    );

    const rows: Array<Record<string, unknown>> = await em.query(
      `SELECT * FROM ${this.snapshotsTableName()} WHERE id = $1`,
      [id],
    );
    return this.hydrateSnapshotRow(rows[0]);
  }

  /** Map a raw snake_case row onto the entity shape (dates as Date). */
  private hydrateSnapshotRow(row: Record<string, unknown>): BrokerAccountSnapshot {
    const date = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string));
    const num = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);
    const str = (v: unknown): string | null =>
      v === null || v === undefined ? null : String(v);
    return {
      id: String(row.id),
      connectionId: String(row.connection_id),
      generation: Number(row.generation),
      providerObservedAt: date(row.provider_observed_at),
      acceptedAt: new Date(row.accepted_at as string),
      balance: str(row.balance),
      equity: str(row.equity),
      margin: str(row.margin),
      freeMargin: str(row.free_margin),
      marginLevel: str(row.margin_level),
      leverage: num(row.leverage),
      openPositionsCount: num(row.open_positions_count),
      currency: str(row.currency),
      source: String(row.source),
      providerAccountIdentity: str(row.provider_account_identity),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    } as BrokerAccountSnapshot;
  }

  /**
   * In-process per-connection write lease: a tail-promise chain per
   * connectionId. Overlapping callers await their predecessor before running
   * the critical section; the chain entry is removed once drained so the map
   * does not grow without bound.
   */
  private async withConnectionWriteLease<T>(
    connectionId: string,
    critical: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.connectionWriteLeases.get(connectionId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor ? predecessor.then(() => gate) : gate;
    this.connectionWriteLeases.set(connectionId, tail);
    void tail.then(() => {
      if (this.connectionWriteLeases.get(connectionId) === tail) {
        this.connectionWriteLeases.delete(connectionId);
      }
    });

    try {
      if (predecessor) await predecessor;
      return await critical();
    } finally {
      release();
    }
  }
}
