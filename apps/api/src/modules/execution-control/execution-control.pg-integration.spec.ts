import { ConflictException } from '@nestjs/common';
import { DataSource, FindOptionsWhere, IsNull, Repository } from 'typeorm';
import { ExecutionControlService } from './execution-control.service';
import {
  ExecutionControl,
  ExecutionControlScope,
  ExecutionControlStatus,
} from './entities/execution-control.entity';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';

/**
 * Sprint 50 correction (architect review A2) — execution-control lifecycle
 * proven against a REAL PostgreSQL store.
 *
 * Proves:
 * - activate → expire → re-activate at the same (scope, scopeKey) succeeds
 *   deterministically (the original non-partial unique index blocked this);
 * - repeated A → B → C replacement preserves historical EXPIRED rows without
 *   allowing an older row to shadow the current time-expired ACTIVE row;
 * - concurrent replacement of a time-expired ACTIVE row produces exactly one
 *   new ACTIVE winner while retaining the expired predecessor as history;
 * - concurrent activations produce exactly ONE active control;
 * - all four scopes (GLOBAL / PROVIDER / USER / BROKER_CONNECTION) are
 *   enforced end-to-end on the real store, with unrelated scopes unaffected;
 * - EXPIRED-status rows never block;
 * - deactivation clears the block.
 *
 * Runs ONLY via test/jest-pg.json (excluded from the unit run).
 */
