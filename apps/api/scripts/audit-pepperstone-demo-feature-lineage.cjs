#!/usr/bin/env node
'use strict';
// Read-only, owner-bound, DEMO-only causal feature-lineage and admission audit.
// This script does not call trading services, alter market rules or authorize orders.
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync, renameSync, chmodSync } = require('node:fs');

const ARTIFACT = 'pepperstone-demo-feature-lineage-readonly-v1';
const PAIRS = ['AUDUSD', 'EURUSD', 'GBPUSD', 'USDCAD', 'USDCHF', 'USDJPY'];
const MAX_ROWS = 4800;
const REPORT = '/home/lightworld/webapps/irexpro-research/feature-lineage/latest-report.json';
const SCOPE_SQL = `
SELECT b.id FROM trading.trading_sessions s
JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id
WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
AND b.deleted_at IS NULL AND b.status='CONNECTED' AND b.authorization_status='ACTIVE'
ORDER BY s.authority_generation DESC,s.started_at DESC LIMIT 1
`;
const DECISIONS_SQL = `
SELECT d.instrument,d.direction,d.evaluated_at AS "evaluatedAt",d.route AS "m1Route",
 d.candidate->>'confidence' AS confidence,
 d.candidate->>'directionQuality' AS "m1Quality",
 d.candidate->>'alignedEmaSeparationAtr' AS "rawAlignedEma",
 d.candidate->>'alignedM15' AS "rawAlignedM15",
 d.governance->'oodResearchFeatures' AS "asofFeatures",
 d.governance #>> '{multimodelEnsemble,strategyRoute}' AS "planBRoute",
 d.governance #>> '{multimodelEnsemble,paperAdmitted}' AS "planBAdmitted",
 d.governance #>> '{multimodelGovernance,paperExecutionEligible}' AS "governanceEligible",
 d.governance #>> '{multimodelGovernance,driftState}' AS "driftState",
 d.governance #> '{multimodelGovernance,driftDiagnostics}' AS "driftReasons",
 d.governance #>> '{advisoryAlternateTrial,reason}' AS "advisoryReason",
 d.governance #>> '{multimodelTrainedExpert,direction}' AS "expertDirection",
 d.governance #>> '{multimodelTrainedExpert,meanOpportunityProbability}' AS "expertProbability",
 d.execution_authority AS "executionAuthority"
FROM trading.m1_tactical_decisions d
WHERE d.user_id=$1 AND d.broker_connection_id=$2
 AND d.evaluated_at >= $3::timestamptz AND d.evaluated_at < $4::timestamptz
 AND d.instrument=ANY($5::text[]) AND d.direction IN ('BUY','SELL')
ORDER BY d.evaluated_at ASC,d.id ASC LIMIT $6
`;
function numeric(x) {
  if (x === null || x === undefined || x === '') return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function lineage(row) {
  const a = numeric(row.rawAlignedEma),
    m = numeric(row.rawAlignedM15);
  const f = row.asofFeatures && typeof row.asofFeatures === 'object' ? row.asofFeatures : {};
  const expectedEma = a === null ? null : clamp01(a / 2);
  const expectedMtf = m === null ? null : clamp01(m);
  const actualEma = numeric(f.emaSeparation),
    actualMtf = numeric(f.mtfStrength);
  const valid = [expectedEma, expectedMtf, actualEma, actualMtf].every((x) => x !== null);
  return {
    complete: valid,
    emaMismatch: valid && Math.abs(expectedEma - actualEma) > 1e-9,
    mtfMismatch: valid && Math.abs(expectedMtf - actualMtf) > 1e-9,
    negativeEmaClampedToZero: valid && a < 0 && actualEma === 0,
    negativeMtfClampedToZero: valid && m < 0 && actualMtf === 0,
    zeroFromClipping: valid && ((a < 0 && actualEma === 0) || (m < 0 && actualMtf === 0)),
  };
}
function quantiles(nums) {
  const v = nums.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => {
    if (!v.length) return null;
    const at = (v.length - 1) * p,
      lo = Math.floor(at),
      hi = Math.ceil(at);
    return v[lo] + (v[hi] - v[lo]) * (at - lo);
  };
  const round = (x) => (x === null ? null : Number(x.toFixed(6)));
  return { n: v.length, p10: round(q(0.1)), median: round(q(0.5)), p90: round(q(0.9)) };
}
function analyze(rows, { start, end }) {
  const byRoute = {},
    features = {},
    diagnostics = {},
    advisory = {},
    byInstrument = {};
  const sums = {
    rows: rows.length,
    missingLineage: 0,
    emaTransformMismatch: 0,
    mtfTransformMismatch: 0,
    negativeEmaClampedToZero: 0,
    negativeMtfClampedToZero: 0,
    admittedAlternates: 0,
    admittedAlternatesOOD: 0,
    admittedAlternatesM1QualityBelow055: 0,
    independentExpertOpposesAdmittedAlternative: 0,
    brokerAuthorized: 0,
  };
  for (const row of rows) {
    if (!PAIRS.includes(row.instrument) || !['BUY', 'SELL'].includes(row.direction))
      throw Error('BAD_SCOPED_DECISION');
    const date = new Date(row.evaluatedAt).getTime();
    if (
      !Number.isFinite(date) ||
      date < new Date(start).getTime() ||
      date >= new Date(end).getTime()
    )
      throw Error('INVALID_ASOF_DECISION_TIME');
    const route = ['TREND_CONTINUATION', 'CONFIRMED_REVERSAL', 'EARLY_TRANSITION'].includes(
      row.planBRoute,
    )
      ? row.planBRoute
      : 'OTHER';
    const bucket = (byRoute[route] ??= {
      scans: 0,
      ood: 0,
      admitted: 0,
      governanceEligible: 0,
      brokerAuthorized: 0,
      m1RouteCounts: {},
      features: {},
      diagnostics: {},
    });
    bucket.scans++;
    const ood = row.driftState === 'OUT_OF_DISTRIBUTION';
    if (ood) bucket.ood++;
    if (row.planBAdmitted === 'true') bucket.admitted++;
    if (row.governanceEligible === 'true') bucket.governanceEligible++;
    if (row.executionAuthority === 'BROKER_NATIVE') {
      sums.brokerAuthorized++;
      bucket.brokerAuthorized++;
    }
    bucket.m1RouteCounts[row.m1Route] = (bucket.m1RouteCounts[row.m1Route] || 0) + 1;
    const k = row.instrument;
    byInstrument[k] ??= { scans: 0, ood: 0, admittedAlternate: 0 };
    byInstrument[k].scans++;
    if (ood) byInstrument[k].ood++;
    for (const label of Array.isArray(row.driftReasons) ? row.driftReasons : [])
      if (typeof label === 'string' && label.length < 80) {
        diagnostics[label] = (diagnostics[label] || 0) + 1;
        bucket.diagnostics[label] = (bucket.diagnostics[label] || 0) + 1;
      }
    const lf = lineage(row);
    if (!lf.complete) sums.missingLineage++;
    if (lf.emaMismatch) sums.emaTransformMismatch++;
    if (lf.mtfMismatch) sums.mtfTransformMismatch++;
    if (lf.negativeEmaClampedToZero) sums.negativeEmaClampedToZero++;
    if (lf.negativeMtfClampedToZero) sums.negativeMtfClampedToZero++;
    for (const [name, raw] of Object.entries({
      rawAlignedEma: row.rawAlignedEma,
      rawAlignedM15: row.rawAlignedM15,
      emaSeparation: row.asofFeatures?.emaSeparation,
      mtfStrength: row.asofFeatures?.mtfStrength,
      volatilityScore: row.asofFeatures?.volatilityScore,
      extensionAtr: row.asofFeatures?.extensionAtr,
      confidence: row.confidence,
      m1Quality: row.m1Quality,
    })) {
      const n = numeric(raw);
      (features[name] ??= []).push(n);
      (bucket.features[name] ??= []).push(n);
    }
    if (row.advisoryReason) advisory[row.advisoryReason] = (advisory[row.advisoryReason] || 0) + 1;
    if (
      ['CONFIRMED_REVERSAL', 'EARLY_TRANSITION'].includes(route) &&
      row.planBAdmitted === 'true'
    ) {
      sums.admittedAlternates++;
      byInstrument[k].admittedAlternate++;
      if (ood) sums.admittedAlternatesOOD++;
      const quality = numeric(row.m1Quality);
      if (quality !== null && quality < 0.55) sums.admittedAlternatesM1QualityBelow055++;
      if (row.expertDirection && row.expertDirection !== row.direction)
        sums.independentExpertOpposesAdmittedAlternative++;
    }
  }
  const finalize = (items) =>
    Object.fromEntries(Object.entries(items).map(([k, v]) => [k, quantiles(v)]));
  for (const bucket of Object.values(byRoute)) bucket.features = finalize(bucket.features);
  return {
    artifact: ARTIFACT,
    authority: 'READ_ONLY_RESEARCH',
    modifiesExecution: false,
    window: { start, end },
    sample: { ...sums, independentTrades: 'NOT_MEASURED_REPEATED_SCANS' },
    byRoute,
    byInstrument,
    diagnostics,
    advisoryReasons: advisory,
    featureQuantiles: finalize(features),
    limitations: [
      'Repeated per-minute pair-side observations are not independent trade entries',
      'Static feature-envelope comparisons do not prove profit or an incorrect normalization',
      'Quantiles are from a bounded read-only DEMO time window, not the immutable training corpus',
      'This report does not evaluate broker-native first stop/target outcomes',
    ],
  };
}
async function runAudit({ pgModule, env = process.env, now = new Date(), write = true } = {}) {
  const { Client } = pgModule || require('pg');
  const to = new Date(now);
  const from = new Date(to.getTime() - 6 * 3600000);
  if (!Number.isFinite(to.getTime())) throw Error('INVALID_REPORT_TIME');
  if (!env.VPS_FOREX_SCANNER_USER_ID || !env.DB_HOST || !env.DB_NAME || !env.DB_USER)
    throw Error('MISSING_OWNER_OR_DATABASE_SCOPE');
  const c = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 16000,
  });
  let began = false;
  try {
    await c.connect();
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    began = true;
    const scope = await c.query(SCOPE_SQL, [env.VPS_FOREX_SCANNER_USER_ID]);
    if (scope.rowCount !== 1) throw Error('NO_EXACT_ACTIVE_OWNER_PEPPERSTONE_DEMO');
    const q = await c.query(DECISIONS_SQL, [
      env.VPS_FOREX_SCANNER_USER_ID,
      scope.rows[0].id,
      from.toISOString(),
      to.toISOString(),
      PAIRS,
      MAX_ROWS + 1,
    ]);
    if (q.rows.length > MAX_ROWS) throw Error('AUDIT_WINDOW_TRUNCATED_REDUCE_TIME_WINDOW');
    const report = analyze(q.rows, { start: from.toISOString(), end: to.toISOString() });
    await c.query('COMMIT');
    began = false;
    if (write) {
      const { dirname } = require('node:path');
      const folder = dirname(REPORT);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const tmp = REPORT + '.tmp-' + process.pid;
      writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, REPORT);
    }
    return report;
  } catch (e) {
    if (began) await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
if (require.main === module) {
  require('dotenv').config({ path: resolve(__dirname, '../.env'), quiet: true });
  runAudit()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error('FEATURE_LINEAGE_AUDIT_FAILED', e.message);
      process.exitCode = 1;
    });
}
module.exports = {
  ARTIFACT,
  PAIRS,
  MAX_ROWS,
  SCOPE_SQL,
  DECISIONS_SQL,
  numeric,
  lineage,
  quantiles,
  analyze,
  runAudit,
};
