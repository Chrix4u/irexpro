import { DataSource } from 'typeorm';

/**
 * Production-LIVE completion round (Phase 11) — PostgreSQL restart /
 * connection-kill recovery drill.
 *
 * The directive's failure-matrix scenario "PostgreSQL restart/recovery" had
 * NO drill anywhere (audit finding). A true PG service restart cannot be
 * driven from inside a CI job, but the OPERATIVE hazards of a restart are:
 *
 *   1. connections killed MID-TRANSACTION (atomicity: the partially-applied
 *      write must vanish entirely — no half-committed exposure),
 *   2. the pool's connections killed between transactions (durability: the
 *      pre-kill committed truth is exactly what is observed after
 *      reconnection — nothing lost, nothing duplicated),
 *   3. a client retrying an idempotent write after recovery (exactly-once:
 *      the durable unique indexes + CAS guards must yield ONE row / ONE
 *      consume, never a duplicate exposure).
 *
 * All three are driven here with `pg_terminate_backend` against this spec's
 * OWN connections only — the pools carry distinctive application_name values
 * so parallel CI suites on the same test database are never collateral
 * damage. (CI-only suite: test/jest-pg.json — no PostgreSQL in the dev
 * sandbox; honestly skipped there.)
 *
 * Proves: no duplicate exposure can be created across a database restart,
 * and the idempotency/CAS discipline survives connection loss.
 */
