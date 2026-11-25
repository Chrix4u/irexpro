'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateReconciliationEvidence: check } = require('./reconciliation-cutover-policy.cjs');
const now = new Date('2026-11-21T13:30:00.000Z');
const base = () => ({
  trade: { nonclosed: 0, unclosed: 0 },
  orders: [],
  discrepancies: [],
  stateRuns: [{
    mode: 'DEMO',
    provider: 'pepperstone-ctrader',
    status: 'COMPLETED',
    last_run_at: '2026-11-21T13:28:00.000Z',
    provider_positions_seen: 0,
    errors: 0,
  }],
});
test('zero internal blockers passes policy but does not prove broker is flat', () => {
  const r = check(base(), now);
  assert.equal(r.passed, true);
  assert.equal(r.summary.unresolvedOrders, 0);
});
test('closed trades linked to unresolved orders still block restart', () => {
  const x = base();
  x.orders = [{ mode: 'DEMO', provider: 'pepperstone-ctrader', status: 'RECONCILIATION_PENDING', n: 375 }];
  const r = check(x, now);
  assert.equal(r.passed, false);
  assert.equal(r.summary.unresolvedOrders, 375);
});
test('open warning discrepancies block even when no trade row is open', () => {
  const x = base();
  x.discrepancies = [
    { type: 'UNRESOLVED_EXECUTION_RESULT', n: 660 },
    { type: 'POSITION_CLOSED_EXTERNALLY', n: 58 },
  ];
  const r = check(x, now);
  assert.equal(r.passed, false);
  assert.equal(r.summary.openDiscrepancies, 718);
});
test('recent state run with zero positions is distinct from independent broker truth', () => {
  const x = base();
  x.stateRuns[0].status = 'COMPLETED_WITH_WARNINGS';
  assert.equal(check(x, now).passed, true);
  x.stateRuns[0].provider_positions_seen = 1;
  assert.equal(check(x, now).passed, false);
});
test('stale, future, missing or failed reconciliation cannot pass', () => {
  const x = base();
  x.stateRuns[0].last_run_at = '2026-11-21T12:30:00.000Z';
  assert.equal(check(x, now).passed, false);
  x.stateRuns[0].last_run_at = '2026-11-21T13:40:00.000Z';
  assert.equal(check(x, now).passed, false);
  x.stateRuns[0].last_run_at = '2026-11-21T13:28:00.000Z';
  x.stateRuns[0].status = 'FAILED';
  assert.equal(check(x, now).passed, false);
  x.stateRuns = [];
  x.orders = [{ status: 'ACKNOWLEDGED', n: 1 }];
  assert.equal(check(x, now).passed, false);
});
test('missing/corrupt evidence fails closed', () => {
  assert.equal(check({}, now).passed, false);
  const x = base();
  x.orders = [{ status: 'ACKNOWLEDGED', n: 'unknown' }];
  assert.equal(check(x, now).passed, false);
});
