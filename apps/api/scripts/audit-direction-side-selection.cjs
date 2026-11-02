'use strict';

const ENGINE = 'irexpro-multimodel-ensemble-v1';
const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_HORIZON_BARS = 72;

const SCOPE_SQL = `
  SELECT CURRENT_TIMESTAMP AS "snapshotAt", broker_id AS "brokerId"
  FROM broker.broker_connections
  WHERE user_id = $1
    AND id = $2
    AND deleted_at IS NULL
`;

const TRADE_COUNTERFACTUAL_SQL = `
  SELECT
    t.instrument,
    t.direction,
    t.opened_at AS "openedAt",
    t.realised_pnl AS "realisedPnl",
    COALESCE(t.fill_price, t.requested_entry_price, ti.requested_entry_price) AS "entryPrice",
    COALESCE(ti.stop_loss, t.stop_loss) AS "stopLoss",
    COALESCE(ti.take_profit, t.take_profit) AS "takeProfit",
    COALESCE(ti.metadata, '{}'::jsonb) AS metadata,
    path.candles
  FROM trading.trades t
  LEFT JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'timestamp', candle.bucket_time,
        'high', candle.high,
        'low', candle.low,
        'close', candle.close,
        'source', candle.source
      )
      ORDER BY candle.bucket_time
    ) AS candles
    FROM (
      SELECT bucket_time, high, low, close, source
      FROM market_data.provider_quote_candles
      WHERE connection_id = t.broker_connection_id
        AND instrument = t.instrument
        AND timeframe = 'M5'
        AND bucket_time > t.opened_at
        AND bucket_time <= $5::timestamptz
      ORDER BY bucket_time
      LIMIT 72
    ) candle
  ) path ON TRUE
  WHERE t.user_id = $1
    AND t.broker_connection_id = $2
    AND t.status = 'CLOSED'
    AND t.opened_at >= $5::timestamptz - ($4::int * interval '1 day')
    AND t.opened_at <= $5::timestamptz
    AND (
      ti.metadata->>'primary_engine_code' = $3
      OR ti.model_version LIKE '%' || $3 || '%'
    )
  ORDER BY t.opened_at, t.id
`;

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value ?? '',
  );
}

function parseObject(value) {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function textBucket(value, fallback = 'UNKNOWN') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value, fallback = 0) {
  const parsed = finiteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : fallback;
}

function mirroredDecision(row, candlePriceBasis) {
  const direction = row.direction === 'BUY' || row.direction === 'SELL' ? row.direction : null;
  const entryPrice = finiteNumber(row.entryPrice);
  const stopLoss = finiteNumber(row.stopLoss);
  const takeProfit = finiteNumber(row.takeProfit);
  const openedAt = new Date(row.openedAt);
  if (
    !direction ||
    entryPrice == null ||
    stopLoss == null ||
    takeProfit == null ||
    !Number.isFinite(openedAt.getTime())
  ) {
    return null;
  }
  const riskDistance = Math.abs(entryPrice - stopLoss);
  const rewardDistance = Math.abs(takeProfit - entryPrice);
  if (!(riskDistance > 0) || !(rewardDistance > 0)) return null;

  const oppositeDirection = direction === 'BUY' ? 'SELL' : 'BUY';
  const mirroredStopLoss =
    oppositeDirection === 'BUY' ? entryPrice - riskDistance : entryPrice + riskDistance;
  const mirroredTakeProfit =
    oppositeDirection === 'BUY' ? entryPrice + rewardDistance : entryPrice - rewardDistance;
  const metadata = parseObject(row.metadata) ?? {};
  const estimatedExecutionCostR = nonNegativeNumber(
    metadata.m1_execution_cost_r ?? metadata.multimodel_execution_cost_r,
    0,
  );

  return {
    direction: oppositeDirection,
    marketBarTime: openedAt.toISOString(),
    evaluatedAt: openedAt.toISOString(),
    entryPrice,
    stopLoss: mirroredStopLoss,
    takeProfit: mirroredTakeProfit,
    estimatedExecutionCostR,
    executionSpreadPrice: 0,
    candlePriceBasis,
  };
}

