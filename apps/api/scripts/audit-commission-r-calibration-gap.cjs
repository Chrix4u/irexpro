'use strict';

// Manual research only. No execution, broker order, feature-flag or DB mutation imports.
const { resolve } = require('node:path');
const ARTIFACT = 'ex-ante-vs-realized-commission-r-audit-v1';
const MAX_ROWS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE_SQL = `
 SELECT current_timestamp AS "asOf" FROM broker.broker_connections
 WHERE id=$1 AND user_id=$2 AND broker_id='ctrader'
   AND account_type='DEMO' AND deleted_at IS NULL
`;
const TRADE_SQL = `
 SELECT t.instrument, t.direction, t.opened_at AS "openedAt", t.closed_at AS "closedAt",
   t.account_currency AS "currency", t.realised_pnl AS "grossPnl",
   t.commission, t.swap, ti.strategy_code AS "engine",
   COALESCE(NULLIF(ti.metadata->>'multimodel_plan_b_route',''), 'UNKNOWN') AS "route",
   NULLIF(ti.metadata->>'m1_net_expected_r','') AS "m1ExpectedNetR",
   NULLIF(ti.metadata->>'multimodel_governance_net_expected_r','') AS "planBExpectedNetR",
   NULLIF(ti.metadata->>'m1_execution_cost_r','') AS "modeledSpreadCostR",
   NULLIF(ti.metadata->>'m1_execution_cost_source','') AS "modeledCostSource",
   ca.created_at AS "allocationCreatedAt",
   ca.sizing_inputs->>'finalRiskAtStop' AS "allocationRiskAtStop",
   ca.sizing_inputs->>'riskAmount' AS "fallbackAllocationRisk"
 FROM trading.trades t
 JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id
   AND ti.user_id=$1 AND ti.broker_connection_id=$2
 LEFT JOIN LATERAL (
   SELECT ca0.created_at,ca0.sizing_inputs
   FROM trading.capital_allocations ca0
   WHERE ca0.trade_intent_id=t.trade_intent_id AND ca0.created_at<=t.opened_at
   ORDER BY ca0.created_at DESC LIMIT 1
 ) ca ON true
 WHERE t.user_id=$1 AND t.broker_connection_id=$2
   AND t.status='CLOSED' AND t.closed_at IS NOT NULL
   AND t.opened_at >= $3::timestamptz AND t.opened_at <= $4::timestamptz
   AND ti.strategy_code IN ('external-irexpro-m1-tactical',
                            'external-irexpro-multimodel-ensemble')
 ORDER BY t.opened_at, t.id
 LIMIT $5::int
`;
function finite(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function timestamp(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = new Date(x).getTime();
  return Number.isFinite(n) ? n : null;
}
function round(n, places = 3) {
  return Number(n.toFixed(places));
}
function quantile(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const i = (a.length - 1) * p,
    l = Math.floor(i),
    h = Math.ceil(i);
  return round(a[l] + (a[h] - a[l]) * (i - l));
}
function normalize(row) {
  const gross = finite(row.grossPnl),
    commission = finite(row.commission),
    swap = finite(row.swap);
  // Never replace a malformed specified final risk with a fallback that could
  // hide an inconsistent sizing record; use fallback only if final field absent.
  const hasFinalRisk =
    row.allocationRiskAtStop !== null &&
    row.allocationRiskAtStop !== undefined &&
    row.allocationRiskAtStop !== '';
  const risk = hasFinalRisk ? finite(row.allocationRiskAtStop) : finite(row.fallbackAllocationRisk);
  const validTime =
    timestamp(row.openedAt) !== null &&
    timestamp(row.closedAt) !== null &&
    timestamp(row.closedAt) >= timestamp(row.openedAt);
  const allocationTime = row.allocationCreatedAt ? timestamp(row.allocationCreatedAt) : null;
  const validRisk =
    risk !== null &&
    risk > 0 &&
    allocationTime !== null &&
    validTime &&
    allocationTime <= timestamp(row.openedAt);
  const costsComplete = gross !== null && commission !== null && swap !== null;
  const usable = validRisk && costsComplete;
  const net = usable ? gross - Math.abs(commission) + swap : null;
  const observedGrossR = usable ? gross / risk : null;
  const observedNetR = usable ? net / risk : null;
  const commissionR = usable ? Math.abs(commission) / risk : null;
  const modeledSpreadCostR = finite(row.modeledSpreadCostR);
  const m1ExpectedNetR = finite(row.m1ExpectedNetR);
  const planBExpectedNetR = finite(row.planBExpectedNetR);
  return {
    instrument: String(row.instrument ?? '').toUpperCase(),
    direction: row.direction,
    currency: String(row.currency ?? 'UNKNOWN').toUpperCase(),
    engine: String(row.engine ?? 'UNKNOWN'),
    route: String(row.route ?? 'UNKNOWN'),
    modeledCostSource: String(row.modeledCostSource ?? 'UNKNOWN'),
    usable,
    riskValid: validRisk,
    costsComplete,
    riskSource: hasFinalRisk ? 'FINAL_RISK_AT_STOP' : 'FALLBACK_RISK_AMOUNT',
    gross,
    commission,
    swap,
    observedGrossR,
    observedNetR,
    commissionR,
    modeledSpreadCostR,
    m1ExpectedNetR,
    planBExpectedNetR,
  };
}
function summarize(rows) {
  const usable = rows.filter((x) => x.usable),
    mean = (f) => {
      const a = usable.map(f).filter((x) => x !== null && Number.isFinite(x));
      return a.length ? round(a.reduce((s, x) => s + x, 0) / a.length) : null;
    };
  const commissionR = usable.map((x) => x.commissionR).filter((x) => x !== null);
  const comparison = (key) => usable.filter((x) => x[key] !== null && Number.isFinite(x[key]));
  const m1Paired = comparison('m1ExpectedNetR'),
    planbPaired = comparison('planBExpectedNetR');
  return {
    trades: rows.length,
    validEntryAllocationRisk: rows.filter((x) => x.riskValid).length,
    completeRecordedCosts: rows.filter((x) => x.costsComplete).length,
    pairedRealizedNetR: usable.length,
    skippedIncompleteCostOrRisk: rows.length - usable.length,
    allocationRiskFallbacks: usable.filter((x) => x.riskSource === 'FALLBACK_RISK_AMOUNT').length,
    meanRealizedGrossR: mean((x) => x.observedGrossR),
    meanRealizedNetR: mean((x) => x.observedNetR),
    meanRecordedCommissionR: mean((x) => x.commissionR),
    recordedCommissionR_P50: quantile(commissionR, 0.5),
    recordedCommissionR_P90: quantile(commissionR, 0.9),
    meanModeledSpreadOnlyCostR: mean((x) => x.modeledSpreadCostR),
    m1ExpectedNetR: {
      pairedCount: m1Paired.length,
      meanForecastR: m1Paired.length
        ? round(m1Paired.reduce((s, x) => s + x.m1ExpectedNetR, 0) / m1Paired.length)
        : null,
      meanRealizedMinusForecastR: m1Paired.length
        ? round(
            m1Paired.reduce((s, x) => s + x.observedNetR - x.m1ExpectedNetR, 0) / m1Paired.length,
          )
        : null,
    },
    planBGovernanceNetExpectedR: {
      pairedCount: planbPaired.length,
      meanForecastR: planbPaired.length
        ? round(planbPaired.reduce((s, x) => s + x.planBExpectedNetR, 0) / planbPaired.length)
        : null,
      meanRealizedMinusForecastR: planbPaired.length
        ? round(
            planbPaired.reduce((s, x) => s + x.observedNetR - x.planBExpectedNetR, 0) /
              planbPaired.length,
          )
        : null,
    },
    grossPositiveNetNonPositive: usable.filter((x) => x.gross > 0 && x.observedNetR <= 0).length,
    netProfitable: usable.filter((x) => x.observedNetR > 0).length,
    netUnprofitable: usable.filter((x) => x.observedNetR < 0).length,
  };
}
function group(rows, key) {
  return Object.fromEntries(
    [...Map.groupBy(rows, (x) => x.currency + ' | ' + key(x))]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, items]) => [k, summarize(items)]),
  );
}
function evaluateRows(raw, since, asOf) {
  const from = timestamp(since),
    now = timestamp(asOf);
  if (from === null || now === null || from > now || now - from > 14 * 864e5)
    throw Error('INVALID_WINDOW');
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw Error('TOO_MANY_TRADES');
  const rows = raw.map(normalize);
  return {
    artifact: ARTIFACT,
    researchOnly: true,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    promotionEligible: false,
    from: new Date(from).toISOString(),
    asOf: new Date(now).toISOString(),
    costModelSemantics:
      'MODELED_SPREAD_PLUS_25_PERCENT_SLIPPAGE; EXCLUDES_EXPLICIT_BROKER_COMMISSION',
    initialRiskSemantics:
      'CAPITAL_ALLOCATION_FINAL_RISK_AT_STOP_AS_OF_ENTRY; NOT_INDEPENDENT_BROKER_FILL_RISK',
    byCurrency: group(rows, () => 'ALL'),
    byStrategyRoute: group(rows, (x) => x.route),
    byEngineAndRoute: group(
      rows,
      (x) => (x.engine.endsWith('m1-tactical') ? 'M1_TACTICAL' : 'PLAN_B_ENSEMBLE') + '/' + x.route,
    ),
    byExecutionCostSource: group(rows, (x) => x.modeledCostSource),
    caveats: [
      'Observed commission R is calculated AFTER closure; never use it as if known at entry.',
      'ModeledSpreadOnlyCostR is a spread/slippage component and not a total fee-inclusive broker cost estimate.',
      'ForecastR is a stored pre-entry governance estimate, not a broker or audited cash return.',
      'Allocation-risk-normalized R may differ from broker-realizable initial-stop R due to execution price and conversion drift.',
      'Only matched complete risk-and-cost rows enter means; this selected seven-day DEMO sample is not an out-of-sample model validation.',
      'No changes to order sizing, risk brakes, cost gate or execution authority are authorized.',
    ],
  };
}
async function runAudit({ client, userId, connectionId, since, maxRows = MAX_ROWS }) {
  if (!UUID.test(userId ?? '') || !UUID.test(connectionId ?? '')) throw Error('INVALID_DEMO_SCOPE');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS)
    throw Error('INVALID_ROW_LIMIT');
  const from = new Date(since);
  if (!Number.isFinite(from.getTime())) throw Error('INVALID_WINDOW');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const scope = (await client.query(SCOPE_SQL, [connectionId, userId])).rows[0];
    if (!scope) throw Error('OWNER_CTRADER_DEMO_NOT_FOUND');
    const asOf = new Date(scope.asOf);
    if (!Number.isFinite(asOf.getTime()) || from > asOf || asOf - from > 14 * 864e5)
      throw Error('INVALID_WINDOW');
    const raw = (
      await client.query(TRADE_SQL, [
        userId,
        connectionId,
        from.toISOString(),
        asOf.toISOString(),
        maxRows + 1,
      ])
    ).rows;
    if (raw.length > maxRows) throw Error('TRUNCATED_TRADE_HISTORY');
    const report = evaluateRows(raw, from, asOf);
    await client.query('COMMIT');
    return report;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
async function main() {
  require('dotenv').config({
    path: process.env.IREXPRO_API_ENV_PATH || resolve(__dirname, '../.env'),
    quiet: true,
  });
  const { Client } = require('pg'),
    { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const c = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'irexpro_dev',
    user: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    application_name: 'irexpro-commission-r-gap-readonly',
  });
  try {
    await c.connect();
    const report = await runAudit({
      client: c,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID,
      since: process.env.COMMISSION_R_AUDIT_SINCE || new Date(Date.now() - 7 * 864e5).toISOString(),
    });
    console.log('COMMISSION_R_AUDIT ' + JSON.stringify(report));
  } finally {
    await c.end();
  }
}
module.exports = { ARTIFACT, SCOPE_SQL, TRADE_SQL, normalize, summarize, evaluateRows, runAudit };
if (require.main === module)
  main().catch(() => {
    console.error('COMMISSION_R_AUDIT_FAILED read-only research could not complete');
    process.exitCode = 1;
  });
