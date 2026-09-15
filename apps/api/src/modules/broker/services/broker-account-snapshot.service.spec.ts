import { DataSource, Repository } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { EntityManager } from 'typeorm';
import { BrokerAccountSnapshot } from '../entities/broker-account-snapshot.entity';
import { BrokerAccount } from '../entities/broker-account.entity';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import {
  BrokerAccountSnapshotService,
  MalformedSnapshotFieldError,
  NEW_EXPOSURE_SNAPSHOT_MAX_AGE_MS,
  ProviderAccountObservation,
  SnapshotAcceptOutcome,
  SnapshotNotFreshError,
} from './broker-account-snapshot.service';

/**
 * BrokerAccountSnapshotService — the versioned monotonic snapshot authority
 * (Round 6, task 6-c — architect issues #297/#312).
 *
 * REAL sqlite store with REAL TypeORM repositories: the service code under
 * test is the REAL production code. The production entities declare
 * PostgreSQL-native column types (timestamptz/uuid) and schema-qualified
 * table names (broker.*) the sqlite driver cannot host, so this harness
 * mirrors the two tables 1:1 (same table/column names, sqlite-compatible
 * types; money columns are varchar on the mirror so the exact decimal
 * strings round-trip verbatim — production PostgreSQL NUMERIC also returns
 * exact strings) and casts the repositories to the production entity types
 * — the exact pattern of risk-grant.spec.ts / execution-session.authority.
 *
 * The service's protected table-name seams are overridden to the unqualified
 * mirror names (production defaults stay 'broker.broker_account_snapshots' /
 * 'broker.broker_accounts'); the guarded max-generation read keeps its
 * production shape (SELECT ... ORDER BY generation DESC LIMIT 1) without the
 * PostgreSQL-only FOR UPDATE suffix — exactly how the driver-conditional
 * emission behaves in production for non-PG drivers.
 *
 * Matrix (31 tests):
 *   - acceptSnapshot: generation 1 → 2; concurrent accepts serialize into
 *     DISTINCT generations (per-connection write lease); malformed decimal
 *     strings in ANY of the five money fields are rejected TYPED before any
 *     insert (zero rows); ALL fields move together as ONE logical snapshot;
 *     stale-writer fencing (manual higher-generation insert → next accept is
 *     max+1, never an overwrite); racing-writer unique backstop retries ONCE
 *     in a fresh transaction; a repeated collision returns the typed
 *     STALE_GENERATION outcome with the real current generation.
 *   - readLatestAcceptedSnapshot: null when empty; latest by GENERATION, not
 *     write time.
 *   - resolveFreshSnapshotForNewExposure: every failure code typed
 *     (MISSING / STALE with ageMs+maxAgeMs / MALFORMED balance+equity /
 *     CURRENCY_UNKNOWN for null, 'usd', 'US' — USD is NEVER synthesized),
 *     the documented providerObservedAt ?? acceptedAt fallback, the exact
 *     precedence order, and the happy path with deterministic now/maxAgeMs.
 *   - projectToLegacyAccount: creates the legacy current-view row when
 *     missing and projects all fields with synced_at = the snapshot's
 *     acceptedAt (NEVER now()); the monotonic guard skips older AND equal
 *     generations; a newer generation projects and last_snapshot_generation
 *     only moves forward.
 */

// ─── sqlite mirror entities (1:1 with the production tables) ─────────────────

@Entity({ name: 'broker_account_snapshots' })
@Unique('uq_broker_account_snapshot_connection_generation', ['connectionId', 'generation'])
@Index('idx_broker_account_snapshots_connection_id', ['connectionId'])
class BrokerAccountSnapshotMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'connection_id', type: 'varchar' })
  connectionId: string;
  @Column({ name: 'generation', type: 'integer' })
  generation: number;
  @Column({ name: 'provider_observed_at', type: 'datetime', nullable: true })
  providerObservedAt: Date | null;
  @Column({ name: 'accepted_at', type: 'datetime' })
  acceptedAt: Date;
  @Column({ name: 'balance', type: 'varchar', nullable: true })
  balance: string | null;
  @Column({ name: 'equity', type: 'varchar', nullable: true })
  equity: string | null;
  @Column({ name: 'margin', type: 'varchar', nullable: true })
  margin: string | null;
  @Column({ name: 'free_margin', type: 'varchar', nullable: true })
  freeMargin: string | null;
  @Column({ name: 'margin_level', type: 'varchar', nullable: true })
  marginLevel: string | null;
  @Column({ name: 'leverage', type: 'integer', nullable: true })
  leverage: number | null;
  @Column({ name: 'open_positions_count', type: 'integer', nullable: true })
  openPositionsCount: number | null;
  @Column({ name: 'currency', type: 'varchar', length: 3, nullable: true })
  currency: string | null;
  @Column({ name: 'source', type: 'varchar', length: 30 })
  source: string;
  @Column({ name: 'provider_account_identity', type: 'varchar', length: 200, nullable: true })
  providerAccountIdentity: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

