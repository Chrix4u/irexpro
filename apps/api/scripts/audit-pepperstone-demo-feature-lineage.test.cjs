'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ARTIFACT,
  SCOPE_SQL,
  DECISIONS_SQL,
  MAX_ROWS,
  PAIRS,
  quantiles,
  lineage,
  analyze,
  runAudit,
} = require('./audit-pepperstone-demo-feature-lineage.cjs');
const start = '2026-11-16T21:00:00.000Z',
  end = '2026-11-17T00:00:00.000Z';
function row(override = {}) {
  return {
    instrument: 'EURUSD',
    direction: 'BUY',
    evaluatedAt: '2026-11-16T23:59:00.000Z',
    m1Route: 'ABSTAIN',
    confidence: '0.70',
    m1Quality: '0.52',
    rawAlignedEma: '-0.4',
    rawAlignedM15: '-0.2',
    asofFeatures: { emaSeparation: 0, mtfStrength: 0, volatilityScore: 0.04, extensionAtr: 0.7 },
    planBRoute: 'TREND_CONTINUATION',
    planBAdmitted: 'false',
    governanceEligible: 'false',
    driftState: 'OUT_OF_DISTRIBUTION',
    driftReasons: ['emaSeparation:HARD_LOW', 'mtfStrength:HARD_LOW'],
    advisoryReason: 'NOT_ADMITTED_REVERSAL_OR_TRANSITION',
    expertDirection: 'SELL',
    expertProbability: '0.2',
    executionAuthority: 'NONE',
    ...override,
  };
}
test('lineage reconciles signed EMA and M15 into stored nonnegative directional inputs', () => {
  assert.deepEqual(lineage(row()), {
    complete: true,
    emaMismatch: false,
    mtfMismatch: false,
    negativeEmaClampedToZero: true,
    negativeMtfClampedToZero: true,
    zeroFromClipping: true,
  });
  assert.equal(
    lineage(
      row({
        rawAlignedEma: '.8',
        rawAlignedM15: '.15',
        asofFeatures: { emaSeparation: 0.4, mtfStrength: 0.15 },
      }),
    ).emaMismatch,
    false,
  );
  assert.equal(
    lineage(row({ asofFeatures: { emaSeparation: 0.5, mtfStrength: 0 } })).emaMismatch,
    true,
  );
  assert.equal(lineage(row({ rawAlignedM15: null })).complete, false);
});
test('per-route aggregation separates OOD trend scans from valid admitted alternates', () => {
  const a = row();
  const b = row({
    instrument: 'USDCAD',
    rawAlignedEma: '.4',
    rawAlignedM15: '.12',
    planBRoute: 'CONFIRMED_REVERSAL',
    planBAdmitted: 'true',
    governanceEligible: 'true',
    driftState: 'NORMAL',
    driftReasons: [],
    asofFeatures: { emaSeparation: 0.2, mtfStrength: 0.12 },
    advisoryReason: 'M1_DIRECTION_OR_STOP_NOT_QUALIFIED',
    m1Quality: '.51',
    expertDirection: 'BUY',
  });
  const s = analyze([a, b], { start, end });
  assert.equal(s.artifact, ARTIFACT);
  assert.equal(s.authority, 'READ_ONLY_RESEARCH');
  assert.equal(s.modifiesExecution, false);
  assert.equal(s.byRoute.TREND_CONTINUATION.ood, 1);
  assert.equal(s.byRoute.CONFIRMED_REVERSAL.ood, 0);
  assert.equal(s.sample.admittedAlternates, 1);
  assert.equal(s.sample.admittedAlternatesOOD, 0);
  assert.equal(s.sample.admittedAlternatesM1QualityBelow055, 1);
  assert.equal(s.sample.independentExpertOpposesAdmittedAlternative, 0);
  assert.equal(s.sample.emaTransformMismatch, 0);
  assert.equal(s.diagnostics['emaSeparation:HARD_LOW'], 1);
  assert.equal(s.advisoryReasons.M1_DIRECTION_OR_STOP_NOT_QUALIFIED, 1);
  assert.deepEqual(s.featureQuantiles.emaSeparation, { n: 2, p10: 0.02, median: 0.1, p90: 0.18 });
  assert.equal(JSON.stringify(s).includes('brokerConnectionId'), false);
});
test('strict malformed/missing feature audit and time checks', () => {
  const s = analyze([row({ asofFeatures: null })], { start, end });
  assert.equal(s.sample.missingLineage, 1);
  assert.equal(s.featureQuantiles.emaSeparation.n, 0);
  assert.throws(
    () => analyze([row({ instrument: 'XAUUSD' })], { start, end }),
    /BAD_SCOPED_DECISION/,
  );
  assert.throws(
    () => analyze([row({ evaluatedAt: '2026-11-18' })], { start, end }),
    /INVALID_ASOF_DECISION_TIME/,
  );
  assert.deepEqual(quantiles([null, NaN, Infinity]), { n: 0, p10: null, median: null, p90: null });
});
test('SQL is read-only, owner-bound, exact Pepperstone DEMO and bounded', () => {
  assert.match(SCOPE_SQL, /s.user_id=\$1/);
  assert.match(SCOPE_SQL, /b.account_type='DEMO'/);
  assert.match(SCOPE_SQL, /b.broker_id='pepperstone-ctrader'/);
  assert.match(SCOPE_SQL, /s.status='ACTIVE'/);
  assert.match(DECISIONS_SQL, /d.user_id=\$1 AND d.broker_connection_id=\$2/);
  assert.match(DECISIONS_SQL, /ORDER BY d.evaluated_at ASC,d.id ASC LIMIT \$6/);
  assert.equal(MAX_ROWS, 4800);
  assert.equal(PAIRS.length, 6);
  assert.doesNotMatch(SCOPE_SQL + DECISIONS_SQL, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
});
test('runAudit rejects unknown active DEMO and always rolls back read-only transaction', async () => {
  const calls = [];
  class Client {
    async connect() {
      calls.push('connect');
    }
    async query(s, args) {
      calls.push(String(s).trim().split(' ')[0]);
      if (s === SCOPE_SQL) return { rowCount: 0, rows: [] };
      if (s === 'ROLLBACK') return { rows: [] };
      return { rowCount: 0, rows: [] };
    }
    async end() {
      calls.push('end');
    }
  }
  await assert.rejects(
    runAudit({
      pgModule: { Client },
      env: {
        VPS_FOREX_SCANNER_USER_ID: 'owner-test',
        DB_HOST: 'localhost',
        DB_NAME: 'test',
        DB_USER: 'test',
      },
      now: new Date(end),
      write: false,
    }),
    /NO_EXACT_ACTIVE_OWNER_PEPPERSTONE_DEMO/,
  );
  assert.deepEqual(calls, ['connect', 'BEGIN', 'SELECT', 'ROLLBACK', 'end']);
});
test('runAudit returns only scoped read-only summary and commits before any file writes', async () => {
  const calls = [];
  class Client {
    async connect() {}
    async query(s, args) {
      calls.push(s);
      if (s === SCOPE_SQL) return { rowCount: 1, rows: [{ id: 'test-only-conn' }] };
      if (s === DECISIONS_SQL) {
        assert.equal(args[1], 'test-only-conn');
        assert.equal(args[5], 4801);
        return { rows: [row()] };
      }
      return { rows: [] };
    }
    async end() {}
  }
  const report = await runAudit({
    pgModule: { Client },
    env: {
      VPS_FOREX_SCANNER_USER_ID: 'owner-test',
      DB_HOST: 'localhost',
      DB_NAME: 'test',
      DB_USER: 'test',
    },
    now: new Date(end),
    write: false,
  });
  assert.equal(report.sample.rows, 1);
  assert.equal(report.sample.brokerAuthorized, 0);
  assert.ok(calls.includes('COMMIT'));
  assert.ok(
    calls.some((s) => s.startsWith('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')),
  );
});
