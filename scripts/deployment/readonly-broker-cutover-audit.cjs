#!/usr/bin/env node
'use strict';

// Read-only broker cutover audit. It cannot place/cancel trades or write to the
// database. Database state is NOT a substitute for broker-side position checks.
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (process.argv.length !== 3) {
    console.error('Usage: readonly-broker-cutover-audit.cjs /absolute/candidate/api');
    process.exitCode = 2;
    return;
  }
  const root = '/home/lightworld/runtime/irexpro/candidates';
  const api = fs.realpathSync(process.argv[2]);
  if (!api.startsWith(root + '/') || !api.endsWith('/api')) {
    console.error('HOLD: API must be the verified release candidate');
    process.exitCode = 2;
    return;
  }
  const envPath = path.join(api, '.env');
  const expected = '/home/lightworld/runtime/irexpro/shared/env/api.env';
  if (!fs.lstatSync(envPath).isSymbolicLink() ||
      fs.realpathSync(envPath) !== expected) {
    console.error('HOLD: candidate API environment is not from protected shared storage');
    process.exitCode = 2;
    return;
  }
  const dotenv = require(path.join(api, 'node_modules', 'dotenv'));
  const { Client } = require(path.join(api, 'node_modules', 'pg'));
  const env = dotenv.parse(fs.readFileSync(envPath));
  const options = {
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || '5432'),
    database: env.DB_NAME || 'irexpro_dev',
    user: env.DB_USER || 'irexpro',
    password: env.DB_PASSWORD,
    connectionTimeoutMillis: 6000,
    query_timeout: 8000,
  };
  if (env.DB_SSL === 'true') options.ssl = { rejectUnauthorized: false };
  const db = new Client(options);
  try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const trade = (await db.query(
      'SELECT COUNT(*) FILTER (WHERE closed_at IS NULL)::int AS unclosed, ' +
      'COUNT(*) FILTER (WHERE status::text <> $1)::int AS nonclosed FROM trading.trades',
      ['CLOSED'],
    )).rows[0];
    const orders = (await db.query(
      'SELECT COUNT(*) FILTER (WHERE status::text = $1)::int AS pending, ' +
      'COUNT(*) FILTER (WHERE status::text = $2)::int AS acknowledged, ' +
      'MAX(updated_at) FILTER (WHERE status::text = $1)::text AS newest_pending_update ' +
      'FROM trading.orders',
      ['RECONCILIATION_PENDING', 'ACKNOWLEDGED'],
    )).rows[0];
    const broker = (await db.query(
      'SELECT COUNT(*)::int AS runs, MAX(updated_at)::text AS last_run ' +
      'FROM broker_reconciliation.broker_trade_reconciliation_runs',
    )).rows[0];
    await db.query('ROLLBACK');
    console.log('READ-ONLY CUTOVER AUDIT (counts only; no broker orders sent)');
    console.log('Ledger nonclosed trades:', trade.nonclosed, 'trades lacking close timestamp:', trade.unclosed);
    console.log('Orders pending reconciliation:', orders.pending, 'acknowledged:', orders.acknowledged);
    console.log('Broker trade reconciliation run records:', broker.runs);
    if (Number(trade.nonclosed) || Number(trade.unclosed) ||
        Number(orders.pending) || Number(orders.acknowledged) || !Number(broker.runs)) {
      console.log('HOLD: trading ledger is not fully reconciled; broker-side positions require independent verification.');
      process.exitCode = 10;
    } else {
      console.log('Ledger counts clear, but separate live broker-side reconciliation is still mandatory.');
    }
  } finally {
    try { await db.end(); } catch { /* close best-effort */ }
  }
}

main().catch(err => {
  console.error('HOLD: read-only cutover audit unavailable:', err.code || err.name);
  process.exitCode = 2;
});
