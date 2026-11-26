'use strict';

// V2 Champion–Challenger DEMO isolation topology — descriptive contract
// validation, research-only. This module validates a TOPOLOGY DESCRIPTOR; it
// does not create, connect or modify any broker account. The intended
// comparative environment is two isolated Pepperstone cTrader DEMO accounts
// (AI V1 Champion and AI V2 Challenger) with the six mandatory properties
// from the research directive.
const ARTIFACT = 'v2-demo-isolation-topology-v1';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const ENGINE_IDS = Object.freeze(['AI-V1-CHAMPION', 'AI-V2-CHALLENGER']);
const REQUIRED_LEDGER_FIELDS = ['windowId', 'engineId', 'accountIdRef', 'netPnlUsd', 'costsUsd', 'maxDrawdownUsd', 'recordedAt', 'prevRecordHash', 'recordHash'];

function validateTopology(topology, options = {}) {
  const base = { artifact: ARTIFACT, researchOnly: true, executionAuthority: 'NONE' };
  if (!topology || typeof topology !== 'object') {
    return { ...base, status: 'INVALID_INPUT', violations: [{ requirement: 'TOPOLOGY_DESCRIPTOR', detail: 'missing topology descriptor' }] };
  }
  const violations = [];
  const engines = Array.isArray(topology.engines) ? topology.engines : [];

  // R1 — independent DEMO account per engine (Pepperstone cTrader, distinct accounts).
  const accountIds = engines.map((e) => e && e.account && e.account.accountIdRef);
  if (engines.length !== 2) violations.push({ requirement: 'R1_INDEPENDENT_DEMO_ACCOUNT', detail: `expected exactly 2 engines, found ${engines.length}` });
  engines.forEach((e, i) => {
    if (!e || !e.account || e.account.environment !== 'DEMO') {
      violations.push({ requirement: 'R1_INDEPENDENT_DEMO_ACCOUNT', detail: `engine ${i} is not scoped to a DEMO environment` });
    }
    if (!e || !e.account || e.account.broker !== 'PEPPERSTONE_CTRADER') {
      violations.push({ requirement: 'R1_INDEPENDENT_DEMO_ACCOUNT', detail: `engine ${i} is not on the Pepperstone cTrader broker` });
    }
    if (!e || !e.account || !finite(e.account.accountIdRef) || e.account.accountIdRef <= 0) {
      violations.push({ requirement: 'R1_INDEPENDENT_DEMO_ACCOUNT', detail: `engine ${i} lacks a broker-confirmed account reference` });
    }
  });
  if (new Set(accountIds.filter((a) => a !== undefined && a !== null)).size !== engines.length || engines.length === 2 && accountIds[0] === accountIds[1]) {
    violations.push({ requirement: 'R1_INDEPENDENT_DEMO_ACCOUNT', detail: 'engines must hold distinct DEMO account references — no shared account' });
  }

  // R2 — separate engine identities.
  const engineIds = engines.map((e) => e && e.engineId);
  engineIds.forEach((id, i) => {
    if (!ENGINE_IDS.includes(id)) {
      violations.push({ requirement: 'R2_SEPARATE_ENGINE_IDENTITY', detail: `engine ${i} identity must be AI-V1-CHAMPION or AI-V2-CHALLENGER, found ${id}` });
    }
  });
  if (new Set(engineIds).size !== engineIds.length) {
    violations.push({ requirement: 'R2_SEPARATE_ENGINE_IDENTITY', detail: 'engine identities must be unique' });
  }
  if (engineIds.length === 2 && !(engineIds.includes('AI-V1-CHAMPION') && engineIds.includes('AI-V2-CHALLENGER'))) {
    violations.push({ requirement: 'R2_SEPARATE_ENGINE_IDENTITY', detail: 'the comparative pair requires exactly AI-V1-CHAMPION and AI-V2-CHALLENGER' });
  }

  // R3 — independent position ownership: each position belongs to exactly
  // one engine identity; no cross-engine position mutation is possible.
  engines.forEach((e, i) => {
    if (!e || e.positionOwnership !== 'ENGINE_SCOPED') {
      violations.push({ requirement: 'R3_INDEPENDENT_POSITION_OWNERSHIP', detail: `engine ${i} must declare ENGINE_SCOPED position ownership` });
    }
    if (!e || !e.credentials || e.credentials.scope !== 'ENGINE_SCOPED' || e.credentials.shared !== false) {
      violations.push({ requirement: 'R3_INDEPENDENT_POSITION_OWNERSHIP', detail: `engine ${i} must use engine-scoped, non-shared credentials` });
    }
  });

  // R4 — equivalent starting conditions: identical equity, instrument set,
  // volume constraints and risk configuration on both sides.
  if (engines.length === 2) {
    const [a, b] = engines.map((e) => e && e.startingConditions);
    const requiredEqual = (field, label) => {
      const va = a && a[field];
      const vb = b && b[field];
      const same = JSON.stringify(va) === JSON.stringify(vb) && va !== undefined;
      if (!same) violations.push({ requirement: 'R4_EQUIVALENT_STARTING_CONDITIONS', detail: `starting ${label} must be identical for both engines` });
    };
    if (!a || !finite(a.startingEquityUsd) || a.startingEquityUsd <= 0) {
      violations.push({ requirement: 'R4_EQUIVALENT_STARTING_CONDITIONS', detail: 'engine 0 starting equity must be a positive finite number' });
    }
    requiredEqual('startingEquityUsd', 'equity');
    requiredEqual('instruments', 'instrument set');
    requiredEqual('volumeConstraints', 'volume constraints');
    requiredEqual('riskConfiguration', 'risk configuration');
  }

  // R5 — immutable performance attribution: append-only, engine-stamped,
  // hash-chained records that no engine can rewrite after the fact.
  const ledger = topology.attributionLedger;
  if (!ledger || ledger.appendOnly !== true || ledger.engineStamped !== true
    || ledger.mutable === true || ledger.hashChain !== 'SHA256_CHAIN_V1') {
    violations.push({ requirement: 'R5_IMMUTABLE_PERFORMANCE_ATTRIBUTION', detail: 'ledger must be append-only, engine-stamped, non-mutable and SHA256 hash-chained' });
  }
  if (!ledger || !Array.isArray(ledger.recordFields) || REQUIRED_LEDGER_FIELDS.some((f) => !ledger.recordFields.includes(f))) {
    violations.push({
      requirement: 'R5_IMMUTABLE_PERFORMANCE_ATTRIBUTION',
      detail: `ledger records must capture at least: ${REQUIRED_LEDGER_FIELDS.join(', ')}`,
    });
  }

  // R6 — comparative performance dashboard contract.
  const dash = topology.comparativeDashboard;
  if (!dash || dash.perEngineViews !== true || !Array.isArray(dash.enginesListed) || dash.enginesListed.length !== 2) {
    violations.push({ requirement: 'R6_COMPARATIVE_DASHBOARD', detail: 'dashboard must expose per-engine views for exactly both engines' });
  }
  if (dash && Array.isArray(dash.enginesListed) && !(dash.enginesListed.includes('AI-V1-CHAMPION') && dash.enginesListed.includes('AI-V2-CHALLENGER'))) {
    violations.push({ requirement: 'R6_COMPARATIVE_DASHBOARD', detail: 'dashboard must list both AI-V1-CHAMPION and AI-V2-CHALLENGER' });
  }
  const requiredMetrics = ['netAfterCostReturn', 'riskNormalizedExpectancy', 'maxDrawdown', 'profitFactor', 'calibration'];
  if (!dash || !Array.isArray(dash.metrics) || requiredMetrics.some((m) => !dash.metrics.includes(m))) {
    violations.push({ requirement: 'R6_COMPARATIVE_DASHBOARD', detail: `dashboard metrics must include: ${requiredMetrics.join(', ')}` });
  }

  const requirements = {
    R1_INDEPENDENT_DEMO_ACCOUNT: 'Each engine holds its own Pepperstone cTrader DEMO account; accounts are never shared',
    R2_SEPARATE_ENGINE_IDENTITY: 'AI-V1-CHAMPION and AI-V2-CHALLENGER run as distinct engine identities',
    R3_INDEPENDENT_POSITION_OWNERSHIP: 'Positions and credentials are engine-scoped; no cross-engine mutation',
    R4_EQUIVALENT_STARTING_CONDITIONS: 'Identical starting equity, instruments, volume constraints and risk configuration',
    R5_IMMUTABLE_PERFORMANCE_ATTRIBUTION: 'Append-only, engine-stamped, hash-chained attribution ledger',
    R6_COMPARATIVE_DASHBOARD: 'Per-engine dashboard views with the mandatory metric set',
  };
  return {
    ...base,
    status: violations.length === 0 ? 'VALIDATED' : 'VIOLATIONS_FOUND',
    violations,
    requirements,
    note: 'Validation of a descriptor only. No broker account is created, connected or modified by this module.',
  };
}

module.exports = { validateTopology, ENGINE_IDS, REQUIRED_LEDGER_FIELDS, ARTIFACT };
