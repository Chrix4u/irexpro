'use strict';

const ENGINE = 'irexpro-multimodel-ensemble-v1';

const SCOPE_SQL = `
  SELECT CURRENT_TIMESTAMP AS "snapshotAt"
  FROM broker.broker_connections
  WHERE user_id = $1
    AND id = $2
    AND broker_id = 'paper-broker'
    AND deleted_at IS NULL
`;

const SHADOW_SQL = `
  SELECT
    instrument,
    direction,
    evaluated_at AS "evaluatedAt",
    components->'outcome' AS outcome
  FROM trading.ensemble_shadow_decisions
  WHERE user_id = $1
    AND broker_connection_id = $2
    AND engine_code = $3
    AND components->'paperResearchRequalificationShadow'->>'artifact' = $4
    AND components->'paperResearchRequalificationShadow'->>'candidate' = 'true'
    AND (
      NOT (components ? 'outcome')
      OR components->'outcome'->>'version' = $5
    )
  ORDER BY instrument, direction, evaluated_at, id
`;

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value ?? '',
  );
}

function parseOutcome(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeEpisodes(episodes, summarizeEnsembleSleeveOutcomes, classifyEvidence) {
  const sleeve = summarizeEnsembleSleeveOutcomes(episodes);
  const resolved = episodes.filter(
    (episode) =>
      episode &&
      episode.status !== 'AMBIGUOUS' &&
      episode.netR != null &&
      Number.isFinite(Number(episode.netR)),
  );
  const returns = resolved.map((episode) => Number(episode.netR));
  const wins = returns.filter((value) => value > 0).length;
  const losses = returns.filter((value) => value < 0).length;
  const netR = returns.reduce((sum, value) => sum + value, 0);
  const metrics = {
    episodes: sleeve.closedTrades,
    wins,
    losses,
    netR,
    profitFactor: sleeve.profitFactor,
    sharpe: sleeve.sharpe,
    maxDrawdown: sleeve.maxDrawdown,
    positiveWindowFraction: sleeve.positiveWindowFraction,
  };
  return {
    metrics,
    scorecard: classifyEvidence(metrics),
  };
}

async function runPaperResearchRequalificationShadowAudit({
  client,
  collapseEnsembleOutcomeEpisodes,
  summarizeEnsembleSleeveOutcomes,
  evaluatePaperResearchRequalificationEvidence,
  artifact,
  outcomeVersion,
  engineCode,
  userId,
  connectionId,
}) {
  if (!validUuid(userId) || !validUuid(connectionId)) throw new Error('INVALID_AUDIT_SCOPE');
  if (
    typeof artifact !== 'string' ||
    artifact.trim() === '' ||
    typeof outcomeVersion !== 'string' ||
    outcomeVersion.trim() === '' ||
    typeof engineCode !== 'string' ||
    engineCode.trim() === ''
  ) {
    throw new Error('INVALID_AUDIT_CONFIGURATION');
  }
  if (
    typeof collapseEnsembleOutcomeEpisodes !== 'function' ||
    typeof summarizeEnsembleSleeveOutcomes !== 'function' ||
    typeof evaluatePaperResearchRequalificationEvidence !== 'function'
  ) {
    throw new Error('INVALID_AUDIT_HELPERS');
  }

  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const scope = (await client.query(SCOPE_SQL, [userId, connectionId])).rows[0];
    if (!scope?.snapshotAt) throw new Error('PAPER_SCOPE_UNAVAILABLE');
    const generatedAt = new Date(scope.snapshotAt);
    if (!Number.isFinite(generatedAt.getTime())) throw new Error('INVALID_AUDIT_SNAPSHOT_TIME');

    const rows = (
      await client.query(SHADOW_SQL, [userId, connectionId, engineCode, artifact, outcomeVersion])
    ).rows;
    const grouped = new Map();
    for (const row of rows) {
      const instrument = String(row.instrument ?? '')
        .trim()
        .toUpperCase();
      const direction = row.direction === 'BUY' || row.direction === 'SELL' ? row.direction : null;
      const evaluatedAt = new Date(row.evaluatedAt);
      if (!instrument || !direction || !Number.isFinite(evaluatedAt.getTime())) continue;
      const key = `${instrument}:${direction}`;
      const observations = grouped.get(key) ?? [];
      observations.push({ evaluatedAt: row.evaluatedAt, outcome: parseOutcome(row.outcome) });
      grouped.set(key, observations);
    }

    const byPairSide = [];
    const allEpisodes = [];
    for (const [pairSide, observations] of [...grouped.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const episodes = collapseEnsembleOutcomeEpisodes(observations);
      allEpisodes.push(...episodes);
      byPairSide.push({
        pairSide,
        annotatedDecisions: observations.length,
        ...summarizeEpisodes(
          episodes,
          summarizeEnsembleSleeveOutcomes,
          evaluatePaperResearchRequalificationEvidence,
        ),
      });
    }
    allEpisodes.sort(
      (a, b) => new Date(a.resolvedAt).getTime() - new Date(b.resolvedAt).getTime(),
    );

    const report = {
      artifact: 'paper-research-requalification-shadow-audit-v1',
      sourceArtifact: artifact,
      outcomeVersion,
      mode: 'READ_ONLY_SHADOW_RECOVERY_AUDIT',
      generatedAt: generatedAt.toISOString(),
      executionAuthority: 'NONE',
      modifiesExecution: false,
      qualificationEvidence: false,
      productionEligible: false,
      annotatedDecisions: rows.length,
      resolvedOutcomeRows: rows.filter((row) => parseOutcome(row.outcome) !== null).length,
      overall: summarizeEpisodes(
        allEpisodes,
        summarizeEnsembleSleeveOutcomes,
        evaluatePaperResearchRequalificationEvidence,
      ),
      byPairSide,
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
  require('dotenv').config({ path: process.env.IREXPRO_API_ENV_PATH || path.join(__dirname, '../.env'), quiet: true });
  if (process.env.VPS_FOREX_SCANNER_ENABLED !== 'true') {
    console.log('PAPER_RESEARCH_REQUALIFICATION_SHADOW_AUDIT_SKIPPED scanner_disabled');
    return;
  }
  const { Client } = require('pg');
  const {
    ENSEMBLE_OUTCOME_MODEL_VERSION,
    collapseEnsembleOutcomeEpisodes,
    summarizeEnsembleSleeveOutcomes,
  } = require('../dist/modules/ai/ensemble-shadow-outcome');
  const {
    PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT,
    evaluatePaperResearchRequalificationEvidence,
  } = require('../dist/modules/ai/paper-research-requalification-shadow');
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
    application_name: 'irexpro-paper-research-requalification-shadow-read-only-audit',
  });
  try {
    await client.connect();
    const report = await runPaperResearchRequalificationShadowAudit({
      client,
      collapseEnsembleOutcomeEpisodes,
      summarizeEnsembleSleeveOutcomes,
      evaluatePaperResearchRequalificationEvidence,
      artifact: PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT,
      outcomeVersion: ENSEMBLE_OUTCOME_MODEL_VERSION,
      engineCode: ENGINE,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.VPS_FOREX_SCANNER_BROKER_CONNECTION_ID,
    });
    console.log(`PAPER_RESEARCH_REQUALIFICATION_SHADOW_AUDIT ${JSON.stringify(report)}`);
  } finally {
    await client.end();
  }
}

module.exports = {
  ENGINE,
  SCOPE_SQL,
  SHADOW_SQL,
  runPaperResearchRequalificationShadowAudit,
};

if (require.main === module) {
  main().catch(() => {
    console.error(
      'PAPER_RESEARCH_REQUALIFICATION_SHADOW_AUDIT_FAILED read-only audit could not be completed',
    );
    process.exitCode = 1;
  });
}
