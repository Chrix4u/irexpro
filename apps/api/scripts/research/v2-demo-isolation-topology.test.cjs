'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTopology } = require('./v2-demo-isolation-topology.cjs');

// Reference topology satisfying all six DEMO-isolation requirements.
const topology = () => ({
  engines: [
    {
      engineId: 'AI-V1-CHAMPION',
      account: { environment: 'DEMO', broker: 'PEPPERSTONE_CTRADER', accountIdRef: 800111 },
      positionOwnership: 'ENGINE_SCOPED',
      credentials: { scope: 'ENGINE_SCOPED', shared: false },
      startingConditions: {
        startingEquityUsd: 10000, instruments: ['EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY'],
        volumeConstraints: { minLot: 0.01, maxLot: 0.1 }, riskConfiguration: { maxRiskPerTradeUsd: 100 },
      },
    },
    {
      engineId: 'AI-V2-CHALLENGER',
      account: { environment: 'DEMO', broker: 'PEPPERSTONE_CTRADER', accountIdRef: 800222 },
      positionOwnership: 'ENGINE_SCOPED',
      credentials: { scope: 'ENGINE_SCOPED', shared: false },
      startingConditions: {
        startingEquityUsd: 10000, instruments: ['EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY'],
        volumeConstraints: { minLot: 0.01, maxLot: 0.1 }, riskConfiguration: { maxRiskPerTradeUsd: 100 },
      },
    },
  ],
  attributionLedger: {
    appendOnly: true, engineStamped: true, mutable: false, hashChain: 'SHA256_CHAIN_V1',
    recordFields: ['windowId', 'engineId', 'accountIdRef', 'netPnlUsd', 'costsUsd', 'maxDrawdownUsd', 'recordedAt', 'prevRecordHash', 'recordHash'],
  },
  comparativeDashboard: {
    perEngineViews: true, enginesListed: ['AI-V1-CHAMPION', 'AI-V2-CHALLENGER'],
    metrics: ['netAfterCostReturn', 'riskNormalizedExpectancy', 'maxDrawdown', 'profitFactor', 'calibration'],
  },
});

test('validates the reference two-engine DEMO-isolation topology', () => {
  const r = validateTopology(topology());
  assert.equal(r.status, 'VALIDATED');
  assert.equal(r.violations.length, 0);
  assert.equal(r.researchOnly, true);
  assert.equal(r.executionAuthority, 'NONE');
  assert.equal(Object.keys(r.requirements).length, 6);
  assert.match(r.note, /No broker account is created/);
});

test('rejects a shared DEMO account between the two engines', () => {
  const t = topology();
  t.engines[1].account.accountIdRef = t.engines[0].account.accountIdRef;
  const r = validateTopology(t);
  assert.equal(r.status, 'VIOLATIONS_FOUND');
  assert.ok(r.violations.some((v) => v.requirement === 'R1_INDEPENDENT_DEMO_ACCOUNT' && /distinct/.test(v.detail)));
});

test('rejects LIVE environments and non-Pepperstone brokers for the comparative study', () => {
  const t = topology();
  t.engines[0].account.environment = 'LIVE';
  t.engines[1].account.broker = 'OTHER_BROKER';
  const r = validateTopology(t);
  assert.ok(r.violations.some((v) => v.requirement === 'R1_INDEPENDENT_DEMO_ACCOUNT' && /DEMO environment/.test(v.detail)));
  assert.ok(r.violations.some((v) => v.requirement === 'R1_INDEPENDENT_DEMO_ACCOUNT' && /Pepperstone cTrader/.test(v.detail)));
});

test('rejects shared credentials and non engine-scoped positions', () => {
  const t = topology();
  t.engines[1].credentials = { scope: 'SHARED', shared: true };
  const r = validateTopology(t);
  assert.ok(r.violations.some((v) => v.requirement === 'R3_INDEPENDENT_POSITION_OWNERSHIP'));
});

test('rejects unequal starting conditions', () => {
  const t = topology();
  t.engines[1].startingConditions.startingEquityUsd = 20000;
  const r = validateTopology(t);
  assert.ok(r.violations.some((v) => v.requirement === 'R4_EQUIVALENT_STARTING_CONDITIONS' && /equity/.test(v.detail)));
});

test('rejects a mutable or incomplete attribution ledger', () => {
  const t = topology();
  t.attributionLedger.mutable = true;
  let r = validateTopology(t);
  assert.ok(r.violations.some((v) => v.requirement === 'R5_IMMUTABLE_PERFORMANCE_ATTRIBUTION' && /append-only/.test(v.detail)));
  t.attributionLedger.mutable = false;
  t.attributionLedger.recordFields = ['windowId', 'engineId']; // missing mandatory evidence fields
  r = validateTopology(t);
  assert.ok(r.violations.some((v) => v.requirement === 'R5_IMMUTABLE_PERFORMANCE_ATTRIBUTION' && /recordHash/.test(v.detail)));
});

test('rejects a dashboard that hides an engine or a mandatory metric', () => {
  const t = topology();
  t.comparativeDashboard.enginesListed = ['AI-V2-CHALLENGER'];
  let r = validateTopology(t);
  assert.ok(r.violations.some((v) => v.requirement === 'R6_COMPARATIVE_DASHBOARD' && /both/.test(v.detail)));
  t.comparativeDashboard.enginesListed = ['AI-V1-CHAMPION', 'AI-V2-CHALLENGER'];
  t.comparativeDashboard.metrics = ['netAfterCostReturn'];
  r = validateTopology(t);
  assert.ok(r.violations.some((v) => v.requirement === 'R6_COMPARATIVE_DASHBOARD' && /calibration/.test(v.detail)));
});

test('rejects engine identities outside the champion-challenger pair', () => {
  const t = topology();
  t.engines[1].engineId = 'AI-V3-EXPERIMENTAL';
  const r = validateTopology(t);
  assert.ok(r.violations.some((v) => v.requirement === 'R2_SEPARATE_ENGINE_IDENTITY'));
});

test('refuses missing topology input without inventing defaults', () => {
  const r = validateTopology(null);
  assert.equal(r.status, 'INVALID_INPUT');
  assert.equal(r.executionAuthority, 'NONE');
});
