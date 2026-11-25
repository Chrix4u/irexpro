'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SQL, summarize, inspect } = require('./audit-closed-order-integrity.cjs');
const row = (overrides = {}) => ({ order_status: 'RECONCILIATION_PENDING', trade_status: 'CLOSED',
  side_relation: 'OPPOSITE_SIDE', missing_provider_id: true, zero_recorded_fill: true, aged: true, records: 375, ...overrides });
test('reports historical closed-trade mismatch without inferring a broker fill', () => {
  const result = summarize([row(), row({ records: 2, aged: false, side_relation: 'SAME_SIDE' })]);
  assert.equal(result.totals.closedTradeOrders, 377);
  assert.equal(result.totals.agedClosedTradeOrders, 375);
  assert.equal(result.totals.closedTradeOppositeSide, 375);
  assert.equal(result.brokerOutcomeVerified, false);
  assert.equal(result.brokerExposureVerified, false);
});
test('empty or nonclosed records do not assert broker safety', () => {
  for (const rows of [[], [row({ trade_status: 'OPEN' })], [row({ trade_status: 'NO_LINKED_TRADE' })]]) {
    const result = summarize(rows);
    assert.equal(result.totals.closedTradeOrders, 0);
    assert.equal(result.brokerExposureVerified, false);
  }
});
test('invalid counts fail rather than misreporting integrity', () => {
  for (const records of [-1, NaN, '375', 0.1]) assert.throws(() => summarize([row({ records })]));
});
test('account ownership is joined and report runs in a read-only transaction', async () => {
  assert.match(SQL, /t.user_id = o.user_id AND t.broker_connection_id = o.broker_connection_id/);
  const calls = [];
  const db = { query: async q => { calls.push(q); return { rows: [row()] }; } };
  assert.equal((await inspect(db)).totals.closedTradeOrders, 375);
  assert.deepEqual(calls, ['BEGIN READ ONLY', SQL, 'ROLLBACK']);
});
test('query failure rolls back and remains a failure', async () => {
  const calls = [];
  const db = { query: async q => { calls.push(q); if (q === SQL) throw Error('unavailable'); } };
  await assert.rejects(inspect(db), /unavailable/);
  assert.deepEqual(calls, ['BEGIN READ ONLY', SQL, 'ROLLBACK']);
});

test('separates LIVE, DEMO and unknown account discrepancies without claiming external safety', () => {
  const result = summarize([
    row({ account_environment: 'DEMO', records: 375 }),
    row({ account_environment: 'LIVE', records: 3, aged: false }),
    row({ account_environment: 'PAPER', records: 2 }),
    row({ account_environment: 'LIVE', trade_status: 'OPEN', records: 1 }),
  ]);
  assert.equal(result.byEnvironment.DEMO.closedTradeOrders, 375);
  assert.equal(result.byEnvironment.LIVE.closedTradeOrders, 3);
  assert.equal(result.byEnvironment.LIVE.uncertainOrders, 4);
  assert.equal(result.byEnvironment.OTHER_OR_UNKNOWN.closedTradeOrders, 2);
  assert.equal(result.totals.closedTradeOrders, 380);
  assert.equal(result.brokerOutcomeVerified, false);
  assert.match(SQL, /b.id = o.broker_connection_id AND b.user_id = o.user_id/);
});
