import { DataSource, Repository } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { AiSignalIdentityGateService } from './signal-identity.gate';
import { SignalIdentityConflictException } from './signal-identity.gate';
import { AiSignalIdentity } from '../entities/ai-signal-identity.entity';
import { AiSignalIdentityStatus } from '../interfaces/execution-authority';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';

/**
 * Signal identity gate (#302, Sprint 56 correction round 6 task 6-d):
 * generatedAt is IMMUTABLE IDENTITY EVIDENCE — part of the canonical payload
 * digest — and duplicate deliveries are DETERMINISTIC.
 *
 * REAL sqlite store with REAL TypeORM repositories: the
 * AiSignalIdentityGateService under test is the REAL production code. The
 * authority entity declares PostgreSQL-native column types (timestamptz/
 * jsonb) the sqlite driver refuses to register, so this harness mirrors the
 * table 1:1 (same table/column names + the EXACT
 * uq_ai_signal_identity_user_signal unique constraint) and casts the
 * repository to the production entity type — the pattern of
 * risk-grant.spec.ts. The pg-integration suites re-prove the same guarantees
 * against real PostgreSQL.
 *
 * Matrix (architect #302 + round 6):
 *   - same signalId + same generatedAt + same material → idempotent
 *     duplicate=true (Date-object AND ISO-string redeliveries; the SAME
 *     identityId; the PERSISTED original generatedAt comes back)
 *   - same signalId + NEW (fresh) generatedAt + same material →
 *     SIGNAL_IDENTITY_CONFLICT security event (audit + unchanged row)
 *   - same signalId + SAME timestamp redelivered 10 minutes later →
 *     SIGNAL_STALE (freshness is enforced on the DELIVERED timestamp — a
 *     replay can never refresh an old signal's time forward)
 *   - same signalId + changed material (price) + same generatedAt →
 *     SIGNAL_IDENTITY_CONFLICT (generatedAt NOT shifted)
 *   - different users, same signalId → independent identities
 *   - stale (> 120s) / future (> 30s skew) first delivery → typed rejection
 *   - missing signalId → SIGNAL_IDENTITY_REQUIRED
 *   - missing generatedAt → SIGNAL_GENERATED_AT_REQUIRED
 *   - markProcessed is idempotent (firstProcessedAt moves EXACTLY once)
 */

// ─── sqlite mirror entity (1:1 with the production trading.ai_signal_identities) ──

@Entity({ name: 'ai_signal_identities' })
@Unique('uq_ai_signal_identity_user_signal', ['userId', 'signalId'])
class AiSignalIdentityMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'user_id', type: 'varchar' })
  userId: string;
  @Column({ name: 'signal_id', type: 'varchar', length: 100 })
  signalId: string;
  @Column({ name: 'payload_digest', type: 'varchar', length: 64 })
  payloadDigest: string;
  @Column({ name: 'material_fields', type: 'simple-json' })
  materialFields: Record<string, unknown>;
  @Column({ name: 'generated_at', type: 'datetime' })
  generatedAt: Date;
  @Column({ name: 'received_at', type: 'datetime', nullable: true })
  receivedAt: Date | null;
  @Column({ name: 'first_processed_at', type: 'datetime', nullable: true })
  firstProcessedAt: Date | null;
  @Column({
    name: 'status',
    type: 'varchar',
    length: 30,
    default: AiSignalIdentityStatus.RECEIVED,
  })
  status: AiSignalIdentityStatus;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const MATERIAL: Record<string, unknown> = {
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedLotSize: '0.05',
  entryPrice: 1.085,
  stopLoss: 1.075,
  takeProfit: 1.095,
  strategyCode: 'TREND_V1',
  timeframe: 'H1',
  modelVersion: '1.0.0',
};

