'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./v2-champion-challenger-attribution.cjs');

function identity(over) {
  return {
    role: 'CHAMPION', engineId: 'AI-V1-CHAMPION', accountRef: 'DEMO-ACCOUNT-A',
    accountCurrency: 'USD', accountType: 'DEMO', startingBalance: 50000, leverage: 30,
    instruments: ['EURUSD', 'AUDUSD', 'USDCAD', 'USDJPY'], windowStart: '2026-12-01T00:00:00Z',
    windowEnd: '2026-12-15T00:00:00Z', engineVersion: 'v1-frozen', decisionPolicySha: 'sha-v1',
    costModel: { commissionPerLot: 3.5, slippagePips: 0.3 }, ...over,
  };
}
const challenger = (over) => identity({ role: 'CHALLENGER', engineId: 'AI-V2-CHALLENGER', accountRef: 'DEMO-ACCOUNT-B', engineVersion: 'v2-research-0', decisionPolicySha: 'sha-v2', ...over });
const fill = (over) => ({
  fillId: 'F-1', engineId: 'AI-V1-CHAMPION', accountRef: 'DEMO-ACCOUNT-A', tradeId: 'T-1',
  instrument: 'EURUSD', direction: 'BUY', openedAt: '2026-12-01T01:00:00Z', closedAt: '2026-12-01T01:20:00Z',
  realizedNetAfterCost: -0.2, exitType: 'BROKER_CLOSE', decisionProvenance: 'DECISION-JSON-1', ...over,
});

test('engine identities require DEMO isolation fields and policy SHA', () => {
  const ok = m.defineEngineIdentity(identity({}));
  assert.deepEqual(ok.errors, undefined);
  const bad = m.defineEngineIdentity(identity({ accountType: 'LIVE' }));
  assert.ok(bad.errors.some((e) => /accountType/.test(e)));
  const noSha = m.defineEngineIdentity(identity({ decisionPolicySha: '' }));
  assert.ok(noSha.errors.some((e) => /decisionPolicySha/.test(e)));
});

test('equivalent starting conditions verified; unequal balance blocks comparison', () => {
  const eq = m.verifyEquivalentConditions(identity({}), challenger({}));
  assert.equal(eq.equivalent, true);
  const diff = m.verifyEquivalentConditions(identity({}), challenger({ startingBalance: 25000 }));
  assert.equal(diff.equivalent, false);
  assert.ok(diff.failed.includes('startingBalance'));
  const sameAccount = m.verifyEquivalentConditions(identity({}), challenger({ accountRef: 'DEMO-ACCOUNT-A' }));
  assert.equal(sameAccount.equivalent, false);
  assert.ok(sameAccount.failed.includes('accountIsolation'));
  const diffCost = m.verifyEquivalentConditions(identity({}), challenger({ costModel: { commissionPerLot: 0 } }));
  assert.equal(diffCost.equivalent, false);
  assert.ok(diffCost.failed.includes('costModel'));
});

test('attribution ledger is append-only: duplicates and mutation rejected', () => {
  const ledger = m.createAttributionLedger();
  assert.equal(ledger.appendFill(fill({})).accepted, true);
  const dup = ledger.appendFill(fill({}));
  assert.equal(dup.reason, 'DUPLICATE_FILL_ATTRIBUTION');
  const mut = ledger.tryMutate('F-1', { realizedNetAfterCost: 5 });
  assert.equal(mut.reason, 'IMMUTABLE_ATTRIBUTION');
  assert.ok(ledger.rejections.some((r) => r.reason === 'IMMUTABLE_ATTRIBUTION'));
  // provenance digest recorded
  const stored = ledger.fills.find((f) => f.fillId === 'F-1');
  assert.ok(/^fixture-/.test(stored.decisionProvenanceSha));
});

test('engine-account binding rejects a fill posted to the wrong account', () => {
  const ledger = m.createAttributionLedger();
  ledger.registerEngineAccount('AI-V1-CHAMPION', 'DEMO-ACCOUNT-A');
  assert.equal(ledger.appendFill(fill({})).accepted, true);
  const wrong = ledger.appendFill(fill({ fillId: 'F-2', tradeId: 'T-2', accountRef: 'DEMO-ACCOUNT-B' }));
  assert.equal(wrong.reason, 'ENGINE_ACCOUNT_MISMATCH');
});