describe('PostgreSQL restart/kill recovery drill (Phase 11)', () => {
  const MAIN_APP_NAME = 'irexpro-pg-drill-main';
  const ADMIN_APP_NAME = 'irexpro-pg-drill-admin';
  let dataSource: DataSource;
  let adminDataSource: DataSource;

  const baseOptions = {
    type: 'postgres' as const,
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD ?? 'test_password',
    database: process.env.DB_NAME ?? 'irexpro_test',
    synchronize: false,
    logging: false,
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      ...baseOptions,
      applicationName: MAIN_APP_NAME,
    } as typeof baseOptions & { applicationName: string });
    await dataSource.initialize();

    // A separate single-connection pool used ONLY to observe and terminate
    // the main pool's backends (the administrator's eyes; never used for the
    // drilled writes).
    adminDataSource = new DataSource({
      ...baseOptions,
      applicationName: ADMIN_APP_NAME,
      poolSize: 1,
      // One connection is all this pool ever needs.
      extra: { max: 1, min: 0 },
    } as typeof baseOptions & { applicationName: string; poolSize: number });
    await adminDataSource.initialize();

    await dataSource.query('CREATE SCHEMA IF NOT EXISTS trading');
    await dataSource.query('DROP TABLE IF EXISTS trading.drill_orders');
    await dataSource.query('DROP TABLE IF EXISTS trading.drill_grants');
    // Mirrors the production orders idempotency discipline (unique
    // idempotency key per order) and the risk-grant CAS-consume shape.
    await dataSource.query(`CREATE TABLE trading.drill_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      client_order_id VARCHAR(100) NOT NULL,
      idempotency_key VARCHAR(120) NOT NULL,
      status VARCHAR(40) NOT NULL,
      quantity NUMERIC(20,8) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await dataSource.query(
      `CREATE UNIQUE INDEX uq_drill_orders_idempotency ON trading.drill_orders (idempotency_key)`,
    );
    await dataSource.query(`CREATE TABLE trading.drill_grants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      signal_id UUID NOT NULL,
      status VARCHAR(20) NOT NULL,
      consumed_at TIMESTAMPTZ
    )`);
    await dataSource.query(
      `CREATE UNIQUE INDEX uq_drill_grants_signal ON trading.drill_grants (signal_id)`,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DROP TABLE IF EXISTS trading.drill_orders');
      await dataSource.query('DROP TABLE IF EXISTS trading.drill_grants');
      await dataSource.destroy();
    }
    if (adminDataSource?.isInitialized) {
      await adminDataSource.destroy();
    }
  });

  /** Terminate every backend of THIS spec's main pool (identified by application_name — never another suite's connections). */
  const killMainPoolBackends = async (): Promise<number> => {
    const result = await adminDataSource.query(
      `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1`,
      [MAIN_APP_NAME],
    );
    return result.filter((r: { terminated: boolean }) => r.terminated).length;
  };

  it('durability: committed truth survives a full pool kill exactly (nothing lost, nothing duplicated)', async () => {
    const userId = '11111111-2222-4222-8222-333333333331';
    await dataSource.query(
      `INSERT INTO trading.drill_orders (user_id, client_order_id, idempotency_key, status, quantity)
       VALUES ($1, 'drill-durable-1', 'idem-durable-1', 'DISPATCH_COMMITTED', 0.05)`,
      [userId],
    );
    const before = await dataSource.query(
      `SELECT count(*)::int AS n FROM trading.drill_orders WHERE idempotency_key = 'idem-durable-1'`,
    );
    expect(before[0].n).toBe(1);

    await killMainPoolBackends();

    // After reconnection (the pool re-establishes transparently), the
    // committed row count is EXACTLY the pre-kill count.
    const after = await dataSource.query(
      `SELECT count(*)::int AS n FROM trading.drill_orders WHERE idempotency_key = 'idem-durable-1'`,
    );
    expect(after[0].n).toBe(1);
  });

  it('atomicity: a backend killed MID-TRANSACTION rolls back the entire transaction (no half-committed exposure)', async () => {
    const userId = '11111111-2222-4222-8222-333333333332';
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    // Write inside the open transaction (NOT yet committed).
    await queryRunner.query(
      `INSERT INTO trading.drill_orders (user_id, client_order_id, idempotency_key, status, quantity)
       VALUES ($1, 'drill-tx-kill-1', 'idem-tx-kill-1', 'DISPATCH_COMMITTED', 0.10)`,
      [userId],
    );

    // Kill the query runner's backend FROM OUTSIDE while the transaction is open.
    const victims = await adminDataSource.query(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND state = 'idle in transaction'`,
      [MAIN_APP_NAME],
    );
    expect(victims.length).toBeGreaterThanOrEqual(1);
    for (const victim of victims) {
      await adminDataSource.query(`SELECT pg_terminate_backend($1)`, [victim.pid]);
    }

    // The next use of that runner surfaces the connection loss — the
    // transaction NEVER commits silently after its backend died.
    await expect(
      queryRunner.query(`SELECT count(*)::int AS n FROM trading.drill_orders`),
    ).rejects.toThrow();
    await queryRunner.release().catch(() => undefined);

    // After recovery, the mid-flight row is GONE — full rollback; no
    // half-committed exposure exists anywhere in the table.
    const rows = await dataSource.query(
      `SELECT count(*)::int AS n FROM trading.drill_orders WHERE idempotency_key = 'idem-tx-kill-1'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('exactly-once across recovery: an idempotent retry after a pool kill creates NO duplicate exposure', async () => {
    const userId = '11111111-2222-4222-8222-333333333333';
    const insert = async () =>
      dataSource.query(
        `INSERT INTO trading.drill_orders (user_id, client_order_id, idempotency_key, status, quantity)
         VALUES ($1, 'drill-retry-1', 'idem-retry-1', 'DISPATCH_COMMITTED', 0.02)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [userId],
      );

    await insert();
    await killMainPoolBackends();
    // The client cannot know whether the first write survived the kill — it retries.
    await insert();
    await insert();

    const rows = await dataSource.query(
      `SELECT count(*)::int AS n, max(quantity)::text AS qty FROM trading.drill_orders WHERE idempotency_key = 'idem-retry-1'`,
    );
    expect(rows[0].n).toBe(1);
    expect(rows[0].qty).toBe('0.02');
  });

  it('grant CAS consume across recovery: a retried consume after a pool kill consumes EXACTLY once', async () => {
    const userId = '11111111-2222-4222-8222-333333333334';
    const signalId = '44444444-4444-4444-8444-444444444441';
    await dataSource.query(
      `INSERT INTO trading.drill_grants (user_id, signal_id, status) VALUES ($1, $2, 'ACTIVE')`,
      [userId, signalId],
    );

    // RETURNING makes the affected count deterministically observable across
    // drivers — the CAS-consume shape of the final dispatch boundary.
    const consume = async () =>
      dataSource.query(
        `UPDATE trading.drill_grants
            SET status = 'CONSUMED', consumed_at = now()
          WHERE signal_id = $1 AND status = 'ACTIVE'
          RETURNING id`,
        [signalId],
      );

    const first = await consume();
    expect(first).toHaveLength(1);

    await killMainPoolBackends();
    // The dispatch retries the consume after losing its connection — the CAS
    // guard makes the retry a no-op, never a double consume.
    const retry = await consume();
    expect(retry).toHaveLength(0);

    const final = await dataSource.query(
      `SELECT status, count(*)::int AS n FROM trading.drill_grants WHERE signal_id = $1 GROUP BY status`,
      [signalId],
    );
    expect(final).toHaveLength(1);
    expect(final[0].status).toBe('CONSUMED');
    expect(final[0].n).toBe(1);
  });
});
