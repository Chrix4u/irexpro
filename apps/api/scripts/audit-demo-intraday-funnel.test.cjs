'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTIVE_SQL,
  DECISIONS_SQL,
  TRADES_SQL,
  summarize,
  periodForBucket,
  runAudit,
} = require('./audit-demo-intraday-funnel.cjs');
const START = '2026-11-10T00:00:00.000Z';
const END = '2026-11-12T00:00:00.000Z';
const OWNER = 'a25c43a9-0e67-40cc-885a-02743ef02d56';
const CONNECTION = '42b2f231-9bd3-4d81-af5d-742f1a4bca33';
const decision = (bucket, instrument = 'AUDUSD', n = 20, authorized = 0) => ({
  bucket,
  instrument,
  evaluations: n,
  authorized,
  planb: n - authorized,
  ood: 10,
  timing: 12,
  news: 0,
  old_pair_veto: 0,
});

test('13:30 Ghana time changes the bucket period, not trade authority', () => {
  assert.equal(periodForBucket('2026-11-11T13:00:00Z'), 'BEFORE_1330_GHANA');
  assert.equal(periodForBucket('2026-11-11T13:30:00Z'), 'AFTER_1330_GHANA');
  assert.equal(periodForBucket('2026-11-11T22:30:00Z'), 'AFTER_1330_GHANA');
  assert.equal(periodForBucket('2026-11-12T00:00:00Z'), 'BEFORE_1330_GHANA');
});
test('afternoon zero-authorizations are flagged without interpreting a hard clock ban', () => {
  const d = [
    decision('2026-11-11T12:30:00Z', 'AUDUSD', 30, 1),
    decision('2026-11-11T13:30:00Z', 'AUDUSD', 60),
    decision('2026-11-11T13:30:00Z', 'EURUSD', 60),
    decision('2026-11-11T14:00:00Z', 'AUDUSD', 60),
  ];
  const a = summarize(d, [{ bucket: '2026-11-11T12:30:00Z', opened: 1 }], START, END);
  assert.equal(a.byDay['2026-11-11'].BEFORE_1330_GHANA.authorized, 1);
  assert.equal(a.byDay['2026-11-11'].BEFORE_1330_GHANA.opened, 1);
  assert.equal(a.byDay['2026-11-11'].AFTER_1330_GHANA.evaluations, 180);
  assert.equal(a.byDay['2026-11-11'].AFTER_1330_GHANA.authorized, 0);
  assert.deepEqual(a.observations.afternoonZeroAuthorizationDates, ['2026-11-11']);
  assert.equal(a.halfHours[1].missingPairs.includes('EURUSD'), false);
  assert.equal(a.modifiesExecution, false);
});
test('counts and mismatched pair buckets are validated', () => {
  assert.throws(
    () => summarize([decision('2026-11-11T14:05:00Z')], [], START, END),
    /INVALID_HALF_HOUR_BUCKET/,
  );
  assert.throws(
    () =>
      summarize(
        [{ ...decision('2026-11-11T14:00:00Z', 'AUDUSD', 2, 0), authorized: 3 }],
        [],
        START,
        END,
      ),
    /INVALID_AGGREGATE/,
  );
  assert.throws(
    () =>
      summarize(
        [decision('2026-11-11T14:00:00Z'), decision('2026-11-11T14:00:00Z')],
        [],
        START,
        END,
      ),
    /DUPLICATE_PAIR_BUCKET/,
  );
  assert.throws(
    () => summarize([decision('2026-11-11T14:00:00Z', 'FAKEUSD')], [], START, END),
    /UNEXPECTED_INSTRUMENT/,
  );
});
test('source queries stay scoped to owner, active demo connection, and pinned policy', () => {
  assert.match(ACTIVE_SQL, /s\.user_id=\$1/);
  assert.match(ACTIVE_SQL, /s\.status='ACTIVE'/);
  assert.match(ACTIVE_SQL, /b\.account_type='DEMO'/);
  assert.match(DECISIONS_SQL, /user_id=\$1 AND broker_connection_id=\$2/);
  assert.match(DECISIONS_SQL, /rolloutPolicyVersion/);
  assert.match(TRADES_SQL, /user_id=\$1 AND broker_connection_id=\$2/);
});
test('the DB audit is read-only and never includes identifiers in its report', async () => {
  const seen = [];
  const client = {
    query: async (sql, args) => {
      seen.push([sql, args]);
      if (sql === ACTIVE_SQL) return { rows: [{ id: CONNECTION }] };
      if (sql === DECISIONS_SQL) return { rows: [decision('2026-11-11T14:00:00Z')] };
      if (sql === TRADES_SQL) return { rows: [] };
      return { rows: [] };
    },
  };
  const report = await runAudit(client, OWNER, START, END);
  assert.match(seen[0][0], /READ ONLY/);
  assert.equal(
    seen.some(([sql]) => /^INSERT|^UPDATE|^DELETE|^ALTER/i.test(sql)),
    false,
  );
  assert.equal(
    seen.some(([sql]) => sql === 'COMMIT'),
    true,
  );
  assert.equal(JSON.stringify(report).includes(CONNECTION), false);
  assert.equal(JSON.stringify(report).includes(OWNER), false);
  assert.equal(report.halfHours.length, 1);
});
test('missing owned active demo fails closed, transaction rolls back', async () => {
  const seen = [];
  const client = {
    query: async (sql) => {
      seen.push(sql);
      return { rows: [] };
    },
  };
  await assert.rejects(runAudit(client, OWNER, START, END), /NO_ACTIVE_OWNED/);
  assert.equal(seen.at(-1), 'ROLLBACK');
});
test('invalid owner never starts a query', async () => {
  const client = {
    query: async () => {
      throw Error('must not run');
    },
  };
  await assert.rejects(runAudit(client, '', START, END), /INVALID_OWNER_SCOPE/);
});
