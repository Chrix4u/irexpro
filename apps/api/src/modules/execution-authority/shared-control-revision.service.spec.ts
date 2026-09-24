import { DataSource, Repository } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import {
  SharedControlBumpReasonInvalidError,
  SharedControlFingerprintInvalidError,
  SharedControlRevisionService,
  SharedControlStateNotInitializedError,
  SharedControlStoreUnavailableError,
} from './shared-control-revision.service';
import { TradingPolicyState } from './entities/trading-policy-state.entity';
import { TradingPolicyRevisionLog } from './entities/trading-policy-revision-log.entity';
import { ProviderLiveVerificationState } from './entities/provider-live-verification-state.entity';
import { ProviderLiveVerificationRevisionLog } from './entities/provider-live-verification-revision-log.entity';
import { ExecutionControlRevisionState } from './entities/execution-control-revision.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';

/**
 * SharedControlRevisionService — the cross-replica shared control plane
 * (Sprint 56 correction round 6, task 6-b — architect issues #363 + #299).
 *
 * REAL sqlite store with REAL TypeORM repositories: the service code under
 * test is the REAL production code. The production entities declare
 * PostgreSQL-native column types (timestamptz) and a `platform` schema the
 * sqlite driver cannot host, so this harness mirrors the five tables 1:1
 * (same table/column names, sqlite-compatible types, the EXACT
 * revision-unique constraints) and casts the repositories to the production
 * entity types — the exact pattern of risk-grant.spec.ts.
 *
 * Harness note: all singleton INSERTs under test are single-statement
 * createQueryBuilder().insert() calls (repository.save()'s implicit
 * transaction loses the winner under concurrent seeding on the shared sqlite
 * connection — proven by the round-6 probe), so the concurrency tests below
 * prove the winner's rows always survive and the revision-unique log tables
 * converge on exactly one row per revision.
 *
 * The stale-read CAS test simulates a replica race by making the FIRST read
 * of the singleton return a stale row shape (one-shot jest spy on the REAL
 * repository's findOne); every subsequent statement is REAL — the bounded
 * retry, the revision-guarded CAS loss and the convergence are exercised
 * against the real database.
 *
 * Matrix (25 tests):
 *  - syncTradingPolicy: seed (revision 1 + fingerprint + revision-1 log row);
 *    same-fingerprint no-op (no log row); advance (revision 2 + revision-2
 *    log row, DEFAULT reason); CUSTOM reason override; 5× concurrent sync
 *    race ⇒ deterministic final revision 2 + append-only 2 log rows;
 *    stale-read CAS loss ⇒ bounded retry converges (revision 3, 3 log
 *    rows); malformed fingerprint ⇒ typed rejection (shared state
 *    untouched); sync DB failure ⇒ typed error (cause carried).
 *  - fail-closed reads: all three singletons — never-seeded ⇒
 *    SharedControlStateNotInitializedError; DB failure ⇒
 *    SharedControlStoreUnavailableError carrying the cause.
 *  - syncProviderVerificationCatalog: seed / no-op / advance with the
 *    catalog-level log row.
 *  - bumpExecutionControlRevision: monotonic 1→2→3→4 (absent seeds then
 *    bumps); reason + timestamp recorded; 5 concurrent bumps from 2 ⇒
 *    EXACTLY 7 (no lost updates); concurrent absent-row bumps ⇒ ONE row
 *    final 3; bump DB failure ⇒ typed error; empty reason ⇒ typed
 *    rejection before any write.
 *  - audit: shape (ADMIN_ACTION + actionType
 *    'EXECUTION_CONTROL_REVISION_BUMPED' + reason + newRevision); audit
 *    failure never fails the durable bump.
 */

// ─── sqlite mirror entities (1:1 with the production tables) ─────────────────

