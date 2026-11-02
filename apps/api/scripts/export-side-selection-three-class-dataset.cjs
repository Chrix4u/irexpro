'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENGINE = 'irexpro-multimodel-ensemble-v1';
const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_PAIR_EVAL_GAP_SECONDS = 30;

const SCOPE_SQL = `
  SELECT CURRENT_TIMESTAMP AS "snapshotAt", broker_id AS "brokerId"
  FROM broker.broker_connections
  WHERE user_id = $1
    AND id = $2
    AND deleted_at IS NULL
`;

const DECISIONS_SQL = `
  SELECT
    id,
    instrument,
    direction,
    model_version AS "modelVersion",
    market_bar_time AS "marketBarTime",
    evaluated_at AS "evaluatedAt",
    entry_price AS "entryPrice",
    components
  FROM trading.ensemble_shadow_decisions
  WHERE user_id = $1
    AND broker_connection_id = $2
    AND engine_code = $3
    AND evaluated_at >= $5::timestamptz - ($4::int * interval '1 day')
    AND evaluated_at <= $5::timestamptz
    AND components->'outcome'->>'version' = $6
  ORDER BY instrument, market_bar_time, model_version, evaluated_at, id
`;

const CATEGORICAL_FEATURES = Object.freeze([
  'instrument',
  'direction',
  'policy_version',
  'strategy_route',
  'pair_side_route',
  'drift_state',
  'event_risk',
  'sleeve_state',
  'adaptive_market_state',
  'adaptive_evidence_class',
  'trained_expert_state',
  'trained_expert_direction',
  'calibration_conflict_state',
  'calibration_conflict_reason',
  'calibration_raw_preferred_direction',
]);

const NUMERIC_FEATURES = Object.freeze([
  'candidate_score',
  'direction_quality',
  'trade_quality',
  'exit_quality',
  'pair_side_quality',
  'session_quality',
  'portfolio_quality',
  'portfolio_risk_score',
  'open_position_count',
  'same_instrument_count',
  'same_instrument_directional_lots',
  'mtf_strength',
  'ema_separation',
  'extension_atr',
  'rsi14',
  'volatility_score',
  'short_horizon_momentum_atr',
  'governance_gross_expected_r',
  'governance_net_expected_r',
  'execution_cost_r',
  'adaptive_net_expected_r',
  'adaptive_raw_net_expected_r',
  'adaptive_risk_multiplier',
  'pre_adaptive_scan_rank',
  'adaptive_scan_rank',
  'calibration_candidate_directional_probability',
  'calibration_opposite_directional_probability',
  'calibration_directional_edge',
  'calibrated_net_expected_r',
  'calibrated_win_probability',
  'calibration_samples',
  'trained_expert_confidence',
  'trained_expert_opportunity_probability',
  'trained_expert_long_votes',
  'trained_expert_short_votes',
]);

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

