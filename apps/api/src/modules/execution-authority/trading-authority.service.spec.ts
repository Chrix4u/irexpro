import { DataSource, EntityManager, EntityTarget, Repository } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import {
  AUTHORITY_BUMP_REASONS,
  AuthorityBumpReason,
  AuthorityBumpReasonInvalidError,
  AuthorityStoreUnavailableError,
  TradingAuthorityService,
} from './trading-authority.service';
import { TradingAuthorityGeneration } from '../users/entities/trading-authority-generation.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';

/**
 * TradingAuthorityService — per-user monotonic trading-authority generation
 * (Sprint 56 correction round 6, task 6-b — architect issue #300).
 *
 * REAL sqlite store with REAL TypeORM repositories: the service code under
 * test is the REAL production code. The production entity declares
 * PostgreSQL-native column types (uuid/timestamptz) the sqlite driver cannot
 * host, so this harness mirrors the table 1:1 (same table/column names,
 * sqlite-compatible types, the EXACT uq_trading_authority_generation_user
 * unique) and casts the repository to the production entity type — the exact
 * pattern of risk-grant.spec.ts.
 *
 * Harness findings baked into the design (round-6 probe, since deleted):
 *  - repository.save()'s implicit transaction is UNSAFE under concurrent
 *    seeding on the single shared sqlite connection (a loser's unique
 *    violation can roll the winner's insert back), so the service's guarded
 *    INSERTs are single-statement createQueryBuilder().insert() calls — the
 *    5×/20× concurrency tests below prove the winner's row always survives;
 *  - CAS UPDATEs with `generation = generation + 1` never lose an increment
 *    on the shared connection.
 *
 * The transaction-awareness tests use a DELEGATING EntityManager: a Proxy
 * around the REAL DataSource.transaction EntityManager that maps the
 * production entity target to the sqlite MIRROR repository — every service
 * statement then flows through the transaction's queryRunner, so the
 * commit/rollback proofs are the REAL database semantics (the
 * save-fact-then-best-effort-bump-later pattern is impossible).
 *
 * Matrix (22 tests):
 *  - getCurrentGeneration: absent → 1 + exactly one initialized row;
 *    persisted generation passthrough; 5× concurrent double-init ⇒ exactly
 *    one row gen 1; per-user isolation; DB read failure ⇒ typed error
 *    (NEVER 1); DB insert failure ⇒ typed error (cause carried, zero rows);
 *    unique-race winner reuse; unique-race row-VANISH ⇒ typed fail-closed.
 *  - bumpGeneration: sequential CAS loop 1→21 exact (+1 each, no lost
 *    updates); 20 concurrent bumps ⇒ final EXACTLY 21, max return 21, never
 *    lower; reason + timestamp persisted; absent-row bump ⇒ 2; concurrent
 *    absent-row bumps ⇒ ONE row final 3; unknown reason ⇒ typed (no write);
 *    all 19 reason codes accepted; bump DB failure ⇒ typed (generation
 *    unchanged).
 *  - transaction awareness: bump commits atomically with the caller's
 *    authority fact; ROLLBACK discards the bump; read-seed commits inside a
 *    transaction; read-seed is discarded by a rollback.
 *  - audit: shape (ADMIN_ACTION + actionType 'TRADING_AUTHORITY_GENERATION_BUMPED'
 *    + reason + newGeneration); audit failure never fails the durable bump.
 */

// ─── sqlite mirror entities (1:1 with the production tables) ─────────────────

@Entity({ name: 'trading_authority_generations' })
@Unique('uq_trading_authority_generation_user', ['userId'])
class TradingAuthorityGenerationMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'user_id', type: 'varchar' })
  userId: string;
  @Column({ name: 'generation', type: 'integer', default: 1 })
  generation: number;
  @Column({ name: 'last_reason', type: 'varchar', length: 200, nullable: true })
  lastReason: string | null;
  @Column({ name: 'last_bumped_at', type: 'datetime', nullable: true })
  lastBumpedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

