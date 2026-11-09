'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ARTIFACT,
  RECENT_SQL,
  LOSSES_SQL,
  SHADOW_SQL,
  FEES_SQL,
  historyStatus,
  validateMatureOutcome,
  summarizeFresh,
  runAudit,
} = require('./audit-demo-loss-brake-recovery-shadow.cjs');

const anchor = '2026-11-05T12:00:00Z';
const asOf = '2026-11-09T21:00:00Z';
const UUID_A = '1eb44121-d5c2-40a4-860a-2767e3200cff';
const UUID_B = '1eb44121-d5c2-40a4-860a-2767e3200cfe';
function trade(date, gross = -4, commission = -1, swap = 0) {
  return { closedAt: date, gross, commission, swap };
}
function row(date, netR = 0.6, extra = {}) {
  const at = new Date(date).getTime();
  const id = 'f1ef8941-2b2c-4d99-a42d-cb156460697e';
  return {
    id,
    createdAt: date,
    blockers: ['M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK'],
    outcome: {
      artifact: 'm1-shadow-outcome-15m-v1',
      modifiesExecution: false,
      source: 'COMPLETED_M1_OHLC',
      executionCostSource: 'BROKER_OBSERVED_P90',
      episodeLeaderDecisionId: id,
      outcome: netR > 0 ? 'MTM' : 'SL',
      netRMultiple: netR,
      estimatedExecutionCostR: 0.05,
      entryBarOpenTime: new Date(at + 60_000).toISOString(),
      observedAt: new Date(at + 16 * 60_000).toISOString(),
      ...extra,
    },
  };
}
const fees = [
  { closedAt: new Date('2026-11-04T07:00Z').getTime(), commissionR: 0.12 },
  { closedAt: new Date('2026-11-04T08:00Z').getTime(), commissionR: 0.12 },
  { closedAt: new Date('2026-11-04T09:00Z').getTime(), commissionR: 0.12 },
];
test('broker net loss brake preserves last three verified losses and seven-day age-out', () => {
  const h = historyStatus(
    [
      trade('2026-11-09T11:59:44Z', -8.94, -1.11),
      trade('2026-11-09T10:30:48Z', -3.75, -1.12),
      trade('2026-11-05T07:19:06Z', -4.62, -1.12),
      trade('2026-11-05T02:47:32Z', 1.95, -1.12),
    ],
    new Date(asOf).getTime(),
  );
  assert.equal(h.confirmed, true);
  assert.equal(h.latestThreeNetEUR, -20.66);
  assert.equal(h.lastLossAt, '2026-11-09T11:59:44.000Z');
  assert.equal(h.ageOutAt, '2026-11-12T07:19:06.000Z');
});
test('incomplete, fewer than 3 or non-loss histories fail closed', () => {
  assert.equal(
    historyStatus([trade(anchor), trade('2026-11-06T13:00Z')], new Date(asOf).getTime()).confirmed,
    false,
  );
  assert.equal(
    historyStatus(
      [trade(anchor), trade('2026-11-06T13:00Z'), trade('2026-11-07T13:00Z', 1)],
      new Date(asOf).getTime(),
    ).confirmed,
    false,
  );
  assert.equal(
    historyStatus(
      [trade(anchor), trade('2026-11-06T13:00Z'), trade('2026-11-07T13:00Z', -4, null)],
      new Date(asOf).getTime(),
    ).confirmed,
    false,
  );
  assert.equal(
    historyStatus(
      [trade(anchor), trade('2026-11-06T13:00Z'), trade('2026-11-10T13:00Z')],
      new Date(asOf).getTime(),
    ).confirmed,
    false,
  );
});
test('causally matured completed quote outcome is accepted only when episode id matches', () => {
  const x = row('2026-11-09T18:00:00Z');
  const v = validateMatureOutcome(x, new Date(asOf).getTime(), new Date(anchor).getTime());
  assert.equal(v.reason, null);
  assert.equal(v.netRBeforeCommission, 0.6);
  assert.equal(
    validateMatureOutcome(
      { ...x, outcome: { ...x.outcome, episodeLeaderDecisionId: 'other' } },
      new Date(asOf).getTime(),
      new Date(anchor).getTime(),
    ).reason,
    'UNVERIFIED_OR_AMBIGUOUS_QUOTE_OUTCOME',
  );
  assert.equal(
    validateMatureOutcome(
      { ...x, outcome: { ...x.outcome, source: 'SYNTHETIC' } },
      new Date(asOf).getTime(),
      new Date(anchor).getTime(),
    ).reason,
    'UNVERIFIED_OR_AMBIGUOUS_QUOTE_OUTCOME',
  );
  assert.equal(
    validateMatureOutcome(
      { ...x, outcome: { ...x.outcome, executionCostSource: 'PAPER_SIMULATION_SPREAD' } },
      new Date(asOf).getTime(),
      new Date(anchor).getTime(),
    ).reason,
    'UNVERIFIED_OR_AMBIGUOUS_QUOTE_OUTCOME',
  );
  assert.equal(
    validateMatureOutcome(
      { ...x, outcome: { ...x.outcome, outcome: 'AMBIGUOUS' } },
      new Date(asOf).getTime(),
      new Date(anchor).getTime(),
    ).reason,
    'UNVERIFIED_OR_AMBIGUOUS_QUOTE_OUTCOME',
  );
});
test('future/unsettled quote and candidate before latest loss are never fresh evidence', () => {
  const x = row('2026-11-09T20:50:00Z');
  assert.equal(
    validateMatureOutcome(x, new Date(asOf).getTime(), new Date(anchor).getTime()).reason,
    'INVALID_OR_NONCAUSAL_QUOTE_OUTCOME',
  );
  const earlier = row('2026-11-04T06:00:00Z');
  assert.equal(
    validateMatureOutcome(earlier, new Date(asOf).getTime(), new Date(anchor).getTime()).reason,
    'OUTSIDE_FRESH_AFTER_LOSS_WINDOW',
  );
});
test('30-minute cooldown never replaces an unfavorable leader with a favorable duplicate', () => {
  const older = row('2026-11-09T15:00:00Z', -1);
  const later = row('2026-11-09T15:16:00Z', 1.6);
  const h = summarizeFresh(
    [older, later],
    fees,
    new Date(anchor).getTime(),
    new Date(asOf).getTime(),
  );
  assert.equal(h.checkedSettledDecisions, 2);
  assert.equal(h.excludedOverlap, 1);
  assert.equal(h.independentPricedEpisodes, 1);
  assert.equal(h.quoteProxyNetRSum, -1.12);
  assert.equal(h.state, 'COLLECTING_FRESH_EVIDENCE');
  assert.equal(h.canReactivate, false);
});
test('commission samples are strictly earlier than each decision and require 3', () => {
  const f = fees.map((x) => ({ ...x }));
  const afterDate = new Date('2026-11-10T09:00Z').getTime();
  const early = summarizeFresh(
    [row('2026-11-04T08:10:00Z')],
    f,
    new Date('2026-11-03T00:00Z').getTime(),
    new Date(asOf).getTime(),
  );
  assert.equal(early.missingAsOfCommission, 1);
  const future = summarizeFresh(
    [row('2026-11-09T18:00:00Z')],
    [...fees, { closedAt: afterDate, commissionR: 0 }],
    new Date(anchor).getTime(),
    new Date(asOf).getTime(),
  );
  assert.equal(future.independentPricedEpisodes, 1);
  assert.equal(future.quoteProxyNetRSum, 0.48);
});
test('a single profitable day cannot qualify shadow recovery regardless of profit', () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    row(
      new Date(Date.parse('2026-11-09T10:00:00Z') + i * 40 * 60_000).toISOString(),
      i % 4 === 0 ? -0.2 : 1.2,
    ),
  );
  const h = summarizeFresh(
    rows,
    fees,
    new Date(anchor).getTime(),
    Date.parse('2026-11-09T21:00:00Z'),
  );
  assert.equal(h.independentPricedEpisodes, 12);
  assert.equal(h.distinctUtcDays, 1);
  assert.equal(h.state, 'COLLECTING_FRESH_EVIDENCE');
});
test('multi-day good recovery signal can only return non-executable research classification', () => {
  const rows = [];
  for (let day = 6; day <= 8; day++) {
    for (let i = 0; i < 4; i++)
      rows.push(
        row(
          '2026-11-0' + day + 'T' + String(8 + i).padStart(2, '0') + ':00:00Z',
          i === 0 ? -0.2 : 0.8,
        ),
      );
  }
  const h = summarizeFresh(rows, fees, new Date(anchor).getTime(), new Date(asOf).getTime());
  assert.equal(h.independentPricedEpisodes, 12);
  assert.equal(h.distinctUtcDays, 3);
  assert.equal(h.state, 'RESEARCH_RECOVERY_SIGNAL');
  assert.equal(h.canReactivate, false);
  assert.equal(h.executionAuthority, 'NONE');
});
test('exact scoped owner is mandatory and no database writes can occur', async () => {
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [] };
    },
  };
  await assert.rejects(
    runAudit({ client, userId: UUID_A, connectionId: UUID_B, asOf }),
    /EXACT_CTRADER_DEMO_SCOPE_NOT_FOUND/,
  );
  assert.match(calls[0], /READ ONLY/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.some((x) => /^\s*(INSERT|UPDATE|DELETE|EXECUTE)\b/i.test(x)));
});
test('all database reads are bounded by same user, broker, route and settlement time', () => {
  for (const sql of [RECENT_SQL, LOSSES_SQL, SHADOW_SQL, FEES_SQL]) {
    assert.match(sql, /user_id=\$1/);
    assert.match(sql, /broker_connection_id=\$2/);
    assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
  }
  assert.match(SHADOW_SQL, /created_at > \$7::timestamptz/);
  assert.match(SHADOW_SQL, /route=\$5 AND d.policy_version=\$6/);
  assert.match(LOSSES_SQL, /t.account_currency='EUR'/);
  assert.match(ARTIFACT, /loss-brake/);
});

test('existing weekday research workflow runs a separate read-only recovery audit', () => {
  const { readFileSync } = require('node:fs');
  const { resolve } = require('node:path');
  const yaml = readFileSync(
    resolve(__dirname, '../../../.github/workflows/vps-ood-shadow-research.yml'),
    'utf8',
  );
  assert.match(yaml, /cron: '20 16 \* \* 1-5'/);
  assert.match(yaml, /node scripts\/audit-demo-loss-brake-recovery-shadow\.cjs/);
  assert.match(yaml, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(yaml, /workflow_dispatch.*?auto[_-]?promot/i);
});
