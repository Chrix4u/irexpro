'use strict';
/**
 * Operator-only metadata lookup for a previously linked LIVE cTrader account.
 * Does NOT read encrypted_credentials or any secret, contact cTrader,
 * authorize a trade, change a permission, or execute a broker order.
 * Usage: export CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID=<id> then run node script.
 */
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const brokerId = process.env.CTRADER_LIVE_CERT_BROKER_ID || 'pepperstone-ctrader';
const accountId = process.env.CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID;
if (!['pepperstone-ctrader', 'icmarkets-ctrader', 'ctrader'].includes(brokerId)
    || !/^[1-9]\d{4,18}$/.test(accountId || '')) {
  console.error('Provide a supported cTrader broker alias and exact numeric cTID account ID.');
  process.exitCode = 1;
} else {
  const config = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../../.env')));
  const env = { ...config, ...process.env };
  const db = new Client({
    host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000, statement_timeout: 7000,
    application_name: 'irexpro_operator_cert_identity_metadata_readonly',
  });
  (async () => {
    let connected = false;
    try {
      await db.connect();
      connected = true;
      await db.query('BEGIN READ ONLY');
      const result = await db.query(
        `SELECT id::text AS connection_id, user_id::text AS owner_user_id,
                broker_id, account_id, account_type, status,
                authorization_status, credential_status
           FROM broker.broker_connections
          WHERE broker_id = $1 AND account_id = $2 AND account_type = 'LIVE'
            AND deleted_at IS NULL
          LIMIT 2`,
        [brokerId, accountId],
      );
      if (result.rows.length !== 1) {
        console.error('Identity lookup requires exactly one matching LIVE connection.');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(result.rows[0], null, 2));
    } catch (error) {
      console.error('Read-only identity lookup unavailable:', error.code || error.name);
      process.exitCode = 1;
    } finally {
      if (connected) { try { await db.query('ROLLBACK'); } catch {} }
      try { await db.end(); } catch {}
    }
  })();
}
