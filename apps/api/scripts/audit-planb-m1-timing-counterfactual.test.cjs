'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCOPE_SQL,
  ACTIVE_DEMO_CONNECTION_SQL,
  DECISIONS_SQL,
  CANDLES_SQL,
  selectEpisodeLeaders,
  runPlanBTimingCounterfactualAudit,
} = require('./audit-planb-m1-timing-counterfactual.cjs');

const USER = '2caa0c64-00dd-48fb-babb-06b39cb74068';
const ACTIVE = '26ef9b4e-6e24-4a65-a4f2-8db22e209e9d';
const OLD = 'b2f686be-b7ea-4b24-b9cb-fcc89b9cfaef';
const NOW = '2026-11-10T23:00:00Z';
function mockClient({ activeConnection = ACTIVE, brokerId = 'pepperstone-ctrader', rows = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql === ACTIVE_DEMO_CONNECTION_SQL) {
        return { rows: activeConnection ? [{ connectionId: activeConnection }] : [] };
      }
      if (sql === SCOPE_SQL) {
        return { rows: [{ snapshotAt: NOW, brokerId }] };
      }
      if (sql === DECISIONS_SQL) return { rows };
      if (sql === CANDLES_SQL) return { rows: [] };
      return { rows: [] };
    },
  };
}
const input = (client, connectionId) => ({
  client, userId: USER, connectionId,
  since: '2026-11-10T13:40:00Z',
  evaluateOutcome: () => ({ outcome: 'UNOBSERVABLE', netRMultiple: null }),
});

test('active Pepperstone DEMO session is selected rather than stale default data connection', async () => {
  assert.match(SCOPE_SQL, /'pepperstone-ctrader'/);
  assert.match(SCOPE_SQL, /'icmarkets-ctrader'/);
  assert.match(ACTIVE_DEMO_CONNECTION_SQL, /ts.user_id = \$1/);
  assert.match(ACTIVE_DEMO_CONNECTION_SQL, /bc.user_id = ts.user_id/);
  assert.match(ACTIVE_DEMO_CONNECTION_SQL, /ts.execution_mode = 'FULL_AUTO'/);
  assert.match(ACTIVE_DEMO_CONNECTION_SQL, /bc.account_type = 'DEMO'/);
  assert.match(DECISIONS_SQL, /user_id = \$1 AND broker_connection_id = \$2/);
  assert.match(CANDLES_SQL, /connection_id = \$1/);
  const c = mockClient();
  const r = await runPlanBTimingCounterfactualAudit(input(c));
  assert.equal(r.brokerId, 'pepperstone-ctrader');
  assert.equal(r.executionAuthority, 'NONE');
  assert.equal(r.modifiesExecution, false);
  assert.equal(r.timingRejectedEpisodes, 0);
  assert.match(c.calls[0].sql, /REPEATABLE READ READ ONLY/);
  assert.deepEqual(c.calls.find((x) => x.sql === DECISIONS_SQL).params.slice(0, 2), [USER, ACTIVE]);
  assert.equal(c.calls.find((x) => x.sql === CANDLES_SQL).params[0], ACTIVE);
  assert.equal(c.calls.at(-1).sql, 'COMMIT');
});

test('manual historical override remains user-scoped and does not silently follow old env default', async () => {
  const c = mockClient({ brokerId: 'icmarkets-ctrader' });
  const r = await runPlanBTimingCounterfactualAudit(input(c, OLD));
  assert.equal(r.brokerId, 'icmarkets-ctrader');
  assert.equal(c.calls.some((x) => x.sql === ACTIVE_DEMO_CONNECTION_SQL), false);
  assert.deepEqual(c.calls.find((x) => x.sql === SCOPE_SQL).params, [OLD, USER]);
  assert.deepEqual(c.calls.find((x) => x.sql === DECISIONS_SQL).params.slice(0, 2), [USER, OLD]);
});

test('missing active session fails closed and rolls back without reading decisions or candles', async () => {
  const c = mockClient({ activeConnection: null });
  await assert.rejects(runPlanBTimingCounterfactualAudit(input(c)),
    /ACTIVE_CTRADER_DEMO_SESSION_UNAVAILABLE/);
  assert.equal(c.calls.some((x) => x.sql === DECISIONS_SQL), false);
  assert.equal(c.calls.some((x) => x.sql === CANDLES_SQL), false);
  assert.equal(c.calls.at(-1).sql, 'ROLLBACK');
});

test('malformed explicit connection ID fails before DB transaction', async () => {
  const c = mockClient();
  await assert.rejects(runPlanBTimingCounterfactualAudit(input(c, 'not-a-uuid')),
    /INVALID_AUDIT_SCOPE/);
  assert.equal(c.calls.length, 0);
});

test('repeated decisions are episodes, not independent executable trades', () => {
  const base = {
    evaluatedAt: '2026-11-10T13:42:00Z', barTime: '2026-11-10T13:41:00Z',
    instrument: 'USDJPY', direction: 'BUY', planBRoute: 'CONFIRMED_REVERSAL',
    planBAdmitted: 'true', authorityBlockers: ['MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'],
  };
  const rows = [
    base,
    { ...base, evaluatedAt: '2026-11-10T13:43:00Z', barTime: '2026-11-10T13:42:00Z' },
    { ...base, evaluatedAt: '2026-11-10T13:52:00Z', barTime: '2026-11-10T13:51:00Z' },
    { ...base, planBAdmitted: 'false', evaluatedAt: '2026-11-10T14:02:00Z' },
  ];
  const leaders = selectEpisodeLeaders(rows);
  assert.equal(leaders.length, 2);
  assert.equal(leaders[0].timingOnly, true);
});
