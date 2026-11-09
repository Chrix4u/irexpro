'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  phase,
  collapseEpisodes,
  summarizeRows,
  runAudit,
  DECISION_SQL,
  SOLE_SQL,
  TRADES_SQL,
} = require('./audit-demo-policy-funnel.cjs');

test('policy phase uses persisted source instead of guessed calendar cutover', () => {
  assert.equal(phase('m1-tactical-rollout-v8-demo-professional', '2026-11-04'), 'WEDNESDAY_SIX');
  assert.equal(
    phase('m1-tactical-v8-demo-primary-fee-shadow-focused3-v1', '2026-11-09'),
    'FOCUSED3_SHADOW_COST',
  );
  assert.equal(
    phase('m1-tactical-v8-demo-primary-fee-shadow-six-pair-v2', '2026-11-09'),
    'RESTORED_SIX_SHADOW_COST',
  );
  assert.equal(
    phase('m1-tactical-v8-demo-primary-only-commission-focused3-v1', '2026-11-06'),
    'FOCUSED3_COMMISSION_CHECK',
  );
});
test('separates sole instrument restriction from overlapping rejections', () => {
  const x = summarizeRows([
    {
      day: '2026-11-06',
      version: 'm1-tactical-v8-demo-primary-fee-shadow-focused3-v1',
      instrument: 'USDJPY',
      evaluations: 10,
      routed: 3,
      admitted: 4,
      authorized: 0,
      intents: 0,
      pair_veto: 8,
      sole_pair_veto: 2,
      drift_veto: 6,
      probation_veto: 1,
      reversal_veto: 3,
      continuation_veto: 1,
      loss_streak_veto: 1,
    },
  ]).FOCUSED3_SHADOW_COST;
  assert.equal(x.pairVeto, 8);
  assert.equal(x.solePairVeto, 2);
  assert.equal(x.drift, 6);
  assert.equal(x.instruments.USDJPY.solePairVeto, 2);
});
test('separates repeated minute decisions and nearby instrument episodes', () => {
  const x = collapseEpisodes([
    {
      at: '2026-11-09T08:00:00Z',
      instrument: 'USDJPY',
      direction: 'BUY',
      bar_time: '2026-11-09T08:00:00Z',
    },
    {
      at: '2026-11-09T08:00:15Z',
      instrument: 'USDJPY',
      direction: 'BUY',
      bar_time: '2026-11-09T08:00:00Z',
    },
    {
      at: '2026-11-09T08:15:00Z',
      instrument: 'USDJPY',
      direction: 'SELL',
      bar_time: '2026-11-09T08:15:00Z',
    },
    {
      at: '2026-11-09T08:32:00Z',
      instrument: 'USDJPY',
      direction: 'BUY',
      bar_time: '2026-11-09T08:32:00Z',
    },
    {
      at: '2026-11-09T08:16:00Z',
      instrument: 'USDCHF',
      direction: 'SELL',
      bar_time: '2026-11-09T08:16:00Z',
    },
  ]);
  assert.deepEqual(x, {
    evaluations: 5,
    distinctBars: 4,
    spacedEpisodes: 3,
    byInstrument: { USDJPY: 2, USDCHF: 1 },
  });
});
test('does not accept arbitrary account or a writable transaction', async () => {
  const q = [];
  const client = {
    query: async (sql) => {
      q.push(sql);
      return { rows: [] };
    },
  };
  await assert.rejects(
    runAudit({
      client,
      userId: '1eb44121-d5c2-40a4-860a-2767e3200cff',
      connectionId: '1eb44121-d5c2-40a4-860a-2767e3200cfe',
      until: '2026-11-09T18:00:00Z',
    }),
    /SCOPED_CTRADER_DEMO_NOT_FOUND/,
  );
  assert.match(q[0], /READ ONLY/);
  assert.equal(q.at(-1), 'ROLLBACK');
  assert.ok(!q.some((s) => /^\s*(INSERT|UPDATE|DELETE|EXECUTE)\s/i.test(s)));
});
test('bounded queries are scoped to exact user and broker and never emit order writes', () => {
  for (const sql of [DECISION_SQL, SOLE_SQL, TRADES_SQL]) {
    assert.match(sql, /user_id=\$1/);
    assert.match(sql, /broker_connection_id=\$2/);
    assert.match(sql, /created_at >= \$3|opened_at >= \$3/);
    assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
  }
});