describe('ExecutionControlService — real PostgreSQL lifecycle (architect A2)', () => {
  let dataSource: DataSource;
  let service: ExecutionControlService;
  let controlRepo: Repository<ExecutionControl>;

  const admin = '99999999-9999-9999-9999-999999999999';

  const activateDto = (
    scope: ExecutionControlScope,
    scopeKey: string | null,
    reason = 'integration',
    expiresAt?: string,
  ) =>
    ({
      scope,
      scopeKey,
      reason,
      ...(expiresAt ? { expiresAt } : {}),
    }) as Parameters<ExecutionControlService['activateControl']>[0];

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'irexpro',
      password: process.env.DB_PASSWORD ?? 'test_password',
      database: process.env.DB_NAME ?? 'irexpro_test',
      entities: [ExecutionControl],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS platform');

    // DDL mirrors migrations 1753500000000 (CreateExecutionControls) +
    // 1753550000000 (ExecutionControlLifecycleStatus): the partial unique
    // index over ACTIVE rows is the A2 correction under test.
    await dataSource.query(`DROP TABLE IF EXISTS "platform"."execution_controls"`);
    await dataSource.query(`
      CREATE TABLE "platform"."execution_controls" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "scope" varchar(20) NOT NULL,
        "scope_key" varchar(100) NULL,
        "reason" varchar(500) NOT NULL,
        "activated_by_user_id" uuid NOT NULL,
        "activated_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NULL,
        "status" varchar(20) NOT NULL DEFAULT 'ACTIVE',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_execution_controls" PRIMARY KEY ("id"),
        CONSTRAINT "chk_execution_controls_scope"
          CHECK ("scope" IN ('GLOBAL', 'PROVIDER', 'USER', 'BROKER_CONNECTION')),
        CONSTRAINT "chk_execution_controls_scope_key_global"
          CHECK ("scope" != 'GLOBAL' OR "scope_key" IS NULL),
        CONSTRAINT "chk_execution_controls_scope_key_required"
          CHECK ("scope" = 'GLOBAL' OR ("scope_key" IS NOT NULL AND "scope_key" != '')),
        CONSTRAINT "chk_execution_controls_status"
          CHECK ("status" IN ('ACTIVE', 'EXPIRED'))
      )
    `);
    await dataSource.query(`
      CREATE UNIQUE INDEX "uq_exec_controls_active_scope"
      ON "platform"."execution_controls" ("scope", COALESCE("scope_key", ''))
      WHERE "status" = 'ACTIVE'
    `);
    await dataSource.query(`
      CREATE INDEX "idx_exec_controls_scope_key"
      ON "platform"."execution_controls" ("scope", "scope_key")
    `);

    controlRepo = dataSource.getRepository(ExecutionControl);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE "platform"."execution_controls"');
    const auditService = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const eventBus = { publish: jest.fn() } as unknown as DomainEventBus;
    service = new ExecutionControlService(controlRepo, auditService, eventBus);
  });

  const activeRows = async (
    scope: ExecutionControlScope,
    scopeKey: string | null,
  ): Promise<ExecutionControl[]> => {
    const where: FindOptionsWhere<ExecutionControl> = { scope };
    where.scopeKey = scopeKey === null ? IsNull() : scopeKey;
    return controlRepo.find({ where, order: { activatedAt: 'ASC' } });
  };

  const expireInTime = async (id: string): Promise<void> => {
    await dataSource.query(
      `UPDATE "platform"."execution_controls"
       SET "expires_at" = now() - interval '1 minute'
       WHERE "id" = $1`,
      [id],
    );
  };

  it('activate → expire → re-activate at the same scope/key succeeds deterministically (A2)', async () => {
    const first = await service.activateControl(
      activateDto(ExecutionControlScope.USER, 'user-1', 'first incident'),
      admin,
    );
    expect(first.scope).toBe(ExecutionControlScope.USER);

    // The control blocks while unexpired.
    const blocked = await service.checkExecutionPermission({ userId: 'user-1' });
    expect(blocked.allowed).toBe(false);

    // Expire the row in time (simulates the expiry passing).
    await expireInTime(first.id);

    // Expired-in-time rows are ignored immediately.
    const unblocked = await service.checkExecutionPermission({ userId: 'user-1' });
    expect(unblocked.allowed).toBe(true);

    // Reactivation at the SAME scope/key must succeed (the old non-partial
    // unique index made this impossible — the A2 defect).
    const second = await service.activateControl(
      activateDto(ExecutionControlScope.USER, 'user-1', 'second incident'),
      admin,
    );
    expect(second.id).not.toBe(first.id);

    // Old row is retained as an EXPIRED record; exactly ONE ACTIVE row.
    const rows = await activeRows(ExecutionControlScope.USER, 'user-1');
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === ExecutionControlStatus.ACTIVE)).toHaveLength(1);
    expect(rows.filter((r) => r.status === ExecutionControlStatus.EXPIRED)).toHaveLength(1);

    // The new control blocks again.
    const blockedAgain = await service.checkExecutionPermission({ userId: 'user-1' });
    expect(blockedAgain.allowed).toBe(false);
    expect(blockedAgain.blockedBy?.reason).toBe('second incident');
  });

  it('A → expire A → B → expire B → C succeeds and preserves A/B as EXPIRED history (A2 multi-cycle)', async () => {
    const first = await service.activateControl(
      activateDto(ExecutionControlScope.USER, 'user-cycle', 'cycle A'),
      admin,
    );
    await expireInTime(first.id);

    const second = await service.activateControl(
      activateDto(ExecutionControlScope.USER, 'user-cycle', 'cycle B'),
      admin,
    );
    expect(second.id).not.toBe(first.id);
    await expireInTime(second.id);

    // This third activation is the regression boundary. An unqualified slot
    // lookup can rediscover historical row A, fail to retire B, and then hit
    // a false 23505 while attempting to insert C.
    const third = await service.activateControl(
      activateDto(ExecutionControlScope.USER, 'user-cycle', 'cycle C'),
      admin,
    );

    expect(third.id).not.toBe(first.id);
    expect(third.id).not.toBe(second.id);

    const rows = await activeRows(ExecutionControlScope.USER, 'user-cycle');
    expect(rows).toHaveLength(3);

    const active = rows.filter((row) => row.status === ExecutionControlStatus.ACTIVE);
    const expired = rows.filter((row) => row.status === ExecutionControlStatus.EXPIRED);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(third.id);
    expect(active[0].reason).toBe('cycle C');
    expect(expired).toHaveLength(2);
    expect(new Set(expired.map((row) => row.id))).toEqual(new Set([first.id, second.id]));

    const blocked = await service.checkExecutionPermission({ userId: 'user-cycle' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy?.reason).toBe('cycle C');
  });

  it('two concurrent replacements of a time-expired ACTIVE row yield one new ACTIVE winner (A2)', async () => {
    const seeded = await service.activateControl(
      activateDto(ExecutionControlScope.PROVIDER, 'oanda', 'seeded outage'),
      admin,
    );
    await expireInTime(seeded.id);

    const results = await Promise.allSettled([
      service.activateControl(
        activateDto(ExecutionControlScope.PROVIDER, 'oanda', 'replacement A'),
        admin,
      ),
      service.activateControl(
        activateDto(ExecutionControlScope.PROVIDER, 'oanda', 'replacement B'),
        admin,
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof service.activateControl>>>).value;
    const rows = await activeRows(ExecutionControlScope.PROVIDER, 'oanda');
    expect(rows).toHaveLength(2);

    const active = rows.filter((row) => row.status === ExecutionControlStatus.ACTIVE);
    const expired = rows.filter((row) => row.status === ExecutionControlStatus.EXPIRED);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(winner.id);
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe(seeded.id);
  });

  it('concurrent activations at the same scope/key produce exactly one active control (A2)', async () => {
    const results = await Promise.allSettled([
      service.activateControl(
        activateDto(ExecutionControlScope.PROVIDER, 'metatrader5', 'outage A'),
        admin,
      ),
      service.activateControl(
        activateDto(ExecutionControlScope.PROVIDER, 'metatrader5', 'outage B'),
        admin,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const rows = await activeRows(ExecutionControlScope.PROVIDER, 'metatrader5');
    expect(rows.filter((r) => r.status === ExecutionControlStatus.ACTIVE)).toHaveLength(1);
  });

  it('GLOBAL blocks everyone, including other providers/users/connections', async () => {
    await service.activateControl(activateDto(ExecutionControlScope.GLOBAL, null), admin);

    const a = await service.checkExecutionPermission({ userId: 'user-1' });
    const b = await service.checkExecutionPermission({
      userId: 'user-2',
      brokerId: 'oanda',
      brokerConnectionId: 'conn-2',
    });
    expect(a.allowed).toBe(false);
    expect(a.blockedBy?.scope).toBe(ExecutionControlScope.GLOBAL);
    expect(b.allowed).toBe(false);
    expect(b.blockedBy?.scope).toBe(ExecutionControlScope.GLOBAL);
  });

  it('PROVIDER blocks only the affected provider — an unrelated provider stays unaffected', async () => {
    await service.activateControl(
      activateDto(ExecutionControlScope.PROVIDER, 'metatrader5'),
      admin,
    );

    const blocked = await service.checkExecutionPermission({
      userId: 'user-1',
      brokerId: 'metatrader5',
      brokerConnectionId: 'conn-mt5',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy?.scope).toBe(ExecutionControlScope.PROVIDER);

    const unaffected = await service.checkExecutionPermission({
      userId: 'user-1',
      brokerId: 'oanda',
      brokerConnectionId: 'conn-oanda',
    });
    expect(unaffected.allowed).toBe(true);
  });

  it('USER blocks only the affected user — another user stays unaffected', async () => {
    await service.activateControl(activateDto(ExecutionControlScope.USER, 'user-1'), admin);

    const blocked = await service.checkExecutionPermission({
      userId: 'user-1',
      brokerId: 'oanda',
      brokerConnectionId: 'conn-oanda',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy?.scope).toBe(ExecutionControlScope.USER);

    const unaffected = await service.checkExecutionPermission({
      userId: 'user-2',
      brokerId: 'oanda',
      brokerConnectionId: 'conn-oanda',
    });
    expect(unaffected.allowed).toBe(true);
  });

  it('BROKER_CONNECTION blocks only the targeted connection — an unrelated connection stays unaffected', async () => {
    await service.activateControl(
      activateDto(ExecutionControlScope.BROKER_CONNECTION, 'conn-target'),
      admin,
    );

    const blocked = await service.checkExecutionPermission({
      userId: 'user-1',
      brokerId: 'metatrader5',
      brokerConnectionId: 'conn-target',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy?.scope).toBe(ExecutionControlScope.BROKER_CONNECTION);

    const unaffected = await service.checkExecutionPermission({
      userId: 'user-1',
      brokerId: 'metatrader5',
      brokerConnectionId: 'conn-other',
    });
    expect(unaffected.allowed).toBe(true);
  });

  it('deactivate deletes the row and unblocks the scope', async () => {
    const view = await service.activateControl(
      activateDto(ExecutionControlScope.USER, 'user-9'),
      admin,
    );
    const blocked = await service.checkExecutionPermission({ userId: 'user-9' });
    expect(blocked.allowed).toBe(false);

    await service.deactivateControl(view.id, admin);

    const unblocked = await service.checkExecutionPermission({ userId: 'user-9' });
    expect(unblocked.allowed).toBe(true);
    expect(await activeRows(ExecutionControlScope.USER, 'user-9')).toHaveLength(0);
  });

  it('GLOBAL with a NULL scope_key and a re-activation after clear: slot is reusable', async () => {
    const first = await service.activateControl(
      activateDto(ExecutionControlScope.GLOBAL, null),
      admin,
    );
    await service.deactivateControl(first.id, admin);

    // The GLOBAL slot (scope_key IS NULL) must accept a fresh control.
    const second = await service.activateControl(
      activateDto(ExecutionControlScope.GLOBAL, null, 'second global'),
      admin,
    );
    expect(second.scope).toBe(ExecutionControlScope.GLOBAL);
    const rows = await activeRows(ExecutionControlScope.GLOBAL, null);
    expect(rows).toHaveLength(1);
  });
});
