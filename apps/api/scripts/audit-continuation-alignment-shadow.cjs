'use strict';

/**
 * Purely retrospective, read-only cTrader DEMO study of a predeclared
 * four-feature continuation alignment hypothesis. This code must never be
 * imported into broker execution, model admission or risk management.
 */
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { DECISIONS_SQL: OOD_DECISIONS_SQL, FEES_SQL } = require('./audit-ood-regime-shadow.cjs');
const {
  pathState,
  feeRiskSample,
  median,
} = require('./audit-wednesday-six-pair-policy-shadow.cjs');

const ARTIFACT = 'normal-drift-m1-continuation-four-feature-asof-shadow-v1';
const REPORT =
  '/home/lightworld/webapps/irexpro-research/continuation-alignment/latest-report.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const START = '2026-11-04T00:00:00Z';
const SPLIT = '2026-11-06T00:00:00Z'; // Fixed chronology, not fitted from price outcomes
const MAX = 1200;

function replaceExactlyOnce(text, from, to) {
  if (text.split(from).length !== 2) throw Error('UNVERIFIED_SQL_REPLACEMENT');
  return text.replace(from, to);
}
const DECISIONS_SQL = replaceExactlyOnce(
  replaceExactlyOnce(
    replaceExactlyOnce(
      OOD_DECISIONS_SQL,
      "AND d.governance #>> '{genericGovernance,driftState}'='OUT_OF_DISTRIBUTION'",
      "AND d.governance #>> '{genericGovernance,driftState}'='NORMAL'",
    ),
    "AND d.direction IN ('BUY','SELL') AND d.route<>'ABSTAIN'",
    "AND d.direction IN ('BUY','SELL') AND d.route='M1_TREND_CONTINUATION'",
  ),
  'SELECT d.instrument,d.direction,d.created_at AS "createdAt",',
  'SELECT d.candidate AS candidate,d.instrument,d.direction,d.created_at AS "createdAt",',
);

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function alignedContinuation(c) {
  if (!c || typeof c !== 'object') return false;
  const h1 = positiveNumber(c.alignedH1),
    h4 = positiveNumber(c.alignedH4),
    m5 = positiveNumber(c.alignedM5),
    quality = positiveNumber(c.directionQuality);
  return (
    h1 !== null &&
    h4 !== null &&
    m5 !== null &&
    quality !== null &&
    h1 >= 0 &&
    h4 >= 0 &&
    m5 >= 0.3 &&
    quality >= 0.65
  );
}
function asofFees(rows, samples) {
  const at = new Date(rows.createdAt).getTime();
  const earlier = samples
    .filter((x) => x.instrument === rows.instrument && x.closedAt < at)
    .map((x) => x.commissionR);
  return earlier.length >= 3 ? median(earlier) : null;
}
function assess(row, commissionR) {
  const outcome = pathState(row);
  const validCost = Number.isFinite(commissionR) && commissionR >= 0;
  let hold15mNetR = null,
    stressNetR = null;
  let stressState = 'CENSORED';
  if (outcome.state === 'UNOBSERVABLE') stressState = 'UNOBSERVABLE';
  else if (!validCost) stressState = 'INSUFFICIENT_ASOF_BROKER_COMMISSION';
  else if (outcome.state === 'NO_BARRIER_TOUCH') {
    hold15mNetR = outcome.grossR - commissionR;
    stressNetR = hold15mNetR;
    stressState = 'BARRIER_FREE_15M';
  } else if (outcome.state === 'POSSIBLE_STOP_BEFORE_TARGET') {
    // Deliberately pessimistic: possible midpoint/quote stop touch treated
    // as a stress loss, not falsely described as an actual broker stop fill.
    stressNetR = -1 - commissionR;
    stressState = 'POSSIBLE_STOP_STRESS_LOSS';
  } else if (outcome.state === 'POSSIBLE_TARGET_BEFORE_STOP' && outcome.quoteTargetFirst) {
    const entry = positiveNumber(row.direction === 'BUY' ? row.entryAsk : row.entryBid);
    const target = positiveNumber(row.takeProfit),
      stop = positiveNumber(row.stopLoss);
    const risk = entry !== null && stop !== null ? Math.abs(entry - stop) : 0;
    const reward = entry !== null && target !== null ? Math.abs(target - entry) : 0;
    if (risk > 0 && reward > 0) {
      stressNetR = reward / risk - commissionR;
      stressState = 'QUOTE_TARGET_FIRST_PROXY';
    }
  }
  return { outcome, stressState, stressNetR, hold15mNetR };
}
function summarize(items) {
  const s = {
    episodes: items.length,
    observable: 0,
    unobservable: 0,
    possibleStops: 0,
    possibleTargets: 0,
    barrierFree: 0,
    costCalibratedBarrierFree: 0,
    barrierFreeNetRSum: 0,
    stressMeasured: 0,
    stressWinCount: 0,
    stressNetRSum: 0,
    possibleStopStressLosses: 0,
    ambiguousOrCostUnknown: 0,
    meanStressNetR: null,
    meanBarrierFreeNetR: null,
    utcDays: [],
  };
  const days = new Set();
  for (const x of items) {
    days.add(x.day);
    if (x.observation.outcome.state === 'UNOBSERVABLE') s.unobservable++;
    else s.observable++;
    if (x.observation.outcome.stopPossible) s.possibleStops++;
    if (x.observation.outcome.targetPossible) s.possibleTargets++;
    if (x.observation.outcome.state === 'NO_BARRIER_TOUCH') s.barrierFree++;
    if (x.observation.hold15mNetR !== null) {
      s.costCalibratedBarrierFree++;
      s.barrierFreeNetRSum += x.observation.hold15mNetR;
    }
    if (x.observation.stressNetR !== null) {
      s.stressMeasured++;
      s.stressNetRSum += x.observation.stressNetR;
      if (x.observation.stressNetR > 0) s.stressWinCount++;
      if (x.observation.stressState === 'POSSIBLE_STOP_STRESS_LOSS') s.possibleStopStressLosses++;
    } else s.ambiguousOrCostUnknown++;
  }
  s.stressNetRSum = Number(s.stressNetRSum.toFixed(3));
  s.barrierFreeNetRSum = Number(s.barrierFreeNetRSum.toFixed(3));
  if (s.stressMeasured) s.meanStressNetR = Number((s.stressNetRSum / s.stressMeasured).toFixed(4));
  if (s.costCalibratedBarrierFree)
    s.meanBarrierFreeNetR = Number((s.barrierFreeNetRSum / s.costCalibratedBarrierFree).toFixed(4));
  s.utcDays = [...days].sort();
  return s;
}
function analyze(rows, feeRows, since, through) {
  const samples = feeRows.map(feeRiskSample).filter(Boolean);
  const spaced = [],
    lastByInstrument = new Map();
  let boundaryOverlaps = 0;
  for (const row of [...rows].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
    const at = new Date(row.createdAt).getTime();
    if (!Number.isFinite(at)) throw Error('INVALID_DECISION_TIMESTAMP');
    const prev = lastByInstrument.get(row.instrument);
    if (prev !== undefined && at - prev < 30 * 60_000) {
      boundaryOverlaps++;
      continue;
    }
    lastByInstrument.set(row.instrument, at);
    spaced.push(row);
  }
  const cohortRows = spaced.map((row) => ({
    day: new Date(row.createdAt).toISOString().slice(0, 10),
    instrument: row.instrument,
    phase:
      new Date(row.createdAt).getTime() < new Date(SPLIT).getTime()
        ? 'DISCOVERY'
        : 'LATER_UNTOUCHED_DATES',
    qualifiedByPlanB: row.planBAdmitted === 'true',
    fourFeatureAligned: alignedContinuation(row.candidate),
    observation: assess(row, asofFees(row, samples)),
  }));
  const groups = {};
  for (const row of cohortRows) {
    const key = [
      row.phase,
      row.qualifiedByPlanB ? 'PLANB_ADMITTED' : 'PLANB_REJECTED',
      row.fourFeatureAligned ? 'FOUR_FEATURE_ALIGNED' : 'OTHER',
    ].join('/');
    (groups[key] ??= []).push(row);
  }
  return {
    artifact: ARTIFACT,
    since,
    through,
    asOf: new Date().toISOString(),
    executionAuthority: 'NONE',
    modifiesExecution: false,
    promotionEligible: false,
    modelFitted: false,
    hypothesis: {
      direction: 'M1_TREND_CONTINUATION',
      drift: 'NORMAL',
      fourFeatures: 'alignedH1>=0, alignedH4>=0, alignedM5>=0.3, directionQuality>=0.65',
      historicalSplit: SPLIT,
      cooldownMinutesPerPairAcrossDirections: 30,
    },
    sample: {
      initial30mSqlWindows: rows.length,
      adjacentOverlapExcluded: boundaryOverlaps,
      independentEpisodes: cohortRows.length,
    },
    cohorts: Object.fromEntries(
      Object.entries(groups)
        .sort()
        .map(([k, v]) => [k, summarize(v)]),
    ),
    cautions: [
      'NOT a retrained model, broker fill simulation or order authorization.',
      'Cohort thresholds are predeclared research hypotheses, not validated promotion gates.',
      'Discovery and later periods are time-separated but share highly correlated markets and a short history.',
      'First saved decision is selected per half-hour instrument; a subsequent strict 30-minute cooldown removes adjacent-window overlaps.',
      'Commission-R uses only already-closed, broker-native same-pair EUR trades prior to each decision.',
      'POSSIBLE_STOP_STRESS_LOSS treats possible intraminute touch as -1R minus historical fees; not an observed broker fill.',
      'Unobservable, same-minute ambiguity and uncertain target paths are censored, not assumed wins.',
      'Mean stress R excludes censored paths; do not interpret it as conservative realised net profitability.',
      'No LIVE, DEMO or PAPER execution route, thresholds, stops or volume settings are modified.',
    ],
  };
}
async function runAudit({ client, userId, connectionId, since = START, until = new Date() }) {
  if (!UUID.test(userId || '') || !UUID.test(connectionId || ''))
    throw Error('INVALID_OWNER_BROKER_SCOPE');
  const start = new Date(since),
    end = new Date(until);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start ||
    end - start > 14 * 86400_000
  )
    throw Error('INVALID_BOUND');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='60000ms'");
    const sc = await client.query(
      "SELECT id FROM broker.broker_connections WHERE user_id=$1 AND id=$2 AND broker_id='ctrader' AND account_type='DEMO' AND deleted_at IS NULL",
      [userId, connectionId],
    );
    if (sc.rows.length !== 1) throw Error('CTRADER_DEMO_OWNER_SCOPE_NOT_FOUND');
    const endLabels = new Date(end.getTime() - 20 * 60_000).toISOString();
    const rows = await client.query(DECISIONS_SQL, [
      userId,
      connectionId,
      start.toISOString(),
      endLabels,
      MAX + 1,
    ]);
    if (rows.rows.length > MAX) throw Error('TRUNCATED_M1_CONTINUATION_EPISODES');
    const fees = await client.query(FEES_SQL, [
      userId,
      connectionId,
      new Date(start.getTime() - 30 * 86400_000).toISOString(),
      end.toISOString(),
    ]);
    if (fees.rows.length > 3000) throw Error('TRUNCATED_BROKER_COMMISSION_HISTORY');
    const result = analyze(rows.rows, fees.rows, start.toISOString(), endLabels);
    await client.query('COMMIT');
    return result;
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
  const db = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: +(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'irexpro_dev',
    user: process.env.DB_USER || 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    application_name: 'irexpro-continuation-alignment-readonly',
    connectionTimeoutMillis: 10000,
  });
  try {
    await db.connect();
    const report = await runAudit({
      client: db,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID,
    });
    mkdirSync(resolve(REPORT, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(
      'NORMAL_CONTINUATION_RESEARCH ' +
        JSON.stringify({
          sample: report.sample,
          cohorts: report.cohorts,
          modifiesExecution: report.modifiesExecution,
          promotionEligible: report.promotionEligible,
        }),
    );
  } finally {
    await db.end();
  }
}
module.exports = {
  ARTIFACT,
  DECISIONS_SQL,
  alignedContinuation,
  assess,
  summarize,
  analyze,
  runAudit,
};
if (require.main === module)
  main().catch((err) => {
    console.error('NORMAL_CONTINUATION_RESEARCH_FAILED ' + String(err.message).slice(0, 220));
    process.exitCode = 1;
  });