@Entity({ name: 'broker_accounts' })
class BrokerAccountMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'broker_connection_id', type: 'varchar', unique: true })
  brokerConnectionId: string;
  @Column({ name: 'balance', type: 'varchar', default: '0' })
  balance: string;
  @Column({ name: 'equity', type: 'varchar', default: '0' })
  equity: string;
  @Column({ name: 'margin', type: 'varchar', default: '0' })
  margin: string;
  @Column({ name: 'free_margin', type: 'varchar', default: '0' })
  freeMargin: string;
  @Column({ name: 'margin_level', type: 'varchar', default: '0' })
  marginLevel: string;
  @Column({ name: 'currency', type: 'varchar', length: 3, nullable: true })
  currency: string | null;
  @Column({ name: 'leverage', type: 'integer', nullable: true })
  leverage: number | null;
  @Column({ name: 'open_positions_count', type: 'integer', default: 0 })
  openPositionsCount: number;
  @Column({ name: 'synced_at', type: 'datetime', nullable: true })
  syncedAt: Date | null;
  @Column({ name: 'last_snapshot_generation', type: 'integer', nullable: true })
  lastSnapshotGeneration: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

// ─── Test service (mirror table names through the protected seams) ──────────

class TestableSnapshotService extends BrokerAccountSnapshotService {
  protected snapshotsTableName(): string {
    return 'broker_account_snapshots';
  }
  protected legacyAccountsTableName(): string {
    return 'broker_accounts';
  }
}

/**
 * Simulates a racing writer that committed a higher generation BETWEEN the
 * guarded max-read and the INSERT: the guarded read returns a stale max for
 * the first `staleReads` calls (production equivalent of losing the row-lock
 * race to another process), then tells the truth again.
 */
class RacingWriterSnapshotService extends TestableSnapshotService {
  private staleReadsRemaining: number;

  constructor(
    snapshotRepo: Repository<BrokerAccountSnapshot>,
    legacyRepo: Repository<BrokerAccount>,
    dataSource: DataSource,
    staleReads: number,
  ) {
    super(snapshotRepo, legacyRepo, dataSource);
    this.staleReadsRemaining = staleReads;
  }

