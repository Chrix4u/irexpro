'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  defineEngineIdentity,
  assertAccountIsolation,
  assertEquivalentStartingConditions,
  createAttributionLedger,
} = require('./v2-challenger-attribution.cjs');

const identityOf = (over) => defineEngineIdentity({
  engineCode: 'irexpro-v2-research', modelVersion: 'v2-r0',
  strategyCode: 'm1-tactical', generation: 1,
  executionAuthority: 'NONE', ...over,
});

test('R2: engine identity is a frozen research-only tuple', () => {
  const id = identityOf();
  assert.equal(id.engineCode, 'irexpro-v2-research');
  assert.equal(id.generation, 1);
  assert.equal(id.executionAuthority, 'NONE');
  assert.throws(() => { id.engineCode = 'x'; }, TypeError);
});

test('R2: broker or demo authority is refused at identity level', () => {
  assert.throws(() => identityOf({ executionAuthority: 'DEMO_ONLY' }),
    /ENGINE_IDENTITY_AUTHORITY_REFUSED:DEMO_ONLY/);
  assert.throws(() => identityOf({ executionAuthority: 'PAPER_ONLY_RESEARCH' }),
    /ENGINE_IDENTITY_AUTHORITY_REFUSED/);
});

test('R2: generation must be a positive integer', () => {
  assert.throws(() => identityOf({ generation: 0 }), /GENERATION_INVALID/);
  assert.throws(() => identityOf({ generation: 1.5 }), /GENERATION_INVALID/);
});

test('R1: account isolation requires distinct connection and credentials', () => {
  const ok = assertAccountIsolation(
    { connectionId: 'conn-champion', credentialFingerprint: 'fp-A' },
    { connectionId: 'conn-challenger', credentialFingerprint: 'fp-B' });
  assert.equal(ok.isolated, true);
  assert.deepEqual(ok.violations, []);

  const shared = assertAccountIsolation(
    { connectionId: 'conn-champion', credentialFingerprint: 'fp-A' },
    { connectionId: 'conn-champion', credentialFingerprint: 'fp-A' });
  assert.equal(shared.isolated, false);
  assert.deepEqual(shared.violations, ['CONNECTION_ID_SHARED', 'CREDENTIAL_FINGERPRINT_SHARED']);

  const missing = assertAccountIsolation(
    { connectionId: 'conn-champion', credentialFingerprint: 'fp-A' },
    { connectionId: 'conn-challenger' });
  assert.equal(missing.isolated, false);
  assert.deepEqual(missing.violations, ['CREDENTIAL_FINGERPRINT_MISSING']);
});

