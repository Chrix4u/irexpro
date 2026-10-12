'use strict';

const ENGINE = 'irexpro-multimodel-ensemble-v1';
const SCOPE_SQL = `
  SELECT account_currency AS "accountCurrency", CURRENT_TIMESTAMP AS "snapshotAt"
  FROM broker.broker_connections
  WHERE user_id = $1 AND id = $2 AND broker_id = 'paper-broker' AND deleted_at IS NULL
`;
const TRADES_SQL = `
  WITH paper_order_identity AS (
    SELECT order_state->>0 AS external_order_id,
      order_state->1->>'clientOrderId' AS client_order_id
    FROM broker.paper_broker_states ps
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(ps.state->'orderStates') = 'array'
        THEN ps.state->'orderStates' ELSE '[]'::jsonb END
    ) AS order_state
    WHERE ps.connection_id = $2
      AND jsonb_typeof(order_state) = 'array'
      AND jsonb_array_length(order_state) >= 2
      AND NULLIF(order_state->>0, '') IS NOT NULL
      AND NULLIF(order_state->1->>'clientOrderId', '') IS NOT NULL
  ), paper_positions AS (
    SELECT position->>'positionId' AS external_position_id,
      COALESCE(NULLIF(position->>'dedupeKey', ''), poi.client_order_id) AS client_order_id
    FROM broker.paper_broker_states ps
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(ps.state->'positions') = 'array'
        THEN ps.state->'positions' ELSE '[]'::jsonb END
    ) AS position
    LEFT JOIN paper_order_identity poi
      ON poi.external_order_id = position->>'positionId'
    WHERE ps.connection_id = $2
      AND NULLIF(position->>'positionId', '') IS NOT NULL
  ), paper_closes AS (
    SELECT poi.client_order_id, event->>'lotSize' AS lot_size
    FROM broker.paper_broker_states ps
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(ps.state->'closedTrades') = 'array'
        THEN ps.state->'closedTrades' ELSE '[]'::jsonb END
    ) AS event
    JOIN paper_order_identity poi ON poi.external_order_id = event->>'externalOrderId'
    WHERE ps.connection_id = $2
  )
  SELECT t.instrument, t.direction, t.lot_size AS "lotSize", t.fill_price AS "entryPrice",
    t.stop_loss AS "stopLoss", ti.stop_loss AS "initialStopLoss",
    t.take_profit AS "takeProfit", ti.take_profit AS "initialTakeProfit",
    t.exit_price AS "exitPrice", t.realised_pnl AS "realisedPnl",
    t.account_currency AS "accountCurrency", t.commission, t.swap,
    t.trailing_stop_pips AS "trailingStopPips",
    o.filled_quantity AS "filledQuantity", o.avg_fill_price AS "filledEntryPrice",
    CASE WHEN o.client_order_id IS NULL THEN 0
      ELSE (SELECT COUNT(*)::int FROM trading.trades duplicate
        JOIN trading.orders duplicate_order ON duplicate_order.id = duplicate.order_id
          AND duplicate_order.trade_id = duplicate.id
          AND duplicate_order.user_id = $1 AND duplicate_order.broker_connection_id = $2
          AND duplicate_order.status = 'FILLED'
        WHERE duplicate.user_id = $1 AND duplicate.broker_connection_id = $2
          AND duplicate_order.client_order_id = o.client_order_id) END AS "positionRecordCount",
    (EXISTS (SELECT 1 FROM trading.orders closing
      WHERE closing.user_id = $1 AND closing.broker_connection_id = $2
        AND closing.trade_id = t.id AND closing.id IS DISTINCT FROM t.order_id
        AND closing.direction <> t.direction
        AND closing.status IN ('FILLED', 'PARTIALLY_FILLED')
        AND closing.filled_quantity > 0 AND closing.filled_quantity < o.filled_quantity)
      OR (SELECT COUNT(*) FROM paper_closes pc
        WHERE pc.client_order_id = o.client_order_id) > 1
      OR EXISTS (SELECT 1 FROM paper_closes pc
        WHERE pc.client_order_id = o.client_order_id
          AND COALESCE(pc.lot_size::numeric <> o.filled_quantity, true))
      OR EXISTS (SELECT 1 FROM paper_positions position
        WHERE position.client_order_id = o.client_order_id))
        AS "hasPartialCloseOrder",
    ti.metadata->>'paper_execution_route' AS "executionRoute",
    CASE ti.metadata->>'paper_research_throughput'
      WHEN 'true' THEN true WHEN 'false' THEN false ELSE NULL END AS research,
    ti.metadata->>'decision_policy_version' AS "policyVersion",
    ti.model_version AS "modelVersion",
    ti.metadata->>'execution_cost_model_version' AS "costModelVersion",
    ti.metadata->>'plan_b_ensemble_strategy_route' AS "strategyRoute",
    t.close_reason::text AS "closeReason"
  FROM trading.trades t
  JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
    AND ti.user_id = $1 AND ti.broker_connection_id = $2
  JOIN broker.broker_connections bc ON bc.id = t.broker_connection_id
    AND bc.user_id = $1 AND bc.broker_id = 'paper-broker' AND bc.deleted_at IS NULL
  LEFT JOIN trading.orders o ON o.id = t.order_id AND o.trade_id = t.id
    AND o.user_id = $1 AND o.broker_connection_id = $2 AND o.status = 'FILLED'
    AND o.instrument = t.instrument AND o.direction = t.direction
  WHERE t.user_id = $1 AND t.broker_connection_id = $2 AND t.status = 'CLOSED'
    AND ti.status = 'EXECUTED'
    AND ti.metadata->>'signal_source' = 'EXTERNAL_PROVIDER'
    AND ti.metadata->>'external_provider_code' = $4
    AND t.closed_at >= $3::timestamptz AND t.closed_at <= CURRENT_TIMESTAMP
  ORDER BY t.closed_at, t.id
`;
const SHADOWS_SQL = `
  SELECT instrument, direction, evaluated_at AS "evaluatedAt", market_bar_time AS "marketBarTime",
    entry_price AS "entryPrice", components->>'stopLoss' AS "stopLoss",
    CASE WHEN components->'governance'->>'executionSpreadEvidenceValid' = 'true'
      THEN components->'governance'->'executionSpreadEvidence'->>'spreadPrice'
      ELSE NULL END AS "brokerSpreadPrice",
    model_version AS "policyVersion", model_version AS "modelVersion",
    components->'governance'->>'costModelVersion' AS "costModelVersion",
    components->>'strategyRoute' AS "strategyRoute", components->'outcome' AS outcome
  FROM trading.ensemble_shadow_decisions
  WHERE user_id = $1 AND broker_connection_id = $2 AND engine_code = $4
    AND evaluated_at >= $3::timestamptz AND evaluated_at <= CURRENT_TIMESTAMP
    AND execution_authority = 'PAPER_ONLY'
  ORDER BY instrument, direction, evaluated_at, id
`;
const LINKS_SQL = `
  SELECT ti.instrument, ti.direction,
    ti.metadata->>'market_data_bar_time' AS "marketBarTime",
    ti.metadata->>'decision_policy_version' AS "policyVersion",
    ti.metadata->>'execution_cost_model_version' AS "costModelVersion",
    ti.metadata->>'paper_execution_route' AS "executionRoute",
    CASE ti.metadata->>'paper_research_throughput'
      WHEN 'true' THEN true WHEN 'false' THEN false ELSE NULL END AS research
  FROM trading.trade_intents ti JOIN trading.trades t ON t.trade_intent_id = ti.id
  WHERE ti.user_id = $1 AND ti.broker_connection_id = $2
    AND t.user_id = $1 AND t.broker_connection_id = $2
    AND ti.status = 'EXECUTED' AND t.status IN ('OPEN', 'CLOSED') AND t.fill_price > 0
    AND t.instrument = ti.instrument AND t.direction = ti.direction
    AND ti.metadata->>'signal_source' = 'EXTERNAL_PROVIDER'
    AND ti.metadata->>'external_provider_code' = $4
    AND ti.signal_generated_at >= $3::timestamptz AND ti.signal_generated_at <= CURRENT_TIMESTAMP
`;
const ACTIVITY_SQL = `
  WITH recent AS (
    SELECT evaluated_at, components->'paperPostLossEntryGuard'->>'reason' AS reason
    FROM trading.ensemble_shadow_decisions
    WHERE user_id = $1 AND broker_connection_id = $2 AND engine_code = $4
      AND evaluated_at >= $3::timestamptz AND evaluated_at <= CURRENT_TIMESTAMP
      AND execution_authority = 'PAPER_ONLY'
  ), reasons AS (
    SELECT reason, COUNT(*)::int AS count FROM recent
    WHERE evaluated_at >= CURRENT_TIMESTAMP - INTERVAL '30 minutes' AND reason IS NOT NULL
    GROUP BY reason
  )
  SELECT (SELECT MAX(evaluated_at) FROM recent) AS "lastEvaluatedAt",
    (SELECT COUNT(*)::int FROM recent) AS decisions,
    (SELECT COUNT(*)::int FROM trading.trades t JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id
      WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND ti.user_id=$1 AND ti.broker_connection_id=$2
        AND ti.metadata->>'external_provider_code'=$4 AND ti.status='EXECUTED'
        AND t.fill_price>0 AND t.opened_at >= $3::timestamptz
        AND t.opened_at <= CURRENT_TIMESTAMP) AS "executedTrades",
    (SELECT COUNT(*)::int FROM recent WHERE reason IN
      ('HISTORY_UNAVAILABLE','INVALID_CLOSE_EVIDENCE','WAITING_FOR_POST_LOSS_BAR','DIRECTION_NOT_RECONFIRMED'))
      AS "postLossBlocks",
    (SELECT COALESCE(jsonb_object_agg(reason,count),'{}'::jsonb) FROM reasons) AS "latestGuardReasons"
`;

