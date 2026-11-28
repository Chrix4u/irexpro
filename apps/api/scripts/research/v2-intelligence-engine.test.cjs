'use strict';
/** Tests for the V2 intelligence engine and champion baseline mirror. */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  CHAMPION_POLICY_MIRROR,
  CHALLENGER_POLICY,
  computeChampionCandidate,
  createEnginePolicy,
} = require('./v2-intelligence-engine.cjs');
const { createFeatureWindow } = require('./v2-engine-features.cjs');
const { generateMarketPath } = require('./v2-synthetic-market.cjs');
const { V2_CHALLENGER_EXIT_PRESET } = require('./v2-exit-intelligence-contract.cjs');
const { defineEngineIdentity } = require('./v2-challenger-attribution.cjs');

const identity = defineEngineIdentity({
  engineCode: 'V2-CHALLENGER', modelVersion: 'v2-intelligence-engine-v1',
  strategyCode: 'V2-RESEARCH', generation: 1, executionAuthority: 'RESEARCH_SHADOW',
});

const championIdentity = defineEngineIdentity({
  engineCode: 'V1-CHAMPION-MIRROR', modelVersion: 'm1-tactical-candidate-v1',
  strategyCode: 'M1-TACTICAL', generation: 1, executionAuthority: 'RESEARCH_SHADOW',
});

function firstSnapshot(scenario) {
  const path = generateMarketPath({ seed: 31, nBars: 400, scenario });
  const fw = createFeatureWindow({});
  let snap = null;
  for (const bar of path.bars) {
    snap = fw.update(bar);
    if (snap) break;
  }
  return { path, snap };
}

test('champion policy mirror constants are the audited values (frozen)', () => {
  assert.strictEqual(CHAMPION_POLICY_MIRROR.stopAtrMultiplier, 1.1);
  assert.strictEqual(CHAMPION_POLICY_MIRROR.minStopPips, 5);
  assert.strictEqual(CHAMPION_POLICY_MIRROR.targetR, 1.6);
  assert.strictEqual(CHAMPION_POLICY_MIRROR.maxConfidence, 0.738);
  assert.strictEqual(CHAMPION_POLICY_MIRROR.fixedLots, 0.2);
  assert.deepStrictEqual(
    Object.values(CHAMPION_POLICY_MIRROR.compositeWeights).reduce((s, v) => s + v, 0),
    1.0,
  );
  assert.strictEqual(
    CHAMPION_POLICY_MIRROR.compositeWeights.emaSeparation, 0.19);
  assert.strictEqual(CHAMPION_POLICY_MIRROR.compositeWeights.htfAgreement, 0.20);
});

test('champion mirror is frozen (V1 preservation canary)', () => {
  assert.throws(() => { CHAMPION_POLICY_MIRROR.stopAtrMultiplier = 2; }, TypeError);
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(CHAMPION_POLICY_MIRROR)).digest('hex');
  // Pinned: any change to the champion mirror is a baseline change and
  // must fail this canary.
  assert.strictEqual(hash,
    crypto.createHash('sha256')
      .update(JSON.stringify({
        artifact: 'v2-champion-baseline-v1',
        stopAtrMultiplier: 1.1,
        minStopPips: 5,
        targetR: 1.6,
        maxConfidence: 0.738,
        compositeWeights: {
          emaSeparation: 0.19, emaSlope: 0.10, momentum3: 0.16, momentum5: 0.10,
          htfAgreement: 0.20, closePressure: 0.08, wickPressure: 0.05,
          rsiBias: 0.04, breakout: 0.08,
        },
        entryGateDirectionQuality: 0.60,
        fixedLots: 0.2,
        provenance: 'm1-tactical-candidate.ts l.24-27,110-167; position-sizing.service.ts l.190',
      })).digest('hex'));
});

test('computeChampionCandidate mirrors the S1 formula chain', () => {
  const { snap } = firstSnapshot('EDGE_ZERO');
  const buy = computeChampionCandidate(snap, 'BUY', 0.0001);
  const sell = computeChampionCandidate(snap, 'SELL', 0.0001);
  assert.ok(buy.directionQuality >= 0 && buy.directionQuality <= 1);
  assert.ok(buy.confidence <= 0.738);
  // Directional symmetry: S1's composite is sign-flipped between sides.
  assert.ok(Math.abs((buy.directionQuality + sell.directionQuality) - 1) < 1e-9);
  // Stop geometry: max(1.1xATR, 5 pips).
  assert.ok(Math.abs(buy.stopDistance -
    Math.max(snap.atr14 * 1.1, 0.0005)) < 1e-12);
  assert.ok(Math.abs(buy.targetDistance - buy.stopDistance * 1.6) < 1e-12);
});

test('computeChampionCandidate refuses non-ready snapshots', () => {
  assert.throws(() => computeChampionCandidate({}, 'BUY', 0.0001),
    /ENGINE_SNAPSHOT_REQUIRED/);
});

test('engine policies refuse non-research identities', () => {
  assert.throws(() => createEnginePolicy('CHALLENGER', { engineIdentity: null }),
    /ENGINE_IDENTITY_RESEARCH_ONLY/);
  assert.throws(() => createEnginePolicy('CHALLENGER', {
    engineIdentity: { ...identity, executionAuthority: 'LIVE' },
  }), /ENGINE_IDENTITY_RESEARCH_ONLY/);
  assert.throws(() => createEnginePolicy('WAT', { engineIdentity: identity }),
    /ENGINE_KIND_UNKNOWN/);
});