function nestedObject(value, key) {
  const object = parseObject(value);
  return parseObject(object?.[key]);
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

function dateValue(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function decisiveOutcome(components, outcomeVersion) {
  const outcome = nestedObject(components, 'outcome');
  if (!outcome || outcome.version !== outcomeVersion) return null;
  if (outcome.status !== 'WIN' && outcome.status !== 'LOSS') return null;
  const resolvedAt = dateValue(outcome.resolvedAt);
  const netR = finiteNumber(outcome.netR);
  if (!resolvedAt || netR == null) return null;
  if (outcome.status === 'WIN' && netR <= 0) return null;
  if (outcome.status === 'LOSS' && netR >= 0) return null;
  return { status: outcome.status, resolvedAt, netR };
}

function policyVersion(row, components) {
  const parsed = parseObject(components) ?? {};
  return textBucket(parsed.decisionPolicyVersion ?? row.modelVersion);
}

function normalizeDecision(row, outcomeVersion) {
  const direction = row.direction === 'BUY' || row.direction === 'SELL' ? row.direction : null;
  const instrument = textBucket(row.instrument, '').toUpperCase();
  const marketBarTime = dateValue(row.marketBarTime);
  const evaluatedAt = dateValue(row.evaluatedAt);
  const components = parseObject(row.components);
  const outcome = decisiveOutcome(components, outcomeVersion);
  if (!direction || !instrument || !marketBarTime || !evaluatedAt || !components || !outcome) {
    return null;
  }
  return {
    id: String(row.id ?? ''),
    instrument,
    direction,
    marketBarTime,
    evaluatedAt,
    policyVersion: policyVersion(row, components),
    components,
    outcome,
  };
}

function groupSimultaneousPairs(rows, outcomeVersion) {
  const groups = new Map();
  for (const raw of rows) {
    const row = normalizeDecision(raw, outcomeVersion);
    if (!row) continue;
    const key = `${row.instrument}|${row.marketBarTime.toISOString()}|${row.policyVersion}`;
    const current = groups.get(key) ?? { BUY: null, SELL: null };
    const existing = current[row.direction];
    if (!existing || row.evaluatedAt.getTime() < existing.evaluatedAt.getTime()) {
      current[row.direction] = row;
    }
    groups.set(key, current);
  }

  return [...groups.values()]
    .filter((group) => group.BUY && group.SELL)
    .map((group) => {
      const buy = group.BUY;
      const sell = group.SELL;
      const gapMs = Math.abs(buy.evaluatedAt.getTime() - sell.evaluatedAt.getTime());
      if (gapMs > MAX_PAIR_EVAL_GAP_SECONDS * 1000) return null;
      const decisionTime = new Date(Math.max(buy.evaluatedAt.getTime(), sell.evaluatedAt.getTime()));
      const resolvedAt = new Date(
        Math.max(buy.outcome.resolvedAt.getTime(), sell.outcome.resolvedAt.getTime()),
      );
      if (resolvedAt.getTime() < decisionTime.getTime()) return null;
      return { buy, sell, decisionTime, resolvedAt };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.decisionTime.getTime() - b.decisionTime.getTime() ||
        a.buy.instrument.localeCompare(b.buy.instrument),
    );
}

function deoverlapPairs(pairs) {
  const activeUntilByInstrument = new Map();
  const accepted = [];
  for (const pair of pairs) {
    const instrument = pair.buy.instrument;
    const activeUntil = activeUntilByInstrument.get(instrument) ?? Number.NEGATIVE_INFINITY;
    if (pair.decisionTime.getTime() <= activeUntil) continue;
    accepted.push(pair);
    activeUntilByInstrument.set(instrument, pair.resolvedAt.getTime());
  }
  return accepted;
}

function labelFor(candidate, opposite) {
  if (candidate.outcome.status === 'WIN') return 'KEEP';
  if (candidate.outcome.status === 'LOSS' && opposite.outcome.status === 'WIN') return 'FLIP';
  if (candidate.outcome.status === 'LOSS' && opposite.outcome.status === 'LOSS') return 'ABSTAIN';
  return null;
}

function featureRow(pair, candidate, opposite) {
  const c = candidate.components;
  const governance = nestedObject(c, 'governance') ?? {};
  const adaptive = nestedObject(c, 'adaptiveMarketIntelligence') ?? {};
  const adaptiveMarketState = parseObject(adaptive.marketState) ?? {};
  const trained = nestedObject(c, 'highConvictionOverlay') ?? {};
  const calibration = nestedObject(c, 'calibrationBidirectionalConflict') ?? {};
  const label = labelFor(candidate, opposite);
  if (!label) return null;

  return {
    episode_id: `${candidate.instrument}|${candidate.marketBarTime.toISOString()}|${candidate.policyVersion}`,
    decision_time: pair.decisionTime.toISOString(),
    market_bar_time: candidate.marketBarTime.toISOString(),
    target_resolved_at: pair.resolvedAt.toISOString(),
    instrument: candidate.instrument,
    direction: candidate.direction,
    policy_version: candidate.policyVersion,
    label,
    target_original_net_r: candidate.outcome.netR,
    target_opposite_net_r: opposite.outcome.netR,
    strategy_route: textBucket(c.strategyRoute),
    pair_side_route: textBucket(c.pairSideRoute),
    drift_state: textBucket(governance.driftState),
    event_risk: textBucket(governance.eventRisk),
    sleeve_state: textBucket(governance.sleeveState),
    adaptive_market_state: textBucket(adaptiveMarketState.state),
    adaptive_evidence_class: textBucket(adaptive.evidenceClass),
    trained_expert_state: textBucket(trained.state),
    trained_expert_direction: textBucket(trained.direction),
    calibration_conflict_state: textBucket(calibration.state),
    calibration_conflict_reason: textBucket(calibration.reason),
    calibration_raw_preferred_direction: textBucket(calibration.rawPreferredDirection),
    candidate_score: finiteNumber(c.candidateScore),
    direction_quality: finiteNumber(c.directionQuality),
    trade_quality: finiteNumber(c.tradeQuality),
    exit_quality: finiteNumber(c.exitQuality),
    pair_side_quality: finiteNumber(c.pairSideQuality),
    session_quality: finiteNumber(c.sessionQuality),
    portfolio_quality: finiteNumber(c.portfolioQuality),
    portfolio_risk_score: finiteNumber(c.portfolioRiskScore),
    open_position_count: finiteNumber(c.openPositionCount),
    same_instrument_count: finiteNumber(c.sameInstrumentCount),
    same_instrument_directional_lots: finiteNumber(c.sameInstrumentDirectionalLots),
    mtf_strength: finiteNumber(c.mtfStrength),
    ema_separation: finiteNumber(c.emaSeparation),
    extension_atr: finiteNumber(c.extensionAtr),
    rsi14: finiteNumber(c.rsi14),
    volatility_score: finiteNumber(c.volatilityScore),
    short_horizon_momentum_atr: finiteNumber(c.shortHorizonMomentumAtr),
    governance_gross_expected_r: finiteNumber(governance.grossExpectedR),
    governance_net_expected_r: finiteNumber(governance.netExpectedR),
    execution_cost_r: finiteNumber(governance.estimatedExecutionCostR),
    adaptive_net_expected_r: finiteNumber(adaptive.netExpectedR),
    adaptive_raw_net_expected_r: finiteNumber(adaptive.rawNetExpectedR),
    adaptive_risk_multiplier: finiteNumber(adaptive.riskMultiplier),
    pre_adaptive_scan_rank: finiteNumber(adaptive.preAdaptiveScanRank),
    adaptive_scan_rank: finiteNumber(adaptive.scanRank),
    calibration_candidate_directional_probability: finiteNumber(
      calibration.candidateDirectionalProbability,
    ),
    calibration_opposite_directional_probability: finiteNumber(
      calibration.oppositeDirectionalProbability,
    ),
    calibration_directional_edge: finiteNumber(calibration.directionalEdge),
    calibrated_net_expected_r: finiteNumber(calibration.calibratedNetExpectedR),
    calibrated_win_probability: finiteNumber(calibration.calibratedWinProbability),
    calibration_samples: finiteNumber(calibration.calibrationSamples),
    trained_expert_confidence: finiteNumber(trained.ensembleConfidence),
    trained_expert_opportunity_probability: finiteNumber(trained.meanOpportunityProbability),
    trained_expert_long_votes: finiteNumber(trained.longVotes),
    trained_expert_short_votes: finiteNumber(trained.shortVotes),
  };
}

function countLabels(rows) {
  const result = { KEEP: 0, FLIP: 0, ABSTAIN: 0 };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(result, row.label)) result[row.label] += 1;
  }
  return result;
}

function byPolicy(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const current = grouped.get(row.policy_version) ?? [];
    current.push(row);
    grouped.set(row.policy_version, current);
  }
  return [...grouped.entries()]
    .map(([policyVersion, policyRows]) => ({
      policyVersion,
      rows: policyRows.length,
      labels: countLabels(policyRows),
    }))
    .sort((a, b) => b.rows - a.rows || a.policyVersion.localeCompare(b.policyVersion));
}

