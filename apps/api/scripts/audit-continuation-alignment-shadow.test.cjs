'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ARTIFACT,
  DECISIONS_SQL,
  alignedContinuation,
  assess,
  analyze,
  runAudit,
} = require('./audit-continuation-alignment-shadow.cjs');

const features = { alignedH1: 0.4, alignedH4: 0.1, alignedM5: 0.5, directionQuality: 0.7 };
const record = {
  candidate: features,
  createdAt: '2026-11-09T08:02:50Z',
  instrument: 'EURUSD',
  direction: 'BUY',
  planBAdmitted: 'false',
  entryAt: '2026-11-09T08:02:59Z',
  entryAsk: 1.1188,
  entryBid: 1.11878,
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
function fee(closedAt) {
  return {
    instrument: 'EURUSD',
    closedAt,
    fillPrice: 1.11877,
    exitPrice: 1.11927,
    stopLoss: 1.11827,
    gross: 8.1,
    commission: -1.62,
    swap: 0,
    lotSize: 0.2,
  };
}
test('four-feature predeclared rule rejects missing, opposite and weak alignment', () => {
  assert.equal(alignedContinuation(features), true);
  assert.equal(alignedContinuation({ ...features, alignedH1: null }), false);
  assert.equal(alignedContinuation({ ...features, alignedH4: -0.01 }), false);
  assert.equal(alignedContinuation({ ...features, alignedM5: 0.29 }), false);
  assert.equal(alignedContinuation({ ...features, directionQuality: 0.64 }), false);
  assert.equal(alignedContinuation({ ...features, alignedM5: Infinity }), false);
});
test('risk-priced barrier-free result uses quote-side move and known cost', () => {
  const out = assess(record, 0.2);
  assert.equal(out.stressState, 'BARRIER_FREE_15M');
  assert.ok(Math.abs(out.stressNetR - 0.4) < 1e-8);
  assert.ok(Math.abs(out.hold15mNetR - 0.4) < 1e-8);
});
test('possible stop is stress-loss, never silently omitted from scenario', () => {
  const out = assess({ ...record, firstPossibleStop: '2026-11-09T08:07:00Z' }, 0.2);
  assert.equal(out.stressState, 'POSSIBLE_STOP_STRESS_LOSS');
  assert.equal(out.stressNetR, -1.2);
  assert.equal(out.hold15mNetR, null);
});
test('possible target receives a positive proxy only with supporting quote close', () => {
  const target = { ...record, firstPossibleTarget: '2026-11-09T08:07:00Z' };
  assert.equal(assess(target, 0.2).stressNetR, null);
  const outcome = assess({ ...target, firstQuoteTarget: '2026-11-09T08:07:00Z' }, 0.2);
  assert.equal(outcome.stressState, 'QUOTE_TARGET_FIRST_PROXY');
  assert.ok(Math.abs(outcome.stressNetR - 1.8) < 1e-8);
});
test('no commission means no monetary scenario; unavailable quotes are censored', () => {
  assert.equal(assess(record, null).stressNetR, null);
  assert.equal(assess({ ...record, futureBid: null }, 0.2).stressState, 'UNOBSERVABLE');
});
test('chronological split, adjacent overlaps and future quote validity', () => {
  const fees = [
    fee('2026-11-08T06:00:00Z'),
    fee('2026-11-08T06:30:00Z'),
    fee('2026-11-08T07:00:00Z'),
    fee('2026-11-10T08:00:00Z'),
  ];
  const rows = [
    { ...record, createdAt: '2026-11-09T08:02:50Z' },
    { ...record, createdAt: '2026-11-09T08:15:00Z' },
    { ...record, createdAt: '2026-11-09T08:35:00Z' },
    { ...record, createdAt: '2026-11-05T09:00:00Z', instrument: 'GBPUSD' },
  ];
  const report = analyze(rows, fees, '2026-11-04T00:00Z', '2026-11-09T19:00Z');
  assert.equal(report.artifact, ARTIFACT);
  assert.equal(report.modifiesExecution, false);
  assert.equal(report.promotionEligible, false);
  assert.equal(report.sample.independentEpisodes, 3);
  assert.equal(report.sample.adjacentOverlapExcluded, 1);
  const later = report.cohorts['LATER_UNTOUCHED_DATES/PLANB_REJECTED/FOUR_FEATURE_ALIGNED'];
  assert.equal(later.episodes, 2);
  assert.equal(later.costCalibratedBarrierFree, 1);
  assert.equal(later.stressMeasured, 1);
  const early = report.cohorts['DISCOVERY/PLANB_REJECTED/FOUR_FEATURE_ALIGNED'];
  assert.equal(early.costCalibratedBarrierFree, 0);
});
test('read-only exact owner scope fails closed before reading prices', async () => {
  const commands = [];
  const client = {
    query: async (sql) => {
      commands.push(sql);
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
    /CTRADER_DEMO_OWNER_SCOPE_NOT_FOUND/,
  );
  assert.match(commands[0], /READ ONLY/);
  assert.equal(commands.at(-1), 'ROLLBACK');
});
test('bounded quote research is native and excludes OOD and arbitrary trades', () => {
  assert.match(DECISIONS_SQL, /source='ctrader-broker-native'/);
  assert.match(DECISIONS_SQL, /driftState}'='NORMAL'/);
  assert.match(DECISIONS_SQL, /route='M1_TREND_CONTINUATION'/);
  assert.match(DECISIONS_SQL, /LIMIT \$5::int/);
  assert.doesNotMatch(DECISIONS_SQL, /INSERT|UPDATE|DELETE/);
});