  protected async readMaxGeneration(em: EntityManager, connectionId: string): Promise<number> {
    const real = await super.readMaxGeneration(em, connectionId);
    if (this.staleReadsRemaining > 0) {
      this.staleReadsRemaining -= 1;
      return Math.max(0, real - 1);
    }
    return real;
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CONN = '33333333-3333-4333-8333-333333333333';

const observation = (
  overrides: Partial<ProviderAccountObservation> = {},
): ProviderAccountObservation => ({
  connectionId: CONN,
  balance: '10000.00',
  equity: '10050.00',
  margin: '250.00',
  freeMargin: '9800.00',
  marginLevel: '4020.00',
  leverage: 100,
  openPositionsCount: 2,
  currency: 'USD',
  providerObservedAt: new Date(),
  providerAccountIdentity: 'metaapi:12345',
  source: 'provider:metatrader5',
  ...overrides,
});

/** Raw manual snapshot insert (simulates another writer / legacy rows). */
const insertSnapshotRow = async (
  dataSource: DataSource,
  row: {
    connectionId?: string;
    generation: number;
    balance?: string | null;
    equity?: string | null;
    currency?: string | null;
    providerObservedAt?: Date | null;
    acceptedAt?: Date;
  },
): Promise<void> => {
  const ts = (row.acceptedAt ?? new Date()).toISOString();
  await dataSource.query(
    `INSERT INTO broker_account_snapshots
       (id, connection_id, generation, provider_observed_at, accepted_at,
        balance, equity, currency, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      `00000000-0000-4000-8000-${String(row.generation).padStart(12, '0')}`,
      row.connectionId ?? CONN,
      row.generation,
      row.providerObservedAt === undefined ? null : (row.providerObservedAt?.toISOString() ?? null),
      ts,
      row.balance ?? null,
      row.equity ?? null,
      row.currency ?? null,
      'manual-test',
      ts,
    ],
  );
};

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('BrokerAccountSnapshotService (Round 6, 6-c — #297/#312)', () => {
  let dataSource: DataSource;
  let snapshotRepo: Repository<BrokerAccountSnapshotMirror>;
  let legacyRepo: Repository<BrokerAccountMirror>;
  let service: TestableSnapshotService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [BrokerAccountSnapshotMirror, BrokerAccountMirror],
    });
    await dataSource.initialize();
    snapshotRepo = dataSource.getRepository(BrokerAccountSnapshotMirror);
    legacyRepo = dataSource.getRepository(BrokerAccountMirror);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM broker_account_snapshots');
    await dataSource.query('DELETE FROM broker_accounts');
    service = new TestableSnapshotService(
      snapshotRepo as unknown as Repository<BrokerAccountSnapshot>,
      legacyRepo as unknown as Repository<BrokerAccount>,
      dataSource,
    );
  });

  const countSnapshots = async (connectionId = CONN): Promise<number> => {
    const rows = await dataSource.query(
      'SELECT COUNT(*) AS n FROM broker_account_snapshots WHERE connection_id = $1',
      [connectionId],
    );
    return Number(rows[0].n);
  };

  const resolveFailure = async (
    connectionId = CONN,
    opts?: { maxAgeMs?: number; now?: Date },
  ): Promise<SnapshotNotFreshError | null> => {
    try {
      await service.resolveFreshSnapshotForNewExposure(connectionId, opts);
      return null;
    } catch (e) {
      if (e instanceof SnapshotNotFreshError) return e;
      throw e;
    }
  };

  // ─── acceptSnapshot ────────────────────────────────────────────────────────

  describe('acceptSnapshot', () => {
    it('inserts the FIRST snapshot at generation 1 with every field', async () => {
      const observedAt = new Date('2026-09-14T10:00:00.000Z');
      const outcome = await service.acceptSnapshot(observation({ providerObservedAt: observedAt }));

      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;
      expect(outcome.snapshot.generation).toBe(1);
      expect(outcome.snapshot.connectionId).toBe(CONN);
      expect(outcome.snapshot.balance).toBe('10000.00');
      expect(outcome.snapshot.equity).toBe('10050.00');
      expect(outcome.snapshot.margin).toBe('250.00');
      expect(outcome.snapshot.freeMargin).toBe('9800.00');
      expect(outcome.snapshot.marginLevel).toBe('4020.00');
      expect(outcome.snapshot.leverage).toBe(100);
      expect(outcome.snapshot.openPositionsCount).toBe(2);
      expect(outcome.snapshot.currency).toBe('USD');
      expect(outcome.snapshot.source).toBe('provider:metatrader5');
      expect(outcome.snapshot.providerAccountIdentity).toBe('metaapi:12345');
      expect(outcome.snapshot.providerObservedAt?.getTime()).toBe(observedAt.getTime());
      expect(await countSnapshots()).toBe(1);
    });

    it('advances the generation monotonically on the second accept', async () => {
      await service.acceptSnapshot(observation());
      const second = await service.acceptSnapshot(
        observation({ balance: '10100.00', equity: '10150.00' }),
      );

      expect(second.accepted).toBe(true);
      if (!second.accepted) return;
      expect(second.snapshot.generation).toBe(2);
      expect(await countSnapshots()).toBe(2);
    });

    it('serializes concurrent accepts into DISTINCT generations (write lease)', async () => {
      const outcomes = await Promise.all([
        service.acceptSnapshot(observation({ balance: '1.00' })),
        service.acceptSnapshot(observation({ balance: '2.00' })),
      ]);

      expect(outcomes.every((o) => o.accepted)).toBe(true);
      const generations = outcomes.map((o) => (o.accepted ? o.snapshot.generation : -1));
      expect(new Set(generations).size).toBe(2);
      expect(generations).toEqual(expect.arrayContaining([1, 2]));
      expect(await countSnapshots()).toBe(2);
    });

    it.each(['balance', 'equity', 'margin', 'freeMargin', 'marginLevel'] as const)(
      'rejects a malformed decimal %s TYPED before any insert (nothing written)',
      async (field) => {
        await expect(
          service.acceptSnapshot(
            observation({ [field]: 'abc' } as Partial<ProviderAccountObservation>),
          ),
        ).rejects.toBeInstanceOf(MalformedSnapshotFieldError);

        await expect(
          service.acceptSnapshot(
            observation({ [field]: 'abc' } as Partial<ProviderAccountObservation>),
          ),
        ).rejects.toMatchObject({ field, value: 'abc', name: 'MalformedSnapshotFieldError' });

        expect(await countSnapshots()).toBe(0);
      },
    );

    it('moves ALL fields together as ONE logical snapshot (never a partial update)', async () => {
      await service.acceptSnapshot(
        observation({
          balance: '1000.00',
          equity: '1010.00',
          currency: 'EUR',
          leverage: 30,
          openPositionsCount: 7,
          providerAccountIdentity: 'acct-A',
        }),
      );
      const outcome = await service.acceptSnapshot(
        observation({
          balance: '2000.50',
          equity: '1999.25',
          margin: null,
          freeMargin: null,
          marginLevel: null,
          currency: 'GBP',
          leverage: 500,
          openPositionsCount: 0,
          providerAccountIdentity: 'acct-B',
          source: 'reconciliation',
          providerObservedAt: null,
        }),
      );

      expect(outcome.accepted).toBe(true);
      const latest = await service.readLatestAcceptedSnapshot(CONN);
      expect(latest).not.toBeNull();
      expect(latest!.generation).toBe(2);
      // Every field from the SECOND observation, none from the first:
      expect(latest!.balance).toBe('2000.50');
      expect(latest!.equity).toBe('1999.25');
      expect(latest!.margin).toBeNull();
      expect(latest!.freeMargin).toBeNull();
      expect(latest!.marginLevel).toBeNull();
      expect(latest!.currency).toBe('GBP');
      expect(latest!.leverage).toBe(500);
      expect(latest!.openPositionsCount).toBe(0);
      expect(latest!.providerAccountIdentity).toBe('acct-B');
      expect(latest!.source).toBe('reconciliation');
      expect(latest!.providerObservedAt).toBeNull();
      // The generation-1 row is untouched (INSERT-only):
      const first = await snapshotRepo.findOne({ where: { generation: 1 } });
      expect(first).not.toBeNull();
      expect(first!.balance).toBe('1000.00');
      expect(first!.currency).toBe('EUR');
    });

    it('fences a stale writer: after a manual higher-generation insert, the next accept is max+1', async () => {
      await service.acceptSnapshot(observation());
      // Another (manual) writer commits generation 5 out-of-band:
      await insertSnapshotRow(dataSource, {
        generation: 5,
        balance: '777.00',
        equity: '778.00',
        currency: 'USD',
      });

      const outcome = await service.acceptSnapshot(observation({ balance: '888.00' }));

      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;
      expect(outcome.snapshot.generation).toBe(6);
      expect(outcome.snapshot.balance).toBe('888.00');
      expect(await countSnapshots()).toBe(3);
      // The manual generation-5 row was never overwritten:
      const manual = await snapshotRepo.findOne({ where: { generation: 5 } });
      expect(manual?.balance).toBe('777.00');
    });

    it('retries ONCE in a fresh transaction after losing the generation race', async () => {
      await service.acceptSnapshot(observation());
      const racing = new RacingWriterSnapshotService(
        snapshotRepo as unknown as Repository<BrokerAccountSnapshot>,
        legacyRepo as unknown as Repository<BrokerAccount>,
        dataSource,
        1, // first guarded read is stale (simulated racing writer)
      );

      const outcome = await racing.acceptSnapshot(observation({ balance: '42.00' }));

      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;
      // Stale read computed generation 1 (collision) → fresh retry computed 2.
      expect(outcome.snapshot.generation).toBe(2);
      expect(outcome.snapshot.balance).toBe('42.00');
      expect(await countSnapshots()).toBe(2);
    });

    it('returns the typed STALE_GENERATION outcome when the race is repeated', async () => {
      await service.acceptSnapshot(observation());
      const alwaysStale = new RacingWriterSnapshotService(
        snapshotRepo as unknown as Repository<BrokerAccountSnapshot>,
        legacyRepo as unknown as Repository<BrokerAccount>,
        dataSource,
        Number.POSITIVE_INFINITY, // every guarded read is stale
      );

      const outcome: SnapshotAcceptOutcome = await alwaysStale.acceptSnapshot(
        observation({ balance: '99.00' }),
      );

      expect(outcome).toMatchObject({
        accepted: false,
        reason: 'STALE_GENERATION',
        currentGeneration: 1,
      });
      // Nothing was written by the losing writer:
      expect(await countSnapshots()).toBe(1);
      const only = await service.readLatestAcceptedSnapshot(CONN);
      expect(only?.balance).toBe('10000.00');
    });
  });

  // ─── readLatestAcceptedSnapshot ────────────────────────────────────────────

  describe('readLatestAcceptedSnapshot', () => {
    it('returns null when nothing was accepted for the connection', async () => {
      expect(await service.readLatestAcceptedSnapshot(CONN)).toBeNull();
    });

    it('resolves the latest by GENERATION, never by write time', async () => {
      await service.acceptSnapshot(observation()); // generation 1, accepted NOW
      // Generation 2 was accepted EARLIER (e.g. clock skew / delayed write):
      await insertSnapshotRow(dataSource, {
        generation: 2,
        balance: '2.00',
        acceptedAt: new Date(Date.now() - 86_400_000),
      });

      const latest = await service.readLatestAcceptedSnapshot(CONN);
      expect(latest).not.toBeNull();
      expect(latest!.generation).toBe(2);
      expect(latest!.balance).toBe('2.00');
    });
  });

  // ─── resolveFreshSnapshotForNewExposure ────────────────────────────────────

  describe('resolveFreshSnapshotForNewExposure', () => {
    it('fails typed with SNAPSHOT_MISSING when nothing exists', async () => {
      const err = await resolveFailure(CONN);
      expect(err).not.toBeNull();
      expect(err!.failure).toEqual({ code: 'SNAPSHOT_MISSING' });
      expect(err!.connectionId).toBe(CONN);
    });

    it('fails typed with SNAPSHOT_STALE carrying ageMs and maxAgeMs', async () => {
      const now = new Date('2026-09-14T12:00:00.000Z');
      const observedAt = new Date(now.getTime() - 60_000);
      await service.acceptSnapshot(observation({ providerObservedAt: observedAt }));

      const err = await resolveFailure(CONN, { now, maxAgeMs: 30_000 });
      expect(err).not.toBeNull();
      expect(err!.failure).toEqual({
        code: 'SNAPSHOT_STALE',
        ageMs: 60_000,
        maxAgeMs: 30_000,
      });
    });

    it('falls back to acceptedAt when providerObservedAt is null (documented)', async () => {
      // acceptedAt is "now" inside acceptSnapshot → fresh without provider time
      await service.acceptSnapshot(observation({ providerObservedAt: null }));
      const snapshot = await service.resolveFreshSnapshotForNewExposure(CONN);
      expect(snapshot.generation).toBe(1);
      expect(snapshot.providerObservedAt).toBeNull();
      expect(snapshot.acceptedAt).toBeInstanceOf(Date);
    });

    it('fails typed with SNAPSHOT_MALFORMED when balance is null', async () => {
      await service.acceptSnapshot(observation({ balance: null }));
      const err = await resolveFailure(CONN);
      expect(err!.failure).toEqual({ code: 'SNAPSHOT_MALFORMED', field: 'balance' });
    });

    it('fails typed with SNAPSHOT_MALFORMED when a stored balance is garbage', async () => {
      // Corrupt/legacy row that could never pass acceptSnapshot validation:
      await insertSnapshotRow(dataSource, {
        generation: 1,
        balance: 'not-a-decimal',
        equity: '1.00',
        currency: 'USD',
      });
      const err = await resolveFailure(CONN);
      expect(err!.failure).toEqual({ code: 'SNAPSHOT_MALFORMED', field: 'balance' });
    });

    it('fails typed with SNAPSHOT_MALFORMED when equity is null', async () => {
      await service.acceptSnapshot(observation({ equity: null }));
      const err = await resolveFailure(CONN);
      expect(err!.failure).toEqual({ code: 'SNAPSHOT_MALFORMED', field: 'equity' });
    });

    it('fails typed with SNAPSHOT_CURRENCY_UNKNOWN when currency is null — USD is NEVER synthesized', async () => {
      await service.acceptSnapshot(observation({ currency: null }));
      const err = await resolveFailure(CONN);
      expect(err!.failure).toEqual({ code: 'SNAPSHOT_CURRENCY_UNKNOWN' });

      // The stored truth still says unknown — no synthetic 'USD' anywhere:
      const latest = await service.readLatestAcceptedSnapshot(CONN);
      expect(latest!.currency).toBeNull();
    });

    it("fails typed with SNAPSHOT_CURRENCY_UNKNOWN when currency is lowercase 'usd'", async () => {
      await service.acceptSnapshot(observation({ currency: 'usd' }));
      const err = await resolveFailure(CONN);
      expect(err!.failure).toEqual({ code: 'SNAPSHOT_CURRENCY_UNKNOWN' });
    });

    it("fails typed with SNAPSHOT_CURRENCY_UNKNOWN when currency is 'US' (not 3 letters)", async () => {
      await service.acceptSnapshot(observation({ currency: 'US' }));
      const err = await resolveFailure(CONN);
      expect(err!.failure).toEqual({ code: 'SNAPSHOT_CURRENCY_UNKNOWN' });
    });

    it('precedence: STALE beats MALFORMED and CURRENCY_UNKNOWN', async () => {
      const now = new Date('2026-09-14T12:00:00.000Z');
      await insertSnapshotRow(dataSource, {
        generation: 1,
        balance: 'garbage',
        equity: null,
        currency: null,
        providerObservedAt: new Date(now.getTime() - 120_000),
      });

      const err = await resolveFailure(CONN, { now, maxAgeMs: 30_000 });
      expect(err!.failure).toMatchObject({ code: 'SNAPSHOT_STALE' });
    });

    it('precedence: MALFORMED beats CURRENCY_UNKNOWN', async () => {
      await insertSnapshotRow(dataSource, {
        generation: 1,
        balance: 'garbage',
        equity: '5.00',
        currency: null,
        providerObservedAt: new Date(),
      });

      const err = await resolveFailure(CONN);
      expect(err!.failure).toEqual({ code: 'SNAPSHOT_MALFORMED', field: 'balance' });
    });

    it('returns the fresh well-formed snapshot (deterministic now/maxAgeMs options)', async () => {
      const observedAt = new Date('2026-09-14T12:00:00.000Z');
      await service.acceptSnapshot(observation({ providerObservedAt: observedAt }));

      const snapshot = await service.resolveFreshSnapshotForNewExposure(CONN, {
        now: new Date(observedAt.getTime() + 5_000),
        maxAgeMs: 10_000,
      });
      expect(snapshot.generation).toBe(1);
      expect(ExactDecimal.parse(snapshot.balance!).eq(ExactDecimal.parse('10000.00'))).toBe(true);
      expect(NEW_EXPOSURE_SNAPSHOT_MAX_AGE_MS).toBe(30_000);
    });
  });

  // ─── projectToLegacyAccount ────────────────────────────────────────────────

  describe('projectToLegacyAccount', () => {
    const seedLegacyRow = async (overrides: {
      lastSnapshotGeneration: number | null;
      balance?: string;
      syncedAt?: Date;
    }): Promise<void> => {
      await dataSource.query(
        `INSERT INTO broker_accounts
           (id, broker_connection_id, balance, equity, currency, synced_at,
            last_snapshot_generation, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          '99999999-9999-4999-8999-999999999999',
          CONN,
          overrides.balance ?? '1.00',
          '1.00',
          'USD',
          (overrides.syncedAt ?? new Date('2020-01-01T00:00:00.000Z')).toISOString(),
          overrides.lastSnapshotGeneration,
          new Date('2020-01-01T00:00:00.000Z').toISOString(),
        ],
      );
    };

    it('projects all fields into the legacy current-view with syncedAt = acceptedAt (never now())', async () => {
      await seedLegacyRow({ lastSnapshotGeneration: 0 });
      const outcome = await service.acceptSnapshot(
        observation({
          balance: '500.25',
          equity: '510.50',
          margin: '10.00',
          freeMargin: '500.25',
          marginLevel: '5100.00',
          currency: 'USD',
          leverage: 200,
          openPositionsCount: 3,
        }),
      );
      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;

      await service.projectToLegacyAccount(outcome.snapshot);

      const legacy = await legacyRepo.findOne({ where: { brokerConnectionId: CONN } });
      expect(legacy).not.toBeNull();
      expect(legacy!.balance).toBe('500.25');
      expect(legacy!.equity).toBe('510.50');
      expect(legacy!.margin).toBe('10.00');
      expect(legacy!.freeMargin).toBe('500.25');
      expect(legacy!.marginLevel).toBe('5100.00');
      expect(legacy!.currency).toBe('USD');
      expect(legacy!.leverage).toBe(200);
      expect(legacy!.openPositionsCount).toBe(3);
      expect(legacy!.lastSnapshotGeneration).toBe(outcome.snapshot.generation);
      // synced_at is the snapshot's accept time — NOT the projection time:
      expect(legacy!.syncedAt?.getTime()).toBe(outcome.snapshot.acceptedAt.getTime());
    });

    it('creates the legacy row when none exists (upsert semantics)', async () => {
      const outcome = await service.acceptSnapshot(
        observation({ balance: '77.00', equity: '78.00', currency: 'EUR' }),
      );
      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;

      await service.projectToLegacyAccount(outcome.snapshot);

      const legacy = await legacyRepo.findOne({ where: { brokerConnectionId: CONN } });
      expect(legacy).not.toBeNull();
      expect(legacy!.balance).toBe('77.00');
      expect(legacy!.equity).toBe('78.00');
      expect(legacy!.currency).toBe('EUR');
      expect(legacy!.lastSnapshotGeneration).toBe(outcome.snapshot.generation);
      expect(legacy!.syncedAt?.getTime()).toBe(outcome.snapshot.acceptedAt.getTime());
    });

    it('skips the projection when the legacy view already has an OLDER-or-newer generation (guard: existing >= snapshot)', async () => {
      const oldSyncedAt = new Date('2020-06-01T00:00:00.000Z');
      await seedLegacyRow({ lastSnapshotGeneration: 5, balance: '111.00', syncedAt: oldSyncedAt });
      const outcome = await service.acceptSnapshot(observation({ balance: '999.00' }));
      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;
      expect(outcome.snapshot.generation).toBe(1); // older than the legacy guard

      await service.projectToLegacyAccount(outcome.snapshot);

      const legacy = await legacyRepo.findOne({ where: { brokerConnectionId: CONN } });
      expect(legacy!.balance).toBe('111.00'); // untouched
      expect(legacy!.lastSnapshotGeneration).toBe(5);
      expect(legacy!.syncedAt?.getTime()).toBe(oldSyncedAt.getTime());
    });

    it('skips the projection when the generation is EQUAL', async () => {
      await seedLegacyRow({ lastSnapshotGeneration: 1, balance: '222.00' });
      const outcome = await service.acceptSnapshot(observation({ balance: '333.00' }));
      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;
      expect(outcome.snapshot.generation).toBe(1);

      await service.projectToLegacyAccount(outcome.snapshot);

      const legacy = await legacyRepo.findOne({ where: { brokerConnectionId: CONN } });
      expect(legacy!.balance).toBe('222.00'); // untouched
      expect(legacy!.lastSnapshotGeneration).toBe(1);
    });

    it('projects a NEWER generation and moves last_snapshot_generation forward only', async () => {
      await seedLegacyRow({ lastSnapshotGeneration: 3, balance: '1.00' });
      // Manually accept generations 4 and 5 (simulating accumulated history):
      await insertSnapshotRow(dataSource, {
        generation: 4,
        balance: '4.00',
        equity: '4.00',
        currency: 'USD',
      });
      const outcome = await service.acceptSnapshot(observation({ balance: '555.00' }));
      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;
      expect(outcome.snapshot.generation).toBe(5);

      await service.projectToLegacyAccount(outcome.snapshot);

      const legacy = await legacyRepo.findOne({ where: { brokerConnectionId: CONN } });
      expect(legacy!.balance).toBe('555.00');
      expect(legacy!.lastSnapshotGeneration).toBe(5);
      expect(legacy!.syncedAt?.getTime()).toBe(outcome.snapshot.acceptedAt.getTime());
    });
  });
});
