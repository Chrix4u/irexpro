#!/usr/bin/env node
'use strict';

/**
 * Read-only release guard. Fail closed before touching the staged release
 * when a trading session, pending position, or recent broker uncertainty exists.
 * This is not a substitute for an atomic trading maintenance lock.
 */
const fs = require('node:fs');
const path = require('node:path');

function classify(counts) {
  const names = ['activeSessions', 'openOrPendingTrades', 'inflightOrders', 'recentUncertainOrders'];
  if (!counts || names.some((name) => !Number.isSafeInteger(counts[name]) || counts[name] < 0)) {
    throw new Error('INVALID_READONLY_COUNTS');
  }
  return names.filter((name) => counts[name] > 0);
}

async function readCounts() {
  const root = process.env.STAGING_ROOT || path.resolve(__dirname, '../..');
  const apiDir = path.join(root, 'apps/api');
  const env = require(path.join(apiDir, 'node_modules/dotenv')).parse(
    fs.readFileSync(path.join(apiDir, '.env')),
  );
  const { Client } = require(path.join(apiDir, 'node_modules/pg'));
  const db = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 6000,
    application_name: 'irexpro_staging_readonly_release_guard',
  });
  try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    // Historical order journal rows can outlive already-CLOSED DEMO trades.
    // Treat them as deploy-only artifacts ONLY when a very recent, successful
    // provider reconciliation for that SAME connection observes zero working
    // orders AND zero open positions. This NEVER edits/resolves the journal,
    // does not certify order history, and does not authorize LIVE execution.
    // Missing/stale/failed broker snapshots continue to HOLD deployments.
    const statement = `
      WITH latest_provider AS (
        SELECT DISTINCT ON (broker_connection_id)
          broker_connection_id, status, completed_at,
          provider_orders_seen, provider_positions_seen,
          account_snapshot_compared, errors
        FROM reconciliation.runs
        ORDER BY broker_connection_id, created_at DESC
      ), unconfirmed AS (
        SELECT o.status,
          (b.account_type = 'DEMO'
           AND o.status IN ('ACKNOWLEDGED','RECONCILIATION_PENDING')
           AND o.provider_order_id IS NULL
           AND o.updated_at < NOW() - INTERVAL '24 hours'
           AND t.status = 'CLOSED' AND t.closed_at IS NOT NULL
           AND t.closed_at < NOW() - INTERVAL '24 hours'
           AND p.status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
           AND p.completed_at > NOW() - INTERVAL '3 minutes'
           AND p.errors = 0 AND p.account_snapshot_compared > 0
           AND p.provider_orders_seen = 0 AND p.provider_positions_seen = 0
          ) IS TRUE AS historically_closed_provider_clear
        FROM trading.orders o
        LEFT JOIN trading.trades t ON t.id = o.trade_id
        LEFT JOIN broker.broker_connections b ON b.id = o.broker_connection_id
        LEFT JOIN latest_provider p ON p.broker_connection_id = o.broker_connection_id
        WHERE o.status IN ('DISPATCH_COMMITTED','SUBMITTED','ACKNOWLEDGED',
                           'PARTIALLY_FILLED','RECONCILIATION_PENDING')
      ) SELECT
        (SELECT COUNT(*)::int FROM trading.trading_sessions WHERE status = 'ACTIVE') AS active_sessions,
        (SELECT COUNT(*)::int FROM trading.trades
          WHERE status IN ('PENDING','OPEN','RECONCILIATION_PENDING')) AS open_or_pending_trades,
        (SELECT COUNT(*)::int FROM unconfirmed
          WHERE status IN ('DISPATCH_COMMITTED','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED')
          AND NOT historically_closed_provider_clear) AS inflight_orders,
        (SELECT COUNT(*)::int FROM unconfirmed
          WHERE status = 'RECONCILIATION_PENDING'
          AND NOT historically_closed_provider_clear) AS recent_uncertain_orders,
        (SELECT COUNT(*)::int FROM unconfirmed WHERE historically_closed_provider_clear)
          AS historical_orders_not_reconciled
    `;
    const rows = await db.query(statement);
    await db.query('ROLLBACK');
    const row = rows.rows[0];
    if (!row) throw new Error('EMPTY_DEPLOY_GUARD_RESULT');
    return {
      activeSessions: row.active_sessions,
      openOrPendingTrades: row.open_or_pending_trades,
      inflightOrders: row.inflight_orders,
      recentUncertainOrders: row.recent_uncertain_orders,
      historicalOrdersNotReconciled: row.historical_orders_not_reconciled,
    };
  } finally {
    await db.end().catch(() => {});
  }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const noBlockers = {activeSessions: 0, openOrPendingTrades: 0, inflightOrders: 0, recentUncertainOrders: 0};
    if (classify(noBlockers).length) throw new Error('SELFTEST_ZERO');
    for (const key of Object.keys(noBlockers)) {
      if (classify({...noBlockers, [key]: 1}).join() !== key) throw new Error('SELFTEST_BLOCKER');
    }
    for (const bad of [-1, NaN, null, undefined, '0']) {
      try {
        classify({...noBlockers, activeSessions: bad});
        throw new Error('SELFTEST_INVALID_ACCEPTED');
      } catch (error) {
        if (error.message === 'SELFTEST_INVALID_ACCEPTED') throw error;
      }
    }
    console.log('staging-quiescence self-test OK');
    return;
  }
  try {
    const blockers = classify(await readCounts());
    if (blockers.length) {
      console.error('DEPLOY HOLD: trading not quiescent (' + blockers.join(', ') +
        '). Stop the AI trader and reconcile exposure before a restart.');
      process.exitCode = 12;
      return;
    }
    console.log('Staging release guard PASS: no active session or unproven current broker exposure. Historical closed DEMO journal rows, if any, remain UNRECONCILED; LIVE execution is NOT certified.');
  } catch (error) {
    // Do not log raw DB errors or credentials.
    const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{2,12}$/.test(error.code)
      ? error.code : 'CHECK_FAILED';
    console.error('DEPLOY HOLD: read-only broker execution check unavailable (' + code + ').');
    process.exitCode = 13;
  }
}

// Deployment boots candidate source via git show piped to node stdin.
// In Node stdin mode require.main is undefined; testing only that flag
// would silently SKIP the guard. Importers must not execute it.
if (require.main === module || (module.id === '[stdin]' && process.argv[1] === '-')) {
  void main();
}
module.exports = { classify, readCounts };