const responseOf = (err: unknown): Record<string, unknown> =>
  (err as { getResponse: () => Record<string, unknown> }).getResponse();

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('AiSignalIdentityGate generatedAt identity binding + deterministic duplicates (Round 6, 6-d)', () => {
  let dataSource: DataSource;
  let repo: Repository<AiSignalIdentityMirror>;
  let auditService: { log: jest.Mock };
  let gate: AiSignalIdentityGateService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [AiSignalIdentityMirror],
    });
    await dataSource.initialize();
    repo = dataSource.getRepository(AiSignalIdentityMirror);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM ai_signal_identities');
    jest.clearAllMocks();
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    gate = new AiSignalIdentityGateService(
      repo as unknown as Repository<AiSignalIdentity>,
      auditService as unknown as AuditService,
    );
  });

  const allRows = async (): Promise<
    Array<{
      id: string;
      user_id: string;
      signal_id: string;
      payload_digest: string;
      generated_at: string;
      status: string;
      first_processed_at: string | null;
    }>
  > =>
    dataSource.query(
      'SELECT id, user_id, signal_id, payload_digest, generated_at, status, ' +
        'first_processed_at FROM ai_signal_identities',
    );

  // ─── Idempotent duplicate (same signal + same instant + same material) ─────

  it('same signalId + same generatedAt + same material → duplicate=true (Date AND ISO-string redelivery; same identityId; persisted original timestamp)', async () => {
    const generatedAt = new Date(Date.now() - 10_000);

    const first = await gate.registerOrReuse(USER, {
      signalId: 'sig-dup-001',
      generatedAt,
      materialFields: MATERIAL,
    });
    expect(first.duplicate).toBe(false);
    expect(first.identityId).toBeDefined();
    expect(first.generatedAt.getTime()).toBe(generatedAt.getTime());

    // Redelivery as a Date object — idempotent duplicate.
    const again = await gate.registerOrReuse(USER, {
      signalId: 'sig-dup-001',
      generatedAt,
      materialFields: MATERIAL,
    });
    expect(again.duplicate).toBe(true);
    expect(again.identityId).toBe(first.identityId);
    expect(again.payloadDigest).toBe(first.payloadDigest);
    // The PERSISTED authoritative original instant comes back — never "now".
    expect(again.generatedAt.getTime()).toBe(generatedAt.getTime());

    // Redelivery as an ISO STRING (transport-level replay) — still the SAME
    // identity: the canonical instant is identical, so the digest is too.
    const isoAgain = await gate.registerOrReuse(USER, {
      signalId: 'sig-dup-001',
      generatedAt: generatedAt.toISOString(),
      materialFields: MATERIAL,
    });
    expect(isoAgain.duplicate).toBe(true);
    expect(isoAgain.identityId).toBe(first.identityId);
    expect(isoAgain.generatedAt.getTime()).toBe(generatedAt.getTime());

    // Exactly ONE durable identity row — retries mint nothing.
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].signal_id).toBe('sig-dup-001');
    expect(new Date(rows[0].generated_at).getTime()).toBe(generatedAt.getTime());
  });

  // ─── NEW generatedAt on the same signalId → SECURITY EVENT ─────────────────

  it('same signalId + NEW generatedAt + same material → SIGNAL_IDENTITY_CONFLICT (audit + row unchanged)', async () => {
    const original = new Date(Date.now() - 30_000);
    const first = await gate.registerOrReuse(USER, {
      signalId: 'sig-shift-001',
      generatedAt: original,
      materialFields: MATERIAL,
    });
    const rowBefore = (await allRows())[0];

    // The replay carries a FRESH (in-window) but DIFFERENT timestamp — the
    // producer instant is immutable identity evidence, so this is a conflict,
    // never a refreshed identity.
    const shifted = new Date(Date.now() - 5_000);
    const err = await gate
      .registerOrReuse(USER, {
        signalId: 'sig-shift-001',
        generatedAt: shifted,
        materialFields: MATERIAL,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SignalIdentityConflictException);
    expect(responseOf(err)).toMatchObject({
      code: 'SIGNAL_IDENTITY_CONFLICT',
      signalId: 'sig-shift-001',
      existingIdentityId: first.identityId,
      generatedAtShifted: true,
      existingGeneratedAt: original.toISOString(),
      deliveredGeneratedAt: shifted.toISOString(),
    });
    const details = responseOf(err) as {
      existingDigest: string;
      deliveredDigest: string;
    };
    expect(details.deliveredDigest).not.toBe(details.existingDigest);

    // CRITICAL security audit carries existing vs delivered generatedAt.
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AI_SIGNAL_IDENTITY_CONFLICT,
        severity: AuditSeverity.CRITICAL,
        metadata: expect.objectContaining({
          signalId: 'sig-shift-001',
          existingGeneratedAt: original.toISOString(),
          deliveredGeneratedAt: shifted.toISOString(),
          generatedAtShifted: true,
        }),
      }),
    );

    // The durable identity row is UNCHANGED (same digest, same instant).
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(rowBefore.id);
    expect(rows[0].payload_digest).toBe(rowBefore.payload_digest);
    expect(rows[0].generated_at).toBe(rowBefore.generated_at);
  });

  // ─── Same timestamp redelivered 10 minutes later → STALE (no time refresh) ─

  it('10-minutes-later redelivery of the SAME timestamp → SIGNAL_STALE (freshness applies to the delivered instant)', async () => {
    const generatedAt = new Date(Date.now() - 5_000);
    await gate.registerOrReuse(USER, {
      signalId: 'sig-stale-replay',
      generatedAt,
      materialFields: MATERIAL,
    });

    // Simulate the redelivery arriving 10 minutes later: the SAME (now old)
    // producer instant must be rejected as STALE BEFORE any dedup — a replay
    // can never refresh an old signal's time forward.
    const laterNow = Date.now() + 10 * 60_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(laterNow);
    try {
      const err = await gate
        .registerOrReuse(USER, {
          signalId: 'sig-stale-replay',
          generatedAt,
          materialFields: MATERIAL,
        })
        .catch((e: unknown) => e);
      expect(responseOf(err)).toMatchObject({ code: 'SIGNAL_STALE' });
    } finally {
      nowSpy.mockRestore();
    }

    // The original row is intact and no second row exists.
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].signal_id).toBe('sig-stale-replay');
    expect(rows[0].status).toBe(AiSignalIdentityStatus.RECEIVED);
  });

  // ─── Changed material field → SECURITY EVENT (timestamp NOT shifted) ───────

  it('same signalId + changed price + same generatedAt → SIGNAL_IDENTITY_CONFLICT (generatedAtShifted=false)', async () => {
    const generatedAt = new Date(Date.now() - 10_000);
    await gate.registerOrReuse(USER, {
      signalId: 'sig-price-001',
      generatedAt,
      materialFields: MATERIAL,
    });

    const err = await gate
      .registerOrReuse(USER, {
        signalId: 'sig-price-001',
        generatedAt,
        materialFields: { ...MATERIAL, entryPrice: 1.11111 },
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SignalIdentityConflictException);
    expect(responseOf(err)).toMatchObject({
      code: 'SIGNAL_IDENTITY_CONFLICT',
      generatedAtShifted: false,
      existingGeneratedAt: generatedAt.toISOString(),
      deliveredGeneratedAt: generatedAt.toISOString(),
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AI_SIGNAL_IDENTITY_CONFLICT,
        severity: AuditSeverity.CRITICAL,
      }),
    );
    expect(await allRows()).toHaveLength(1);
  });

  // ─── Cross-user independence ────────────────────────────────────────────────

  it('different users delivering the same signalId → independent identities (no cross-user conflict)', async () => {
    const generatedAt = new Date(Date.now() - 8_000);
    const a = await gate.registerOrReuse(USER, {
      signalId: 'sig-shared-001',
      generatedAt,
      materialFields: MATERIAL,
    });
    // Even with DIFFERENT material for the same signalId — a different user
    // is a different identity namespace.
    const b = await gate.registerOrReuse(USER_B, {
      signalId: 'sig-shared-001',
      generatedAt,
      materialFields: { ...MATERIAL, entryPrice: 2.5 },
    });

    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(a.identityId).not.toBe(b.identityId);
    const rows = await allRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([USER, USER_B]));
    expect(auditService.log).not.toHaveBeenCalled();
  });

  // ─── Typed freshness / presence rejections ─────────────────────────────────

  it('stale first delivery (age > 120s) → SIGNAL_STALE, nothing persisted', async () => {
    const err = await gate
      .registerOrReuse(USER, {
        signalId: 'sig-old-001',
        generatedAt: new Date(Date.now() - 121_000),
        materialFields: MATERIAL,
      })
      .catch((e: unknown) => e);
    expect(responseOf(err)).toMatchObject({ code: 'SIGNAL_STALE' });
    expect(await allRows()).toHaveLength(0);
  });

  it('future-dated delivery beyond the 30s skew tolerance → SIGNAL_FUTURE, nothing persisted', async () => {
    const err = await gate
      .registerOrReuse(USER, {
        signalId: 'sig-future-001',
        generatedAt: new Date(Date.now() + 60_000),
        materialFields: MATERIAL,
      })
      .catch((e: unknown) => e);
    expect(responseOf(err)).toMatchObject({ code: 'SIGNAL_FUTURE' });
    expect(await allRows()).toHaveLength(0);
  });

  it('missing signalId → SIGNAL_IDENTITY_REQUIRED', async () => {
    const err = await gate
      .registerOrReuse(USER, {
        signalId: '   ',
        generatedAt: new Date(Date.now() - 5_000),
        materialFields: MATERIAL,
      })
      .catch((e: unknown) => e);
    expect(responseOf(err)).toMatchObject({ code: 'SIGNAL_IDENTITY_REQUIRED' });
    expect(await allRows()).toHaveLength(0);
  });

  it('missing generatedAt → SIGNAL_GENERATED_AT_REQUIRED', async () => {
    const err = await gate
      .registerOrReuse(USER, {
        signalId: 'sig-nogen-001',
        generatedAt: null,
        materialFields: MATERIAL,
      })
      .catch((e: unknown) => e);
    expect(responseOf(err)).toMatchObject({ code: 'SIGNAL_GENERATED_AT_REQUIRED' });
    expect(await allRows()).toHaveLength(0);
  });

  // ─── markProcessed idempotence ─────────────────────────────────────────────

  it('markProcessed is idempotent — firstProcessedAt moves EXACTLY once, status PROCESSED', async () => {
    await gate.registerOrReuse(USER, {
      signalId: 'sig-processed-001',
      generatedAt: new Date(Date.now() - 3_000),
      materialFields: MATERIAL,
    });

    await gate.markProcessed(USER, 'sig-processed-001');
    let rows = await allRows();
    expect(rows[0].status).toBe(AiSignalIdentityStatus.PROCESSED);
    expect(rows[0].first_processed_at).not.toBeNull();
    const firstProcessedMs = new Date(rows[0].first_processed_at as string).getTime();

    // A second completion (duplicate pipeline race) must NOT move the
    // authoritative first-processing instant.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await gate.markProcessed(USER, 'sig-processed-001');
    rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(AiSignalIdentityStatus.PROCESSED);
    expect(new Date(rows[0].first_processed_at as string).getTime()).toBe(firstProcessedMs);
  });
});
