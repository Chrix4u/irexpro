'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ARTIFACT,
  PAIR_VETO,
  FALLBACK_VETO,
  feeRiskSample,
  classify,
  pathState,
  assess,
  analyze,
  runAudit,
  median,
} = require('./audit-wednesday-six-pair-policy-shadow.cjs');
const createdAt = '2026-11-09T08:02:50.000Z';
function example(overrides = {}) {
  return {
    instrument: 'USDCHF',
    direction: 'BUY',
    createdAt,
    evaluatedAt: '2026-11-09T08:02:00Z',
    executionAuthority: 'NONE',
    route: 'M1_TREND_CONTINUATION',
    primaryPath: 'PRIMARY_PLAN_B',
    chosenPath: 'PRIMARY_PLAN_B',
    blockers: [PAIR_VETO],
    stopLoss: 1.1183,
    takeProfit: 1.1198,
    entryAt: '2026-11-09T08:02:59Z',
    entryAsk: 1.1188,
    entryBid: 1.11878,
    futureAt: '2026-11-09T08:18:01Z',
    futureBid: 1.1189,
    futureAsk: 1.11892,
    pathBars: 16,
    firstPathBar: '2026-11-09T08:03:00Z',
    lastPathBar: '2026-11-09T08:18:00Z',
    firstPossibleStop: null,
    firstPossibleTarget: null,
    firstQuoteStop: null,
    firstQuoteTarget: null,
    ...overrides,
  };
}
test('policy categories require exactly the target blocker with no hidden risk veto', () => {
  assert.equal(classify(example()), 'SIX_PAIR_PRIMARY_RESTORATION_ONLY');
  assert.equal(
    classify(example({ blockers: [PAIR_VETO, 'M1_FAST_STOP_REGIME_BRAKE'] })),
    'OTHER_BLOCKERS_REMAIN',
  );
  assert.equal(classify(example({ primaryPath: 'BLOCKED' })), 'OTHER_BLOCKERS_REMAIN');
  assert.equal(
    classify(example({ instrument: 'EURUSD', blockers: [], executionAuthority: 'BROKER_NATIVE' })),
    'CURRENT_PRIMARY_ELIGIBLE',
  );
  assert.equal(
    classify(
      example({
        instrument: 'EURUSD',
        primaryPath: 'BLOCKED',
        chosenPath: 'BOOTSTRAP_CONTINUATION',
        blockers: [FALLBACK_VETO],
      }),
    ),
    'WEDNESDAY_FALLBACK_RESTORATION_ONLY',
  );
  assert.equal(
    classify(
      example({
        primaryPath: 'BLOCKED',
        chosenPath: 'QUALIFIED_CONTINUATION',
        blockers: [PAIR_VETO, FALLBACK_VETO],
      }),
    ),
    'BOTH_RESTRICTIONS_REQUIRED',
  );
  assert.equal(
    classify(
      example({
        instrument: 'EURUSD',
        primaryPath: 'BLOCKED',
        chosenPath: 'BLOCKED',
        blockers: [FALLBACK_VETO],
      }),
    ),
    'OTHER_BLOCKERS_REMAIN',
  );
});
test('commission-R calibration derives from closed broker gross economics and SL geometry', () => {
  assert.equal(median([0.12, 0.2, 0.31, 0.17]), 0.185);
  const x = feeRiskSample({
    instrument: 'EURUSD',
    closedAt: '2026-11-09T07:00Z',
    fillPrice: 1.11877,
    exitPrice: 1.11927,
    stopLoss: 1.11827,
    gross: 8.1,
    commission: -1.62,
    swap: 0,
    lotSize: 0.18,
  });
  assert.equal(x.instrument, 'EURUSD');
  assert.ok(Math.abs(x.commissionR - 0.2) < 1e-9);
  assert.equal(
    feeRiskSample({
      instrument: 'EURUSD',
      closedAt: createdAt,
      fillPrice: 1.11877,
      exitPrice: 1.11877,
      stopLoss: 1.11827,
      gross: 0,
      commission: -1.62,
      swap: 0,
      lotSize: 0.18,
    }),
    null,
  );
});
test('15 minute price proxy uses executable-side ASK for BUY and BID for SELL', () => {
  const x = pathState(example());
  assert.equal(x.state, 'NO_BARRIER_TOUCH');
  assert.ok(Math.abs(x.grossR - 0.2) < 1e-9);
  const y = pathState(
    example({
      direction: 'SELL',
      stopLoss: 1.1193,
      takeProfit: 1.1178,
      entryBid: 1.1188,
      entryAsk: 1.11882,
      futureAsk: 1.11865,
      futureBid: 1.11863,
    }),
  );
  assert.equal(y.state, 'NO_BARRIER_TOUCH');
  assert.ok(Math.abs(y.grossR - 0.3) < 1e-9);
});
test('missing quotes, gaps and quote-before-decision never become winning hypothetical trades', () => {
  for (const change of [
    { entryAt: '2026-11-09T08:02:48Z' },
    { entryAt: '2026-11-09T08:08:59Z' },
    { futureAt: '2026-11-09T08:12:00Z' },
    { pathBars: 15 },
    { firstPathBar: '2026-11-09T08:04:00Z', pathBars: 15 },
    { lastPathBar: '2026-11-09T08:17:00Z', pathBars: 15 },
    { entryBid: 1.119 },
    { futureBid: 1.11899, futureAsk: 1.11898 },
  ])
    assert.equal(pathState(example(change)).state, 'UNOBSERVABLE', JSON.stringify(change));
});
test('same-minute stop and target are unresolved even if a target quote closes high', () => {
  const x = pathState(
    example({
      firstPossibleStop: '2026-11-09T08:11:00Z',
      firstPossibleTarget: '2026-11-09T08:11:00Z',
      firstQuoteTarget: '2026-11-09T08:11:00Z',
    }),
  );
  assert.equal(x.state, 'SAME_MINUTE_BARRIER_AMBIGUITY');
  assert.equal(x.quoteTargetFirst, false);
});
test('a confirmed quote-close target only counts before any possible midpoint stop', () => {
  const x = pathState(
    example({
      firstPossibleTarget: '2026-11-09T08:10:00Z',
      firstQuoteTarget: '2026-11-09T08:11:00Z',
      firstPossibleStop: '2026-11-09T08:13:00Z',
    }),
  );
  assert.equal(x.state, 'POSSIBLE_TARGET_BEFORE_STOP');
  assert.equal(x.quoteTargetFirst, true);
});
test('only three previously closed commission samples and no future data calibrate net R', () => {
  const past = (n) => ({
    instrument: 'USDCHF',
    closedAt: new Date(Date.parse(createdAt) - (n + 1) * 3600000).toISOString(),
    fillPrice: 1.11877,
    exitPrice: 1.11927,
    stopLoss: 1.11827,
    gross: 8.1,
    commission: -1.62,
    swap: 0,
    lotSize: 0.18,
  });
  const future = { ...past(2), closedAt: '2026-11-09T09:00:00Z', commission: -15 };
  let x = assess(example(), [past(0), past(1)].map(feeRiskSample));
  assert.equal(x.holdTo15mNetProxyR, null);
  x = assess(example(), [past(0), past(1), past(2), future].map(feeRiskSample));
  assert.equal(x.commissionCalibrationSamples, 3);
  assert.ok(Math.abs(x.holdTo15mNetProxyR) < 1e-9);
});
test('stop first is not treated as an executable 15m hold-to-profit comparison', () => {
  const x = assess(
    example({ firstPossibleStop: '2026-11-09T08:08:00Z', futureBid: 1.1194, futureAsk: 1.11942 }),
    [],
  );
  assert.equal(x.observed.state, 'POSSIBLE_STOP_BEFORE_TARGET');
  assert.equal(x.holdTo15mNetProxyR, null);
});
test('episode spacing is independent by pair across direction and alternate pathways', () => {
  const rows = [
    example({ createdAt: '2026-11-09T08:02:50Z' }),
    example({
      direction: 'SELL',
      primaryPath: 'BLOCKED',
      chosenPath: 'BOOTSTRAP_CONTINUATION',
      blockers: [PAIR_VETO, FALLBACK_VETO],
      createdAt: '2026-11-09T08:07:50Z',
    }),
    example({ createdAt: '2026-11-09T08:35:50Z' }),
    example({ instrument: 'USDJPY', createdAt: '2026-11-09T08:10:50Z' }),
  ];
  const report = analyze(rows, [], [], '2026-11-05T14:00:00Z', '2026-11-09T11:15:00Z');
  assert.equal(report.artifact, ARTIFACT);
  assert.equal(report.authority, 'NONE');
  assert.equal(report.executionAllowed, false);
  assert.equal(report.modelFitted, false);
  assert.equal(report.rawCohortCounts.SIX_PAIR_PRIMARY_RESTORATION_ONLY.decisions, 3);
  assert.equal(report.spacedCohorts.SIX_PAIR_PRIMARY_RESTORATION_ONLY.decisions, 3);
  assert.equal(report.spacedCohorts.BOTH_RESTRICTIONS_REQUIRED, undefined);
});
test('realized historical net uses actual gross+commission+swap and never invents fills', () => {
  const trades = [
    {
      utcDate: '2026-11-04',
      instrument: 'USDJPY',
      authorityPath: 'PRIMARY_PLAN_B',
      gross: 9.43,
      commission: -1.6,
      swap: 0,
    },
    {
      utcDate: '2026-11-04',
      instrument: 'USDJPY',
      authorityPath: 'PRIMARY_PLAN_B',
      gross: 2.14,
      commission: -1.6,
      swap: 0,
    },
  ];
  const report = analyze([], [], trades, '2026-11-05T14:00:00Z', '2026-11-09T11:15:00Z');
  assert.deepEqual(report.actualClosedTradeNetEUR['2026-11-04/USDJPY/PRIMARY_PLAN_B'], {
    trades: 2,
    netEUR: 8.37,
    wins: 2,
  });
  assert.deepEqual(report.spacedCohorts, {});
});
test('read-only audit fails absent signed-in broker-owner scope and rolls back', async () => {
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('SELECT current_timestamp AS')) return { rows: [] };
      return { rows: [] };
    },
  };
  await assert.rejects(
    runAudit({
      client,
      userId: '1eb44121-d5c2-40a4-860a-2767e3200cff',
      connectionId: '1eb44121-d5c2-40a4-860a-2767e3200cfe',
      since: '2026-11-05T14:00:00Z',
    }),
    /OWNER_CTRADER_DEMO_NOT_FOUND/,
  );
  assert.ok(queries[0].includes('READ ONLY'));
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.ok(!queries.some((x) => /^\s*(?:INSERT|UPDATE|DELETE|EXECUTE)\s/i.test(x)));
});