function deriveLabel(row, resolveOutcome, horizonBars, candlePriceBasis) {
  const realisedPnl = finiteNumber(row.realisedPnl);
  if (realisedPnl == null || realisedPnl === 0) return 'UNRESOLVED';
  if (realisedPnl > 0) return 'KEEP';

  const decision = mirroredDecision(row, candlePriceBasis);
  if (!decision) return 'UNRESOLVED';
  const outcome = resolveOutcome(decision, parseArray(row.candles), horizonBars);
  if (!outcome || outcome.status === 'AMBIGUOUS' || outcome.status === 'EXPIRED') {
    return 'UNRESOLVED';
  }
  const netR = finiteNumber(outcome.netR);
  if (outcome.status === 'WIN' && netR != null && netR > 0) return 'FLIP';
  if (outcome.status === 'LOSS' && netR != null && netR < 0) return 'ABSTAIN';
  return 'UNRESOLVED';
}

function trainedExpertRelation(metadata, executedDirection) {
  const state = textBucket(metadata.multimodel_trained_expert_state, 'UNAVAILABLE').toUpperCase();
  const expertDirection = textBucket(
    metadata.multimodel_trained_expert_direction,
    'UNAVAILABLE',
  ).toUpperCase();
  if (state === 'UNAVAILABLE' || (expertDirection !== 'BUY' && expertDirection !== 'SELL')) {
    return 'UNAVAILABLE';
  }
  const supports = expertDirection === executedDirection;
  if (state === 'ABSTAIN') return supports ? 'ABSTAIN_SUPPORTS' : 'ABSTAIN_OPPOSES';
  return supports ? 'SUPPORTS' : 'OPPOSES';
}

function featureRow(row, label) {
  const metadata = parseObject(row.metadata) ?? {};
  const direction = row.direction === 'BUY' || row.direction === 'SELL' ? row.direction : 'UNKNOWN';
  return {
    instrument: textBucket(row.instrument).toUpperCase(),
    direction,
    label,
    planBRoute: textBucket(
      metadata.multimodel_plan_b_route ?? metadata.plan_b_ensemble_strategy_route,
    ),
    m1Route: textBucket(metadata.m1_tactical_route),
    m1Reliability: textBucket(metadata.m1_route_reliability_reason),
    pairSideReliability: textBucket(metadata.m1_shadow_pair_side_reliability_reason),
    marketRegime: textBucket(metadata.marketRegime ?? metadata.plan_b_ensemble_regime),
    sizingTier: textBucket(metadata.position_sizing_tier),
    trainedExpertRelation: trainedExpertRelation(metadata, direction),
    confidence: finiteNumber(metadata.confidenceScore),
    candidateScore: finiteNumber(metadata.feature_candidate_score),
    netExpectedR: finiteNumber(metadata.m1_net_expected_r),
  };
}

function counts(rows) {
  const keep = rows.filter((row) => row.label === 'KEEP').length;
  const flip = rows.filter((row) => row.label === 'FLIP').length;
  const abstain = rows.filter((row) => row.label === 'ABSTAIN').length;
  const unresolved = rows.filter((row) => row.label === 'UNRESOLVED').length;
  const resolvedTrades = keep + flip + abstain;
  return {
    closedTrades: rows.length,
    resolvedTrades,
    unresolvedTrades: unresolved,
    keep,
    flip,
    abstain,
    keepRate: resolvedTrades > 0 ? keep / resolvedTrades : null,
    flipRate: resolvedTrades > 0 ? flip / resolvedTrades : null,
    abstainRate: resolvedTrades > 0 ? abstain / resolvedTrades : null,
  };
}

function groupSummary(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, groupedRows]) => {
      const summary = counts(groupedRows);
      return { key, ...summary, unresolved: summary.unresolvedTrades };
    })
    .sort((a, b) => b.closedTrades - a.closedTrades || String(a.key).localeCompare(String(b.key)));
}

function patternSummary(rows) {
  const groups = new Map();
  for (const row of rows) {
    const identity = [
      row.planBRoute,
      row.m1Route,
      row.m1Reliability,
      row.pairSideReliability,
      row.trainedExpertRelation,
    ].join('|');
    const current = groups.get(identity) ?? {
      planBRoute: row.planBRoute,
      m1Route: row.m1Route,
      m1Reliability: row.m1Reliability,
      pairSideReliability: row.pairSideReliability,
      trainedExpertRelation: row.trainedExpertRelation,
      rows: [],
    };
    current.rows.push(row);
    groups.set(identity, current);
  }
  return [...groups.values()]
    .map((group) => ({
      planBRoute: group.planBRoute,
      m1Route: group.m1Route,
      m1Reliability: group.m1Reliability,
      pairSideReliability: group.pairSideReliability,
      trainedExpertRelation: group.trainedExpertRelation,
      ...counts(group.rows),
    }))
    .sort((a, b) => b.resolvedTrades - a.resolvedTrades || b.closedTrades - a.closedTrades);
}

