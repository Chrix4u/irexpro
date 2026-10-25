'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ACTIVE_ENGINE = 'irexpro-multimodel-ensemble-v1';
const CHAMPION_MODEL_VERSION = `external-provider/${ACTIVE_ENGINE}/paper-only-v1`;
const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];

const DEFAULT_SIX_PAIR_SUMMARY =
  '/home/lightworld/research/irexpro-six-pair/341e107b0066f26b3b373e29a2329f007bda35b4/reports/six_pair_walkforward_summary.json';
const DEFAULT_BROKER_PROSPECTIVE =
  '/home/lightworld/research/irexpro-broker-prospective-20261025/services/ai-engine/reports/broker-native-v84-base-h5-prospective-v1-814d10fc.json';

const SCOPE_SQL = `
  SELECT CURRENT_TIMESTAMP AS "snapshotAt"
  FROM broker.broker_connections
  WHERE user_id = $1
    AND id = $2
    AND broker_id = 'paper-broker'
    AND deleted_at IS NULL
`;

const TRADES_SQL = `
  SELECT
    t.instrument,
    t.direction,
    ti.timeframe,
    ti.model_version AS "modelVersion",
    ti.metadata->>'plan_b_ensemble_strategy_route' AS "strategyRoute",
    ti.metadata->>'decision_policy_version' AS "decisionPolicyVersion",
    t.realised_pnl AS "realisedPnl",
    t.opened_at AS "openedAt"
  FROM trading.trades t
  JOIN trading.trade_intents ti
    ON ti.id = t.trade_intent_id
    AND ti.user_id = $1
    AND ti.broker_connection_id = $2
  JOIN broker.broker_connections bc
    ON bc.id = t.broker_connection_id
    AND bc.user_id = $1
    AND bc.id = $2
    AND bc.broker_id = 'paper-broker'
    AND bc.deleted_at IS NULL
  WHERE t.user_id = $1
    AND t.broker_connection_id = $2
    AND t.status = 'CLOSED'
    AND t.realised_pnl IS NOT NULL
    AND ti.status = 'EXECUTED'
    AND ti.metadata->>'signal_source' = 'EXTERNAL_PROVIDER'
    AND ti.metadata->>'external_provider_code' = '${ACTIVE_ENGINE}'
  ORDER BY t.opened_at ASC, t.id ASC
`;

function validateScopeValue(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code);
  return value;
}

function normalizeTradeRows(rows) {
  return rows.map((row) => ({
    instrument: String(row.instrument ?? '').trim().toUpperCase(),
    direction: row.direction,
    timeframe: String(row.timeframe ?? ''),
    modelVersion: String(row.modelVersion ?? ''),
    strategyRoute: row.strategyRoute == null ? null : String(row.strategyRoute),
    decisionPolicyVersion:
      row.decisionPolicyVersion == null ? null : String(row.decisionPolicyVersion),
    realisedPnl: Number(row.realisedPnl),
    openedAt: row.openedAt,
  }));
}

function normalizeSixPairResearch(summary) {
  const horizons = {};
  for (const horizon of ['1m', '5m', '10m']) {
    const gate = summary?.horizon_reports?.[horizon]?.research_gate;
    if (
      !gate ||
      typeof gate.research_gate_passed !== 'boolean' ||
      !gate.observed ||
      typeof gate.observed !== 'object'
    ) {
      throw new Error('INVALID_SIX_PAIR_RESEARCH_EVIDENCE');
    }
    horizons[horizon] = {
      researchGatePassed: gate.research_gate_passed,
      observed: {
        balancedAccuracy: gate.observed.balanced_accuracy ?? null,
        profitFactor: gate.observed.profit_factor ?? null,
        sharpeRatio: gate.observed.sharpe_ratio ?? null,
        maxDrawdown: gate.observed.max_drawdown ?? null,
        positiveFoldFraction: gate.observed.positive_fold_fraction ?? null,
        positiveInstrumentFraction: gate.observed.positive_instrument_fraction ?? null,
      },
    };
  }
  return {
    verdict: Object.values(horizons).every((item) => item.researchGatePassed === false)
      ? 'REJECTED_ALL_HORIZONS'
      : 'NOT_REJECTED_ALL_HORIZONS',
    purpose: 'FROZEN_DUKASCOPY_GENERIC_CLASSIFIER_REJECTION_BASELINE',
    horizons,
  };
}

function normalizeBrokerProspective(report) {
  if (
    typeof report?.artifact !== 'string' ||
    typeof report?.economic_screen_passed !== 'boolean' ||
    typeof report?.next_action !== 'string' ||
    !report?.metrics ||
    typeof report.metrics !== 'object'
  ) {
    throw new Error('INVALID_BROKER_PROSPECTIVE_EVIDENCE');
  }
  return {
    artifact: report.artifact,
    mode: report.mode ?? null,
    verdict: report.economic_screen_passed ? 'NOT_REJECTED' : 'REJECTED',
    economicScreenPassed: report.economic_screen_passed,
    nextAction: report.next_action,
    metrics: {
      trades: report.metrics.n ?? null,
      profitFactor: report.metrics.profit_factor ?? null,
      sharpe: report.metrics.sharpe ?? null,
      balancedAccuracy: report.metrics.balanced_accuracy ?? null,
      positiveInstrumentFraction: report.metrics.positive_instrument_fraction ?? null,
      netReturn: report.metrics.net_return ?? null,
    },
    promotionEligible: false,
  };
}

