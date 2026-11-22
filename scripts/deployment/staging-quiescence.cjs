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
    const statement = [
      'SELECT',
      "(SELECT COUNT(*)::int FROM trading.trading_sessions WHERE status = 'ACTIVE') AS active_sessions,",
      "(SELECT COUNT(*)::int FROM trading.trades WHERE status IN ('PENDING','OPEN','RECONCILIATION_PENDING')) AS open_or_pending_trades,",
      "(SELECT COUNT(*)::int FROM trading.orders WHERE status IN ('DISPATCH_COMMITTED','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED')) AS inflight_orders,",
      "(SELECT COUNT(*)::int FROM trading.orders WHERE status = 'RECONCILIATION_PENDING' AND updated_at > NOW() - INTERVAL '1 hour') AS recent_uncertain_orders",
    ].join(' ');
    const rows = await db.query(statement);
    await db.query('ROLLBACK');
    const row = rows.rows[0];
    if (!row) throw new Error('EMPTY_DEPLOY_GUARD_RESULT');
    return {
      activeSessions: row.active_sessions,
      openOrPendingTrades: row.open_or_pending_trades,
      inflightOrders: row.inflight_orders,
      recentUncertainOrders: row.recent_uncertain_orders,
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
    console.log('Staging release guard PASS: no active session, position or recent uncertain broker order.');
  } catch (error) {
    // Do not log raw DB errors or credentials.
    const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{2,12}$/.test(error.code)
      ? error.code : 'CHECK_FAILED';
    console.error('DEPLOY HOLD: read-only broker execution check unavailable (' + code + ').');
    process.exitCode = 13;
  }
}

if (require.main === module) {
  void main();
}
module.exports = { classify, readCounts };
