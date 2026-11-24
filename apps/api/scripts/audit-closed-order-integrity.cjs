'use strict';
// Read-only integrity report. Never infers a broker outcome from local state.
const SQL = `SELECT o.status AS order_status,
  COALESCE(t.status, 'NO_LINKED_TRADE') AS trade_status,
  CASE WHEN t.id IS NULL THEN 'UNLINKED'
       WHEN o.direction = t.direction THEN 'SAME_SIDE'
       ELSE 'OPPOSITE_SIDE' END AS side_relation,
  o.provider_order_id IS NULL AS missing_provider_id,
  o.filled_quantity = 0 AS zero_recorded_fill,
  o.updated_at <= CURRENT_TIMESTAMP - INTERVAL '1 hour' AS aged,
  COUNT(*)::int AS records,
  MIN(o.created_at) AS oldest_created_at,
  MAX(o.updated_at) AS latest_update_at
FROM trading.orders o
LEFT JOIN trading.trades t ON t.id = o.trade_id
  AND t.user_id = o.user_id AND t.broker_connection_id = o.broker_connection_id
WHERE o.status IN ('DISPATCH_COMMITTED','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','RECONCILIATION_PENDING')
GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6`;

function summarize(groups) {
  const totals = { uncertainOrders: 0, closedTradeOrders: 0, agedClosedTradeOrders: 0,
    closedTradeMissingProviderId: 0, closedTradeZeroFill: 0, closedTradeOppositeSide: 0 };
  for (const g of groups) {
    if (!Number.isSafeInteger(g.records) || g.records < 0) throw Error('INVALID_INTEGRITY_COUNT');
    totals.uncertainOrders += g.records;
    if (g.trade_status !== 'CLOSED') continue;
    totals.closedTradeOrders += g.records;
    if (g.aged) totals.agedClosedTradeOrders += g.records;
    if (g.missing_provider_id) totals.closedTradeMissingProviderId += g.records;
    if (g.zero_recorded_fill) totals.closedTradeZeroFill += g.records;
    if (g.side_relation === 'OPPOSITE_SIDE') totals.closedTradeOppositeSide += g.records;
  }
  return { artifact: 'closed-order-integrity-v1', readOnly: true,
    brokerExposureVerified: false, brokerOutcomeVerified: false,
    status: totals.closedTradeOrders > 0 ? 'INTERNAL_DISCREPANCY_REQUIRES_REVIEW' : 'NO_CLOSED_TRADE_ORDER_DISCREPANCY_DETECTED',
    totals, groups };
}

async function inspect(db) {
  await db.query('BEGIN READ ONLY');
  try { return summarize((await db.query(SQL)).rows); }
  finally { await db.query('ROLLBACK'); }
}

async function main() {
  const fs = require('node:fs');
  const path = require('node:path');
  const api = path.join(process.env.IREXPRO_AUDIT_ROOT || path.resolve(__dirname, '..', '..', '..'), 'apps/api');
  const env = require(path.join(api, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(api, '.env')));
  const { Client } = require(path.join(api, 'node_modules/pg'));
  const db = new Client({ host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD, ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    statement_timeout: 6000, connectionTimeoutMillis: 5000, application_name: 'irexpro_closed_order_integrity_readonly' });
  try { await db.connect(); console.log(JSON.stringify(await inspect(db), null, 2)); }
  finally { await db.end(); }
}
if (require.main === module) main().catch(() => { console.error('Closed-order integrity read failed'); process.exitCode = 1; });
module.exports = { SQL, summarize, inspect };