test('R4: equivalent starting conditions verified field by field', () => {
  const base = {
    startingBalance: 10000, leverage: 30,
    instruments: ['AUDUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
    costBasis: { commissionPerLot: 7, swapAssumption: 'NONE' },
    sessionWindow: '2026-12-01T00:00:00Z/PT24H',
    startedAt: '2026-12-01T00:00:00Z',
  };
  const ok = assertEquivalentStartingConditions(base,
    { ...base, startedAt: '2026-12-01T00:01:00Z' },
    { alignmentToleranceMs: 60000 });
  assert.equal(ok.equivalent, true);

  const late = assertEquivalentStartingConditions(base,
    { ...base, startedAt: '2026-12-01T00:01:01Z' },
    { alignmentToleranceMs: 60000 });
  assert.equal(late.equivalent, false);
  assert.deepEqual(late.violations, ['STARTED_AT_OUTSIDE_ALIGNMENT_WINDOW']);

  const divergent = assertEquivalentStartingConditions(base,
    { ...base, startingBalance: 5000, leverage: 500,
      instruments: ['EURUSD'], costBasis: { commissionPerLot: 3.5 } });
  assert.equal(divergent.equivalent, false);
  assert.deepEqual(divergent.violations, [
    'STARTING_BALANCE_MISMATCH', 'LEVERAGE_MISMATCH',
    'INSTRUMENT_ALLOWLIST_MISMATCH', 'COST_BASIS_MISMATCH',
  ]);
});

test('R5: ledger computes after-cost net and R, freezing rows on insert', () => {
  const ledger = createAttributionLedger();
  const row = ledger.register({
    engineIdentity: identityOf(),
    tradeId: 'demo-0001', instrument: 'EURUSD', direction: 'BUY',
    lots: 0.5, openedAt: '2026-12-01T00:05:00Z', closedAt: '2026-12-01T00:20:00Z',
    grossPnl: 100, commission: 8, swap: 2, riskAmount: 200,
    settlementProvenance: 'BROKER_CONFIRMED',
  });
  assert.equal(row.netPnl, 90);
  assert.equal(row.rMultiple, 0.45);
  assert.equal(row.settlementProvenance, 'BROKER_CONFIRMED');
  assert.throws(() => { row.netPnl = 0; }, TypeError);
  assert.equal(ledger.count(), 1);
});

test('R5/R3: duplicate trade id refused; cross-engine id is contamination', () => {
  const ledger = createAttributionLedger();
  const champion = identityOf();
  const challenger = identityOf({
    engineCode: 'irexpro-v2-research', modelVersion: 'v2-r1',
  });
  ledger.register({
    engineIdentity: champion, tradeId: 'demo-0001', instrument: 'EURUSD',
    direction: 'BUY', lots: 0.1, openedAt: '2026-12-01T00:05:00Z',
    closedAt: '2026-12-01T00:20:00Z', grossPnl: 10, commission: 1, swap: 0,
  });
  assert.throws(() => ledger.register({
    engineIdentity: champion, tradeId: 'demo-0001', instrument: 'EURUSD',
    direction: 'BUY', lots: 0.1, openedAt: '2026-12-01T00:25:00Z',
    closedAt: '2026-12-01T00:40:00Z', grossPnl: 5, commission: 1, swap: 0,
  }), /ATTRIBUTION_DUPLICATE_TRADE_ID/);
  assert.throws(() => ledger.register({
    engineIdentity: challenger, tradeId: 'demo-0001', instrument: 'EURUSD',
    direction: 'SELL', lots: 0.1, openedAt: '2026-12-01T00:25:00Z',
    closedAt: '2026-12-01T00:40:00Z', grossPnl: -5, commission: 1, swap: 0,
  }), /ATTRIBUTION_CROSS_ENGINE_CONTAMINATION/);
});

test('R5: malformed rows are typed refusals, never silent repairs', () => {
  const ledger = createAttributionLedger();
  assert.throws(() => ledger.register({
    engineIdentity: identityOf(), tradeId: 'bad-1', instrument: 'EURUSD',
    direction: 'BUY', lots: 0.1, openedAt: '2026-12-01T00:40:00Z',
    closedAt: '2026-12-01T00:20:00Z', grossPnl: 0, commission: 0, swap: 0,
  }), /ATTRIBUTION_TIMESTAMPS_INVALID/);
  assert.throws(() => ledger.register({
    engineIdentity: identityOf(), tradeId: 'bad-2', instrument: 'EURUSD',
    direction: 'HOLD', lots: 0.1, openedAt: '2026-12-01T00:05:00Z',
    closedAt: '2026-12-01T00:20:00Z', grossPnl: 0, commission: 0, swap: 0,
  }), /ATTRIBUTION_DIRECTION_INVALID/);
  assert.throws(() => ledger.register({
    engineIdentity: { engineCode: 'x', modelVersion: 'y', strategyCode: 'z',
      generation: 1, executionAuthority: 'DEMO_ONLY' },
    tradeId: 'bad-3', instrument: 'EURUSD', direction: 'BUY', lots: 0.1,
    openedAt: '2026-12-01T00:05:00Z', closedAt: '2026-12-01T00:20:00Z',
    grossPnl: 0, commission: 0, swap: 0,
  }), /ATTRIBUTION_IDENTITY_INVALID/);
});

test('R6: comparative summary is a per-engine read-only projection', () => {
  const ledger = createAttributionLedger();
  const champion = identityOf();
  const challenger = identityOf({ modelVersion: 'v2-r1' });
  const row = (identity, tradeId, gross, lots) => ledger.register({
    engineIdentity: identity, tradeId, instrument: 'EURUSD',
    direction: 'BUY', lots,
    openedAt: '2026-12-01T00:05:00Z', closedAt: '2026-12-01T00:20:00Z',
    grossPnl: gross, commission: 0, swap: 0,
  });
  row(champion, 'c-1', 90, 1.0);
  row(champion, 'c-2', -50, 0.5);
  row(challenger, 'h-1', 25, 0.2);
  const summary = ledger.summarize();
  assert.equal(summary.length, 2);
  const [a, b] = summary;
  assert.equal(a.tradeCount, 2);
  assert.equal(a.winRate, 0.5);
  assert.equal(a.totalNetPnl, 40);
  assert.equal(a.netPerLot, 40 / 1.5);
  assert.equal(b.tradeCount, 1);
  assert.equal(b.winRate, 1);
  assert.equal(b.totalNetPnl, 25);
});
