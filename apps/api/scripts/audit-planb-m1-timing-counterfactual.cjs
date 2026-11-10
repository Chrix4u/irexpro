'use strict';

// Standalone, manually invoked, READ-ONLY research. Never modifies trading decisions,
// promotion state, broker authorization, open positions, or market data.
const ARTIFACT = 'planb-m1-timing-missed-entry-counterfactual-v1';
const POLICY = 'm1-tactical-v2-m5-lifecycle';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMING_REJECT = new Set([
  'MULTIMODEL_CONTINUATION_TIMING_NOT_READY',
  'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED',
  'MULTIMODEL_EARLY_TRANSITION_NOT_M1_CONFIRMED',
]);

const SCOPE_SQL = `
  SELECT CURRENT_TIMESTAMP AS "snapshotAt", broker_id AS "brokerId"
  FROM broker.broker_connections
  WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
    AND broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')
    AND account_type = 'DEMO'
`;

// Default to the broker that the user's current DEMO trading session is
// actually using; the generic market-data connection may belong to an old
// broker and yield a misleading zero-decision research report.
const ACTIVE_DEMO_CONNECTION_SQL = `
  SELECT ts.broker_connection_id AS "connectionId"
  FROM trading.trading_sessions ts
  JOIN broker.broker_connections bc
    ON bc.id = ts.broker_connection_id AND bc.user_id = ts.user_id
  WHERE ts.user_id = $1
    AND ts.status = 'ACTIVE' AND ts.execution_mode = 'FULL_AUTO'
    AND bc.account_type = 'DEMO' AND bc.deleted_at IS NULL
    AND bc.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')
  ORDER BY ts.started_at DESC
  LIMIT 1
`;

const DECISIONS_SQL = `
  SELECT bar_time AS "barTime", evaluated_at AS "evaluatedAt",
    instrument, direction, route,
    candidate->>'stopDistance' AS "stopDistance",
    candidate->>'targetDistance' AS "targetDistance",
    governance #>> '{genericGovernance,estimatedExecutionCostR}' AS "estimatedCostR",
    governance #>> '{multimodelEnsemble,paperAdmitted}' AS "planBAdmitted",
    governance #>> '{multimodelEnsemble,regime}' AS "planBRegime",
    governance #>> '{multimodelEnsemble,strategyRoute}' AS "planBRoute",
    governance #>> '{multimodelEnsemble,regimeAllowed}' AS "planBRegimeAllowed",
    governance #>> '{routeDecision,reason}' AS "m1Reason",
    governance #>> '{routeDecision,route}' AS "m1Route",
    governance #> '{multimodelAuthority,blockers}' AS "authorityBlockers"
  FROM trading.m1_tactical_decisions
  WHERE user_id = $1 AND broker_connection_id = $2
    AND policy_version = $3
    AND evaluated_at >= $4::timestamptz
    AND evaluated_at <= $5::timestamptz
  ORDER BY evaluated_at DESC, bar_time DESC
  LIMIT $6::int
`;

const CANDLES_SQL = `
  SELECT instrument, bucket_time AS "timestamp", open, high, low, close
  FROM market_data.provider_quote_candles
  WHERE connection_id = $1 AND timeframe = 'M1'
    AND source = 'ctrader-broker-native'
    AND positive_quote_sample_count > 0
    AND last_quote_sample_at >= bucket_time
    AND last_quote_sample_at < bucket_time + interval '1 minute'
    AND bucket_time >= $2::timestamptz
    AND bucket_time + interval '1 minute' <= $3::timestamptz
  ORDER BY instrument, bucket_time
`;

function validNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function summarize(items, key) {
  const groups = {};
  for (const item of items) {
    const bucket = String(key(item) || 'UNKNOWN');
    const x =
      groups[bucket] ||
      (groups[bucket] = {
        episodes: 0,
        observed: 0,
        unobservable: 0,
        ambiguous: 0,
        positive: 0,
        negative: 0,
        netR: 0,
        timingOnly: 0,
      });
    x.episodes++;
    if (item.timingOnly) x.timingOnly++;
    if (item.state === 'UNOBSERVABLE') x.unobservable++;
    else if (item.state === 'AMBIGUOUS') x.ambiguous++;
    else if (item.state === 'OBSERVED') {
      x.observed++;
      x.netR += item.netR;
      if (item.netR > 0) x.positive++;
      else if (item.netR < 0) x.negative++;
    }
  }
  return Object.fromEntries(
    Object.entries(groups)
      .sort((a, b) => b[1].episodes - a[1].episodes)
      .map(([k, v]) => [k, { ...v, netR: Number(v.netR.toFixed(4)) }]),
  );
}