test('cross-engine close is rejected: independent position ownership', () => {
  const ledger = m.createAttributionLedger();
  ledger.registerEngineAccount('AI-V1-CHAMPION', 'DEMO-ACCOUNT-A');
  ledger.registerEngineAccount('AI-V2-CHALLENGER', 'DEMO-ACCOUNT-B');
  ledger.appendFill(fill({}));
  const own = ledger.requestClose({ engineId: 'AI-V1-CHAMPION', tradeId: 'T-1' });
  assert.equal(own.allowed, true);
  const cross = ledger.requestClose({ engineId: 'AI-V2-CHALLENGER', tradeId: 'T-1' });
  assert.equal(cross.reason, 'CROSS_ENGINE_CLOSE_REJECTED');
  assert.ok(ledger.rejections.some((r) => r.reason === 'CROSS_ENGINE_CLOSE_REJECTED'));
});

test('comparative dashboard only under equivalence and sufficient samples', () => {
  const ledger = m.createAttributionLedger();
  ledger.registerEngineAccount('AI-V1-CHAMPION', 'DEMO-ACCOUNT-A');
  ledger.registerEngineAccount('AI-V2-CHALLENGER', 'DEMO-ACCOUNT-B');
  ledger.appendFill(fill({ realizedNetAfterCost: 0.4 }));
  ledger.appendFill(fill({ fillId: 'F-2', tradeId: 'T-2', engineId: 'AI-V2-CHALLENGER', accountRef: 'DEMO-ACCOUNT-B', realizedNetAfterCost: -0.1, decisionProvenance: 'DECISION-JSON-2' }));
  const insufficient = m.comparativeReport(identity({}), challenger({}), ledger, { minTrades: 100 });
  assert.equal(insufficient.emitted, false);
  assert.ok(insufficient.blockers.some((b) => b.kind === 'INSUFFICIENT_SAMPLE'));
  // No winner declared even when emitted at low sufficiency:
  const none = m.comparativeReport(identity({}), challenger({}), ledger, null);
  assert.equal(none.emitted, true);
  assert.equal(none.paired.note.includes('no winner'), true);
  // Unequal starting conditions block the dashboard entirely:
  const blocked = m.comparativeReport(identity({}), challenger({ startingBalance: 25000 }), ledger, null);
  assert.equal(blocked.emitted, false);
  assert.ok(blocked.blockers.some((b) => b.kind === 'STARTING_CONDITIONS_NOT_EQUIVALENT'));
});

test('accounts are never netted: attribution stays per engine and account', () => {
  const ledger = m.createAttributionLedger();
  ledger.registerEngineAccount('AI-V1-CHAMPION', 'DEMO-ACCOUNT-A');
  ledger.registerEngineAccount('AI-V2-CHALLENGER', 'DEMO-ACCOUNT-B');
  ledger.appendFill(fill({ realizedNetAfterCost: 0.3 }));
  ledger.appendFill(fill({ fillId: 'F-2', tradeId: 'T-2', realizedNetAfterCost: -0.2, decisionProvenance: 'D2' }));
  ledger.appendFill(fill({ fillId: 'F-3', tradeId: 'T-3', engineId: 'AI-V2-CHALLENGER', accountRef: 'DEMO-ACCOUNT-B', realizedNetAfterCost: 0.5, decisionProvenance: 'D3' }));
  const attribution = ledger.attributionByEngine();
  assert.equal(attribution.length, 2);
  const champ = attribution.find((a) => a.engineId === 'AI-V1-CHAMPION');
  const chall = attribution.find((a) => a.engineId === 'AI-V2-CHALLENGER');
  assert.ok(Math.abs(champ.netAfterCost - 0.1) < 1e-12);
  assert.equal(chall.netAfterCost, 0.5);
  assert.notEqual(champ.accountRef, chall.accountRef);
});
