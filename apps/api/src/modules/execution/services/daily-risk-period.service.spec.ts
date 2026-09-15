import { DataSource, Repository } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { DailyRiskPeriod } from '../entities/daily-risk-period.entity';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import {
  DailyRiskPeriodBaselineError,
  DailyRiskPeriodCurrencyMismatchError,
  DailyRiskPeriodService,
} from './daily-risk-period.service';

/**
 * DailyRiskPeriodService — the durable per-day loss budget authority (Round
 * 6, task 6-c — architect issues #362/#313).
 *
 * REAL sqlite store with REAL TypeORM repositories: the service code under
 * test is the REAL production code. The production entities declare
 * PostgreSQL-native column types (timestamptz/uuid/date) and a
 * schema-qualified trades table (trading.trades) the sqlite driver cannot
 * host, so this harness mirrors the two tables 1:1 (same table/column names,
 * sqlite-compatible types) and casts the period repository to the production
 * entity type — the exact pattern of risk-grant.spec.ts.
 *
 * Mirror divergences (documented, harness-only):
 *  - money columns are varchar so exact decimal strings round-trip verbatim
 *    (production PostgreSQL NUMERIC also returns exact strings);
 *  - trades.realised_pnl keeps NUMERIC affinity so SQL SUM/< 0 behave — the
 *    sqlite SUM returns an IEEE double, which the service's harness-only
 *    number branch converts back to the shortest round-trip string
 *    (spec values use binary-exact fractions; production PostgreSQL returns
 *    the NUMERIC string and never takes that branch);
 *  - the service's protected tradesTableName() seam is overridden to the
 *    unqualified mirror name 'trades' (production default stays EXACTLY
 *    'trading.trades');
 *  - trades are seeded with ISO-8601 closed_at strings, matching the
 *    day-start literal the service binds (lexicographic comparison on the
 *    mirror; semantic timestamptz comparison on production PostgreSQL).
 *
 * Matrix (15 tests):
 *   - utcDayKey: UTC 'YYYY-MM-DD' at both sides of the midnight boundary.
 *   - resolveDailyRiskPeriod: exact snapshot baseline + lineage persisted;
 *     same scope re-resolution returns the SAME row (budget NEVER resets,
 *     even with a different snapshot); a different UTC day creates a NEW
 *     row; concurrent creation converges on ONE row (unique violation →
 *     re-read winner); malformed baseline fails typed (nothing persisted);
 *     a different currency for the same logical account + day fails typed.
 *   - getTodayRealisedLossExact: exact string total '-150.75' (verified via
 *     ExactDecimal — zero parseFloat); other currency / logical key / user
 *     are excluded; OPEN and positive P&L are excluded; yesterday's CLOSED
 *     loser is excluded (UTC day boundary); legacy NULL-provenance losers
 *     (null key OR null currency) are excluded from the scoped total and
 *     mark the result complete=false; no rows → total '0', complete=true.
 */

// ─── sqlite mirror entities (1:1 with the production tables) ─────────────────

@Entity({ name: 'daily_risk_periods' })
@Unique('uq_daily_risk_periods_scope', ['userId', 'logicalAccountKey', 'riskPeriodDate'])
class DailyRiskPeriodMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'user_id', type: 'varchar' })
  userId: string;
  @Column({ name: 'broker_connection_id', type: 'varchar' })
  brokerConnectionId: string;
  @Column({ name: 'logical_account_key', type: 'varchar' })
  logicalAccountKey: string;
  @Column({ name: 'account_currency', type: 'varchar', length: 3 })
  accountCurrency: string;
  @Column({ name: 'risk_period_date', type: 'date' })
  riskPeriodDate: string;
  @Column({ name: 'opening_balance', type: 'varchar' })
  openingBalance: string;
  @Column({ name: 'opening_equity', type: 'varchar' })
  openingEquity: string;
  @Column({ name: 'opening_snapshot_id', type: 'varchar', nullable: true })
  openingSnapshotId: string | null;
  @Column({ name: 'risk_profile_id', type: 'varchar', nullable: true })
  riskProfileId: string | null;
  @Column({ name: 'risk_profile_revision', type: 'integer', nullable: true })
  riskProfileRevision: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

