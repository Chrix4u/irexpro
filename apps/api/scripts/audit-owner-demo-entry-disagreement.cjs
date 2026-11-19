/**
 * Owner-only, READ-ONLY demo entry-disagreement research export.
 * Usage: node scripts/audit-owner-demo-entry-disagreement.cjs [days]
 *
 * No trades, config changes, model retraining or LIVE execution.
 * Features at trade-entry and post-close labels are intentionally separated.
 */
'use strict';
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { Client } = require('pg');
const { evaluateM1AtEntry, theoreticalNoEntryOmission } = require('./research/m1-entry-asof.cjs');
const days = Number(process.argv[2] || 14);
if (!Number.isInteger(days) || days < 1 || days > 60)
  throw new Error('Choose an integer window from 1 to 60 days');
const owner = process.env.VPS_FOREX_SCANNER_USER_ID;
if (!owner) throw new Error('Owner identity is not configured');
const db = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 7000,
  statement_timeout: 18000,
});
const finite = (v) => (v === null || v === undefined || v === '' ? null :
  Number.isFinite(Number(v)) ? Number(v) : null);
const aggregate = (items) => ({
  availableOppositeBeforeEntry: items.filter(x => x.retrospectiveAudit.oppositeDecisionAvailableAtEntry).length,
  oppositeOnlySeenAfterEntry: items.filter(x => x.retrospectiveAudit.laterOppositeDecisionSeen &&
    !x.retrospectiveAudit.oppositeDecisionAvailableAtEntry).length,
  twoSidedAbstainKnownAtEntry: items.filter(x => x.retrospectiveAudit.verifiedDoubleAbstain).length,
  twoSidedAbstainNetUsd: Number(items.filter(x => x.retrospectiveAudit.verifiedDoubleAbstain)
    .reduce((s,x)=>s+x.labels.netUsd,0).toFixed(2)),
  count: items.length,
  wins: items.filter(x => x.labels.netUsd > 0).length,
  netUsd: Number(items.reduce((s,x) => s+x.labels.netUsd, 0).toFixed(2)),
  netAverageUsd: items.length
    ? Number((items.reduce((s,x) => s+x.labels.netUsd, 0)/items.length).toFixed(2))
    : null,
  riskBasedCount: items.filter(x => x.labels.actualNetR !== null).length,
  confirmedDelay: items.filter(x => x.labels.sameExitState === 'INDICATIVE_SAME_EXIT').length,
  pairedPositive: items.filter(x => x.labels.sameExitDeltaR !== null &&
    x.labels.sameExitDeltaR > 0).length,
  pairedNegative: items.filter(x => x.labels.sameExitDeltaR !== null &&
    x.labels.sameExitDeltaR < 0).length,
  pairedNoConfirmation: items.filter(x => x.labels.sameExitState === 'NO_CONFIRMATION').length,
});
(async () => {
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const rows = await db.query(`
      SELECT t.id, t.instrument, t.direction, t.opened_at, t.closed_at,
        ti.metadata->>'multimodel_plan_b_route' strategy_route,
        ti.metadata->>'m1_tactical_route' executed_m1_route,
        ti.metadata->>'multimodel_trained_expert_state' expert_state,
        ti.metadata->>'multimodel_trained_expert_direction' expert_side,
        ti.metadata->>'multimodel_trained_expert_confidence' expert_confidence,
        ti.metadata->>'feature_candidate_score' candidate_score,
        ti.metadata->>'feature_volatility_score' volatility_score,
        ti.metadata->>'feature_rsi14' rsi14,
        op.route AS opposite_m1_route,
        op.governance->'routeDecision'->>'reason' opposite_m1_reason,
        op.created_at AS opposite_created_at, op.evaluated_at AS opposite_evaluated_at,
        md.created_at AS executed_m1_created_at,
        late.created_at AS later_opposite_created_at,
        late.route AS later_opposite_route,
        t.realised_pnl, t.commission, t.swap,
        allocation.sizing_inputs->>'finalRiskAtStop' stop_risk_account,
        path.response->>'firstMovement' first_movement,
        paired.response->'sameExitComparison' AS same_exit
      FROM trading.trades t
      JOIN broker.broker_connections b
        ON b.id=t.broker_connection_id AND b.user_id=t.user_id
      JOIN trading.trade_intents ti
        ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id
      LEFT JOIN trading.m1_tactical_decisions md
        ON md.id=CASE WHEN ti.metadata->>'m1_decision_id' ~
          '^[0-9a-f-]{36}$' THEN (ti.metadata->>'m1_decision_id')::uuid END
      LEFT JOIN LATERAL (
        SELECT d.route, d.governance, d.created_at, d.evaluated_at
        FROM trading.m1_tactical_decisions d
        WHERE d.user_id=md.user_id AND d.broker_connection_id=md.broker_connection_id
          AND d.instrument=md.instrument AND d.bar_time=md.bar_time
          AND d.direction <> md.direction
          -- The opposite decision must already have been PERSISTED and evaluated
          -- before the original order was opened, not just have an early bar time.
          AND d.created_at <= t.opened_at AND d.evaluated_at <= t.opened_at
        ORDER BY d.created_at DESC LIMIT 1
      ) op ON TRUE
      LEFT JOIN LATERAL (
        SELECT d.created_at, d.route
        FROM trading.m1_tactical_decisions d
        WHERE d.user_id=md.user_id AND d.broker_connection_id=md.broker_connection_id
          AND d.instrument=md.instrument AND d.bar_time=md.bar_time
          AND d.direction <> md.direction AND d.created_at > t.opened_at
        ORDER BY d.created_at ASC LIMIT 1
      ) late ON TRUE
      LEFT JOIN LATERAL (
        SELECT z.sizing_inputs FROM trading.capital_allocations z
        WHERE z.trade_intent_id=t.trade_intent_id
        ORDER BY z.created_at DESC LIMIT 1
      ) allocation ON TRUE
      LEFT JOIN trading.post_entry_shadow_observations path
        ON path.trade_id=t.id
        AND path.artifact='trade-entry-path-forensics-verified-m1-v1'
        AND path.checkpoint_minutes=5
      LEFT JOIN trading.post_entry_shadow_observations paired
        ON paired.trade_id=t.id
        AND paired.artifact='m1-confirmed-delay-stop-parity-shadow-v3-verified-risk'
        AND paired.checkpoint_minutes=60
      WHERE t.user_id=$1 AND b.user_id=$1
        AND b.broker_id='pepperstone-ctrader'
        AND b.account_type='DEMO' AND b.account_currency='USD'
        AND t.status='CLOSED'
        AND t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL
        AND t.swap IS NOT NULL
        AND t.closed_at >= now() - ($2::int * interval '1 day')
        AND t.closed_at < now()
      ORDER BY t.opened_at ASC, t.id ASC
    `, [owner, days]);
    await db.query('ROLLBACK');
    const examples = rows.rows.map(r => {
      const asOf = evaluateM1AtEntry({
        openedAt:r.opened_at,
        executedM1CreatedAt:r.executed_m1_created_at,
        executedM1Route:r.executed_m1_route,
        oppositeM1CreatedAt:r.opposite_created_at,
        oppositeM1EvaluatedAt:r.opposite_evaluated_at,
        oppositeM1Route:r.opposite_m1_route,
      });
      const ownM1VerifiedAtEntry=asOf.executedDecisionAvailableAtEntry;
      const oppositeVerifiedAtEntry=asOf.oppositeDecisionAvailableAtEntry;
      const doubleAbstain=asOf.verifiedDoubleAbstain;
      const netUsd = Number(r.realised_pnl) + Number(r.commission) + Number(r.swap);
      const stopRisk = finite(r.stop_risk_account);
      const safeRisk = stopRisk != null && stopRisk > 0 ? stopRisk : null;
      const paired = r.same_exit || {};
      return {
        tradeId: r.id, instrument: r.instrument, side: r.direction,
        decisionAt: new Date(r.opened_at).toISOString(),
        closedAt: new Date(r.closed_at).toISOString(),
        // These are pre-entry attributes. Never add a future market or
        // post-close statistic to this side of the ML training interface.
        features: {
          strategyRoute: r.strategy_route,
          executedM1Route: ownM1VerifiedAtEntry ? r.executed_m1_route : null,
          expertState: r.expert_state,
          expertSide: r.expert_side,
          expertConfidence: finite(r.expert_confidence),
          candidateScore: finite(r.candidate_score),
          volatilityScore: finite(r.volatility_score),
          rsi14: finite(r.rsi14),
          // Opposite decision is paired historical audit context;
          // do not treat it as entry-time-authoritative unless
          // evaluated timestamp and broker quote freshness are proven.
        },
        retrospectiveAudit: {
          oppositeDecisionAvailableAtEntry: oppositeVerifiedAtEntry,
          oppositeM1Route: oppositeVerifiedAtEntry ? r.opposite_m1_route : null,
          oppositeM1Reason: oppositeVerifiedAtEntry ? r.opposite_m1_reason : null,
          laterOppositeDecisionSeen: r.later_opposite_created_at !== null,
          laterOppositeRouteForAuditOnly: r.later_opposite_route,
          verifiedDoubleAbstain: doubleAbstain,
        },
        // Post-close labels cannot be used as pretrade features.
        labels: {
          netUsd: Number(netUsd.toFixed(2)),
          actualNetR: safeRisk === null ? null : Number((netUsd / safeRisk).toFixed(4)),
          firstMovement5m: r.first_movement,
          sameExitState: paired.state || null,
          sameExitDeltaR: finite(paired.indicativeDeltaNetR),
        },
      };
    });
    // Chronological split by market day, never randomly shuffle adjacent
    // M1 trades or call the retrospective audit a prospective validation.
    const uniqueDays = [...new Set(examples.map(x => x.decisionAt.slice(0,10)))];
    const split = Math.max(1, Math.floor(uniqueDays.length * .7));
    const cutoffDay = uniqueDays[split] || null;
    const training = cutoffDay
      ? examples.filter(x => x.decisionAt.slice(0,10) < cutoffDay)
      : examples;
    const holdout = cutoffDay
      ? examples.filter(x => x.decisionAt.slice(0,10) >= cutoffDay)
      : [];
    const grouped = {};
    for (const row of examples) {
      const k = [row.features.strategyRoute || 'UNKNOWN',
        row.features.executedM1Route || 'UNKNOWN',
        row.retrospectiveAudit.oppositeM1Route || 'NOT_AVAILABLE_AT_ENTRY'].join(' / ');
      (grouped[k] ||= []).push(row);
    }
    const shadowByStrategy = {};
    for (const row of examples) {
      (shadowByStrategy[row.features.strategyRoute || 'UNKNOWN'] ||= []).push(row);
    }
    const omitDoubleAbstainShadow = Object.fromEntries(
      Object.entries(shadowByStrategy).map(([route,items]) =>
        [route,{
          trainDays: theoreticalNoEntryOmission(items.filter(x =>
            !cutoffDay || x.decisionAt.slice(0,10) < cutoffDay)),
          laterDays: theoreticalNoEntryOmission(items.filter(x =>
            cutoffDay && x.decisionAt.slice(0,10) >= cutoffDay)),
        }]),
    );
    const groups = Object.entries(grouped).map(([name,items]) => ({
      name, ...aggregate(items), minimum30SettledTradesNotIndependent: items.length >= 30,
    })).sort((a,b)=>b.count-a.count);
    const result = {
      artifact:'owner-pepperstone-demo-entry-disagreement-chronological-asof-research-v3',
      asOf:new Date().toISOString(),days,
      accountScope:'OWNER_PEPPERSTONE_USD_DEMO_ONLY',
      modifiesExecution:false,modelTrainingStatus:'NOT_TRAINED',
      caveats:[
        'Closed broker positions only; no inferred opposite-side broker fill.',
        'Opposite M1 is eligible for as-of comparison only if evaluated and persisted before the order opened; later decisions are separate audit-only evidence.',
        'No independently time-split strategy performance has been proven.',
        'Paired M1 results are conditional quote scenarios, not executable P&L.',
        'Outcomes for recent and older dates share changing policies and markets.',
      ],
      split:{cutoffDay,training:aggregate(training),holdout:aggregate(holdout)},
      overall:aggregate(examples),omitDoubleAbstainShadow,groups,
      // Individual examples are intentionally omitted from stdout by default.
      // The report is aggregate and does not leak customer identities.
    };
    console.log(JSON.stringify(result,null,2));
  } finally { await db.end(); }
})().catch(e => { process.stderr.write('READ_ONLY_AUDIT_FAILED: '+e.message+'\n'); process.exitCode=1; });
