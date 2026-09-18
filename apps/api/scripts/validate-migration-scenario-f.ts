/**
 * CI Scenario F — Existing PostgreSQL 16 Domain Upgrade + CHECK Enforcement.
 *
 * Sprint 30 Phase 2A merge gate. Uses REAL TypeORM migration machinery
 * (dataSource.runMigrations()) — not manual migration.up() invocation.
 * This exercises the exact same migration path the application uses in
 * production.
 *
 * Architecture:
 *   Stage 1: Create a DataSource with ONLY the original 18 migration
 *            classes (timestamps 1750800000000 .. 1752400000000).
 *            Run dataSource.runMigrations() to create the pre-Phase-2A
 *            schema (no CHECK constraints on direction / account_type).
 *   Stage 2: Seed valid pre-upgrade data — a user, a subscription plan
 *            (NO status column), two broker connections (DEMO + LIVE),
 *            two trades (BUY + SELL), a reconciliation run + a reconciled
 *            trade (direction='BUY'). Capture IDs, direction values,
 *            account_type values, and row counts.
 *   Stage 3: Create a NEW DataSource with every currently discovered migration
 *            class. showMigrations() returns true. runMigrations() executes
 *            Phase 2A first, followed by any later additive migrations.
 *   Stage 4: Verify every discovered migration is recorded, all existing rows/values
 *            unchanged (exact string comparison), 3 CHECK constraints
 *            exist via pg_constraint + pg_get_constraintdef, and are
 *            validated (convalidated = true).
 *   Stage 5: Valid-value acceptance tests — INSERT new rows with BUY,
 *            SELL, DEMO, LIVE — all accepted.
 *   Stage 6: Invalid-value rejection tests — INSERT with 'HOLD' for
 *            trades.direction → SQLSTATE 23514 + chk_trades_direction;
 *            same for broker_reconciled_trades.direction →
 *            chk_broker_reconciled_trades_direction; INSERT with 'PAPER'
 *            for broker_connections.account_type → SQLSTATE 23514 +
 *            chk_broker_connections_account_type.
 *   Stage 7: Fail-closed test (separate disposable DB) — apply migrations
 *            1-18, insert a trade with direction='HOLD', attempt
 *            all pending migrations via TypeORM runMigrations() — Phase 2A
 *            must fail first; verify the 'HOLD' row still exists unchanged
 *            and no pending migration is recorded in the migrations table.
 *
 * Usage (inside the db-migration-compat GitHub Actions workflow):
 *   DB_HOST=localhost DB_PORT=5432 DB_NAME=irexpro_scenario_f \
 *   DB_USER=postgres DB_PASSWORD=ci_disposable \
 *   npx ts-node apps/api/scripts/validate-migration-scenario-f.ts
 *
 * Exits non-zero on any assertion failure.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import * as path from 'path';
import * as fs from 'fs';

const MIGRATIONS_DIR = path.resolve(__dirname, '../src/database/migrations');

// The timestamp boundary between the 18 pre-Phase-2A migrations and the
// new Phase 2A migration (1752500000000).
const PHASE2A_BOUNDARY = 1752400000000;
const PHASE2A_MIGRATION_FILE = '1752500000000-AddStableDomainCheckConstraints.ts';

// The separate disposable DB used for the Stage 7 fail-closed test.
const ORPHAN_DB_NAME = 'irexpro_scenario_f_orphan';

// ── Types ────────────────────────────────────────────────────────────────────

interface ConstraintMeta {
  conname: string;
  contype: string;
  convalidated: boolean;
  definition: string;
}

interface MigrationCountRow {
  count: string;
}

interface CapturedTradeRow {
  id: string;
  direction: string;
  idempotency_key: string;
  instrument: string;
  lot_size: string;
}

interface CapturedReconciledTradeRow {
  id: string;
  direction: string;
  broker_trade_id: string;
  instrument: string;
  volume: string;
}

interface CapturedBrokerConnectionRow {
  id: string;
  account_type: string;
  broker_id: string;
  display_name: string | null;
}

interface RowCounts {
  users: string;
  subscription_plans: string;
  broker_connections: string;
  trades: string;
  reconciliation_runs: string;
  reconciled_trades: string;
}

// Minimal structural shape of a `pg` error: SQLSTATE code + the offending
// constraint name. We cast the caught value to this in negative tests.
interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

/** Load a migration class constructor from a file. */
function loadMigrationClass(filename: string): any {
  const full = path.join(MIGRATIONS_DIR, filename);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(full);
  const className = Object.keys(mod).find((k) => {
    if (k === 'default') return false;
    return typeof mod[k] === 'function' && /^([A-Z])/.test(k);
  });
  if (!className) throw new Error(`No migration class found in ${filename}`);
  return mod[className];
}

/** Get all migration files sorted chronologically (excluding .spec.ts). */
function getMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && /^\d/.test(f))
    .sort();
}