async function runPaperChampionEvidenceAudit({
  client,
  buildPaperChampionEvidence,
  compatiblePolicyVersions,
  championModelVersion,
  expectedInstruments,
  userId,
  connectionId,
  sixPairSummary,
  brokerProspective,
}) {
  validateScopeValue(userId, 'INVALID_AUDIT_USER_SCOPE');
  validateScopeValue(connectionId, 'INVALID_AUDIT_CONNECTION_SCOPE');
  if (typeof buildPaperChampionEvidence !== 'function') {
    throw new Error('INVALID_CHAMPION_EVIDENCE_BUILDER');
  }
  if (!Array.isArray(compatiblePolicyVersions)) throw new Error('INVALID_COMPATIBLE_POLICY_VERSIONS');
  if (!Array.isArray(expectedInstruments) || expectedInstruments.length === 0) {
    throw new Error('INVALID_EXPECTED_INSTRUMENTS');
  }

  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const scope = (await client.query(SCOPE_SQL, [userId, connectionId])).rows[0];
    if (!scope?.snapshotAt) throw new Error('PAPER_SCOPE_UNAVAILABLE');
    const snapshotAt = new Date(scope.snapshotAt);
    if (!Number.isFinite(snapshotAt.getTime())) throw new Error('INVALID_AUDIT_SNAPSHOT_TIME');

    const genericSixPair = normalizeSixPairResearch(sixPairSummary);
    const brokerNativeProspective = normalizeBrokerProspective(brokerProspective);
    const rawTrades = (await client.query(TRADES_SQL, [userId, connectionId])).rows;
    const forward = buildPaperChampionEvidence(normalizeTradeRows(rawTrades), {
      championModelVersion,
      expectedInstruments,
      compatiblePolicyVersions,
    });

    const report = {
      artifact: 'friday-champion-evidence-v1',
      mode: 'READ_ONLY_EVIDENCE_AUDIT',
      generatedAt: snapshotAt.toISOString(),
      modifiesExecution: false,
      approvedForPaper: false,
      approvedForDemo: false,
      approvedForLive: false,
      forward,
      research: {
        genericSixPair,
        brokerNativeProspective,
      },
      governance: {
        balancedAccuracyEstablishedByForwardLedger: false,
        formalWalkForwardSharpeEstablishedByForwardLedger: false,
        percentageMaxDrawdownEstablishedByForwardLedger: false,
        note: 'Forward realised-trade evidence can nominate a provisional champion but cannot grant promotion authority.',
      },
    };
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function readJsonRequired(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(code);
  }
}

async function main() {
  const envPath =
    process.env.IREXPRO_API_ENV_PATH || path.join(__dirname, '../.env');
  require('dotenv').config({ path: envPath, quiet: true });

  const { Client } = require('pg');
  const { buildPaperChampionEvidence } = require('../dist/modules/ai/paper-champion-evidence');
  const {
    PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS,
  } = require('../dist/modules/ai/plan-b-multimodel-shadow');
  const { getDatabaseSslOptions } = require('../dist/config/database-tls');

  const sixPairSummary = readJsonRequired(
    process.env.IREXPRO_SIX_PAIR_SUMMARY_PATH || DEFAULT_SIX_PAIR_SUMMARY,
    'SIX_PAIR_RESEARCH_FILE_UNAVAILABLE',
  );
  const brokerProspective = readJsonRequired(
    process.env.IREXPRO_BROKER_PROSPECTIVE_PATH || DEFAULT_BROKER_PROSPECTIVE,
    'BROKER_PROSPECTIVE_FILE_UNAVAILABLE',
  );

  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'irexpro_dev',
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    query_timeout: 35000,
    application_name: 'irexpro-paper-champion-read-only-audit',
  });

  try {
    await client.connect();
    const report = await runPaperChampionEvidenceAudit({
      client,
      buildPaperChampionEvidence,
      compatiblePolicyVersions: [...PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS],
      championModelVersion: CHAMPION_MODEL_VERSION,
      expectedInstruments: PAIRS,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.VPS_FOREX_SCANNER_BROKER_CONNECTION_ID,
      sixPairSummary,
      brokerProspective,
    });
    console.log(`PAPER_CHAMPION_EVIDENCE ${JSON.stringify(report)}`);
  } finally {
    await client.end();
  }
}

module.exports = {
  ACTIVE_ENGINE,
  CHAMPION_MODEL_VERSION,
  PAIRS,
  SCOPE_SQL,
  TRADES_SQL,
  normalizeSixPairResearch,
  normalizeBrokerProspective,
  runPaperChampionEvidenceAudit,
};

if (require.main === module) {
  main().catch(() => {
    console.error('PAPER_CHAMPION_EVIDENCE_FAILED read-only audit could not be completed');
    process.exitCode = 1;
  });
}