async function runSideSelectionDatasetExport({
  client,
  userId,
  connectionId,
  engineCode = ENGINE,
  outcomeVersion,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  outputPath = null,
}) {
  if (!validUuid(userId) || !validUuid(connectionId)) throw new Error('INVALID_DATASET_SCOPE');
  if (typeof engineCode !== 'string' || !engineCode.trim()) throw new Error('INVALID_ENGINE_CODE');
  if (typeof outcomeVersion !== 'string' || !outcomeVersion.trim()) {
    throw new Error('INVALID_OUTCOME_VERSION');
  }
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) {
    throw new Error('INVALID_LOOKBACK_DAYS');
  }

  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '45s'");
    const scope = (await client.query(SCOPE_SQL, [userId, connectionId])).rows[0];
    if (!scope?.snapshotAt) throw new Error('DATASET_SCOPE_UNAVAILABLE');
    const snapshot = dateValue(scope.snapshotAt);
    if (!snapshot) throw new Error('INVALID_DATASET_SNAPSHOT_TIME');

    const rawRows = (
      await client.query(DECISIONS_SQL, [
        userId,
        connectionId,
        engineCode,
        lookbackDays,
        snapshot.toISOString(),
        outcomeVersion,
      ])
    ).rows;
    const simultaneousPairs = groupSimultaneousPairs(rawRows, outcomeVersion);
    const independentPairs = deoverlapPairs(simultaneousPairs);
    const rows = [];
    for (const pair of independentPairs) {
      const buyRow = featureRow(pair, pair.buy, pair.sell);
      const sellRow = featureRow(pair, pair.sell, pair.buy);
      if (buyRow) rows.push(buyRow);
      if (sellRow) rows.push(sellRow);
    }
    rows.sort(
      (a, b) =>
        new Date(a.decision_time).getTime() - new Date(b.decision_time).getTime() ||
        a.instrument.localeCompare(b.instrument) ||
        a.direction.localeCompare(b.direction),
    );

    if (outputPath) {
      const resolved = path.resolve(String(outputPath));
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
    }

    const report = {
      artifact: 'side-selection-three-class-dataset-v1',
      generatedAt: snapshot.toISOString(),
      lookbackDays,
      outcomeVersion,
      pairMaxEvaluationGapSeconds: MAX_PAIR_EVAL_GAP_SECONDS,
      rawResolvedDecisions: rawRows.length,
      simultaneousPairs: simultaneousPairs.length,
      pairedEpisodes: independentPairs.length,
      rows,
      labels: countLabels(rows),
      byPolicy: byPolicy(rows),
      categoricalFeatures: [...CATEGORICAL_FEATURES],
      numericFeatures: [...NUMERIC_FEATURES],
      targetColumns: ['label', 'target_resolved_at', 'target_original_net_r', 'target_opposite_net_r'],
      executionAuthority: 'NONE',
      modifiesExecution: false,
      qualificationEvidence: false,
      approvedForDemo: false,
      approvedForLive: false,
    };
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  require('dotenv').config({
    path: process.env.IREXPRO_API_ENV_PATH || path.join(__dirname, '../.env'),
    quiet: true,
  });
  const { Client } = require('pg');
  const { ENSEMBLE_OUTCOME_MODEL_VERSION } = require('../dist/modules/ai/ensemble-shadow-outcome');
  const { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'irexpro_dev',
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    query_timeout: 50000,
    application_name: 'irexpro-side-selection-three-class-read-only-export',
  });
  try {
    await client.connect();
    const outputPath = process.env.SIDE_SELECTION_DATASET_PATH || null;
    const report = await runSideSelectionDatasetExport({
      client,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.VPS_FOREX_SCANNER_BROKER_CONNECTION_ID,
      engineCode: ENGINE,
      outcomeVersion: ENSEMBLE_OUTCOME_MODEL_VERSION,
      lookbackDays: Number(process.env.SIDE_SELECTION_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS),
      outputPath,
    });
    const { rows, ...summary } = report;
    console.log(
      `SIDE_SELECTION_THREE_CLASS_DATASET ${JSON.stringify({ ...summary, datasetPath: outputPath, rowCount: rows.length })}`,
    );
  } finally {
    await client.end();
  }
}

module.exports = {
  ENGINE,
  SCOPE_SQL,
  DECISIONS_SQL,
  CATEGORICAL_FEATURES,
  NUMERIC_FEATURES,
  groupSimultaneousPairs,
  deoverlapPairs,
  featureRow,
  runSideSelectionDatasetExport,
};

if (require.main === module) {
  main().catch(() => {
    console.error('SIDE_SELECTION_THREE_CLASS_DATASET_FAILED read-only export could not be completed');
    process.exitCode = 1;
  });
}