@Entity({ name: 'trading_policy_state' })
class TradingPolicyStateMirror {
  @PrimaryColumn({ name: 'id', type: 'integer', default: 1 })
  id: number;
  @Column({ name: 'current_revision', type: 'integer', default: 1 })
  currentRevision: number;
  @Column({ name: 'policy_fingerprint', type: 'varchar', length: 64 })
  policyFingerprint: string;
  @Column({ name: 'last_reason', type: 'varchar', length: 200, nullable: true })
  lastReason: string | null;
  @Column({ name: 'last_bumped_at', type: 'datetime', nullable: true })
  lastBumpedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

@Entity({ name: 'trading_policy_revision_logs' })
@Unique('uq_trading_policy_revision_logs_revision', ['revision'])
class TradingPolicyRevisionLogMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'revision', type: 'integer' })
  revision: number;
  @Column({ name: 'policy_fingerprint', type: 'varchar', length: 64 })
  policyFingerprint: string;
  @Column({ name: 'reason', type: 'varchar', length: 200 })
  reason: string;
  @Column({ name: 'description', type: 'varchar', length: 500, nullable: true })
  description: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
}

@Entity({ name: 'provider_live_verification_state' })
class ProviderLiveVerificationStateMirror {
  @PrimaryColumn({ name: 'id', type: 'integer', default: 1 })
  id: number;
  @Column({ name: 'current_revision', type: 'integer', default: 1 })
  currentRevision: number;
  @Column({ name: 'catalog_fingerprint', type: 'varchar', length: 64 })
  catalogFingerprint: string;
  @Column({ name: 'last_reason', type: 'varchar', length: 200, nullable: true })
  lastReason: string | null;
  @Column({ name: 'last_bumped_at', type: 'datetime', nullable: true })
  lastBumpedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

@Entity({ name: 'provider_live_verification_revision_logs' })
@Unique('uq_provider_live_verification_revision_logs_revision', ['revision'])
class ProviderLiveVerificationRevisionLogMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'revision', type: 'integer' })
  revision: number;
  @Column({ name: 'catalog_fingerprint', type: 'varchar', length: 64 })
  catalogFingerprint: string;
  @Column({ name: 'reason', type: 'varchar', length: 200 })
  reason: string;
  @Column({ name: 'description', type: 'varchar', length: 500, nullable: true })
  description: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
}

@Entity({ name: 'execution_control_revision_state' })
class ExecutionControlRevisionStateMirror {
  @PrimaryColumn({ name: 'id', type: 'integer', default: 1 })
  id: number;
  @Column({ name: 'current_revision', type: 'integer', default: 1 })
  currentRevision: number;
  @Column({ name: 'last_reason', type: 'varchar', length: 200, nullable: true })
  lastReason: string | null;
  @Column({ name: 'last_bumped_at', type: 'datetime', nullable: true })
  lastBumpedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const FP_C = 'c'.repeat(64);

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('SharedControlRevisionService — shared control plane (Round 6, 6-b)', () => {
  let dataSource: DataSource;
  let policyStateRepo: Repository<TradingPolicyStateMirror>;
  let policyLogRepo: Repository<TradingPolicyRevisionLogMirror>;
  let providerStateRepo: Repository<ProviderLiveVerificationStateMirror>;
  let providerLogRepo: Repository<ProviderLiveVerificationRevisionLogMirror>;
  let controlStateRepo: Repository<ExecutionControlRevisionStateMirror>;
  let service: SharedControlRevisionService;
  let auditLog: jest.Mock;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [
        TradingPolicyStateMirror,
        TradingPolicyRevisionLogMirror,
        ProviderLiveVerificationStateMirror,
        ProviderLiveVerificationRevisionLogMirror,
        ExecutionControlRevisionStateMirror,
      ],
    });
    await dataSource.initialize();

    policyStateRepo = dataSource.getRepository(TradingPolicyStateMirror);
    policyLogRepo = dataSource.getRepository(TradingPolicyRevisionLogMirror);
    providerStateRepo = dataSource.getRepository(ProviderLiveVerificationStateMirror);
    providerLogRepo = dataSource.getRepository(ProviderLiveVerificationRevisionLogMirror);
    controlStateRepo = dataSource.getRepository(ExecutionControlRevisionStateMirror);