async function runDirectionSideSelectionAudit({
  client,
  userId,
  connectionId,
  engineCode = ENGINE,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  resolveOutcome,
  horizonBars = DEFAULT_HORIZON_BARS,
}) {
  if (!validUuid(userId) || !validUuid(connectionId)) throw new Error('INVALID_AUDIT_SCOPE');
  if (typeof engineCode !== 'string' || !engineCode.trim()) throw new Error('INVALID_ENGINE_CODE');
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) {
    throw new Error('INVALID_LOOKBACK_DAYS');
  }
  if (typeof resolveOutcome !== 'function') throw new Error('INVALID_OUTCOME_RESOLVER');
  if (!Number.isInteger(horizonBars) || horizonBars < 1 || horizonBars > 500) {
    throw new Error('INVALID_HORIZON_BARS');
  }

  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const scope = (await client.query(SCOPE_SQL, [userId, connectionId])).rows[0];
    if (!scope?.snapshotAt) throw new Error('AUDIT_SCOPE_UNAVAILABLE');
    const snapshot = new Date(scope.snapshotAt);
    if (!Number.isFinite(snapshot.getTime())) throw new Error('INVALID_AUDIT_SNAPSHOT_TIME');
    const brokerId = textBucket(scope.brokerId, '').toLowerCase();
    const candlePriceBasis = brokerId === 'metaapi' ? 'BID' : 'MID';

    const rows = (
      await client.query(TRADE_COUNTERFACTUAL_SQL, [
        userId,
        connectionId,
        engineCode,
        lookbackDays,
        snapshot.toISOString(),
      ])
    ).rows;
    const features = rows.map((row) =>
      featureRow(row, deriveLabel(row, resolveOutcome, horizonBars, candlePriceBasis)),
    );
    const report = {
      artifact: 'direction-side-selection-mirrored-path-audit-v2',
      generatedAt: snapshot.toISOString(),
      lookbackDays,
      horizonBars,
      labelMethod: 'SAME_ENTRY_MIRRORED_DIRECTION_M5_FIRST_HIT',
      mode: 'READ_ONLY_CAUSAL_COUNTERFACTUAL_AUDIT',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      qualificationEvidence: false,
      productionEligible: false,
      labels: counts(features),
      byPairSide: groupSummary(features, (row) => `${row.instrument}:${row.direction}`),
      byPlanBRoute: groupSummary(features, (row) => row.planBRoute),
      byM1Route: groupSummary(features, (row) => row.m1Route),
      byM1Reliability: groupSummary(features, (row) => row.m1Reliability),
      byPairSideReliability: groupSummary(features, (row) => row.pairSideReliability),
      byTrainedExpertRelation: groupSummary(features, (row) => row.trainedExpertRelation),
      patterns: patternSummary(features),
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
  const {
    ENSEMBLE_OUTCOME_HORIZON_BARS,
    resolveEnsembleShadowOutcome,
  } = require('../dist/modules/ai/ensemble-shadow-outcome');
  const { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'irexpro_dev',
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    query_timeout: 35000,
    application_name: 'irexpro-direction-side-selection-read-only-audit',
  });
  try {
    await client.connect();
    const report = await runDirectionSideSelectionAudit({
      client,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.DIRECTION_SIDE_SELECTION_BROKER_CONNECTION_ID ?? process.env.VPS_FOREX_SCANNER_BROKER_CONNECTION_ID,
      engineCode: ENGINE,
      lookbackDays: Number(
        process.env.DIRECTION_SIDE_SELECTION_AUDIT_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS,
      ),
      resolveOutcome: resolveEnsembleShadowOutcome,
      horizonBars: ENSEMBLE_OUTCOME_HORIZON_BARS,
    });
    console.log(`DIRECTION_SIDE_SELECTION_AUDIT ${JSON.stringify(report)}`);
  } finally {
    await client.end();
  }
}

module.exports = {
  ENGINE,
  SCOPE_SQL,
  TRADE_COUNTERFACTUAL_SQL,
  mirroredDecision,
  deriveLabel,
  trainedExpertRelation,
  runDirectionSideSelectionAudit,
};

if (require.main === module) {
  main().catch(() => {
    console.error('DIRECTION_SIDE_SELECTION_AUDIT_FAILED read-only audit could not be completed');
    process.exitCode = 1;
  });
}
