'use strict';

/**
 * Causal, user-owned, active-DEMO research only.
 * Compare frozen Plan-B meta predictions with the identical as-of features
 * evaluated using a fixed UTC 12:00 reference hour. This changes ONLY the
 * research meta-score: never Plan-B regime, session/rollover, M1 route, drift,
 * risk, SL/TP, costs, portfolio, order submission or promotion.
 *
 * The noon-reference comparison is an exploratory feature-dependence test,
 * NOT evidence that noon's market conditions exist at another hour.
 */
const { resolve } = require('node:path');

const ARTIFACT = 'planb-utc-hour-factor-asof-funnel-v1';
const MAX_DECISIONS = 16000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_ADMISSION_ONLY = new Set([
  'ENSEMBLE_NOT_PAPER_ADMITTED',
  'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
]);

const SCOPE_SQL = `
  SELECT bc.id AS "connectionId", bc.broker_id AS "brokerId",
         now() AS "snapshotAt"
  FROM trading.trading_sessions ts
  JOIN broker.broker_connections bc
    ON bc.id = ts.broker_connection_id AND bc.user_id = ts.user_id
  WHERE ts.user_id = $1
    AND ts.status = 'ACTIVE' AND ts.execution_mode = 'FULL_AUTO'
    AND bc.deleted_at IS NULL AND bc.account_type = 'DEMO'
    AND bc.broker_id IN ('ctrader','pepperstone-ctrader','icmarkets-ctrader')
  ORDER BY ts.started_at DESC
  LIMIT 1
`;

const DECISIONS_SQL = `
  SELECT d.instrument, d.direction, d.evaluated_at AS "evaluatedAt",
         d.route AS "m1Route",
         d.candidate->>'confidence' AS confidence,
         d.candidate->>'alignedEmaSeparationAtr' AS "alignedEma",
         d.candidate->>'alignedM15' AS "alignedM15",
         d.governance #>> '{oodResearchFeatures,extensionAtr}' AS extension,
         d.governance #>> '{oodResearchFeatures,volatilityScore}' AS volatility,
         d.governance #>> '{oodResearchFeatures,rsi14}' AS rsi,
         d.governance #>> '{oodResearchFeatures,shortHorizonMomentumAtr}' AS momentum,
         d.governance #>> '{multimodelEnsemble,metaProbability}' AS "originalProbability",
         d.governance #>> '{multimodelEnsemble,paperAdmitted}' AS "paperAdmitted",
         d.governance #>> '{multimodelEnsemble,strategyRoute}' AS "strategyRoute",
         d.governance #>> '{multimodelEnsemble,directionQuality}' AS "directionQuality",
         d.governance #>> '{multimodelEnsemble,tradeQuality}' AS "tradeQuality",
         d.governance #>> '{multimodelEnsemble,exitQuality}' AS "exitQuality",
         d.governance #>> '{multimodelEnsemble,sessionQuality}' AS "sessionQuality",
         d.governance #>> '{multimodelEnsemble,portfolioQuality}' AS "portfolioQuality",
         d.governance #>> '{multimodelEnsemble,consensusPassed}' AS "consensusPassed",
         d.governance #>> '{multimodelEnsemble,regime}' AS "regime",
         d.governance #>> '{multimodelEnsemble,regimeAllowed}' AS "regimeAllowed",
         d.governance #>> '{multimodelGovernance,eventRisk}' AS "eventRisk",
         d.governance #>> '{multimodelGovernance,driftState}' AS "driftState",
         d.governance #> '{multimodelGovernance,paperExecutionBlockers}' AS "governanceBlockers"
  FROM trading.m1_tactical_decisions d
  WHERE d.user_id = $1 AND d.broker_connection_id = $2
    AND d.created_at >= $3::timestamptz AND d.created_at < $4::timestamptz
    AND d.instrument IN ('AUDUSD','EURUSD','GBPUSD','USDCAD','USDCHF','USDJPY')
    AND d.direction IN ('BUY','SELL')
  ORDER BY d.created_at ASC, d.id ASC
  LIMIT $5::int
`;