    auditLog = jest.fn().mockResolvedValue(undefined);
    service = new SharedControlRevisionService(
      policyStateRepo as unknown as Repository<TradingPolicyState>,
      policyLogRepo as unknown as Repository<TradingPolicyRevisionLog>,
      providerStateRepo as unknown as Repository<ProviderLiveVerificationState>,
      providerLogRepo as unknown as Repository<ProviderLiveVerificationRevisionLog>,
      controlStateRepo as unknown as Repository<ExecutionControlRevisionState>,
      { log: auditLog } as unknown as AuditService,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM trading_policy_revision_logs');
    await dataSource.query('DELETE FROM trading_policy_state');
    await dataSource.query('DELETE FROM provider_live_verification_revision_logs');
    await dataSource.query('DELETE FROM provider_live_verification_state');
    await dataSource.query('DELETE FROM execution_control_revision_state');
    jest.restoreAllMocks();
    auditLog.mockReset();
    auditLog.mockResolvedValue(undefined);
  });

  const readPolicyState = (): Promise<TradingPolicyStateMirror | null> =>
    policyStateRepo.findOne({ where: { id: 1 } });

  const readProviderState = (): Promise<ProviderLiveVerificationStateMirror | null> =>
    providerStateRepo.findOne({ where: { id: 1 } });

  const readControlState = (): Promise<ExecutionControlRevisionStateMirror | null> =>
    controlStateRepo.findOne({ where: { id: 1 } });

  const countRows = async (table: string): Promise<number> => {
    const rows = await dataSource.query(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(rows[0].n);
  };

  const policyLogRevisions = async (): Promise<
    { revision: number; fingerprint: string; reason: string }[]
  > =>
    (await policyLogRepo.find({ order: { revision: 'ASC' } })).map((row) => ({
      revision: row.revision,
      fingerprint: row.policyFingerprint,
      reason: row.reason,
    }));

  // ─── syncTradingPolicy (#363) ──────────────────────────────────────────────

  describe('syncTradingPolicy', () => {
    it('never-seeded ⇒ seeds revision 1 + fingerprint + the revision-1 log row', async () => {
      await expect(service.syncTradingPolicy(FP_A)).resolves.toBe(1);

      const state = await readPolicyState();
      expect(state).not.toBeNull();
      expect(state!.id).toBe(1);
      expect(state!.currentRevision).toBe(1);
      expect(state!.policyFingerprint).toBe(FP_A);

      expect(await countRows('trading_policy_revision_logs')).toBe(1);
      expect(await policyLogRevisions()).toEqual([
        { revision: 1, fingerprint: FP_A, reason: 'embedded policy initialized' },
      ]);
    });

    it('same fingerprint ⇒ no-op: same revision, NO new log row, state untouched', async () => {
      await expect(service.syncTradingPolicy(FP_A)).resolves.toBe(1);
      const afterSeed = await readPolicyState();

      await expect(service.syncTradingPolicy(FP_A)).resolves.toBe(1);
      await expect(service.syncTradingPolicy(FP_A)).resolves.toBe(1);

      const afterNoop = await readPolicyState();
      expect(afterNoop!.currentRevision).toBe(1);
      expect(afterNoop!.policyFingerprint).toBe(FP_A);
      // No bump of last_bumped_at on a no-op.
      expect(afterNoop!.lastBumpedAt?.getTime()).toBe(afterSeed!.lastBumpedAt?.getTime());
      expect(await countRows('trading_policy_revision_logs')).toBe(1);
    });

    it('different fingerprint ⇒ advance: revision 2 + revision-2 log row with the DEFAULT reason', async () => {
      await expect(service.syncTradingPolicy(FP_A)).resolves.toBe(1);

      await expect(service.syncTradingPolicy(FP_B)).resolves.toBe(2);

      const state = await readPolicyState();
      expect(state!.currentRevision).toBe(2);
      expect(state!.policyFingerprint).toBe(FP_B);
      expect(state!.lastReason).toBe('embedded policy changed');
      expect(state!.lastBumpedAt).toBeInstanceOf(Date);

      expect(await countRows('trading_policy_revision_logs')).toBe(2);
      expect(await policyLogRevisions()).toEqual([
        { revision: 1, fingerprint: FP_A, reason: 'embedded policy initialized' },
        { revision: 2, fingerprint: FP_B, reason: 'embedded policy changed' },
      ]);
    });

    it('caller-supplied reason overrides the default on the advance (state + log row)', async () => {
      await expect(service.syncTradingPolicy(FP_A)).resolves.toBe(1);

      await expect(
        service.syncTradingPolicy(FP_B, 'jurisdiction matrix hotfix 2026-09'),
      ).resolves.toBe(2);

      const state = await readPolicyState();
      expect(state!.lastReason).toBe('jurisdiction matrix hotfix 2026-09');
      expect(await policyLogRevisions()).toEqual([
        { revision: 1, fingerprint: FP_A, reason: 'embedded policy initialized' },
        { revision: 2, fingerprint: FP_B, reason: 'jurisdiction matrix hotfix 2026-09' },
      ]);
    });

    it('5 concurrent syncs with a changed fingerprint ⇒ deterministic final revision 2 + append-only 2 log rows', async () => {
      await expect(service.syncTradingPolicy(FP_A)).resolves.toBe(1);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.syncTradingPolicy(FP_B)),
      );

      // CAS winners return 2; losers converge on the no-op and also see 2.
      expect(results).toEqual([2, 2, 2, 2, 2]);

      const state = await readPolicyState();
      expect(state!.currentRevision).toBe(2);
      expect(state!.policyFingerprint).toBe(FP_B);

      // Exactly ONE revision-1 row + ONE revision-2 row — the revision
      // unique converges concurrent appenders; nothing is duplicated or lost.
      expect(await countRows('trading_policy_revision_logs')).toBe(2);
      expect(await policyLogRevisions()).toEqual([
        { revision: 1, fingerprint: FP_A, reason: 'embedded policy initialized' },
        { revision: 2, fingerprint: FP_B, reason: 'embedded policy changed' },
      ]);
    });

    it('stale-read CAS loss ⇒ bounded retry converges (revision 3, append-only history intact)', async () => {
      await expect(service.syncTradingPolicy(FP_A)).resolves.toBe(1);
      await expect(service.syncTradingPolicy(FP_B)).resolves.toBe(2);

      // Simulate the replica race the bounded retry exists for: this sync's
      // FIRST read returns the stale revision-1 row (one-shot spy on the REAL
      // repository). Its revision-2 log append is ignored (the revision-2 row
      // already exists) and its revision-guarded CAS `WHERE
      // current_revision = 1` affects 0 rows — the retry must re-read the
      // CURRENT revision 2 and advance to 3.
      const spy = jest.spyOn(policyStateRepo, 'findOne').mockImplementationOnce(
        async () =>
          ({
            id: 1,
            currentRevision: 1,
            policyFingerprint: FP_A,
            lastReason: null,
            lastBumpedAt: null,
          }) as TradingPolicyStateMirror,
      );

      await expect(service.syncTradingPolicy(FP_C)).resolves.toBe(3);
      spy.mockRestore();

      const state = await readPolicyState();
      expect(state!.currentRevision).toBe(3);
      expect(state!.policyFingerprint).toBe(FP_C);

      expect(await policyLogRevisions()).toEqual([
        { revision: 1, fingerprint: FP_A, reason: 'embedded policy initialized' },
        { revision: 2, fingerprint: FP_B, reason: 'embedded policy changed' },
        { revision: 3, fingerprint: FP_C, reason: 'embedded policy changed' },
      ]);
    });

    it('malformed fingerprint (non-64-lowercase-hex) ⇒ typed rejection BEFORE any shared state', async () => {
      for (const malformed of [
        '',
        'xyz',
        'A'.repeat(64),
        'a'.repeat(63),
        'a'.repeat(65),
        'g'.repeat(64),
      ]) {
        const err = await service.syncTradingPolicy(malformed).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SharedControlFingerprintInvalidError);
        expect((err as SharedControlFingerprintInvalidError).name).toBe(
          'SharedControlFingerprintInvalidError',
        );
      }

      expect(await countRows('trading_policy_state')).toBe(0);
      expect(await countRows('trading_policy_revision_logs')).toBe(0);
    });

    it('sync DB failure ⇒ typed SharedControlStoreUnavailableError carrying the cause', async () => {
      await dataSource.query(`
        CREATE TRIGGER sc_fail_policy_insert BEFORE INSERT ON trading_policy_state
        BEGIN SELECT RAISE(ABORT, 'injected policy-state insert failure'); END
      `);
      try {
        const err = await service.syncTradingPolicy(FP_A).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(SharedControlStoreUnavailableError);
        expect((err as SharedControlStoreUnavailableError).name).toBe(
          'SharedControlStoreUnavailableError',
        );
        expect((err as SharedControlStoreUnavailableError).cause).toBeInstanceOf(Error);
        expect((err as SharedControlStoreUnavailableError).message).toContain(
          'injected policy-state insert failure',
        );
        expect(await countRows('trading_policy_state')).toBe(0);
        expect(await countRows('trading_policy_revision_logs')).toBe(0);
      } finally {
        await dataSource.query('DROP TRIGGER sc_fail_policy_insert');
      }
    });
  });

  // ─── Fail-closed reads (never-seeded ≠ store-down ≠ revision 1) ────────────

  describe('fail-closed reads', () => {
    it('getCurrentTradingPolicyRevision: never-seeded ⇒ SharedControlStateNotInitializedError', async () => {
      const err = await service.getCurrentTradingPolicyRevision().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SharedControlStateNotInitializedError);
      expect((err as SharedControlStateNotInitializedError).name).toBe(
        'SharedControlStateNotInitializedError',
      );
      expect((err as SharedControlStateNotInitializedError).message).toContain('trading policy');
    });

    it('getCurrentTradingPolicyRevision: DB failure ⇒ SharedControlStoreUnavailableError with the cause', async () => {
      const failure = new Error('policy store unreachable');
      const spy = jest.spyOn(policyStateRepo, 'findOne').mockRejectedValueOnce(failure);

      const err = await service.getCurrentTradingPolicyRevision().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SharedControlStoreUnavailableError);
      expect((err as SharedControlStoreUnavailableError).cause).toBe(failure);
      spy.mockRestore();
    });

    it('getCurrentProviderVerificationRevision: never-seeded ⇒ typed not-initialized', async () => {
      const err = await service.getCurrentProviderVerificationRevision().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SharedControlStateNotInitializedError);
      expect((err as SharedControlStateNotInitializedError).message).toContain(
        'provider LIVE-verification catalog',
      );
    });

    it('getCurrentProviderVerificationRevision: DB failure ⇒ typed store-unavailable with the cause', async () => {
      const failure = new Error('catalog store unreachable');
      const spy = jest.spyOn(providerStateRepo, 'findOne').mockRejectedValueOnce(failure);

      const err = await service.getCurrentProviderVerificationRevision().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SharedControlStoreUnavailableError);
      expect((err as SharedControlStoreUnavailableError).cause).toBe(failure);
      spy.mockRestore();
    });

    it('getCurrentExecutionControlRevision: never-seeded ⇒ typed not-initialized', async () => {
      const err = await service.getCurrentExecutionControlRevision().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SharedControlStateNotInitializedError);
      expect((err as SharedControlStateNotInitializedError).message).toContain('execution-control');
    });

    it('getCurrentExecutionControlRevision: DB failure ⇒ typed store-unavailable with the cause', async () => {
      const failure = new Error('control store unreachable');
      const spy = jest.spyOn(controlStateRepo, 'findOne').mockRejectedValueOnce(failure);

      const err = await service.getCurrentExecutionControlRevision().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SharedControlStoreUnavailableError);
      expect((err as SharedControlStoreUnavailableError).cause).toBe(failure);
      spy.mockRestore();
    });
  });

  // ─── syncProviderVerificationCatalog (#363) ───────────────────────────────

  describe('syncProviderVerificationCatalog', () => {
    it('never-seeded ⇒ seeds revision 1 + catalog fingerprint + the revision-1 log row', async () => {
      await expect(service.syncProviderVerificationCatalog(FP_A)).resolves.toBe(1);

      const state = await readProviderState();
      expect(state).not.toBeNull();
      expect(state!.id).toBe(1);
      expect(state!.currentRevision).toBe(1);
      expect(state!.catalogFingerprint).toBe(FP_A);

      expect(await countRows('provider_live_verification_revision_logs')).toBe(1);
      const logRows = await providerLogRepo.find({ order: { revision: 'ASC' } });
      expect(logRows).toHaveLength(1);
      expect(logRows[0].revision).toBe(1);
      expect(logRows[0].catalogFingerprint).toBe(FP_A);
      expect(logRows[0].reason).toBe('embedded verification catalog initialized');
    });

    it('same catalog fingerprint ⇒ no-op: same revision, no new log row', async () => {
      await expect(service.syncProviderVerificationCatalog(FP_A)).resolves.toBe(1);

      await expect(service.syncProviderVerificationCatalog(FP_A)).resolves.toBe(1);

      const state = await readProviderState();
      expect(state!.currentRevision).toBe(1);
      expect(state!.catalogFingerprint).toBe(FP_A);
      expect(await countRows('provider_live_verification_revision_logs')).toBe(1);
    });

    it('different catalog fingerprint ⇒ advance to revision 2 + catalog-level revision-2 log row', async () => {
      await expect(service.syncProviderVerificationCatalog(FP_A)).resolves.toBe(1);

      await expect(service.syncProviderVerificationCatalog(FP_B)).resolves.toBe(2);

      const state = await readProviderState();
      expect(state!.currentRevision).toBe(2);
      expect(state!.catalogFingerprint).toBe(FP_B);
      expect(state!.lastReason).toBe('embedded verification catalog changed');

      const logRows = await providerLogRepo.find({ order: { revision: 'ASC' } });
      expect(logRows).toHaveLength(2);
      expect(logRows[1].revision).toBe(2);
      expect(logRows[1].catalogFingerprint).toBe(FP_B);
      expect(logRows[1].reason).toBe('embedded verification catalog changed');
    });
  });

  describe('ensureExecutionControlRevisionInitialized', () => {
    it('seeds revision 1 without recording a control mutation', async () => {
      await expect(service.ensureExecutionControlRevisionInitialized()).resolves.toBe(1);

      const state = await readControlState();
      expect(state).not.toBeNull();
      expect(state!.currentRevision).toBe(1);
      expect(state!.lastBumpedAt).toBeNull();
      expect(state!.lastReason).toContain('deployment bootstrap');
      expect(await countRows('execution_control_revision_state')).toBe(1);
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('is idempotent and never bumps an existing revision', async () => {
      await expect(service.ensureExecutionControlRevisionInitialized()).resolves.toBe(1);
      await expect(service.bumpExecutionControlRevision('activation')).resolves.toBe(2);

      await expect(service.ensureExecutionControlRevisionInitialized()).resolves.toBe(2);
      await expect(service.ensureExecutionControlRevisionInitialized()).resolves.toBe(2);

      const state = await readControlState();
      expect(state!.currentRevision).toBe(2);
      expect(await countRows('execution_control_revision_state')).toBe(1);
    });

    it('concurrent bootstrap initialization converges on one revision-1 row', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.ensureExecutionControlRevisionInitialized()),
      );

      expect(results).toEqual([1, 1, 1, 1, 1]);
      expect((await readControlState())!.currentRevision).toBe(1);
      expect(await countRows('execution_control_revision_state')).toBe(1);
    });
  });

  // ─── bumpExecutionControlRevision (#299 no-resurrection) ───────────────────

  describe('bumpExecutionControlRevision', () => {
    it('monotonic 1→2→3→4: absent seeds then every bump advances exactly +1', async () => {
      // Absent singleton: the first bump seeds revision 1 then bumps to 2.
      await expect(
        service.bumpExecutionControlRevision('emergency control activated'),
      ).resolves.toBe(2);
      await expect(
        service.bumpExecutionControlRevision('emergency control deactivated'),
      ).resolves.toBe(3);
      await expect(
        service.bumpExecutionControlRevision('emergency control expired and replaced'),
      ).resolves.toBe(4);

      const state = await readControlState();
      expect(state).not.toBeNull();
      expect(state!.id).toBe(1);
      expect(state!.currentRevision).toBe(4);
      expect(await countRows('execution_control_revision_state')).toBe(1);
    });

    it('reason + timestamp are recorded on the control singleton', async () => {
      const before = new Date(Date.now() - 5_000);

      await expect(
        service.bumpExecutionControlRevision('kill switch activated for user escalation'),
      ).resolves.toBe(2);

      const state = await readControlState();
      expect(state!.lastReason).toBe('kill switch activated for user escalation');
      expect(state!.lastBumpedAt).toBeInstanceOf(Date);
      expect(state!.lastBumpedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('5 concurrent bumps from revision 2 ⇒ final revision EXACTLY 7 (no lost updates)', async () => {
      await expect(service.bumpExecutionControlRevision('activation')).resolves.toBe(2);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          service.bumpExecutionControlRevision(`concurrent mutation ${i + 1}`),
        ),
      );

      for (const value of results) {
        expect(value).toBeGreaterThanOrEqual(3);
        expect(value).toBeLessThanOrEqual(7);
      }
      expect(Math.max(...results)).toBe(7);
      expect((await readControlState())!.currentRevision).toBe(7);
      expect(await countRows('execution_control_revision_state')).toBe(1);
    });

    it('concurrent bumps on the absent singleton ⇒ ONE row, final revision 3', async () => {
      const results = await Promise.all([
        service.bumpExecutionControlRevision('activation'),
        service.bumpExecutionControlRevision('deactivation'),
      ]);

      expect(await countRows('execution_control_revision_state')).toBe(1);
      const state = await readControlState();
      expect(state!.currentRevision).toBe(3);
      for (const value of results) {
        expect(value).toBeGreaterThanOrEqual(2);
        expect(value).toBeLessThanOrEqual(3);
      }
    });

    it('bump DB failure ⇒ typed SharedControlStoreUnavailableError, revision unchanged', async () => {
      await expect(service.bumpExecutionControlRevision('activation')).resolves.toBe(2);

      await dataSource.query(`
        CREATE TRIGGER sc_fail_control_update BEFORE UPDATE ON execution_control_revision_state
        BEGIN SELECT RAISE(ABORT, 'injected control-update failure'); END
      `);
      try {
        const err = await service
          .bumpExecutionControlRevision('deactivation')
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(SharedControlStoreUnavailableError);
        expect((err as SharedControlStoreUnavailableError).message).toContain(
          'injected control-update failure',
        );
      } finally {
        await dataSource.query('DROP TRIGGER sc_fail_control_update');
      }

      expect((await readControlState())!.currentRevision).toBe(2);
    });

    it('empty reason ⇒ typed rejection BEFORE any write (no singleton seeded)', async () => {
      for (const emptyReason of ['', '   ']) {
        const err = await service
          .bumpExecutionControlRevision(emptyReason)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SharedControlBumpReasonInvalidError);
        expect((err as SharedControlBumpReasonInvalidError).name).toBe(
          'SharedControlBumpReasonInvalidError',
        );
      }

      expect(await countRows('execution_control_revision_state')).toBe(0);
    });
  });

  // ─── Audit ──────────────────────────────────────────────────────────────────

  describe('audit', () => {
    it('audit shape: ADMIN_ACTION + actionType EXECUTION_CONTROL_REVISION_BUMPED + reason + newRevision', async () => {
      await expect(
        service.bumpExecutionControlRevision('emergency control activated'),
      ).resolves.toBe(2);

      expect(auditLog).toHaveBeenCalledTimes(1);
      const entry = auditLog.mock.calls[0][0];
      expect(entry.action).toBe(AuditAction.ADMIN_ACTION);
      expect(entry.resourceType).toBe('ExecutionControlRevisionState');
      expect(entry.metadata).toMatchObject({
        actionType: 'EXECUTION_CONTROL_REVISION_BUMPED',
        reason: 'emergency control activated',
        newRevision: 2,
      });
    });

    it('audit failure NEVER fails the durable bump', async () => {
      auditLog.mockRejectedValueOnce(new Error('audit store down'));

      await expect(
        service.bumpExecutionControlRevision('emergency control deactivated'),
      ).resolves.toBe(2);

      expect((await readControlState())!.currentRevision).toBe(2);
    });
  });
});
