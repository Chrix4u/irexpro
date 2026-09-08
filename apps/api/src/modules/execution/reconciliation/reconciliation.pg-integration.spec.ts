import { DataSource } from 'typeorm';
import { ReconciliationPersistenceService } from './reconciliation-persistence.service';
import { ReconciliationRun } from './entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from './entities/reconciliation-discrepancy.entity';
import {
  ReconciliationRunStatus,
  ReconciliationDiscrepancySeverity,
  ReconciliationRefType,
  ReconciliationDiscrepancyType,
} from './reconciliation.enums';
import { DiscrepancyCandidate } from './reconciliation-comparator';

/**
 * Sprint 50 PR-4 — real-PostgreSQL proof for state reconciliation
 * persistence and its concurrency model (Directive §25 persist/surface +
 * §30 "duplicate provider event" / racing reconciliation):
 *
 * 1. Discrepancy dedup: the partial unique OPEN-row index (COALESCE exprs)
 *    makes re-detection REFRESH the existing row instead of stacking
 *    duplicates.
 * 2. Resolution is guarded: only an OPEN row flips; duplicate resolutions
 *    (duplicate provider events, concurrent resolvers) no-op.
 * 3. A resolved drift that REAPPEARS opens a fresh row — honest history.
 * 4. Concurrent persist calls serialize via the per-connection advisory
 *    lock — never a 23505 race.
 * 5. Run rows record outcome facts (visibility — §29).
 */