/** Companion "caller authority fact" table for the atomicity proofs. */
@Entity({ name: 'authority_fact_probe' })
class AuthorityFactMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'user_id', type: 'varchar' })
  userId: string;
  @Column({ name: 'fact', type: 'varchar', length: 200 })
  fact: string;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

/**
 * Delegating EntityManager — maps the PRODUCTION entity target to the sqlite
 * MIRROR repository while executing on the REAL transaction EntityManager:
 * every service statement flows through the transaction's queryRunner, so
 * commit/rollback semantics in the tx tests are the REAL database's.
 */
const delegatingEntityManager = (real: EntityManager): EntityManager =>
  new Proxy(real, {
    get(target, prop) {
      if (prop === 'getRepository') {
        return (entityTarget: EntityTarget<unknown>) => {
          if (entityTarget === TradingAuthorityGeneration) {
            return target.getRepository(TradingAuthorityGenerationMirror);
          }
          return target.getRepository(entityTarget as EntityTarget<never>);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('TradingAuthorityService — monotonic per-user authority generation (Round 6, 6-b)', () => {
  let dataSource: DataSource;
  let generationRepo: Repository<TradingAuthorityGenerationMirror>;
  let factRepo: Repository<AuthorityFactMirror>;
  let service: TradingAuthorityService;
  let auditLog: jest.Mock;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [TradingAuthorityGenerationMirror, AuthorityFactMirror],
    });
    await dataSource.initialize();

    generationRepo = dataSource.getRepository(TradingAuthorityGenerationMirror);
    factRepo = dataSource.getRepository(AuthorityFactMirror);

    auditLog = jest.fn().mockResolvedValue(undefined);
    service = new TradingAuthorityService(
      generationRepo as unknown as Repository<TradingAuthorityGeneration>,
      { log: auditLog } as unknown as AuditService,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM authority_fact_probe');
    await dataSource.query('DELETE FROM trading_authority_generations');
    jest.restoreAllMocks();
    auditLog.mockReset();
    auditLog.mockResolvedValue(undefined);
  });

  const countGenerationRows = async (): Promise<number> => {
    const rows = await dataSource.query('SELECT COUNT(*) AS n FROM trading_authority_generations');
    return Number(rows[0].n);
  };

  const readGenerationRow = async (
    userId: string,
  ): Promise<TradingAuthorityGenerationMirror | null> =>
    generationRepo.findOne({ where: { userId } });

  // ─── getCurrentGeneration ──────────────────────────────────────────────────

  describe('getCurrentGeneration', () => {
    it('absent row → returns generation 1 AND initializes exactly one durable row', async () => {
      await expect(service.getCurrentGeneration(USER)).resolves.toBe(1);

      expect(await countGenerationRows()).toBe(1);
      const row = await readGenerationRow(USER);
      expect(row).not.toBeNull();
      expect(row!.generation).toBe(1);
      expect(row!.userId).toBe(USER);
    });

    it('persisted generation is returned unchanged (no re-seed, no default)', async () => {
      await generationRepo.insert({ userId: USER, generation: 7 });

      await expect(service.getCurrentGeneration(USER)).resolves.toBe(7);
      await expect(service.getCurrentGeneration(USER)).resolves.toBe(7);

      expect(await countGenerationRows()).toBe(1);
      expect((await readGenerationRow(USER))!.generation).toBe(7);
    });

    it('5 concurrent first reads → exactly ONE seeded row, every caller sees generation 1', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.getCurrentGeneration(USER)),
      );

      expect(results).toEqual([1, 1, 1, 1, 1]);
      expect(await countGenerationRows()).toBe(1);
      expect((await readGenerationRow(USER))!.generation).toBe(1);
    });

    it('per-user isolation: independent rows and generations per user', async () => {
      await generationRepo.insert({ userId: USER, generation: 5 });

      await expect(service.getCurrentGeneration(USER)).resolves.toBe(5);
      await expect(service.getCurrentGeneration(OTHER_USER)).resolves.toBe(1);

      expect(await countGenerationRows()).toBe(2);
      expect((await readGenerationRow(USER))!.generation).toBe(5);
      expect((await readGenerationRow(OTHER_USER))!.generation).toBe(1);
    });

    it('DB read failure → typed AuthorityStoreUnavailableError carrying the cause — NEVER 1', async () => {
      const failure = new Error('connection refused');
      const spy = jest.spyOn(generationRepo, 'findOne').mockRejectedValueOnce(failure);

      const err = await service.getCurrentGeneration(USER).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AuthorityStoreUnavailableError);
      expect((err as AuthorityStoreUnavailableError).name).toBe('AuthorityStoreUnavailableError');
      expect((err as AuthorityStoreUnavailableError).cause).toBe(failure);
      expect((err as AuthorityStoreUnavailableError).message).toContain('connection refused');
      // The forbidden legacy default is proven absent — the store failure is
      // NEVER reported as generation 1.
      expect(err).not.toHaveProperty('generation', 1);
      spy.mockRestore();
    });

    it('DB insert failure → typed error carrying the cause, nothing persisted', async () => {
      await dataSource.query(`
        CREATE TRIGGER ta_fail_insert BEFORE INSERT ON trading_authority_generations
        BEGIN SELECT RAISE(ABORT, 'injected authority insert failure'); END
      `);
      try {
        const err = await service.getCurrentGeneration(USER).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AuthorityStoreUnavailableError);
        expect((err as AuthorityStoreUnavailableError).cause).toBeInstanceOf(Error);
        expect((err as AuthorityStoreUnavailableError).message).toContain(
          'injected authority insert failure',
        );
        expect(await countGenerationRows()).toBe(0);
      } finally {
        await dataSource.query('DROP TRIGGER ta_fail_insert');
      }
    });

    it("unique-race winner reuse: the seeding loser returns the WINNER's generation", async () => {
      // A concurrent initializer already committed the winning row.
      await generationRepo.insert({ userId: USER, generation: 1 });
      // This caller's first read raced BEFORE the winner committed (stale
      // absent); its guarded INSERT then loses the unique race; the re-read
      // must adopt the winner's row.
      const spy = jest.spyOn(generationRepo, 'findOne').mockImplementationOnce(async () => null);

      await expect(service.getCurrentGeneration(USER)).resolves.toBe(1);

      expect(await countGenerationRows()).toBe(1);
      expect((await readGenerationRow(USER))!.generation).toBe(1);
      spy.mockRestore();
    });

    it('unique-race row VANISHES after the violation → typed fail-closed error (never 1)', async () => {
      await generationRepo.insert({ userId: USER, generation: 1 });
      // Pathological window: the row exists (so the INSERT violates the
      // unique) yet both reads miss it — the service must fail closed.
      const spy = jest
        .spyOn(generationRepo, 'findOne')
        .mockImplementationOnce(async () => null)
        .mockImplementationOnce(async () => null);

      const err = await service.getCurrentGeneration(USER).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AuthorityStoreUnavailableError);
      expect((err as AuthorityStoreUnavailableError).message).toContain('vanish');
      spy.mockRestore();
    });
  });

  // ─── bumpGeneration ────────────────────────────────────────────────────────

  describe('bumpGeneration', () => {
    it('sequential CAS loop: 20 bumps advance 1→21 exactly, +1 each (no lost updates)', async () => {
      await expect(service.getCurrentGeneration(USER)).resolves.toBe(1);

      for (let i = 1; i <= 20; i++) {
        await expect(service.bumpGeneration(USER, 'RISK_PROFILE_MATERIAL_EDIT')).resolves.toBe(
          i + 1,
        );
      }

      expect((await readGenerationRow(USER))!.generation).toBe(21);
    });

    it('20 concurrent bumps → final generation EXACTLY 21, max returned 21, never lower', async () => {
      await expect(service.getCurrentGeneration(USER)).resolves.toBe(1);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.bumpGeneration(USER, 'ACCOUNT_SUSPENDED')),
      );

      expect(results).toHaveLength(20);
      // Every return is at least the caller's own increment and at most the
      // final generation — the re-read value may EXCEED the own increment
      // under concurrency but is NEVER lower.
      for (const value of results) {
        expect(value).toBeGreaterThanOrEqual(2);
        expect(value).toBeLessThanOrEqual(21);
      }
      expect(Math.max(...results)).toBe(21);
      expect((await readGenerationRow(USER))!.generation).toBe(21);
      expect(await countGenerationRows()).toBe(1);
    });

    it('reason + timestamp are persisted on the bumped row', async () => {
      const before = new Date(Date.now() - 5_000);
      await generationRepo.insert({ userId: USER, generation: 1 });

      await expect(service.bumpGeneration(USER, 'KILL_SWITCH_TOGGLED')).resolves.toBe(2);

      const row = await readGenerationRow(USER);
      expect(row!.generation).toBe(2);
      expect(row!.lastReason).toBe('KILL_SWITCH_TOGGLED');
      expect(row!.lastBumpedAt).toBeInstanceOf(Date);
      expect(row!.lastBumpedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('bump on an absent row seeds then bumps → returns 2', async () => {
      expect(await countGenerationRows()).toBe(0);

      await expect(service.bumpGeneration(USER, 'KYC_REVIEW_DECIDED')).resolves.toBe(2);

      expect(await countGenerationRows()).toBe(1);
      expect((await readGenerationRow(USER))!.generation).toBe(2);
    });

    it('concurrent bumps on an absent row → exactly ONE row, final generation 3', async () => {
      const results = await Promise.all([
        service.bumpGeneration(USER, 'ACCOUNT_SUSPENDED'),
        service.bumpGeneration(USER, 'BROKER_CREDENTIAL_ROTATED'),
      ]);

      expect(await countGenerationRows()).toBe(1);
      const row = await readGenerationRow(USER);
      expect(row!.generation).toBe(3);
      // One of the two reasons is the durable last-bump reason.
      expect(['ACCOUNT_SUSPENDED', 'BROKER_CREDENTIAL_ROTATED']).toContain(row!.lastReason);
      for (const value of results) {
        expect(value).toBeGreaterThanOrEqual(2);
        expect(value).toBeLessThanOrEqual(3);
      }
    });

    it('unknown reason code → typed rejection BEFORE any write', async () => {
      const err = await service
        .bumpGeneration(USER, 'DEFINITELY_NOT_A_REASON' as AuthorityBumpReason)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AuthorityBumpReasonInvalidError);
      expect((err as AuthorityBumpReasonInvalidError).name).toBe('AuthorityBumpReasonInvalidError');
      expect((err as AuthorityBumpReasonInvalidError).message).toContain('DEFINITELY_NOT_A_REASON');
      expect(await countGenerationRows()).toBe(0);
    });

    it('ALL 19 AUTHORITY_BUMP_REASONS codes are accepted', async () => {
      expect(AUTHORITY_BUMP_REASONS).toHaveLength(19);
      expect(new Set(AUTHORITY_BUMP_REASONS).size).toBe(19);

      let generation = 1;
      for (const reason of AUTHORITY_BUMP_REASONS) {
        generation += 1;
        await expect(service.bumpGeneration(USER, reason)).resolves.toBe(generation);
      }

      expect((await readGenerationRow(USER))!.generation).toBe(20);
      // Every code left its durable reason on at least the final bump.
      expect((await readGenerationRow(USER))!.lastReason).toBe(
        AUTHORITY_BUMP_REASONS[AUTHORITY_BUMP_REASONS.length - 1],
      );
    });

    it('bump DB failure → typed error carrying the cause, generation unchanged', async () => {
      await generationRepo.insert({ userId: USER, generation: 4 });

      await dataSource.query(`
        CREATE TRIGGER ta_fail_update BEFORE UPDATE ON trading_authority_generations
        BEGIN SELECT RAISE(ABORT, 'injected authority update failure'); END
      `);
      try {
        const err = await service.bumpGeneration(USER, 'ACCOUNT_CLOSED').catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AuthorityStoreUnavailableError);
        expect((err as AuthorityStoreUnavailableError).message).toContain(
          'injected authority update failure',
        );
      } finally {
        await dataSource.query('DROP TRIGGER ta_fail_update');
      }

      expect((await readGenerationRow(USER))!.generation).toBe(4);
    });
  });

  // ─── Transaction awareness (REAL DataSource.transaction) ───────────────────

  describe('transaction awareness', () => {
    it("bump inside a committed transaction commits ATOMICALLY with the caller's authority fact", async () => {
      await dataSource.transaction(async (em) => {
        // The caller's authority-changing fact (e.g. the KYC decision row).
        await factRepoFor(em).insert({ userId: USER, fact: 'KYC_APPROVED' });
        // The bump MUST flow through the SAME transaction.
        await expect(
          service.bumpGeneration(USER, 'KYC_REVIEW_DECIDED', delegatingEntityManager(em)),
        ).resolves.toBe(2);
      });

      const fact = await factRepo.findOne({ where: { userId: USER } });
      expect(fact).not.toBeNull();
      expect(fact!.fact).toBe('KYC_APPROVED');
      expect((await readGenerationRow(USER))!.generation).toBe(2);
    });

    it('ROLLBACK discards the bump — the best-effort-bump-later pattern is impossible', async () => {
      await expect(
        dataSource.transaction(async (em) => {
          await factRepoFor(em).insert({ userId: USER, fact: 'ACCOUNT_SUSPENDED' });
          await service.bumpGeneration(USER, 'ACCOUNT_SUSPENDED', delegatingEntityManager(em));
          throw new Error('caller rollback');
        }),
      ).rejects.toThrow('caller rollback');

      // Neither the caller's fact NOR the generation bump survived — they
      // were one atomic transaction, so a durable generation bump can never
      // be left behind by a rolled-back authority change.
      expect(await factRepo.findOne({ where: { userId: USER } })).toBeNull();
      expect(await readGenerationRow(USER)).toBeNull();
      expect(await countGenerationRows()).toBe(0);
    });

    it('getCurrentGeneration seed inside a committed transaction persists', async () => {
      await dataSource.transaction(async (em) => {
        await expect(service.getCurrentGeneration(USER, delegatingEntityManager(em))).resolves.toBe(
          1,
        );
      });

      expect(await countGenerationRows()).toBe(1);
      expect((await readGenerationRow(USER))!.generation).toBe(1);
    });

    it('getCurrentGeneration seed inside a rolled-back transaction leaves NO row', async () => {
      await expect(
        dataSource.transaction(async (em) => {
          await service.getCurrentGeneration(USER, delegatingEntityManager(em));
          throw new Error('caller rollback');
        }),
      ).rejects.toThrow('caller rollback');

      expect(await countGenerationRows()).toBe(0);
    });
  });

  // ─── Audit ──────────────────────────────────────────────────────────────────

  describe('audit', () => {
    it('audit shape: ADMIN_ACTION + actionType TRADING_AUTHORITY_GENERATION_BUMPED + reason + newGeneration', async () => {
      await expect(service.bumpGeneration(USER, 'ACCOUNT_PERMANENTLY_LOCKED')).resolves.toBe(2);

      expect(auditLog).toHaveBeenCalledTimes(1);
      const entry = auditLog.mock.calls[0][0];
      expect(entry.action).toBe(AuditAction.ADMIN_ACTION);
      expect(entry.resourceType).toBe('TradingAuthorityGeneration');
      expect(entry.resourceId).toBe(USER);
      expect(entry.metadata).toMatchObject({
        actionType: 'TRADING_AUTHORITY_GENERATION_BUMPED',
        userId: USER,
        reason: 'ACCOUNT_PERMANENTLY_LOCKED',
        newGeneration: 2,
      });
    });

    it('audit failure NEVER fails the durable bump', async () => {
      auditLog.mockRejectedValueOnce(new Error('audit store down'));

      await expect(service.bumpGeneration(USER, 'ACCOUNT_REACTIVATED')).resolves.toBe(2);

      expect((await readGenerationRow(USER))!.generation).toBe(2);
    });
  });
});

/** The transaction-scoped companion-fact repository. */
function factRepoFor(em: EntityManager): Repository<AuthorityFactMirror> {
  return em.getRepository(AuthorityFactMirror);
}