function number(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function referenceNoonUtc(date) {
  const at = new Date(date);
  if (!Number.isFinite(at.getTime())) throw new Error('INVALID_ASOF_TIME');
  at.setUTCHours(12, 0, 0, 0);
  return at;
}
function periodUtc(date) {
  const hour = new Date(date).getUTCHours();
  if (hour < 13) return 'BEFORE_13_UTC';
  if (hour < 14) return 'NEWS_13_UTC';
  if (hour < 20) return 'AFTERNOON_14_TO_20_UTC';
  if (hour < 22) return 'EVENING_20_TO_22_UTC';
  return 'OTHER';
}
function asOfInput(row) {
  const keys = ['confidence','alignedEma','alignedM15','extension','volatility','rsi','momentum','originalProbability'];
  const n = Object.fromEntries(keys.map((key) => [key, number(row[key])]));
  if (Object.values(n).some((value) => value == null)) throw new Error('INCOMPLETE_ASOF_MODEL_FEATURES');
  const at = new Date(row.evaluatedAt);
  if (!Number.isFinite(at.getTime())) throw new Error('INVALID_ASOF_TIME');
  if (!['BUY','SELL'].includes(row.direction)) throw new Error('INVALID_ASOF_DIRECTION');
  return {
    originalProbability: n.originalProbability,
    modelInput: {
      instrument: row.instrument, direction: row.direction,
      confidence: n.confidence,
      extensionAtr: n.extension, volatilityScore: n.volatility,
      emaSeparation: Math.max(0, Math.min(1, n.alignedEma / 2)),
      mtfStrength: Math.max(0, Math.min(1, n.alignedM15)),
      rsi14: n.rsi, shortHorizonMomentumAtr: n.momentum,
      scanTime: at,
    },
  };
}
/**
 * Re-evaluate only the original seven immutable Plan B consensus votes.
 * The regime/route and all non-meta quality scores are deliberately frozen
 * at their original decision-time values. This is NOT a production rescore:
 * a true clock-refit could change regime selection, model calibration and P&L.
 */
function frozenRoutePlanBAdmission(row, meta, originalConfidence) {
  const routes = {
    TREND_CONTINUATION: 0.08,
    CONFIRMED_REVERSAL: 0.18,
    EARLY_TRANSITION: 0.3,
  };
  const floor = routes[row.strategyRoute];
  if (floor === undefined) throw new Error('UNSUPPORTED_FROZEN_PLAN_B_ROUTE');
  const d = number(row.directionQuality);
  const q = number(row.tradeQuality);
  const e = number(row.exitQuality);
  const s = number(row.sessionQuality);
  const p = number(row.portfolioQuality);
  const votesPersisted = number(row.consensusPassed);
  if ([d,q,e,s,p,votesPersisted].some((n)=>n===null)) {
    throw new Error('INCOMPLETE_FROZEN_PLAN_B_CONSENSUS');
  }
  const voteCount = [
    meta.admitted, d>=0.55, q>=0.48, e>=0.48, s>=0.5,
    meta.expectedR>=floor, p>=0.35,
  ].filter(Boolean).length;
  const admitted =
    row.regimeAllowed === 'true' &&
    voteCount>=6 &&
    originalConfidence>=0.64 &&
    meta.admitted &&
    meta.expectedR>=floor &&
    p>=0.35;
  return { admitted, voteCount, votesPersisted };
}
function aggregate(rows, scoreFn) {
  const result = {};
  let checked = 0;
  for (const row of rows) {
    const { originalProbability, modelInput } = asOfInput(row);
    const observed = scoreFn(modelInput);
    if (!Number.isFinite(observed.probability) || !Number.isFinite(observed.expectedR)
      || typeof observed.admitted !== 'boolean'
      || Math.abs(observed.probability - originalProbability) > 1e-8) {
      throw new Error('ACTIVE_PLAN_B_META_REPLAY_MISMATCH');
    }
    const hypothetical = scoreFn({ ...modelInput, scanTime: referenceNoonUtc(modelInput.scanTime) });
    if (!Number.isFinite(hypothetical.probability) || !Number.isFinite(hypothetical.expectedR)
      || typeof hypothetical.admitted !== 'boolean') {
      throw new Error('INVALID_SHADOW_META_PROBABILITY');
    }
    const originalCore = frozenRoutePlanBAdmission(row, observed, modelInput.confidence);
    if (originalCore.voteCount !== originalCore.votesPersisted ||
        originalCore.admitted !== (row.paperAdmitted === 'true')) {
      throw new Error('ACTIVE_PLAN_B_CONSENSUS_REPLAY_MISMATCH');
    }
    const shadowCore = frozenRoutePlanBAdmission(row, hypothetical, modelInput.confidence);
    checked++;
    const key = periodUtc(modelInput.scanTime);
    const out = result[key] || (result[key] = {
      evaluatedDecisions: 0, originalMetaAdmitted: 0, noonReferenceMetaAdmitted: 0,
      newlyMetaAdmitted: 0, newlyMetaRejected: 0,
      newlyFrozenRoutePlanBAdmitted: 0,
      newlyFrozenRoutePlanBAdmittedAndM1AndIndependentGatesClear: 0,
      newlyMetaAdmittedWithRegimeAndIndependentGatesClear: 0,
      originalPlanBAdmitted: 0, m1RoutedDecisions: 0,
      qualifiedRegimeDecisions: 0, rolloverRiskDecisions: 0,
      independentGovernanceVetoDecisions: 0,
      originalProbabilitySum: 0, referenceProbabilitySum: 0,
      originalGrossRSum: 0, referenceGrossRSum: 0,
    });
    out.evaluatedDecisions++;
    out.originalMetaAdmitted += Number(observed.admitted);
    out.noonReferenceMetaAdmitted += Number(hypothetical.admitted);
    const gained = !observed.admitted && hypothetical.admitted;
    out.newlyMetaAdmitted += Number(gained);
    out.newlyMetaRejected += Number(observed.admitted && !hypothetical.admitted);
    const rollover = row.regime === 'ROLLOVER_RISK';
    const regimeAllowed = row.regimeAllowed === 'true' && !rollover;
    const blockers = Array.isArray(row.governanceBlockers) ? row.governanceBlockers : null;
    const independentBlockers = blockers === null
      ? ['MISSING_GOVERNANCE_EVIDENCE']
      : blockers.filter((item) => !MODEL_ADMISSION_ONLY.has(item));
    const independentClear =
      row.eventRisk === 'CLEAR' &&
      row.driftState === 'NORMAL' &&
      independentBlockers.length === 0;
    const routed = row.m1Route !== 'ABSTAIN';
    const newlyFrozenRouteAdmitted = !originalCore.admitted && shadowCore.admitted;
    out.newlyFrozenRoutePlanBAdmitted += Number(newlyFrozenRouteAdmitted);
    // This is a strict screen, NOT execution eligibility: strategy-route
    // vs M1-route consistency, actual quote costs and broker fill remain untested.
    out.newlyFrozenRoutePlanBAdmittedAndM1AndIndependentGatesClear +=
      Number(newlyFrozenRouteAdmitted && routed && independentClear);
    out.newlyMetaAdmittedWithRegimeAndIndependentGatesClear +=
      Number(gained && regimeAllowed && independentClear && routed);
    out.originalPlanBAdmitted += Number(row.paperAdmitted === 'true');
    out.m1RoutedDecisions += Number(routed);
    out.qualifiedRegimeDecisions += Number(regimeAllowed);
    out.rolloverRiskDecisions += Number(rollover);
    out.independentGovernanceVetoDecisions += Number(!independentClear);
    out.originalProbabilitySum += observed.probability;
    out.referenceProbabilitySum += hypothetical.probability;
    out.originalGrossRSum += observed.expectedR;
    out.referenceGrossRSum += hypothetical.expectedR;
  }
  return {
    verifiedReplays: checked,
    byPeriod: Object.fromEntries(Object.entries(result).map(([key, value]) => {
      const n = value.evaluatedDecisions;
      const mean = (v) => Number((v/n).toFixed(4));
      return [key, {
        evaluatedDecisions: n,
        originalMetaAdmitted: value.originalMetaAdmitted,
        noonReferenceMetaAdmitted: value.noonReferenceMetaAdmitted,
        newlyMetaAdmitted: value.newlyMetaAdmitted,
        newlyMetaRejected: value.newlyMetaRejected,
        newlyFrozenRoutePlanBAdmitted: value.newlyFrozenRoutePlanBAdmitted,
        newlyFrozenRoutePlanBAdmittedAndM1AndIndependentGatesClear:
          value.newlyFrozenRoutePlanBAdmittedAndM1AndIndependentGatesClear,
        newlyMetaAdmittedWithRegimeAndIndependentGatesClear:
          value.newlyMetaAdmittedWithRegimeAndIndependentGatesClear,
        originalPlanBAdmitted: value.originalPlanBAdmitted,
        m1RoutedDecisions: value.m1RoutedDecisions,
        qualifiedRegimeDecisions: value.qualifiedRegimeDecisions,
        rolloverRiskDecisions: value.rolloverRiskDecisions,
        independentGovernanceVetoDecisions: value.independentGovernanceVetoDecisions,
        originalMeanMetaProbability: mean(value.originalProbabilitySum),
        noonReferenceMeanMetaProbability: mean(value.referenceProbabilitySum),
        originalMeanGrossExpectedR: mean(value.originalGrossRSum),
        noonReferenceMeanGrossExpectedR: mean(value.referenceGrossRSum),
      }];
    })),
  };
}
async function audit({ client, userId, from, through, scoreFn, maxDecisions = MAX_DECISIONS }) {
  if (!UUID.test(userId || '')) throw new Error('INVALID_USER_SCOPE');
  if (typeof scoreFn !== 'function') throw new Error('MISSING_CURRENT_META_SCORER');
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > MAX_DECISIONS) {
    throw new Error('INVALID_LIMIT');
  }
  const start = new Date(from), end = new Date(through);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
      || end <= start || end - start > 72 * 60 * 60 * 1000) {
    throw new Error('INVALID_ASOF_AUDIT_PERIOD');
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='35s'");
    const scope = (await client.query(SCOPE_SQL, [userId])).rows[0];
    if (!scope || !UUID.test(scope.connectionId || '')) {
      throw new Error('ACTIVE_OWNED_CTRADER_DEMO_UNAVAILABLE');
    }
    const rows = (await client.query(DECISIONS_SQL, [
      userId, scope.connectionId, start.toISOString(), end.toISOString(), maxDecisions + 1,
    ])).rows;
    if (rows.length > maxDecisions) throw new Error('AUDIT_WINDOW_TRUNCATED_FAIL_CLOSED');
    const summary = aggregate(rows, scoreFn);
    await client.query('COMMIT');
    return {
      artifact: ARTIFACT,
      brokerId: scope.brokerId,
      from: start.toISOString(), through: end.toISOString(),
      snapshotAt: new Date(scope.snapshotAt).toISOString(),
      executionAuthority: 'NONE', modifiesExecution: false, promotionEligible: false,
      qualificationEvidence: false, replayStatus: 'EXACT_CURRENT_MODEL_REPRODUCTION',
      methodology: 'ASOF_SAVED_META_SCORE_VS_FIXED_NOON_UTC_REFERENCE_HOUR_ONLY',
      caution: 'The noon reference is not real trading at other hours. Frozen-route Plan B admission only holds original regime and quality scores; it is not a full Plan B rerun. M1 strategy agreement, spread, portfolio, risk vetoes, realized P&L and broker execution are not proven. Repeated decisions are not independent trades; no model promotion.',
      ...summary,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
async function main() {
  require('dotenv').config({ path: process.env.IREXPRO_API_ENV_PATH || resolve(__dirname, '../.env'), quiet: true });
  const { Client } = require('pg');
  const { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const { scorePlanBShadowMeta } = require('../dist/modules/ai/v8-shadow-meta-scorer');
  const now = new Date();
  const from = process.env.PLANB_CLOCK_AUDIT_FROM || new Date(now.getTime()-12*3600000).toISOString();
  const through = process.env.PLANB_CLOCK_AUDIT_THROUGH || now.toISOString();
  const client = new Client({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'irexpro_dev', user: process.env.DB_USER || 'irexpro',
    password: process.env.DB_PASSWORD, ssl: getDatabaseSslOptions(process.env.DB_SSL==='true'),
    connectionTimeoutMillis: 10000, query_timeout: 40000,
    application_name: 'irexpro-planb-clock-factor-asof-readonly',
  });
  try {
    await client.connect();
    const report = await audit({
      client, userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      from, through, scoreFn: scorePlanBShadowMeta,
    });
    console.log('PLANB_CLOCK_FACTOR_RESEARCH ' + JSON.stringify(report));
  } finally {
    await client.end();
  }
}
module.exports = { ARTIFACT, SCOPE_SQL, DECISIONS_SQL, MAX_DECISIONS,
  number, referenceNoonUtc, periodUtc, asOfInput,
  frozenRoutePlanBAdmission, aggregate, audit };
if (require.main === module) main().catch((error) => {
  console.error('PLANB_CLOCK_FACTOR_RESEARCH_FAILED ' +
    String(error?.message || 'UNKNOWN').slice(0,200));
  process.exitCode = 1;
});