/** Create a TypeORM DataSource with a specific subset of migration classes. */
function createDataSource(
  host: string,
  port: number,
  database: string,
  user: string,
  password: string,
  migrationClasses: any[],
): DataSource {
  return new DataSource({
    type: 'postgres',
    host,
    port,
    database,
    username: user,
    password,
    synchronize: false,
    entities: [],
    migrations: migrationClasses,
    logging: false,
  });
}

/** Look up a CHECK constraint by name and return its definition + validation status. */
async function getCheckConstraint(
  client: Client,
  constraintName: string,
): Promise<ConstraintMeta | null> {
  const result = await client.query<ConstraintMeta>(
    `SELECT
       c.conname,
       c.contype,
       c.convalidated,
       pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     WHERE c.contype = 'c' AND c.conname = $1`,
    [constraintName],
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/** Count rows in the TypeORM migrations tracking table. */
async function countMigrations(client: Client): Promise<number> {
  const result = await client.query<MigrationCountRow>(
    `SELECT COUNT(*)::text AS count FROM migrations`,
  );
  return parseInt(result.rows[0].count, 10);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== CI Scenario F — Existing DB Domain Upgrade + CHECK Enforcement ===');

  const host = process.env.DB_HOST ?? 'localhost';
  const port = parseInt(process.env.DB_PORT ?? '5432', 10);
  const database = process.env.DB_NAME ?? 'irexpro_scenario_f';
  const user = process.env.DB_USER ?? 'postgres';
  const password = process.env.DB_PASSWORD ?? '';

  // Load migration class constructors and split into the fixed 18-migration
  // pre-Phase-2A subset and every additive migration that follows it.
  const allFiles = getMigrationFiles();
  const allMigrationClasses = allFiles.map(loadMigrationClass);
  const originalFiles = allFiles.filter(
    (f) => parseInt(f.split('-')[0], 10) <= PHASE2A_BOUNDARY,
  );
  const originalMigrationClasses = originalFiles.map(loadMigrationClass);
  const pendingFiles = allFiles.filter(
    (f) => parseInt(f.split('-')[0], 10) > PHASE2A_BOUNDARY,
  );

  console.log(
    `  ${allFiles.length} total migration files (${originalFiles.length} original + ${pendingFiles.length} pending)`,
  );
  assert(originalFiles.length === 18, `expected 18 original migrations, found ${originalFiles.length}`);
  assert(pendingFiles.length >= 1, 'at least 1 post-boundary migration is present');
  assert(
    pendingFiles[0] === PHASE2A_MIGRATION_FILE,
    `Phase 2A remains the first post-boundary migration (got ${pendingFiles[0]})`,
  );

  // ─── Stage 1: Apply original 18 migrations via real TypeORM ────────────
  console.log('\n=== Stage 1: Apply original 18 migrations via TypeORM runMigrations() ===');

  const ds1 = createDataSource(host, port, database, user, password, originalMigrationClasses);
  await ds1.initialize();
  await ds1.runMigrations();
  console.log('  TypeORM runMigrations() completed for original 18 migrations');
  await ds1.destroy();

  const rawClient1 = new Client({ host, port, database, user, password });
  await rawClient1.connect();
  try {
    const count = await countMigrations(rawClient1);
    assert(count === 18, `TypeORM migrations table has 18 entries (got ${count})`);
  } finally {
    await rawClient1.end();
  }

  // ─── Stage 2: Seed valid pre-upgrade data ──────────────────────────────
  console.log('\n=== Stage 2: Seed valid pre-upgrade data ===');

  // Captured state — populated by the seed client and re-read after upgrade.
  let userId = '';
  let demoBcId = '';
  let liveBcId = '';
  let buyTradeId = '';
  let sellTradeId = '';
  let reconciliationRunId = '';
  let reconciledTradeId = '';

  let capturedTradesBefore: CapturedTradeRow[] = [];
  let capturedReconciledTradesBefore: CapturedReconciledTradeRow[] = [];
  let capturedBrokerConnectionsBefore: CapturedBrokerConnectionRow[] = [];
  let rowCountsBefore: RowCounts = {
    users: '0',
    subscription_plans: '0',
    broker_connections: '0',
    trades: '0',
    reconciliation_runs: '0',
    reconciled_trades: '0',
  };

  const seedClient = new Client({ host, port, database, user, password });
  await seedClient.connect();
  try {
    // User
    const userResult = await seedClient.query(
      `INSERT INTO identity.users (email, phone, password_hash, status, country_code, timezone, preferred_currency)
       VALUES ('scenario-f@upgrade.test', '+30000000001', 'hash_f', 'ACTIVE', 'US', 'UTC', 'USD')
       RETURNING id`,
    );
    userId = userResult.rows[0].id;
    console.log(`  user id: ${userId}`);

    // Subscription plan — NO status column exists on subscription_plans.
    // (Migration 18 did not add one; the table has is_active + code.)
    const planResult = await seedClient.query(
      `INSERT INTO subscriptions.subscription_plans (name, code, billing_interval)
       VALUES ('Pro Trader F', 'PRO-TRADER-F', 'MONTHLY')
       RETURNING id`,
    );
    const planId = planResult.rows[0].id;
    console.log(`  plan id: ${planId} (no status column on subscription_plans)`);

    // Broker connection: DEMO
    const demoBcResult = await seedClient.query(
      `INSERT INTO broker.broker_connections
         (user_id, broker_id, broker_name, account_type, status, display_name, account_id, demo_validated, live_trading_enabled)
       VALUES ($1, 'paper-broker', 'Paper Broker', 'DEMO', 'CONNECTED', 'Demo F', 'acc-f-demo', true, false)
       RETURNING id, account_type`,
      [userId],
    );
    demoBcId = demoBcResult.rows[0].id;
    assert(
      demoBcResult.rows[0].account_type === 'DEMO',
      `DEMO broker connection stored account_type='DEMO'`,
    );
    console.log(`  DEMO broker connection id: ${demoBcId}`);

    // Broker connection: LIVE
    const liveBcResult = await seedClient.query(
      `INSERT INTO broker.broker_connections
         (user_id, broker_id, broker_name, account_type, status, display_name, account_id, demo_validated, live_trading_enabled)
       VALUES ($1, 'paper-broker', 'Paper Broker', 'LIVE', 'CONNECTED', 'Live F', 'acc-f-live', true, true)
       RETURNING id, account_type`,
      [userId],
    );
    liveBcId = liveBcResult.rows[0].id;
    assert(
      liveBcResult.rows[0].account_type === 'LIVE',
      `LIVE broker connection stored account_type='LIVE'`,
    );
    console.log(`  LIVE broker connection id: ${liveBcId}`);

    // Trade: BUY
    const buyTradeResult = await seedClient.query(
      `INSERT INTO trading.trades
         (user_id, broker_connection_id, idempotency_key, instrument, direction, lot_size, status)
       VALUES ($1, $2, 'trade-f-buy-001', 'EUR/USD', 'BUY', '0.5000', 'OPEN')
       RETURNING id, direction, idempotency_key, instrument, lot_size::text`,
      [userId, demoBcId],
    );
    buyTradeId = buyTradeResult.rows[0].id;
    assert(buyTradeResult.rows[0].direction === 'BUY', `BUY trade stored direction='BUY'`);
    console.log(`  BUY trade id: ${buyTradeId}`);

    // Trade: SELL
    const sellTradeResult = await seedClient.query(
      `INSERT INTO trading.trades
         (user_id, broker_connection_id, idempotency_key, instrument, direction, lot_size, status)
       VALUES ($1, $2, 'trade-f-sell-001', 'GBP/USD', 'SELL', '0.2500', 'OPEN')
       RETURNING id, direction, idempotency_key, instrument, lot_size::text`,
      [userId, liveBcId],
    );
    sellTradeId = sellTradeResult.rows[0].id;
    assert(sellTradeResult.rows[0].direction === 'SELL', `SELL trade stored direction='SELL'`);
    console.log(`  SELL trade id: ${sellTradeId}`);

    // Broker reconciliation run
    const runResult = await seedClient.query(
      `INSERT INTO broker_reconciliation.broker_trade_reconciliation_runs
         (user_id, broker_connection_id, from_time, to_time)
       VALUES ($1, $2, NOW(), NOW())
       RETURNING id`,
      [userId, demoBcId],
    );
    reconciliationRunId = runResult.rows[0].id;
    console.log(`  reconciliation run id: ${reconciliationRunId}`);

    // Reconciled trade: direction='BUY'
    const reconciledResult = await seedClient.query(
      `INSERT INTO broker_reconciliation.broker_reconciled_trades
         (user_id, broker_connection_id, broker_provider, broker_trade_id, instrument, direction,
          volume, closed_at, realised_pnl, net_realised_pnl, currency, reconciliation_run_id)
       VALUES ($1, $2, 'TEST', 'brt-f-001', 'EUR/USD', 'BUY',
               '0.5000', NOW(), 10000, 9500, 'USD', $3)
       RETURNING id, direction, broker_trade_id, instrument, volume`,
      [userId, demoBcId, reconciliationRunId],
    );
    reconciledTradeId = reconciledResult.rows[0].id;
    assert(
      reconciledResult.rows[0].direction === 'BUY',
      `reconciled trade stored direction='BUY'`,
    );
    console.log(`  reconciled trade id: ${reconciledTradeId}`);

    // ─── Capture pre-upgrade state for exact-comparison after upgrade ────
    capturedTradesBefore = (
      await seedClient.query<CapturedTradeRow>(
        `SELECT id, direction, idempotency_key, instrument, lot_size::text
         FROM trading.trades
         WHERE idempotency_key IN ('trade-f-buy-001', 'trade-f-sell-001')
         ORDER BY idempotency_key`,
      )
    ).rows;
    assert(capturedTradesBefore.length === 2, `captured 2 trades before upgrade`);

    capturedReconciledTradesBefore = (
      await seedClient.query<CapturedReconciledTradeRow>(
        `SELECT id, direction, broker_trade_id, instrument, volume
         FROM broker_reconciliation.broker_reconciled_trades
         WHERE broker_trade_id = 'brt-f-001'`,
      )
    ).rows;
    assert(capturedReconciledTradesBefore.length === 1, `captured 1 reconciled trade before upgrade`);

    capturedBrokerConnectionsBefore = (
      await seedClient.query<CapturedBrokerConnectionRow>(
        `SELECT id, account_type, broker_id, display_name
         FROM broker.broker_connections
         WHERE display_name IN ('Demo F', 'Live F')
         ORDER BY display_name`,
      )
    ).rows;
    assert(capturedBrokerConnectionsBefore.length === 2, `captured 2 broker connections before upgrade`);

    rowCountsBefore = (
      await seedClient.query<RowCounts>(
        `SELECT
           (SELECT COUNT(*)::text FROM identity.users) AS users,
           (SELECT COUNT(*)::text FROM subscriptions.subscription_plans) AS subscription_plans,
           (SELECT COUNT(*)::text FROM broker.broker_connections) AS broker_connections,
           (SELECT COUNT(*)::text FROM trading.trades) AS trades,
           (SELECT COUNT(*)::text FROM broker_reconciliation.broker_trade_reconciliation_runs) AS reconciliation_runs,
           (SELECT COUNT(*)::text FROM broker_reconciliation.broker_reconciled_trades) AS reconciled_trades`,
      )
    ).rows[0];
    console.log(`  row counts before: ${JSON.stringify(rowCountsBefore)}`);

    // Sanity: no Phase 2A CHECK constraints exist yet
    for (const name of [
      'chk_trades_direction',
      'chk_broker_reconciled_trades_direction',
      'chk_broker_connections_account_type',
    ]) {
      const c = await getCheckConstraint(seedClient, name);
      assert(c === null, `CHECK constraint ${name} does NOT exist before upgrade`);
    }
  } finally {
    await seedClient.end();
  }

  // ─── Stage 3: Apply Phase 2A and later migrations via real TypeORM ────
  console.log('\n=== Stage 3: Apply pending migrations via TypeORM runMigrations() ===');

  const ds2 = createDataSource(host, port, database, user, password, allMigrationClasses);
  await ds2.initialize();

  const hasPending = await ds2.showMigrations();
  assert(
    hasPending === true,
    `TypeORM detects ${pendingFiles.length} pending migration(s), beginning with Phase 2A`,
  );

  const appliedMigrations = await ds2.runMigrations();
  assert(
    appliedMigrations.length === pendingFiles.length,
    `TypeORM applied all ${pendingFiles.length} pending migration(s)`,
  );
  console.log(`  TypeORM runMigrations() completed for all ${allFiles.length} migrations`);
  await ds2.destroy();

  // ─── Stage 4: Verify migration count, data preservation, constraint catalog
  console.log('\n=== Stage 4: Verify migration count, data preservation, constraint catalog ===');

  const verifyClient = new Client({ host, port, database, user, password });
  await verifyClient.connect();
  try {
    // 4a. Every discovered migration has a tracking record
    const migrationCount = await countMigrations(verifyClient);
    assert(
      migrationCount === allFiles.length,
      `TypeORM migrations table has ${allFiles.length} entries (got ${migrationCount})`,
    );

    // 4b. Row counts unchanged
    const rowCountsAfter = (
      await verifyClient.query<RowCounts>(
        `SELECT
           (SELECT COUNT(*)::text FROM identity.users) AS users,
           (SELECT COUNT(*)::text FROM subscriptions.subscription_plans) AS subscription_plans,
           (SELECT COUNT(*)::text FROM broker.broker_connections) AS broker_connections,
           (SELECT COUNT(*)::text FROM trading.trades) AS trades,
           (SELECT COUNT(*)::text FROM broker_reconciliation.broker_trade_reconciliation_runs) AS reconciliation_runs,
           (SELECT COUNT(*)::text FROM broker_reconciliation.broker_reconciled_trades) AS reconciled_trades`,
      )
    ).rows[0];
    assert(rowCountsAfter.users === rowCountsBefore.users, 'user count unchanged');
    assert(
      rowCountsAfter.subscription_plans === rowCountsBefore.subscription_plans,
      'subscription_plans count unchanged',
    );
    assert(
      rowCountsAfter.broker_connections === rowCountsBefore.broker_connections,
      'broker_connections count unchanged',
    );
    assert(rowCountsAfter.trades === rowCountsBefore.trades, 'trades count unchanged');
    assert(
      rowCountsAfter.reconciliation_runs === rowCountsBefore.reconciliation_runs,
      'reconciliation_runs count unchanged',
    );
    assert(
      rowCountsAfter.reconciled_trades === rowCountsBefore.reconciled_trades,
      'reconciled_trades count unchanged',
    );

    // 4c. Existing trade rows and values unchanged (exact string comparison)
    const capturedTradesAfter = (
      await verifyClient.query<CapturedTradeRow>(
        `SELECT id, direction, idempotency_key, instrument, lot_size::text
         FROM trading.trades
         WHERE idempotency_key IN ('trade-f-buy-001', 'trade-f-sell-001')
         ORDER BY idempotency_key`,
      )
    ).rows;
    assert(capturedTradesAfter.length === 2, '2 trades still present after upgrade');
    for (let i = 0; i < capturedTradesBefore.length; i++) {
      const before = capturedTradesBefore[i];
      const after = capturedTradesAfter[i];
      assert(after.id === before.id, `trade ${i} id unchanged (${before.id})`);
      assert(after.direction === before.direction, `trade ${i} direction unchanged (${before.direction})`);
      assert(after.idempotency_key === before.idempotency_key, `trade ${i} idempotency_key unchanged`);
      assert(after.instrument === before.instrument, `trade ${i} instrument unchanged`);
      assert(after.lot_size === before.lot_size, `trade ${i} lot_size unchanged (${before.lot_size})`);
    }

    // 4d. Existing reconciled trade row unchanged
    const capturedReconciledTradesAfter = (
      await verifyClient.query<CapturedReconciledTradeRow>(
        `SELECT id, direction, broker_trade_id, instrument, volume
         FROM broker_reconciliation.broker_reconciled_trades
         WHERE broker_trade_id = 'brt-f-001'`,
      )
    ).rows;
    assert(capturedReconciledTradesAfter.length === 1, '1 reconciled trade still present after upgrade');
    const rtBefore = capturedReconciledTradesBefore[0];
    const rtAfter = capturedReconciledTradesAfter[0];
    assert(rtAfter.id === rtBefore.id, `reconciled trade id unchanged (${rtBefore.id})`);
    assert(rtAfter.direction === rtBefore.direction, `reconciled trade direction unchanged (${rtBefore.direction})`);
    assert(rtAfter.broker_trade_id === rtBefore.broker_trade_id, `reconciled trade broker_trade_id unchanged`);
    assert(rtAfter.instrument === rtBefore.instrument, `reconciled trade instrument unchanged`);
    assert(rtAfter.volume === rtBefore.volume, `reconciled trade volume unchanged`);

    // 4e. Existing broker connection rows and account_type unchanged
    const capturedBrokerConnectionsAfter = (
      await verifyClient.query<CapturedBrokerConnectionRow>(
        `SELECT id, account_type, broker_id, display_name
         FROM broker.broker_connections
         WHERE display_name IN ('Demo F', 'Live F')
         ORDER BY display_name`,
      )
    ).rows;
    assert(capturedBrokerConnectionsAfter.length === 2, '2 broker connections still present after upgrade');
    for (let i = 0; i < capturedBrokerConnectionsBefore.length; i++) {
      const before = capturedBrokerConnectionsBefore[i];
      const after = capturedBrokerConnectionsAfter[i];
      assert(after.id === before.id, `broker connection ${i} id unchanged (${before.id})`);
      assert(
        after.account_type === before.account_type,
        `broker connection ${i} account_type unchanged (${before.account_type})`,
      );
      assert(after.broker_id === before.broker_id, `broker connection ${i} broker_id unchanged`);
      assert(after.display_name === before.display_name, `broker connection ${i} display_name unchanged`);
    }

    // 4f. BrokerConnection entity/schema parity for OAuth refresh fencing.
    const leaseOwnerColumn = await verifyClient.query(
      `SELECT data_type, character_maximum_length, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'broker'
         AND table_name = 'broker_connections'
         AND column_name = 'credential_refresh_lease_owner'`,
    );
    assert(
      leaseOwnerColumn.rows.length === 1,
      'broker_connections.credential_refresh_lease_owner exists after upgrade',
    );
    if (leaseOwnerColumn.rows.length === 1) {
      const col = leaseOwnerColumn.rows[0];
      assert(col.data_type === 'character varying', 'credential_refresh_lease_owner is varchar');
      assert(
        Number(col.character_maximum_length) === 64,
        'credential_refresh_lease_owner has length 64',
      );
      assert(col.is_nullable === 'YES', 'credential_refresh_lease_owner remains nullable');
    }

    // 4g. Three CHECK constraints exist via pg_constraint + semantic validation
    // PostgreSQL canonicalizes CHECK expressions (e.g., IN → ANY(ARRAY[])),
    // so we verify semantic components rather than exact SQL text.
    const chk1 = await getCheckConstraint(verifyClient, 'chk_trades_direction');
    assert(chk1 !== null, 'chk_trades_direction exists in pg_constraint');
    if (chk1) {
      assert(chk1.contype === 'c', `chk_trades_direction is a CHECK constraint (contype='c')`);
      assert(chk1.convalidated === true, `chk_trades_direction is validated (convalidated=true)`);
      assert(chk1.definition.includes('direction'), `chk_trades_direction references 'direction' column (got ${chk1.definition})`);
      assert(chk1.definition.includes("'BUY'"), `chk_trades_direction contains 'BUY' value (got ${chk1.definition})`);
      assert(chk1.definition.includes("'SELL'"), `chk_trades_direction contains 'SELL' value (got ${chk1.definition})`);
    }

    const chk2 = await getCheckConstraint(verifyClient, 'chk_broker_reconciled_trades_direction');
    assert(chk2 !== null, 'chk_broker_reconciled_trades_direction exists in pg_constraint');
    if (chk2) {
      assert(chk2.contype === 'c', `chk_broker_reconciled_trades_direction is a CHECK constraint (contype='c')`);
      assert(chk2.convalidated === true, `chk_broker_reconciled_trades_direction is validated`);
      assert(chk2.definition.includes('direction'), `chk_broker_reconciled_trades_direction references 'direction' column (got ${chk2.definition})`);
      assert(chk2.definition.includes("'BUY'"), `chk_broker_reconciled_trades_direction contains 'BUY' value (got ${chk2.definition})`);
      assert(chk2.definition.includes("'SELL'"), `chk_broker_reconciled_trades_direction contains 'SELL' value (got ${chk2.definition})`);
    }

    const chk3 = await getCheckConstraint(verifyClient, 'chk_broker_connections_account_type');
    assert(chk3 !== null, 'chk_broker_connections_account_type exists in pg_constraint');
    if (chk3) {
      assert(chk3.contype === 'c', `chk_broker_connections_account_type is a CHECK constraint (contype='c')`);
      assert(chk3.convalidated === true, `chk_broker_connections_account_type is validated`);
      assert(chk3.definition.includes('account_type'), `chk_broker_connections_account_type references 'account_type' column (got ${chk3.definition})`);
      assert(chk3.definition.includes("'DEMO'"), `chk_broker_connections_account_type contains 'DEMO' value (got ${chk3.definition})`);
      assert(chk3.definition.includes("'LIVE'"), `chk_broker_connections_account_type contains 'LIVE' value (got ${chk3.definition})`);
    }

    // ─── Stage 5: Valid-value acceptance tests ──────────────────────────
    console.log('\n=== Stage 5: Valid-value acceptance tests (BUY, SELL, DEMO, LIVE) ===');

    // New BUY trade
    const validBuy = await verifyClient.query(
      `INSERT INTO trading.trades
         (user_id, broker_connection_id, idempotency_key, instrument, direction, lot_size, status)
       VALUES ($1, $2, 'trade-f-valid-buy', 'USD/JPY', 'BUY', '0.1000', 'PENDING')
       RETURNING direction`,
      [userId, demoBcId],
    );
    assert(validBuy.rows[0].direction === 'BUY', `new trade with direction='BUY' accepted`);

    // New SELL trade
    const validSell = await verifyClient.query(
      `INSERT INTO trading.trades
         (user_id, broker_connection_id, idempotency_key, instrument, direction, lot_size, status)
       VALUES ($1, $2, 'trade-f-valid-sell', 'USD/JPY', 'SELL', '0.1000', 'PENDING')
       RETURNING direction`,
      [userId, liveBcId],
    );
    assert(validSell.rows[0].direction === 'SELL', `new trade with direction='SELL' accepted`);

    // New DEMO broker connection
    const validDemo = await verifyClient.query(
      `INSERT INTO broker.broker_connections
         (user_id, broker_id, broker_name, account_type, status, display_name)
       VALUES ($1, 'paper-broker', 'Paper Broker', 'DEMO', 'CONNECTED', 'Valid Demo F')
       RETURNING account_type`,
      [userId],
    );
    assert(validDemo.rows[0].account_type === 'DEMO', `new broker_connection with account_type='DEMO' accepted`);

    // New LIVE broker connection
    const validLive = await verifyClient.query(
      `INSERT INTO broker.broker_connections
         (user_id, broker_id, broker_name, account_type, status, display_name)
       VALUES ($1, 'paper-broker', 'Paper Broker', 'LIVE', 'CONNECTED', 'Valid Live F')
       RETURNING account_type`,
      [userId],
    );
    assert(validLive.rows[0].account_type === 'LIVE', `new broker_connection with account_type='LIVE' accepted`);

    // New BUY + SELL reconciled trades (closed-domain for reconciled_trades.direction too)
    const validReconBuy = await verifyClient.query(
      `INSERT INTO broker_reconciliation.broker_reconciled_trades
         (user_id, broker_connection_id, broker_provider, broker_trade_id, instrument, direction,
          volume, closed_at, realised_pnl, net_realised_pnl, currency)
       VALUES ($1, $2, 'TEST', 'brt-f-valid-buy', 'EUR/USD', 'BUY', '0.1000', NOW(), 100, 100, 'USD')
       RETURNING direction`,
      [userId, demoBcId],
    );
    assert(validReconBuy.rows[0].direction === 'BUY', `new reconciled trade direction='BUY' accepted`);

    const validReconSell = await verifyClient.query(
      `INSERT INTO broker_reconciliation.broker_reconciled_trades
         (user_id, broker_connection_id, broker_provider, broker_trade_id, instrument, direction,
          volume, closed_at, realised_pnl, net_realised_pnl, currency)
       VALUES ($1, $2, 'TEST', 'brt-f-valid-sell', 'EUR/USD', 'SELL', '0.1000', NOW(), -100, -100, 'USD')
       RETURNING direction`,
      [userId, liveBcId],
    );
    assert(validReconSell.rows[0].direction === 'SELL', `new reconciled trade direction='SELL' accepted`);

    // ─── Stage 6: Invalid-value rejection tests ─────────────────────────
    console.log('\n=== Stage 6: Invalid-value rejection tests (SQLSTATE 23514) ===');

    // trades.direction = 'HOLD'
    try {
      await verifyClient.query(
        `INSERT INTO trading.trades
           (user_id, broker_connection_id, idempotency_key, instrument, direction, lot_size, status)
         VALUES ($1, $2, 'trade-f-invalid-hold', 'EUR/USD', 'HOLD', '0.1000', 'PENDING')`,
        [userId, demoBcId],
      );
      throw new Error('trades.direction=HOLD: INSERT should have failed');
    } catch (err) {
      const e = err as PgError;
      assert(
        e.code === '23514',
        `trades.direction='HOLD' rejected with SQLSTATE 23514 (got ${e.code})`,
      );
      assert(
        e.constraint === 'chk_trades_direction',
        `trades.direction='HOLD' rejected by constraint chk_trades_direction (got ${e.constraint})`,
      );
    }

    // broker_reconciled_trades.direction = 'HOLD'
    try {
      await verifyClient.query(
        `INSERT INTO broker_reconciliation.broker_reconciled_trades
           (user_id, broker_connection_id, broker_provider, broker_trade_id, instrument, direction,
            volume, closed_at, realised_pnl, net_realised_pnl, currency)
         VALUES ($1, $2, 'TEST', 'brt-f-invalid-hold', 'EUR/USD', 'HOLD', '0.1000', NOW(), 0, 0, 'USD')`,
        [userId, demoBcId],
      );
      throw new Error('reconciled_trades.direction=HOLD: INSERT should have failed');
    } catch (err) {
      const e = err as PgError;
      assert(
        e.code === '23514',
        `broker_reconciled_trades.direction='HOLD' rejected with SQLSTATE 23514 (got ${e.code})`,
      );
      assert(
        e.constraint === 'chk_broker_reconciled_trades_direction',
        `broker_reconciled_trades.direction='HOLD' rejected by chk_broker_reconciled_trades_direction (got ${e.constraint})`,
      );
    }

    // broker_connections.account_type = 'PAPER'
    try {
      await verifyClient.query(
        `INSERT INTO broker.broker_connections
           (user_id, broker_id, broker_name, account_type, status, display_name)
         VALUES ($1, 'paper-broker', 'Paper Broker', 'PAPER', 'CONNECTED', 'Invalid Paper F')`,
        [userId],
      );
      throw new Error('broker_connections.account_type=PAPER: INSERT should have failed');
    } catch (err) {
      const e = err as PgError;
      assert(
        e.code === '23514',
        `broker_connections.account_type='PAPER' rejected with SQLSTATE 23514 (got ${e.code})`,
      );
      assert(
        e.constraint === 'chk_broker_connections_account_type',
        `broker_connections.account_type='PAPER' rejected by chk_broker_connections_account_type (got ${e.constraint})`,
      );
    }
  } finally {
    await verifyClient.end();
  }

  // ─── Stage 7: Fail-closed test (separate disposable DB) ───────────────
  console.log('\n=== Stage 7: Fail-closed test (separate disposable DB) ===');

  // Create (or recreate) the orphan DB. We connect to the main DB to issue
  // the DROP/CREATE — you cannot DROP a database you are connected to.
  const adminClient = new Client({ host, port, database, user, password });
  await adminClient.connect();
  try {
    await adminClient.query(`DROP DATABASE IF EXISTS ${ORPHAN_DB_NAME}`);
    await adminClient.query(`CREATE DATABASE ${ORPHAN_DB_NAME}`);
    console.log(`  created disposable DB: ${ORPHAN_DB_NAME}`);
  } finally {
    await adminClient.end();
  }

  // Apply original 18 migrations via TypeORM to the orphan DB
  const orphanDs1 = createDataSource(host, port, ORPHAN_DB_NAME, user, password, originalMigrationClasses);
  await orphanDs1.initialize();
  await orphanDs1.runMigrations();
  await orphanDs1.destroy();

  // Seed an invalid trade (direction='HOLD') in the orphan DB — this is
  // legal under the pre-Phase-2A schema (direction is a bare varchar(10)).
  const orphanSeedClient = new Client({ host, port, database: ORPHAN_DB_NAME, user, password });
  await orphanSeedClient.connect();
  try {
    const orphanUser = await orphanSeedClient.query(
      `INSERT INTO identity.users (email, phone, password_hash, status, country_code, timezone, preferred_currency)
       VALUES ('scenario-f-orphan@test.local', '+30000000099', 'hash_o', 'ACTIVE', 'US', 'UTC', 'USD')
       RETURNING id`,
    );
    const orphanUserId = orphanUser.rows[0].id;

    const orphanBc = await orphanSeedClient.query(
      `INSERT INTO broker.broker_connections
         (user_id, broker_id, broker_name, account_type, status, display_name)
       VALUES ($1, 'paper-broker', 'Paper Broker', 'DEMO', 'CONNECTED', 'Orphan F')
       RETURNING id`,
      [orphanUserId],
    );
    const orphanBcId = orphanBc.rows[0].id;

    await orphanSeedClient.query(
      `INSERT INTO trading.trades
         (user_id, broker_connection_id, idempotency_key, instrument, direction, lot_size, status)
       VALUES ($1, $2, 'trade-f-orphan-hold', 'EUR/USD', 'HOLD', '0.1000', 'OPEN')`,
      [orphanUserId, orphanBcId],
    );
    console.log('  inserted orphan trade with direction=HOLD (legal under 18-migration schema)');

    // Capture the orphan row exactly
    const orphanRowBefore = (
      await orphanSeedClient.query(
        `SELECT id, direction, idempotency_key::text AS idempotency_key
         FROM trading.trades
         WHERE idempotency_key = 'trade-f-orphan-hold'`,
      )
    ).rows[0];
    assert(
      orphanRowBefore.direction === 'HOLD',
      `orphan trade direction is 'HOLD' before migration attempt`,
    );

    // Attempt to run every pending migration via TypeORM. Phase 2A is first,
    // so its preflight must detect the invalid 'HOLD' value and throw before
    // any later additive migration can run.
    const orphanDs2 = createDataSource(host, port, ORPHAN_DB_NAME, user, password, allMigrationClasses);
    await orphanDs2.initialize();
    try {
      await orphanDs2.runMigrations();
      throw new Error('Orphan test: runMigrations should have FAILED on invalid HOLD trade');
    } catch (err) {
      const e = err as PgError;
      const msg = e.message ?? '';
      // The migration throws a JS Error from its preflight block
      // (Cannot add chk_trades_direction: existing invalid values found).
      // TypeORM wraps and rethrows. We accept either a clean preflight
      // diagnostic or a PostgreSQL check-violation if the ALTER beat the
      // preflight — both prove fail-closed behaviour.
      const isPreflightDiagnostic = msg.includes('chk_trades_direction') || msg.includes('invalid values');
      const isCheckViolation = e.code === '23514' && e.constraint === 'chk_trades_direction';
      assert(
        isPreflightDiagnostic || isCheckViolation,
        `migration fails closed on invalid HOLD trade (code=${e.code}, constraint=${e.constraint}, msg=${msg.substring(0, 200)})`,
      );
      console.log(`  ✓ migration correctly rejected invalid HOLD trade (fail-closed)`);
    }
    await orphanDs2.destroy();

    // Verify the 'HOLD' row still exists unchanged (not silently deleted/modified)
    const orphanRowAfter = (
      await orphanSeedClient.query(
        `SELECT id, direction, idempotency_key::text AS idempotency_key
         FROM trading.trades
         WHERE idempotency_key = 'trade-f-orphan-hold'`,
      )
    ).rows[0];
    assert(
      orphanRowAfter !== undefined,
      'orphan HOLD trade row still exists after failed migration (not silently deleted)',
    );
    assert(
      orphanRowAfter.direction === 'HOLD',
      `orphan HOLD trade direction unchanged after failed migration (got ${orphanRowAfter.direction})`,
    );
    assert(
      orphanRowAfter.id === orphanRowBefore.id,
      'orphan HOLD trade id unchanged after failed migration',
    );

    // Verify Phase 2A and every later migration are NOT recorded
    const orphanCount = await countMigrations(orphanSeedClient);
    assert(
      orphanCount === 18,
      `no pending migration recorded in orphan DB (migrations table has ${orphanCount} entries, expected 18)`,
    );

    // Verify the CHECK constraint was NOT created (rollback worked)
    const orphanChk = await getCheckConstraint(orphanSeedClient, 'chk_trades_direction');
    assert(
      orphanChk === null,
      'chk_trades_direction NOT created in orphan DB (migration transaction rolled back)',
    );
  } finally {
    await orphanSeedClient.end();
  }

  console.log('\n=== ALL SCENARIO F ASSERTIONS PASSED ===');
}

main().catch((err) => {
  console.error('\n=== SCENARIO F FAILED ===');
  console.error(err);
  process.exit(1);
});
