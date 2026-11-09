'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PAIRS, V2, COVERAGE_SQL, summarize, runAudit, parseWindowMinutes } = require('./audit-demo-six-pair-cadence.cjs');

const START = new Date('2026-11-09T18:50:00Z');
const END = new Date('2026-11-09T18:55:00Z');
const USER = '1eb44121-d5c2-40a4-860a-2767e3200cff';
const CONNECTION = '1eb44121-d5c2-40a4-860a-2767e3200cfe';
function row(slot, instrument, patch = {}) {
  return {
    slot, instrument, evaluations: 2, directions: 2,
    authorized: 0, ood: 0, planb_not_admitted: 0, old_pair_veto: 0,
    first_persist_lag_sec: '3.15', ...patch,
  };
}

test('coverage deduplicates pair/minute, separates two-sided scans, and does not count missing slots as fills', () => {
  const first = PAIRS.map((pair) => row(START.toISOString(), pair));
  const second = PAIRS.filter((pair) => pair !== 'USDJPY').map((pair) => row('2026-11-09T18:51:00Z', pair));
  second[0].directions = 1;
  second[0].evaluations = 1;
  second[0].ood = 1;
  second[0].planb_not_admitted = 1;
  const result = summarize([...first, ...second], START, END);
  assert.equal(result.windowMinutes, 5);
  assert.equal(result.observedSlots, 2);
  assert.equal(result.slotsWithAllSix, 1);
  assert.equal(result.slotsMissingSomePairs, 1);
  assert.equal(result.incompleteSlots[0].slot, '2026-11-09T18:51:00.000Z');
  assert.deepEqual(result.incompleteSlots[0].absentPairs, ['USDJPY']);
  assert.equal(result.byPair.USDJPY.observedSlots, 1);
  assert.equal(result.byPair.AUDUSD.twoSidedSlots, 1);
  assert.equal(result.byPair.AUDUSD.ood, 1);
  assert.equal(result.byPair.AUDUSD.planBNotAdmitted, 1);
  assert.equal(result.byPair.AUDUSD.persistLagP95Seconds, 3.15);
});

test('rejects duplicate pairs and invented or future slots instead of inflating coverage', () => {
  const a = row(START.toISOString(), 'AUDUSD');
  assert.throws(() => summarize([a, a], START, END), /DUPLICATE_PAIR_SLOT/);
  assert.throws(() => summarize([row(START.toISOString(), 'BTCUSD')], START, END), /UNAPPROVED_PAIR/);
  assert.throws(() => summarize([row(END.toISOString(), 'AUDUSD')], START, END), /INVALID_OBSERVED_SLOT/);
});

test('rejects invalid blocker values and inflated direction counts', () => {
  assert.throws(() => summarize([row(START.toISOString(), 'EURUSD', { directions: 3 })], START, END), /INVALID_DIRECTION_COUNT/);
  assert.throws(() => summarize([row(START.toISOString(), 'EURUSD', { ood: 3 })], START, END), /INVALID_BLOCKER_AGGREGATE/);
  assert.throws(() => summarize([row(START.toISOString(), 'EURUSD', { first_persist_lag_sec: 'NaN' })], START, END), /INVALID_PERSIST_LAG/);
});

test('enforces exact owner DEMO scope, frozen policy version and read-only transaction', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id FROM broker.broker_connections')) return { rows: [{ id: CONNECTION }] };
      if (sql === COVERAGE_SQL) return { rows: [row(START.toISOString(), 'EURUSD', { authorized: 1 })] };
      return { rows: [] };
    },
  };
  const report = await runAudit({ client, userId: USER, connectionId: CONNECTION, since: START, until: END });
  assert.equal(calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.deepEqual(calls[3].params, [USER, CONNECTION, START.toISOString(), END.toISOString(), V2, [...PAIRS]]);
  assert.match(COVERAGE_SQL, /d\.governance->>'rolloutPolicyVersion'=\$5/);
  assert.match(COVERAGE_SQL, /d\.user_id=\$1 AND d\.broker_connection_id=\$2/);
  assert.equal(report.byPair.EURUSD.authorized, 1);
  assert.equal(report.modifiesExecution, false);
  assert.equal(report.authority, 'RESEARCH_ONLY');
});

test('fails closed with rollback for a broker account not owned by the user', async () => {
  const calls = [];
  const client = { query: async (sql) => { calls.push(sql); return { rows: [] }; } };
  await assert.rejects(() => runAudit({ client, userId: USER, connectionId: CONNECTION, since: START, until: END }), /SCOPED_CTRADER_DEMO_NOT_FOUND/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  await assert.rejects(() => runAudit({ client, userId: USER, connectionId: CONNECTION, since: START, until: new Date('2026-11-09T18:54:00Z') }), /INVALID_WINDOW/);
});

test('short window reflects latest rows only from the same scoped database snapshot', async () => {
  const from = new Date('2026-11-09T18:40:00Z');
  const to = new Date('2026-11-09T19:00:00Z');
  const rows = [
    row('2026-11-09T18:41:00Z', 'AUDUSD', { authorized: 1, first_persist_lag_sec: 80 }),
    ...PAIRS.map((pair) => row('2026-11-09T18:55:00Z', pair, {
      first_persist_lag_sec: pair === 'USDJPY' ? 11 : 3,
    })),
    row('2026-11-09T18:57:00Z', 'EURUSD', { ood: 1 }),
  ];
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('SELECT id FROM broker.broker_connections')) return { rows: [{ id: CONNECTION }] };
      if (sql === COVERAGE_SQL) return { rows };
      return { rows: [] };
    },
  };
  const report = await runAudit({ client, userId: USER, connectionId: CONNECTION, since: from, until: to });
  assert.equal(calls.filter((x) => x === COVERAGE_SQL).length, 1);
  assert.equal(report.observedSlots, 3);
  assert.equal(report.byPair.AUDUSD.authorized, 1);
  assert.equal(report.recentWindow.windowMinutes, 10);
  assert.equal(report.recentWindow.since, '2026-11-09T18:50:00.000Z');
  assert.equal(report.recentWindow.observedSlots, 2);
  assert.equal(report.recentWindow.slotsWithAllSix, 1);
  assert.equal(report.recentWindow.byPair.AUDUSD.authorized, 0);
  assert.equal(report.recentWindow.byPair.EURUSD.ood, 1);
  assert.equal(report.recentWindow.byPair.USDJPY.persistLagP95Seconds, 11);
});

test('short window caps to full report when only five-minute window is supplied', async () => {
  const client = {
    query: async (sql) => sql.includes('SELECT id FROM broker.broker_connections')
      ? { rows: [{ id: CONNECTION }] }
      : sql === COVERAGE_SQL ? { rows: [row(START.toISOString(), 'USDJPY')] } : { rows: [] },
  };
  const report = await runAudit({ client, userId: USER, connectionId: CONNECTION, since: START, until: END });
  assert.equal(report.recentWindow.windowMinutes, 5);
  assert.equal(report.recentWindow.observedSlots, report.observedSlots);
});

test('optional CLI cadence window is bounded and rejects ambiguous values', () => {
  assert.equal(parseWindowMinutes(undefined), 60);
  assert.equal(parseWindowMinutes(''), 60);
  assert.equal(parseWindowMinutes('5'), 5);
  assert.equal(parseWindowMinutes('180'), 180);
  for (const raw of ['4', '181', '0', '05', '10.1', '-1', '10m', 'NaN', '1000', null])
    assert.throws(() => parseWindowMinutes(raw), /INVALID_CADENCE_WINDOW_MINUTES/);
});