test('champion enters only above the gate and never exits by policy', () => {
  const engine = createEnginePolicy('CHAMPION', { engineIdentity: championIdentity });
  const { path, snap } = firstSnapshot('TREND_REGIMES');
  const bar = path.bars[150];
  let entered = 0;
  let exited = 0;
  const fw = createFeatureWindow({});
  let i = -1;
  for (const b of path.bars) {
    i += 1;
    const s = fw.update(b);
    if (!s) continue;
    const d = engine.decide({
      bar: b, barIndex: i, snapshot: s,
      position: null, equityUsd: 50000, lastClose: b.close,
    });
    if (d.entry) {
      entered += 1;
      assert.ok(d.entry.directionQuality >= 0.60);
      assert.strictEqual(d.entry.lots, 0.2);
    }
    if (d.exit) exited += 1;
  }
  assert.ok(entered > 0, 'champion must trade over a 400-bar trend path');
  assert.strictEqual(exited, 0);
});

test('challenger sizes by risk fraction, capped at 0.2 lots', () => {
  const engine = createEnginePolicy('CHALLENGER', { engineIdentity: identity });
  const { path } = firstSnapshot('TREND_REGIMES');
  const fw = createFeatureWindow({});
  let i = -1;
  let lotsSeen = 0;
  for (const b of path.bars) {
    i += 1;
    const s = fw.update(b);
    if (!s) continue;
    const d = engine.decide({
      bar: b, barIndex: i, snapshot: s, position: null,
      equityUsd: 50000, lastClose: b.close,
    });
    if (d.entry) {
      lotsSeen += 1;
      assert.ok(d.entry.lots >= CHALLENGER_POLICY.minLots);
      assert.ok(d.entry.lots <= CHALLENGER_POLICY.maxLots);
    }
  }
  assert.ok(lotsSeen > 0, 'challenger must produce sized entries');
});

test('challenger exit decisions flow through EI-1 (time stop / guard / ladder)', () => {
  const engine = createEnginePolicy('CHALLENGER', { engineIdentity: identity });
  const { snap } = firstSnapshot('EDGE_ZERO');
  const position = {
    direction: 'BUY', entryPrice: 1.12, stopDistance: 0.0006,
    peakR: 0.2, grossR: 0.2, barsHeld: V2_CHALLENGER_EXIT_PRESET.timeStopBars,
  };
  const d = engine.decide({
    bar: { close: 1.12 }, barIndex: 500, snapshot: snap, position,
    equityUsd: 50000, lastClose: 1.12,
  });
  assert.strictEqual(d.exit.reason, 'TIME_STOP');

  const guardPosition = {
    direction: 'BUY', entryPrice: 1.12, stopDistance: 0.0006,
    peakR: 0.0, grossR: -0.5, barsHeld: 5,
  };
  const g = engine.decide({
    bar: { close: 1.1197 }, barIndex: 500, snapshot: snap, position: guardPosition,
    equityUsd: 50000, lastClose: 1.1197,
  });
  assert.strictEqual(g.exit.reason, 'DRAWDOWN_GUARD');

  const locked = engine.decide({
    bar: { close: 1.12 }, barIndex: 500, snapshot: snap, position: {
      direction: 'BUY', entryPrice: 1.12, stopDistance: 0.0006,
      peakR: 0.8, grossR: 0.6, barsHeld: 30,
    },
    equityUsd: 50000, lastClose: 1.12,
  });
  // peak 0.8 -> retain 0.75 -> lock 0.6R; gross 0.6 <= lock -> close.
  assert.strictEqual(locked.exit.reason, 'LOCK_TRAIL');
});

test('challenger registers pre-outcome probabilities on a fixed cadence', () => {
  const engine = createEnginePolicy('CHALLENGER', { engineIdentity: identity });
  const { path } = firstSnapshot('EDGE_ZERO');
  const fw = createFeatureWindow({});
  let i = -1;
  const registrations = [];
  for (const b of path.bars) {
    i += 1;
    const s = fw.update(b);
    if (!s) continue;
    const d = engine.decide({
      bar: b, barIndex: i, snapshot: s, position: null,
      equityUsd: 50000, lastClose: b.close,
    });
    if (d.registeredProbability) registrations.push(d.registeredProbability);
  }
  assert.ok(registrations.length >= 30);
  for (const r of registrations) {
    assert.ok(r.probability >= 0 && r.probability <= 0.738 + 1e-12);
    assert.strictEqual(r.windowBars, CHALLENGER_POLICY.forwardWindowBars);
    assert.ok(r.direction === 'BUY' || r.direction === 'SELL');
  }
});

test('challenger decisions are deterministic (same input -> same trace)', () => {
  const runTrace = () => {
    const engine = createEnginePolicy('CHALLENGER', { engineIdentity: identity });
    const { path } = firstSnapshot('TREND_REGIMES');
    const fw = createFeatureWindow({});
    let i = -1;
    const trace = [];
    for (const b of path.bars) {
      i += 1;
      const s = fw.update(b);
      if (!s) continue;
      const d = engine.decide({
        bar: b, barIndex: i, snapshot: s, position: null,
        equityUsd: 50000, lastClose: b.close,
      });
      trace.push(d.entry ? 'e' : d.registeredProbability ? 'p' : 'n');
    }
    return trace.join(',');
  };
  assert.strictEqual(runTrace(), runTrace());
});