@Entity({ name: 'trades' })
class TradeMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'user_id', type: 'varchar' })
  userId: string;
  @Column({ name: 'broker_connection_id', type: 'varchar', nullable: true })
  brokerConnectionId: string | null;
  @Column({ name: 'logical_account_key', type: 'varchar', nullable: true })
  logicalAccountKey: string | null;
  @Column({ name: 'account_currency', type: 'varchar', nullable: true })
  accountCurrency: string | null;
  @Column({ name: 'status', type: 'varchar', length: 30 })
  status: string;
  @Column({ name: 'realised_pnl', type: 'numeric', precision: 18, scale: 8, nullable: true })
  realisedPnl: string | null;
  @Column({ name: 'closed_at', type: 'datetime', nullable: true })
  closedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

// ─── Test service (mirror trades table through the protected seam) ──────────

class TestDailyRiskPeriodService extends DailyRiskPeriodService {
  protected tradesTableName(): string {
    return 'trades';
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const CONN = '33333333-3333-4333-8333-333333333333';
const KEY = 'metatrader5|MetaQuotes-Demo|12345';
const OTHER_KEY = 'metatrader5|MetaQuotes-Demo|99999';

/** Deterministic "now" — 2026-09-14T12:00:00Z (UTC day 2026-09-14). */
const NOW = new Date('2026-09-14T12:00:00.000Z');

const resolveInput = (
  overrides: Partial<{
    userId: string;
    brokerConnectionId: string;
    logicalAccountKey: string;
    accountCurrency: string;
    snapshot: { id: string; balance: string; equity: string };
    riskProfile: { id: string; revision: number } | null;
    now: Date;
  }> = {},
) => ({
  userId: USER,
  brokerConnectionId: CONN,
  logicalAccountKey: KEY,
  accountCurrency: 'USD',
  snapshot: { id: 'snap-1', balance: '10000.00', equity: '10050.50' },
  riskProfile: { id: 'rp-7', revision: 3 } as { id: string; revision: number } | null,
  now: NOW,
  ...overrides,
});

/** Seed a trade row with ISO timestamps (matches the service's day literal). */
const seedTrade = async (
  dataSource: DataSource,
  row: {
    id: string;
    userId?: string;
    logicalAccountKey?: string | null;
    accountCurrency?: string | null;
    status?: string;
    realisedPnl?: string | null;
    closedAt?: Date | null;
  },
): Promise<void> => {
  const ts = (row.closedAt ?? NOW).toISOString();
  await dataSource.query(
    `INSERT INTO trades
       (id, user_id, logical_account_key, account_currency, status,
        realised_pnl, closed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      row.id,
      row.userId ?? USER,
      row.logicalAccountKey === undefined ? KEY : row.logicalAccountKey,
      row.accountCurrency === undefined ? 'USD' : row.accountCurrency,
      row.status ?? 'CLOSED',
      row.realisedPnl ?? null,
      row.closedAt === undefined ? NOW.toISOString() : row.closedAt?.toISOString() ?? null,
      ts,
    ],
  );
};

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('DailyRiskPeriodService (Round 6, 6-c — #362/#313)', () => {
  let dataSource: DataSource;
  let periodRepo: Repository<DailyRiskPeriodMirror>;
  let service: TestDailyRiskPeriodService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [DailyRiskPeriodMirror, TradeMirror],
    });
    await dataSource.initialize();
    periodRepo = dataSource.getRepository(DailyRiskPeriodMirror);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM daily_risk_periods');
    await dataSource.query('DELETE FROM trades');
    service = new TestDailyRiskPeriodService(
      periodRepo as unknown as Repository<DailyRiskPeriod>,
      dataSource,
    );
  });

  const countPeriods = async (): Promise<number> => {
    const rows = await dataSource.query('SELECT COUNT(*) AS n FROM daily_risk_periods');
    return Number(rows[0].n);
  };

  const todayLoss = (overrides: Partial<{ now: Date }> = {}) =>
    service.getTodayRealisedLossExact({
      userId: USER,
      logicalAccountKey: KEY,
      accountCurrency: 'USD',
      now: overrides.now ?? NOW,
    });

  // ─── utcDayKey ─────────────────────────────────────────────────────────────

  it('utcDayKey returns the UTC calendar day on both sides of midnight', () => {
    expect(service.utcDayKey(new Date('2026-09-14T23:59:59.999Z'))).toBe('2026-09-14');
    expect(service.utcDayKey(new Date('2026-09-15T00:00:00.000Z'))).toBe('2026-09-15');
    expect(service.utcDayKey(new Date(Date.UTC(2026, 0, 3, 8, 30, 0)))).toBe('2026-01-03');
    expect(service.utcDayKey(NOW)).toBe('2026-09-14');
  });

  // ─── resolveDailyRiskPeriod ────────────────────────────────────────────────

  describe('resolveDailyRiskPeriod', () => {
    it('creates the period with the EXACT snapshot baseline and lineage', async () => {
      const period = await service.resolveDailyRiskPeriod(resolveInput());

      expect(period.userId).toBe(USER);
      expect(period.brokerConnectionId).toBe(CONN);
      expect(period.logicalAccountKey).toBe(KEY);
      expect(period.accountCurrency).toBe('USD');
      expect(period.riskPeriodDate).toBe('2026-09-14');
      // Baseline EXACTLY from the snapshot — decimal strings, never floats:
      expect(period.openingBalance).toBe('10000.00');
      expect(period.openingEquity).toBe('10050.50');
      expect(period.openingSnapshotId).toBe('snap-1');
      // Risk-profile lineage:
      expect(period.riskProfileId).toBe('rp-7');
      expect(period.riskProfileRevision).toBe(3);
      expect(await countPeriods()).toBe(1);
    });

    it('re-resolution of the same scope returns the SAME row — the budget NEVER resets', async () => {
      const first = await service.resolveDailyRiskPeriod(resolveInput());

      // A session restart resolves again with a DIFFERENT (later, worse)
      // snapshot — the original baseline of the day must survive:
      const second = await service.resolveDailyRiskPeriod(
        resolveInput({
          snapshot: { id: 'snap-2', balance: '9000.00', equity: '9050.00' },
          riskProfile: { id: 'rp-8', revision: 4 },
        }),
      );

      expect(second.id).toBe(first.id);
      expect(second.openingBalance).toBe('10000.00');
      expect(second.openingEquity).toBe('10050.50');
      expect(second.openingSnapshotId).toBe('snap-1');
      expect(second.riskProfileId).toBe('rp-7');
      expect(second.riskProfileRevision).toBe(3);
      expect(await countPeriods()).toBe(1);
    });

    it('a different UTC day creates a NEW period row', async () => {
      const day1 = await service.resolveDailyRiskPeriod(resolveInput());
      const day2 = await service.resolveDailyRiskPeriod(
        resolveInput({
          now: new Date('2026-09-15T10:00:00.000Z'),
          snapshot: { id: 'snap-day2', balance: '8000.00', equity: '8050.00' },
        }),
      );

      expect(day2.id).not.toBe(day1.id);
      expect(day2.riskPeriodDate).toBe('2026-09-15');
      expect(day2.openingBalance).toBe('8000.00');
      expect(day1.riskPeriodDate).toBe('2026-09-14');
      expect(await countPeriods()).toBe(2);
    });

    it('concurrent creation converges on a SINGLE row (unique violation → re-read winner)', async () => {
      const [a, b] = await Promise.all([
        service.resolveDailyRiskPeriod(
          resolveInput({ snapshot: { id: 'snap-a', balance: '5000.00', equity: '5050.00' } }),
        ),
        service.resolveDailyRiskPeriod(
          resolveInput({ snapshot: { id: 'snap-b', balance: '6000.00', equity: '6050.00' } }),
        ),
      ]);

      expect(a.id).toBe(b.id);
      expect(await countPeriods()).toBe(1);
      // The winner's baseline is whichever insert committed first — never a
      // blend, never a reset:
      expect(['5000.00', '6000.00']).toContain(a.openingBalance);
      expect(['snap-a', 'snap-b']).toContain(a.openingSnapshotId);
    });

    it('fails typed on a malformed baseline and persists NOTHING', async () => {
      await expect(
        service.resolveDailyRiskPeriod(resolveInput({ snapshot: { id: 's', balance: 'abc', equity: '1.00' } })),
      ).rejects.toBeInstanceOf(DailyRiskPeriodBaselineError);
      await expect(
        service.resolveDailyRiskPeriod(
          resolveInput({ accountCurrency: 'usd', snapshot: { id: 's', balance: '1.00', equity: '1.00' } }),
        ),
      ).rejects.toBeInstanceOf(DailyRiskPeriodBaselineError);
      await expect(
        service.resolveDailyRiskPeriod(resolveInput({ snapshot: { id: '', balance: '1.00', equity: '1.00' } })),
      ).rejects.toBeInstanceOf(DailyRiskPeriodBaselineError);
      expect(await countPeriods()).toBe(0);
    });

    it('fails typed when the same logical account + day resolves with a DIFFERENT currency', async () => {
      await service.resolveDailyRiskPeriod(resolveInput());

      await expect(
        service.resolveDailyRiskPeriod(
          resolveInput({ accountCurrency: 'EUR', snapshot: { id: 'snap-eur', balance: '1.00', equity: '1.00' } }),
        ),
      ).rejects.toBeInstanceOf(DailyRiskPeriodCurrencyMismatchError);

      // Still exactly ONE period — heterogeneous currencies never fork the
      // budget into a second row:
      expect(await countPeriods()).toBe(1);
      const only = await periodRepo.findOne({ where: { userId: USER } });
      expect(only?.accountCurrency).toBe('USD');
    });
  });

  // ─── getTodayRealisedLossExact ─────────────────────────────────────────────

  describe('getTodayRealisedLossExact', () => {
    it("returns today's CLOSED losers as an exact RAW string total (no floats)", async () => {
      await seedTrade(dataSource, { id: 't1', realisedPnl: '-100.50' });
      await seedTrade(dataSource, { id: 't2', realisedPnl: '-50.25' });

      const result = await todayLoss();

      // Raw string '-150.75' — verified exact via ExactDecimal:
      expect(result.total).toBe('-150.75');
      expect(ExactDecimal.parse(result.total).eq(ExactDecimal.parse('-150.75'))).toBe(true);
      expect(result.complete).toBe(true);
    });

    it('excludes losses of a DIFFERENT account currency', async () => {
      await seedTrade(dataSource, { id: 't1', realisedPnl: '-100.50' });
      await seedTrade(dataSource, { id: 't2', realisedPnl: '-999.75', accountCurrency: 'EUR' });

      const result = await todayLoss();
      expect(result.total).toBe('-100.50');
      expect(result.complete).toBe(true);
    });

    it('excludes losses of a DIFFERENT logical account key', async () => {
      await seedTrade(dataSource, { id: 't1', realisedPnl: '-100.50' });
      await seedTrade(dataSource, { id: 't2', realisedPnl: '-999.75', logicalAccountKey: OTHER_KEY });

      const result = await todayLoss();
      expect(result.total).toBe('-100.50');
      expect(result.complete).toBe(true);
    });

    it('excludes losses of a DIFFERENT user', async () => {
      await seedTrade(dataSource, { id: 't1', realisedPnl: '-100.50' });
      await seedTrade(dataSource, { id: 't2', realisedPnl: '-999.75', userId: OTHER_USER });

      const result = await todayLoss();
      expect(result.total).toBe('-100.50');
      expect(result.complete).toBe(true);
    });

    it('excludes OPEN trades and positive realised P&L (CLOSED losers only)', async () => {
      await seedTrade(dataSource, { id: 't1', realisedPnl: '-25.25' });
      await seedTrade(dataSource, { id: 't2', realisedPnl: '75.25' }); // winner
      await seedTrade(dataSource, { id: 't3', realisedPnl: '-100.50', status: 'OPEN', closedAt: null });

      const result = await todayLoss();
      expect(result.total).toBe('-25.25');
      expect(result.complete).toBe(true);
    });

    it("excludes yesterday's CLOSED loser (UTC day boundary)", async () => {
      await seedTrade(dataSource, { id: 't1', realisedPnl: '-25.25' });
      await seedTrade(dataSource, {
        id: 't2',
        realisedPnl: '-400.50',
        closedAt: new Date('2026-09-13T23:59:59.999Z'),
      });

      const result = await todayLoss();
      expect(result.total).toBe('-25.25');
      expect(result.complete).toBe(true);
    });

    it('excludes legacy NULL-provenance losers from the total and reports complete=false', async () => {
      await seedTrade(dataSource, { id: 't1', realisedPnl: '-100.50' }); // fully provenanced
      // Legacy rows without immutable provenance (never guessed into a scope):
      await seedTrade(dataSource, { id: 't2', realisedPnl: '-70.50', logicalAccountKey: null });
      await seedTrade(dataSource, { id: 't3', realisedPnl: '-30.25', accountCurrency: null });

      const result = await todayLoss();
      expect(result.total).toBe('-100.50'); // only the provable row
      expect(result.complete).toBe(false); // LIVE decisions must fail closed
    });

    it("returns '0' and complete=true when no trades exist today", async () => {
      const result = await todayLoss();
      expect(result.total).toBe('0');
      expect(result.complete).toBe(true);
    });
  });
});