describe('State reconciliation persistence — real PostgreSQL', () => {
  let dataSource: DataSource;
  let service: ReconciliationPersistenceService;

  const userId = '11111111-1111-1111-1111-111111111111';
  const connectionId = '22222222-2222-2222-2222-222222222222';
  const otherConnectionId = '33333333-3333-3333-3333-333333333333';

  const candidate = (overrides: Partial<DiscrepancyCandidate> = {}): DiscrepancyCandidate => ({
    type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
    severity: ReconciliationDiscrepancySeverity.WARNING,
    internalRefType: ReconciliationRefType.TRADE,
    internalRefId: 'trade-1',
    providerRef: 'pos-1',
    clientOrderId: null,
    details: { note: 'test' },
    ...overrides,
  });

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'irexpro',
      password: process.env.DB_PASSWORD ?? 'test_password',
      database: process.env.DB_NAME ?? 'irexpro_test',
      entities: [ReconciliationRun, ReconciliationDiscrepancy],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();

    // reconciliation schema — mirrors migration 1753700000000.
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS reconciliation');
    await dataSource.query('DROP TABLE IF EXISTS reconciliation.discrepancies');
    await dataSource.query('DROP TABLE IF EXISTS reconciliation.runs');
    await dataSource.query(`CREATE TABLE reconciliation.runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      broker_connection_id UUID NOT NULL,
      broker_id VARCHAR(50) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      started_at TIMESTAMPTZ NULL,
      completed_at TIMESTAMPTZ NULL,
      provider_orders_seen INTEGER NOT NULL DEFAULT 0,
      internal_orders_compared INTEGER NOT NULL DEFAULT 0,
      provider_positions_seen INTEGER NOT NULL DEFAULT 0,
      internal_positions_compared INTEGER NOT NULL DEFAULT 0,
      account_snapshot_compared INTEGER NOT NULL DEFAULT 0,
      discrepancies_detected INTEGER NOT NULL DEFAULT 0,
      discrepancies_new INTEGER NOT NULL DEFAULT 0,
      discrepancies_auto_resolved INTEGER NOT NULL DEFAULT 0,
      discrepancies_open INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT NULL,
      metadata JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_reconciliation_runs_status CHECK (status IN (
        'PENDING','RUNNING','COMPLETED','COMPLETED_WITH_WARNINGS','FAILED'))
    )`);
    await dataSource.query(`CREATE TABLE reconciliation.discrepancies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      broker_connection_id UUID NOT NULL,
      run_id UUID NULL,
      discrepancy_type VARCHAR(40) NOT NULL,
      severity VARCHAR(10) NOT NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'OPEN',
      internal_ref_type VARCHAR(10) NULL,
      internal_ref_id VARCHAR(255) NULL,
      client_order_id VARCHAR(100) NULL,
      provider_ref VARCHAR(255) NULL,
      details JSONB NULL,
      first_detected_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ NULL,
      resolution VARCHAR(500) NULL,
      resolved_by VARCHAR(20) NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_reconciliation_discrepancy_type CHECK (discrepancy_type IN (
        'MISSING_INTERNAL_ORDER','UNKNOWN_PROVIDER_ORDER','MISSING_PROVIDER_ORDER',
        'UNKNOWN_PROVIDER_POSITION','STALE_ORDER_STATE','POSITION_CLOSED_EXTERNALLY',
        'DUPLICATE_PROVIDER_ID','UNRESOLVED_EXECUTION_RESULT','ACCOUNT_STATE_MISMATCH')),
      CONSTRAINT chk_reconciliation_discrepancy_severity CHECK (severity IN (
        'INFO','WARNING','CRITICAL')),
      CONSTRAINT chk_reconciliation_discrepancy_status CHECK (status IN ('OPEN','RESOLVED')),
      CONSTRAINT chk_reconciliation_discrepancy_ref_type CHECK (
        internal_ref_type IS NULL OR internal_ref_type IN ('ORDER','TRADE','ACCOUNT')),
      CONSTRAINT chk_reconciliation_discrepancy_resolved_by CHECK (
        resolved_by IS NULL OR resolved_by IN ('AUTO','MANUAL')),
      CONSTRAINT chk_reconciliation_discrepancy_resolved_shape CHECK (
        (status = 'OPEN' AND resolved_at IS NULL AND resolution IS NULL)
        OR
        (status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolution IS NOT NULL))
    )`);
    await dataSource.query(`
      CREATE UNIQUE INDEX uq_reconciliation_discrepancy_open
      ON reconciliation.discrepancies (
        broker_connection_id,
        discrepancy_type,
        COALESCE(internal_ref_id, ''),
        COALESCE(provider_ref, '')
      )
      WHERE status = 'OPEN'
    `);

    service = new ReconciliationPersistenceService(
      dataSource.getRepository(ReconciliationRun),
      dataSource.getRepository(ReconciliationDiscrepancy),
      dataSource,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE reconciliation.discrepancies');
    await dataSource.query('TRUNCATE TABLE reconciliation.runs');
  });

  const makeRun = async (): Promise<string> => {
    const run = await service.createRun({
      userId,
      brokerConnectionId: connectionId,
      brokerId: 'paper-broker',
    });
    return run.id;
  };

  // ─── Runs ─────────────────────────────────────────────────────────────────

  it('persists run rows with RUNNING status and lifecycle timestamps', async () => {
    const runId = await makeRun();
    const rows = await dataSource.query('SELECT * FROM reconciliation.runs WHERE id = $1', [runId]);
    expect(rows[0].status).toBe(ReconciliationRunStatus.RUNNING);
    expect(rows[0].started_at).not.toBeNull();
  });

  it('completes runs with counters and metadata (§29 visibility)', async () => {
    const runId = await makeRun();
    await service.completeRun(runId, {
      status: ReconciliationRunStatus.COMPLETED_WITH_WARNINGS,
      counters: {
        providerOrdersSeen: 3,
        internalOrdersCompared: 2,
        discrepanciesDetected: 5,
        discrepanciesNew: 2,
        discrepanciesOpen: 1,
        errors: 1,
      },
      errorSummary: '1 resolution errors this run',
      metadata: { refreshedDiscrepancies: 3 },
    });

    const rows = await dataSource.query('SELECT * FROM reconciliation.runs WHERE id = $1', [runId]);
    expect(rows[0].status).toBe('COMPLETED_WITH_WARNINGS');
    expect(rows[0].discrepancies_detected).toBe(5);
    expect(rows[0].error_summary).toContain('1 resolution errors');
    expect(rows[0].completed_at).not.toBeNull();
  });

  it('fails runs with a bounded error summary', async () => {
    const runId = await makeRun();
    await service.failRun(runId, 'x'.repeat(3000));
    const rows = await dataSource.query('SELECT * FROM reconciliation.runs WHERE id = $1', [runId]);
    expect(rows[0].status).toBe('FAILED');
    expect((rows[0].error_summary as string).length).toBe(2000);
  });

  // ─── Discrepancy dedup ─────────────────────────────────────────────────────

  it('inserts NEW discrepancies and reports their row identities', async () => {
    const runId = await makeRun();
    const result = await service.persistDiscrepancies(
      { userId, brokerConnectionId: connectionId },
      runId,
      [candidate()],
    );

    expect(result.inserted).toBe(1);
    expect(result.newRows).toHaveLength(1);
    expect(result.newRows[0].type).toBe('POSITION_CLOSED_EXTERNALLY');

    const rows = await dataSource.query('SELECT * FROM reconciliation.discrepancies');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('OPEN');
    expect(rows[0].run_id).toBe(runId);
    expect(rows[0].first_detected_at).toEqual(rows[0].last_seen_at);
  });

  it('re-detection REFRESHES the OPEN row instead of duplicating (dedup index)', async () => {
    const run1 = await makeRun();
    await service.persistDiscrepancies({ userId, brokerConnectionId: connectionId }, run1, [
      candidate(),
    ]);

    const run2 = await makeRun();
    const result = await service.persistDiscrepancies(
      { userId, brokerConnectionId: connectionId },
      run2,
      [candidate({ details: { note: 'updated facts' } })],
    );

    expect(result.inserted).toBe(0);
    expect(result.refreshed).toBe(1);

    const rows = await dataSource.query('SELECT * FROM reconciliation.discrepancies');
    expect(rows).toHaveLength(1); // still ONE row
    expect(rows[0].details).toEqual({ note: 'updated facts' });
    expect(rows[0].run_id).toBe(run2); // latest observing run
    expect(rows[0].last_seen_at).not.toBeNull();
  });

  it('dedups NULL refs correctly (account mismatch has no internal/provider ref)', async () => {
    const run1 = await makeRun();
    const accountCandidate = candidate({
      type: ReconciliationDiscrepancyType.ACCOUNT_STATE_MISMATCH,
      severity: ReconciliationDiscrepancySeverity.WARNING,
      internalRefType: ReconciliationRefType.ACCOUNT,
      internalRefId: null,
      providerRef: null,
      details: { drift: true },
    });

    await service.persistDiscrepancies({ userId, brokerConnectionId: connectionId }, run1, [
      accountCandidate,
    ]);
    const result = await service.persistDiscrepancies(
      { userId, brokerConnectionId: connectionId },
      await makeRun(),
      [accountCandidate],
    );

    expect(result.inserted).toBe(0);
    expect(result.refreshed).toBe(1);
    const rows = await dataSource.query('SELECT * FROM reconciliation.discrepancies');
    expect(rows).toHaveLength(1);
  });

  it('scopes dedup per connection (the same drift on another connection is separate)', async () => {
    const runId = await makeRun();
    await service.persistDiscrepancies({ userId, brokerConnectionId: connectionId }, runId, [
      candidate(),
    ]);
    const result = await service.persistDiscrepancies(
      { userId, brokerConnectionId: otherConnectionId },
      runId,
      [candidate()],
    );
    expect(result.inserted).toBe(1);
    const rows = await dataSource.query('SELECT * FROM reconciliation.discrepancies');
    expect(rows).toHaveLength(2);
  });

  // ─── Resolution guards ─────────────────────────────────────────────────────

  it('resolves OPEN rows once — duplicate resolutions (duplicate provider events) no-op', async () => {
    const runId = await makeRun();
    await service.persistDiscrepancies({ userId, brokerConnectionId: connectionId }, runId, [
      candidate(),
    ]);

    const first = await service.resolveDiscrepanciesByRef(connectionId, [
      {
        type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
        internalRefId: 'trade-1',
        providerRef: 'pos-1',
        resolution: 'Provider reports the position closed — trade converged to CLOSED',
      },
    ]);
    expect(first).toHaveLength(1);

    // The duplicate provider event arrives → same resolution attempt.
    const second = await service.resolveDiscrepanciesByRef(connectionId, [
      {
        type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
        internalRefId: 'trade-1',
        providerRef: 'pos-1',
        resolution: 'duplicate event — must no-op',
      },
    ]);
    expect(second).toHaveLength(0);

    const rows = await dataSource.query('SELECT * FROM reconciliation.discrepancies');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('RESOLVED');
    expect(rows[0].resolved_by).toBe('AUTO');
    expect(rows[0].resolution).toContain('trade converged to CLOSED');
    expect(rows[0].resolved_at).not.toBeNull();
  });

  it('a resolved drift that REAPPEARS opens a fresh row (honest history)', async () => {
    const runId = await makeRun();
    await service.persistDiscrepancies({ userId, brokerConnectionId: connectionId }, runId, [
      candidate(),
    ]);
    await service.resolveDiscrepanciesByRef(connectionId, [
      {
        type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
        internalRefId: 'trade-1',
        providerRef: 'pos-1',
        resolution: 'converged',
      },
    ]);

    // The same mismatch is detected again later.
    const result = await service.persistDiscrepancies(
      { userId, brokerConnectionId: connectionId },
      await makeRun(),
      [candidate()],
    );

    expect(result.inserted).toBe(1);
    const rows = await dataSource.query(
      'SELECT * FROM reconciliation.discrepancies ORDER BY created_at',
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r: { status: string }) => r.status === 'RESOLVED')).toHaveLength(1);
    expect(rows.filter((r: { status: string }) => r.status === 'OPEN')).toHaveLength(1);
  });

  // ─── Concurrency (Directive §30) ──────────────────────────────────────────

  it('CONCURRENT persist calls serialize via the advisory lock — no 23505 race', async () => {
    const runA = await makeRun();
    const runB = await makeRun();

    // Two runs detect the same discrepancy at the same instant.
    const results = await Promise.all([
      service.persistDiscrepancies({ userId, brokerConnectionId: connectionId }, runA, [
        candidate(),
      ]),
      service.persistDiscrepancies({ userId, brokerConnectionId: connectionId }, runB, [
        candidate(),
      ]),
    ]);

    expect(results.some((r) => r.inserted === 1)).toBe(true);
    expect(results.some((r) => r.refreshed === 1)).toBe(true);
    expect(results.every((r) => r.inserted + r.refreshed === 1)).toBe(true);

    const rows = await dataSource.query('SELECT * FROM reconciliation.discrepancies');
    expect(rows).toHaveLength(1); // exactly one OPEN row survives
  });

  it('CONCURRENT resolutions of the same row resolve exactly once', async () => {
    const runId = await makeRun();
    await service.persistDiscrepancies({ userId, brokerConnectionId: connectionId }, runId, [
      candidate(),
    ]);

    const [a, b] = await Promise.all([
      service.resolveDiscrepanciesByRef(connectionId, [
        {
          type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
          internalRefId: 'trade-1',
          providerRef: 'pos-1',
          resolution: 'racer A',
        },
      ]),
      service.resolveDiscrepanciesByRef(connectionId, [
        {
          type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
          internalRefId: 'trade-1',
          providerRef: 'pos-1',
          resolution: 'racer B',
        },
      ]),
    ]);

    const totalResolved = a.length + b.length;
    expect(totalResolved).toBe(1); // exactly one resolver won

    const rows = await dataSource.query('SELECT * FROM reconciliation.discrepancies');
    expect(rows[0].status).toBe('RESOLVED');
  });

  // ─── Constraint enforcement ────────────────────────────────────────────────

  it('CHECK constraints reject out-of-enum discrepancy types (DB-level fail-closed)', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO reconciliation.discrepancies
           (user_id, broker_connection_id, discrepancy_type, severity, status,
            first_detected_at, last_seen_at)
         VALUES ($1, $2, 'NOT_A_REAL_TYPE', 'WARNING', 'OPEN', now(), now())`,
        [userId, connectionId],
      ),
    ).rejects.toThrow(/chk_reconciliation_discrepancy_type/);
  });

  it('CHECK constraints reject a RESOLVED shape without resolution facts', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO reconciliation.discrepancies
           (user_id, broker_connection_id, discrepancy_type, severity, status,
            resolved_at, first_detected_at, last_seen_at)
         VALUES ($1, $2, 'STALE_ORDER_STATE', 'WARNING', 'RESOLVED', now(), now(), now())`,
        [userId, connectionId],
      ),
    ).rejects.toThrow(/chk_reconciliation_discrepancy_resolved_shape/);
  });

  it('counts OPEN discrepancies per connection', async () => {
    const runId = await makeRun();
    await service.persistDiscrepancies({ userId, brokerConnectionId: connectionId }, runId, [
      candidate(),
      candidate({
        type: ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION,
        severity: ReconciliationDiscrepancySeverity.CRITICAL,
        internalRefType: null,
        internalRefId: null,
        providerRef: 'ghost-1',
        details: {},
      }),
    ]);
    expect(await service.countOpenDiscrepancies(connectionId)).toBe(2);
    expect(await service.countOpenDiscrepancies(otherConnectionId)).toBe(0);
  });
});