function selectEpisodeLeaders(rows) {
  // Treat repeated minute-level evaluations of the same strategy and side as
  // a single episode while <=5 minutes apart. Never treat rows as iid trades.
  const prior = new Map();
  const leaders = [];
  for (const row of [...rows].sort(
    (a, b) => new Date(a.evaluatedAt).getTime() - new Date(b.evaluatedAt).getTime(),
  )) {
    const blockers = Array.isArray(row.authorityBlockers) ? row.authorityBlockers : [];
    const timingBlockers = blockers.filter((v) => TIMING_REJECT.has(v));
    if (row.planBAdmitted !== 'true' || timingBlockers.length === 0) continue;
    const when = new Date(row.barTime).getTime();
    if (!Number.isFinite(when)) continue;
    const episodeKey = [row.instrument, row.direction, row.planBRoute].join('|');
    const previous = prior.get(episodeKey);
    prior.set(episodeKey, when);
    if (previous != null && when - previous <= 5 * 60_000) continue;
    leaders.push({
      ...row,
      timingOnly: blockers.every((v) => TIMING_REJECT.has(v)),
      timingBlockers,
    });
  }
  return leaders;
}

async function runPlanBTimingCounterfactualAudit({
  client,
  userId,
  connectionId,
  since,
  evaluateOutcome,
  maxDecisions = 4000,
}) {
  if (!UUID.test(userId ?? '') || (connectionId != null && !UUID.test(connectionId))) {
    throw new Error('INVALID_AUDIT_SCOPE');
  }
  const from = new Date(since);
  if (!Number.isFinite(from.getTime())) throw new Error('INVALID_AUDIT_WINDOW');
  if (typeof evaluateOutcome !== 'function') throw new Error('MISSING_CAUSAL_EVALUATOR');
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 10000) {
    throw new Error('INVALID_AUDIT_LIMIT');
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const active = connectionId
      ? null
      : (await client.query(ACTIVE_DEMO_CONNECTION_SQL, [userId])).rows[0];
    const resolvedConnectionId = connectionId ?? active?.connectionId;
    if (!UUID.test(resolvedConnectionId ?? '')) {
      throw new Error('ACTIVE_CTRADER_DEMO_SESSION_UNAVAILABLE');
    }
    const scope = (await client.query(SCOPE_SQL, [resolvedConnectionId, userId])).rows[0];
    if (!scope) throw new Error('CTRADER_DEMO_SCOPE_UNAVAILABLE');
    const through = new Date(scope.snapshotAt);
    const latestEvaluated = new Date(through.getTime() - 16 * 60_000);
    if (
      !Number.isFinite(through.getTime()) ||
      from > latestEvaluated ||
      through.getTime() - from.getTime() > 72 * 3600_000
    ) {
      throw new Error('INVALID_AUDIT_WINDOW');
    }
    const rows = (
      await client.query(DECISIONS_SQL, [
        userId,
        resolvedConnectionId,
        POLICY,
        from.toISOString(),
        latestEvaluated.toISOString(),
        maxDecisions,
      ])
    ).rows;
    const leaders = selectEpisodeLeaders(rows);
    const candles = (
      await client.query(CANDLES_SQL, [resolvedConnectionId, from.toISOString(), through.toISOString()])
    ).rows;
    const byInstrument = new Map();
    for (const candle of candles) {
      const group = byInstrument.get(candle.instrument) || [];
      group.push(candle);
      byInstrument.set(candle.instrument, group);
    }
    const outcomes = leaders.map((leader) => {
      const stopDistance = validNumber(leader.stopDistance);
      const targetDistance = validNumber(leader.targetDistance);
      const cost = validNumber(leader.estimatedCostR);
      let observation = null;
      if (
        (leader.direction === 'BUY' || leader.direction === 'SELL') &&
        stopDistance > 0 &&
        targetDistance > 0 &&
        cost !== null &&
        cost >= 0
      ) {
        observation = evaluateOutcome({
          direction: leader.direction,
          evaluatedAt: new Date(leader.evaluatedAt),
          stopDistance,
          targetDistance,
          executionCostR: cost,
          bars: byInstrument.get(leader.instrument) || [],
        });
      }
      const netR = observation?.netRMultiple;
      const state =
        observation?.outcome === 'AMBIGUOUS'
          ? 'AMBIGUOUS'
          : Number.isFinite(netR)
            ? 'OBSERVED'
            : 'UNOBSERVABLE';
      return {
        instrument: leader.instrument,
        direction: leader.direction,
        regime: leader.planBRegime,
        planBRoute: leader.planBRoute,
        m1Route: leader.m1Route,
        m1Reason: leader.m1Reason,
        timingOnly: leader.timingOnly,
        state,
        netR: state === 'OBSERVED' ? netR : null,
      };
    });

    const report = {
      artifact: ARTIFACT,
      brokerId: scope.brokerId,
      brokerScope: 'ACTIVE_OR_EXPLICIT_USER_OWNED_CTRADER_DEMO',
      generatedAt: through.toISOString(),
      from: from.toISOString(),
      through: latestEvaluated.toISOString(),
      executionAuthority: 'NONE',
      modifiesExecution: false,
      promotionEligible: false,
      qualificationEvidence: false,
      methodology: 'READ_ONLY_COMPLETED_CTRADER_QUOTE_M1_15_BAR_CAUSAL_SHADOW',
      caution:
        'Not actual broker fills; estimated costs, missing quotes, sampling and selection bias. Never promote a model from this report.',
      evaluatedDecisionRows: rows.length,
      truncatedDecisionWindow: rows.length === maxDecisions,
      observedQuoteCandles: candles.length,
      timingRejectedEpisodes: leaders.length,
      byGateExclusivity: summarize(outcomes, (x) =>
        x.timingOnly ? 'TIMING_ONLY' : 'TIMING_AND_OTHER_GATES',
      ),
      byM1Reason: summarize(outcomes, (x) => x.m1Reason),
      byPlanBRoute: summarize(outcomes, (x) => x.planBRoute),
      byMarketRegime: summarize(outcomes, (x) => x.regime),
      byPairSide: summarize(outcomes, (x) => `${x.instrument}:${x.direction}`),
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
  require('dotenv').config({
    path: process.env.IREXPRO_API_ENV_PATH || path.join(__dirname, '../.env'),
    quiet: true,
  });
  const { Client } = require('pg');
  const { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const { evaluateM1CausalOutcome15m } = require('../dist/modules/ai/m1-causal-outcome');
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'irexpro_dev',
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    query_timeout: 35000,
    application_name: 'irexpro-planb-m1-timing-read-only-counterfactual',
  });
  try {
    await client.connect();
    const report = await runPlanBTimingCounterfactualAudit({
      client,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      // Explicit, dedicated override is allowed for controlled retrospectives.
      // Never silently use the stale market-data account in a broker-switching app.
      connectionId: process.env.PLANB_M1_TIMING_AUDIT_CONNECTION_ID || undefined,
      since:
        process.env.PLANB_M1_TIMING_AUDIT_SINCE ??
        new Date(Date.now() - 6 * 3600_000).toISOString(),
      evaluateOutcome: evaluateM1CausalOutcome15m,
      maxDecisions: process.env.PLANB_M1_TIMING_AUDIT_MAX_DECISIONS
        ? Number(process.env.PLANB_M1_TIMING_AUDIT_MAX_DECISIONS)
        : 4000,
    });
    console.log('PLANB_M1_TIMING_AUDIT ' + JSON.stringify(report));
  } finally {
    await client.end();
  }
}

module.exports = {
  ARTIFACT,
  POLICY,
  TIMING_REJECT,
  SCOPE_SQL,
  ACTIVE_DEMO_CONNECTION_SQL,
  DECISIONS_SQL,
  CANDLES_SQL,
  selectEpisodeLeaders,
  runPlanBTimingCounterfactualAudit,
};
if (require.main === module)
  main().catch(() => {
    console.error('PLANB_M1_TIMING_AUDIT_FAILED read-only audit could not be completed');
    process.exitCode = 1;
  });