async function runPaperPayoffAudit({ client, helpers, paperMarketSpecs, userId, connectionId, since }) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(userId ?? '') || !uuid.test(connectionId ?? '')) throw new Error('INVALID_AUDIT_SCOPE');
  const from = new Date(since);
  if (!Number.isFinite(from.getTime())) throw new Error('INVALID_AUDIT_WINDOW');
  const params = [userId, connectionId, from.toISOString(), ENGINE];
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const scope = (await client.query(SCOPE_SQL, params.slice(0, 2))).rows[0];
    if (!scope) throw new Error('PAPER_SCOPE_UNAVAILABLE');
    const through = new Date(scope.snapshotAt);
    if (!Number.isFinite(through.getTime()) || from > through) throw new Error('INVALID_AUDIT_WINDOW');
    const trades = (await client.query(TRADES_SQL, params)).rows;
    const shadows = (await client.query(SHADOWS_SQL, params)).rows.map(row => ({
      ...row, paperSpreadPrice: paperMarketSpecs[row.instrument.trim().toUpperCase()]?.spread ?? null,
      executionRoute: 'SHADOW_UNLINKED',
    }));
    const links = (await client.query(LINKS_SQL, params)).rows;
    const activity = (await client.query(ACTIVITY_SQL, params)).rows[0];
    const report = {
      artifact: 'paper-realised-payoff-and-exit-shadow-audit-v1',
      executionAuthority: 'PAPER_ONLY', modifiesExecution: false,
      calibrationMode: 'REALISED_PAYOFF_DIAGNOSTIC_ONLY',
      shadowMethodology: 'COMPLETED_M5_COUNTERFACTUAL_NOT_REAL_EXECUTION',
      from: from.toISOString(), through: through.toISOString(),
      activity,
      realised: helpers.summarizeRealisedPaperTrades(trades),
      exitShadows: helpers.summarizePaperExitShadows(helpers.attachPaperExecutionRoutes(shadows, links)),
    };
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const path = require('node:path');
  require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
  if (process.env.VPS_FOREX_SCANNER_ENABLED !== 'true') {
    console.log('PAPER_PAYOFF_AUDIT_SKIPPED scanner_disabled');
    return;
  }
  const { Client } = require('pg');
  const helpers = require('../dist/modules/ai/paper-payoff-shadow-audit');
  const { PAPER_MARKET_SPECS } = require('../dist/modules/broker/services/paper-market-spec');
  const { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost', port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'irexpro', password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'irexpro_dev',
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000, query_timeout: 35000,
    application_name: 'irexpro-paper-payoff-read-only-audit',
  });
  try {
    await client.connect();
    const report = await runPaperPayoffAudit({ client, helpers, paperMarketSpecs: PAPER_MARKET_SPECS,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.VPS_FOREX_SCANNER_BROKER_CONNECTION_ID,
      since: process.env.PAPER_PAYOFF_AUDIT_SINCE ?? new Date(Date.now() - 7 * 86400000).toISOString(),
    });
    console.log('PAPER_PAYOFF_AUDIT ' + JSON.stringify(report));
  } finally {
    await client.end();
  }
}

module.exports = { runPaperPayoffAudit, SCOPE_SQL, TRADES_SQL, SHADOWS_SQL, LINKS_SQL, ACTIVITY_SQL };
if (require.main === module) main().catch(() => {
  // SQL parameters and connection credentials must never appear in release logs.
  console.error('PAPER_PAYOFF_AUDIT_FAILED read-only audit could not be completed');
  process.exitCode = 1;
});
