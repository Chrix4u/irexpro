'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ARTIFACT,
  DECISIONS_SQL,
  FEES_SQL,
  laneOf,
  aggregate,
  analyze,
  runAudit,
} = require('./audit-ood-regime-shadow.cjs');
const base = {
  instrument: 'AUDUSD',
  direction: 'BUY',
  regime: 'TREND_EXTENDED',
  diagnostics: ['extensionAtr:HARD_HIGH'],
  planBAdmitted: 'false',
  blockers: ['DRIFT_OUT_OF_DISTRIBUTION', 'MULTIMODEL_PLAN_B_NOT_ADMITTED'],
  createdAt: '2026-11-09T08:02:50Z',
  m1Route: 'M1_TREND_CONTINUATION',
  entryAt: '2026-11-09T08:02:59Z',
  entryBid: 1.11878,
  entryAsk: 1.1188,
  futureAt: '2026-11-09T08:18:01Z',
  futureBid: 1.1191,
  futureAsk: 1.11912,
  stopLoss: 1.1183,
  takeProfit: 1.1198,
  pathBars: 16,
  firstPathBar: '2026-11-09T08:03:00Z',
  lastPathBar: '2026-11-09T08:18:00Z',
  firstPossibleStop: null,
  firstPossibleTarget: null,
  firstQuoteStop: null,
  firstQuoteTarget: null,
};
const fee = {
  instrument: 'AUDUSD',
  closedAt: '2026-11-08T12:00:00Z',
  fillPrice: 1.11877,
  exitPrice: 1.11927,
  stopLoss: 1.11827,
  gross: 8.1,
  commission: -1.62,
  swap: 0,
  lotSize: 0.2,
};
test('explicit OOD lane precedence distinguishes extension, range and weak trend', () => {
  assert.equal(laneOf(base), 'EXTENDED_TREND_EXCESS_EXTENSION');
  assert.equal(
    laneOf({
      ...base,
      regime: 'TREND_WEAK',
      diagnostics: ['volatilityScore:HARD_LOW', 'emaSeparation:HARD_LOW', 'mtfStrength:HARD_LOW'],
    }),
    'LOW_VOLATILITY_RANGE',
  );
  assert.equal(
    laneOf({ ...base, regime: 'TREND_WEAK', diagnostics: ['mtfStrength:HARD_LOW'] }),
    'WEAK_OR_UNALIGNED_TREND',
  );
  assert.equal(
    laneOf({ ...base, regime: 'TREND_HEALTHY', diagnostics: ['rsi14:HARD_HIGH'] }),
    'MIXED_OTHER_OOD',
  );
});
test('only quote-contiguous barrier-free horizons have after-cost research returns', () => {
  const x = analyze(
    [base],
    [
      fee,
      { ...fee, closedAt: '2026-11-08T13:00:00Z' },
      { ...fee, closedAt: '2026-11-08T14:00:00Z' },
    ],
    '2026-11-09T08:00Z',
    '2026-11-09T09:00Z',
  );
  assert.equal(x.artifact, ARTIFACT);
  assert.equal(x.promotionAllowed, false);
  assert.equal(x.modifiesExecution, false);
  const lane = x.byLane.EXTENDED_TREND_EXCESS_EXTENSION;
  assert.equal(lane.costCalibrated, 1);
  assert.equal(lane.holdNoBarrier, 1);
  assert.equal(lane.afterCostWinners, 1);
  assert.equal(lane.netProxyRSum, 0.4);
  assert.deepEqual(lane.utcDays, ['2026-11-09']);
});
test('possible intraminute stop is censored, never marked a win', () => {
  const x = analyze(
    [{ ...base, firstPossibleStop: '2026-11-09T08:08:00Z' }],
    [
      fee,
      { ...fee, closedAt: '2026-11-08T13:00:00Z' },
      { ...fee, closedAt: '2026-11-08T14:00:00Z' },
    ],
    '2026-11-09T08:00Z',
    '2026-11-09T09:00Z',
  );
  const lane = x.byLane.EXTENDED_TREND_EXCESS_EXTENSION;
  assert.equal(lane.possibleStop, 1);
  assert.equal(lane.costCalibrated, 0);
});
test('historical commission calibration cannot look into the future or use fewer than 3 samples', () => {
  const x = analyze(
    [base],
    [fee, { ...fee, closedAt: '2026-11-10T12:00:00Z' }],
    '2026-11-09T08:00Z',
    '2026-11-09T09:00Z',
  );
  assert.equal(x.byLane.EXTENDED_TREND_EXCESS_EXTENSION.costCalibrated, 0);
});
test('aggregation distinguishes unobservable and possible-barrier samples', () => {
  const x = aggregate([
    { day: '2026-11-08', outcome: { state: 'UNOBSERVABLE' }, netR: null },
    { day: '2026-11-09', outcome: { state: 'NO_BARRIER_TOUCH' }, netR: 0.4 },
  ]);
  assert.equal(x.independentEpisodes, 2);
  assert.equal(x.unobservable, 1);
  assert.equal(x.costCalibrated, 1);
  assert.deepEqual(x.utcDays, ['2026-11-08', '2026-11-09']);
});
test('audit fails closed on missing owner, rolls back read-only transaction', async () => {
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [] };
    },
  };
  await assert.rejects(
    runAudit({
      client,
      userId: '1eb44121-d5c2-40a4-860a-2767e3200cff',
      connectionId: '1eb44121-d5c2-40a4-860a-2767e3200cfe',
      since: '2026-11-04T00:00:00Z',
      until: '2026-11-09T19:00:00Z',
    }),
    /CTRADER_DEMO_SCOPE_NOT_FOUND/,
  );
  assert.match(calls[0], /READ ONLY/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.some((s) => /^\s*(INSERT|UPDATE|DELETE|EXECUTE)\s/i.test(s)));
});
test('quoted M1 broker paths are scoped, fixed, bounded and never authorize orders', () => {
  assert.match(DECISIONS_SQL, /broker_connection_id=\$2/);
  assert.match(DECISIONS_SQL, /source='ctrader-broker-native'/);
  assert.match(DECISIONS_SQL, /date_bin\('30 minutes'/);
  assert.match(DECISIONS_SQL, /LIMIT \$5::int/);
  assert.match(FEES_SQL, /closed_at\s*<\s*\$4::timestamptz/);
  assert.doesNotMatch(DECISIONS_SQL, /INSERT|UPDATE|DELETE/);
});

test('chronological cooldown removes adjacent-window overlap for the same instrument', () => {
  const rows = [
    { ...base, createdAt: '2026-11-09T08:29:50Z' },
    { ...base, createdAt: '2026-11-09T08:30:10Z' },
    { ...base, createdAt: '2026-11-09T09:00:00Z' },
    { ...base, createdAt: '2026-11-09T08:30:10Z', instrument: 'USDJPY' },
  ];
  const out = analyze(rows, [], '2026-11-09T08:00Z', '2026-11-09T10:00Z');
  assert.equal(out.sample.selectedOnePerInstrumentPer30MinuteWindow, 4);
  assert.equal(out.sample.excludedAdjacentWindowOverlap, 1);
  assert.equal(out.sample.spacedIndependentEpisodes, 3);
});
