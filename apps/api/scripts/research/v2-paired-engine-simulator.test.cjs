'use strict';
/** Tests for the paired-engine simulator (P2-2). */

const test = require('node:test');
const assert = require('node:assert');

const { generateMarketPath } = require('./v2-synthetic-market.cjs');
const { runPairedReplay } = require('./v2-paired-engine-simulator.cjs');

test('paired replay is deterministic and ledger-backed', () => {
  const market = generateMarketPath({ seed: 11, nBars: 800, scenario: 'TREND_REGIMES' });
  const a = runPairedReplay({ market });
  const b = runPairedReplay({ market });
  assert.deepStrictEqual(a.champion.trades, b.champion.trades);
  assert.deepStrictEqual(a.challenger.trades, b.challenger.trades);
  assert.deepStrictEqual(a.champion.equityCurve, b.champion.equityCurve);
  assert.strictEqual(a.ledger.count(), a.champion.trades.length + a.challenger.trades.length);
});

test('identical paths and costs: same market, two engines, one ledger', () => {
  const market = generateMarketPath({ seed: 12, nBars: 1500, scenario: 'TREND_REGIMES' });
  const r = runPairedReplay({ market });
  assert.ok(r.champion.trades.length > 10, 'champion must trade');
  assert.ok(r.challenger.trades.length > 10, 'challenger must trade');
  for (const t of [...r.champion.trades, ...r.challenger.trades]) {
    assert.ok(['STOP_LOSS', 'TARGET', 'LOCK_TRAIL', 'DRAWDOWN_GUARD',
      'REVERSAL_EXIT', 'TIME_STOP', 'HORIZON_CLOSE'].includes(t.exitReason));
    assert.ok(t.netR - t.grossR <= 1e-9, 'netR must be gross minus costs');
    assert.ok(t.mfeR >= t.grossR - 1e-9 || t.exitReason === 'HORIZON_CLOSE');
    assert.strictEqual(t.settlementProvenance, 'SYNTHETIC_CAMPAIGN');
    assert.ok(t.riskAmountUsd > 0);
  }
  // Ledger summary sees both engines with identical cost bases.
  const summary = r.ledger.summarize();
  assert.strictEqual(summary.length, 2);
  const codes = summary.map((s) => s.engineIdentity.engineCode).sort();
  assert.deepStrictEqual(codes, ['V1-CHAMPION-MIRROR', 'V2-CHALLENGER']);
});

test('champion exits are stop/target only (frozen baseline behavior)', () => {
  const market = generateMarketPath({ seed: 13, nBars: 1500, scenario: 'TREND_REGIMES' });
  const r = runPairedReplay({ market });
  for (const t of r.champion.trades) {
    assert.ok(['STOP_LOSS', 'TARGET', 'HORIZON_CLOSE'].includes(t.exitReason),
      `champion exit reason must be frozen geometry, saw ${t.exitReason}`);
  }
});

test('challenger retention ladder produces LOCK_TRAIL exits with locked R', () => {
  const market = generateMarketPath({ seed: 14, nBars: 2500, scenario: 'TREND_REGIMES' });
  const r = runPairedReplay({ market });
  const locks = r.challenger.trades.filter((t) => t.exitReason === 'LOCK_TRAIL');
  assert.ok(locks.length > 5, 'retention ladder must fire');
  for (const t of locks) {
    // A lock exit realizes a fraction of a previously-seen peak: 0 < realized grossR < peak R.
    assert.ok(t.grossR > 0, `lock exit must be profitable, saw ${t.grossR}`);
    assert.ok(t.grossR <= t.mfeR + 1e-9);
  }
});

test('costs are charged per side and per night', () => {
  const market = generateMarketPath({ seed: 15, nBars: 1200, scenario: 'EDGE_ZERO' });
  const r = runPairedReplay({ market });
  const t = r.champion.trades[0];
  if (t) {
    assert.ok(t.commissionUsd > 0);
    assert.ok(t.costsR >= 0);
  }
  // Overnight holds accrue swap for at least one trade on a 1200-bar path.
  const withSwap = [...r.champion.trades, ...r.challenger.trades]
    .filter((x) => x.swapUsd > 0);
  assert.ok(withSwap.length > 0, 'expected at least one overnight swap accrual');
});

test('equity curves match the ledger exactly (single source of truth)', () => {
  const market = generateMarketPath({ seed: 16, nBars: 1200, scenario: 'TREND_REGIMES' });
  const r = runPairedReplay({ market });
  for (const side of ['champion', 'challenger']) {
    const finalEquity = r[side].equityCurve[r[side].equityCurve.length - 1];
    const netTotal = r[side].trades.reduce((s, t) => s + t.netUsd, 0);
    assert.ok(Math.abs((finalEquity - r.startingBalanceUsd) - netTotal) < 1e-6,
      `${side} equity must reconcile to settled trade nets`);
  }
});

test('typed refusals for invalid simulator inputs', () => {
  assert.throws(() => runPairedReplay({}), /PAIRED_MARKET_REQUIRED/);
  assert.throws(() => runPairedReplay({
    market: generateMarketPath({ seed: 1, nBars: 500, scenario: 'EDGE_ZERO' }),
    startingBalanceUsd: 0,
  }), /PAIRED_STARTING_BALANCE_INVALID/);
  assert.throws(() => runPairedReplay({
    market: generateMarketPath({ seed: 1, nBars: 500, scenario: 'EDGE_ZERO' }),
    costModel: { commissionUsdPerLotPerSide: 'free' },
  }), /PAIRED_COST_MODEL_INVALID/);
});
