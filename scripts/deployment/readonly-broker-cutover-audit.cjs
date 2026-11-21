#!/usr/bin/env node
'use strict';

// Read-only provider-state cutover audit. Never starts broker adapters or
// schedulers; never sends orders or updates database rows. All output is
// aggregate: no credentials, user IDs, provider tickets or account IDs.
const fs = require('node:fs');
const path = require('node:path');
const { evaluateReconciliationEvidence } = require('./reconciliation-cutover-policy.cjs');

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
    query_timeout: 8500,
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
    const orders = (await db.query(`
      SELECT COALESCE(c.account_type,'UNKNOWN')::text mode,
        COALESCE(c.broker_id,'UNKNOWN')::text provider,
        o.status::text status, COUNT(*)::int n,
        COUNT(*) FILTER (WHERE t.status::text='CLOSED' AND t.closed_at IS NOT NULL)::int linked_closed,
        COUNT(*) FILTER (WHERE o.provider_order_id IS NOT NULL)::int provider_order_refs
      FROM trading.orders o
      LEFT JOIN broker.broker_connections c ON c.id=o.broker_connection_id
      LEFT JOIN trading.trades t ON t.id=o.trade_id
      WHERE o.status::text IN ('RECONCILIATION_PENDING','ACKNOWLEDGED')
      GROUP BY 1,2,3 ORDER BY n DESC
    `)).rows;
    const stateRuns = (await db.query(`
      WITH candidates AS (
        SELECT DISTINCT broker_connection_id FROM trading.orders
        WHERE status::text IN ('RECONCILIATION_PENDING','ACKNOWLEDGED')
      )
      SELECT COALESCE(c.account_type,'UNKNOWN')::text mode,
        COALESCE(c.broker_id,'UNKNOWN')::text provider,
        r.status::text status, r.created_at last_run_at,
        r.provider_positions_seen, r.discrepancies_open, r.errors
      FROM candidates a
      JOIN broker.broker_connections c ON c.id=a.broker_connection_id
      LEFT JOIN LATERAL (
        SELECT status,created_at,provider_positions_seen,discrepancies_open,errors
        FROM reconciliation.runs
        WHERE broker_connection_id=a.broker_connection_id
        ORDER BY created_at DESC LIMIT 1
      ) r ON TRUE
    `)).rows;
    const discrepancies = (await db.query(`
      SELECT COALESCE(c.account_type,'UNKNOWN')::text mode,
        COALESCE(c.broker_id,'UNKNOWN')::text provider,
        d.discrepancy_type::text type,COUNT(*)::int n
      FROM reconciliation.discrepancies d
      LEFT JOIN broker.broker_connections c ON c.id=d.broker_connection_id
      WHERE d.status::text='OPEN'
      GROUP BY 1,2,3 ORDER BY n DESC
    `)).rows;
    await db.query('ROLLBACK');

    const result = evaluateReconciliationEvidence(
      { trade, orders, stateRuns, discrepancies }, new Date(),
    );
    console.log('READ-ONLY CUTOVER AUDIT: DEMO and LIVE connections grouped, no broker calls');
    console.log('Summary:', JSON.stringify(result.summary));
    console.log('Unresolved orders grouped by provider and account type:');
    for (const row of orders) {
      console.log(' ', row.mode, row.provider, row.status,
        'count=' + row.n, 'linked-to-closed=' + row.linked_closed,
        'provider-order-ref=' + row.provider_order_refs);
    }
    console.log('Latest automated state sweeps for unresolved-order connections:');
    for (const row of stateRuns) {
      const ageMinutes = row.last_run_at ?
        Math.round((Date.now() - new Date(row.last_run_at).getTime()) / 60_000) : null;
      console.log(' ', row.mode, row.provider, row.status || 'NO_RUN',
        'age-minutes=' + ageMinutes, 'provider-positions-seen=' + row.provider_positions_seen,
        'open-discrepancies=' + row.discrepancies_open);
    }
    console.log('Open discrepancy types (aggregate):');
    for (const row of discrepancies) console.log(' ', row.mode, row.provider, row.type, row.n);
    if (!result.passed) {
      console.log('HOLD: internal trading state is not reconciled.');
      for (const issue of result.issues) console.log(' - ' + issue);
      process.exitCode = 10;
    } else {
      console.log('Internal evidence checks passed. Independent live broker-side ' +
        'positions and restart safety STILL require separate verification.');
    }
  } finally {
    try { await db.end(); } catch { /* close best-effort */ }
  }
}

main().catch(err => {
  console.error('HOLD: read-only cutover audit unavailable:', err.code || err.name);
  process.exitCode = 2;
});
