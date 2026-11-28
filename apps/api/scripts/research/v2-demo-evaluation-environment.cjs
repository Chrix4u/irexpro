'use strict';
/**
 * V2 Champion–Challenger DEMO evaluation environment (P5 preparation —
 * offline only). Assembles the isolation topology required by the V2
 * directive's six DEMO-isolation requirements at the contract level:
 *
 *   R1 account isolation          — asserted (research stub connections);
 *   R2 engine identity            — registered, frozen generations;
 *   R3 position ownership         — attribution ledger per-trade identity;
 *   R4 equivalent starting        — asserted (same balance, leverage,
 *                                    instruments, costs, session window);
 *   R5 immutable attribution      — append-only ledger, duplicate refusal;
 *   R6 comparative dashboard     — read-only ledger projection.
 *
 * The broker-connected part of P5 stays BLOCKED on independent review:
 * this module provisions nothing, connects nothing, and grants no order
 * authority. It exists so an independent reviewer can verify the offline
 * environment end-to-end before authorizing P5-1/P5-2.
 */

const {
  defineEngineIdentity,
  assertAccountIsolation,
  assertEquivalentStartingConditions,
} = require('./v2-challenger-attribution.cjs');
const {
  CHAMPION_POLICY_MIRROR,
  CHALLENGER_POLICY,
} = require('./v2-intelligence-engine.cjs');
const { DEFAULT_COST_MODEL } = require('./v2-paired-engine-simulator.cjs');

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Assemble the environment: identities, isolation stubs, equivalence
 * contract, and the authority audit. All assertions must pass before any
 * campaign runs (fail-closed assembly).
 */
function assembleDemoEvaluationEnvironment(config) {
  const cfg = config || {};
  const startingBalanceUsd = finiteNumber(cfg.startingBalanceUsd)
    ? cfg.startingBalanceUsd : 50000;
  const leverage = finiteNumber(cfg.leverage) ? cfg.leverage : 30;
  const instruments = Array.isArray(cfg.instruments) && cfg.instruments.length > 0
    ? cfg.instruments : ['EURUSD'];
  const sessionWindow = nonEmpty(cfg.sessionWindow) ? cfg.sessionWindow
    : 'SYNTHETIC-DETERMINISTIC-2026-11-30+';
  const costBasis = { ...DEFAULT_COST_MODEL, ...(cfg.costModel || {}) };
  const startedAt = nonEmpty(cfg.startedAt) ? cfg.startedAt
    : '2026-11-28T00:00:00.000Z';

  // R2: engine identities (frozen generation 1, research authority only).
  const championIdentity = defineEngineIdentity({
    engineCode: 'V1-CHAMPION-MIRROR',
    modelVersion: 'm1-tactical-candidate-v1',
    strategyCode: 'M1-TACTICAL',
    generation: 1,
    executionAuthority: 'RESEARCH_SHADOW',
  });
  const challengerIdentity = defineEngineIdentity({
    engineCode: 'V2-CHALLENGER',
    modelVersion: 'v2-intelligence-engine-v1',
    strategyCode: 'V2-RESEARCH',
    generation: 1,
    executionAuthority: 'RESEARCH_SHADOW',
  });

  // R1: account isolation stubs. The broker-connected equivalents
  // (P5-1/P5-2) are BLOCKED on independent review; these research stubs
  // exist so the isolation CONTRACT is exercised end-to-end offline.
  const championAccount = {
    connectionId: 'RESEARCH-DEMO-ISOLATED-A',
    credentialFingerprint: 'stub-champion-credential-fingerprint-01',
    startedAt,
    startingBalance: startingBalanceUsd,
    leverage,
    instruments,
    costBasis,
    sessionWindow,
  };
  const challengerAccount = {
    connectionId: 'RESEARCH-DEMO-ISOLATED-B',
    credentialFingerprint: 'stub-challenger-credential-fingerprint-02',
    startedAt,
    startingBalance: startingBalanceUsd,
    leverage,
    instruments,
    costBasis,
    sessionWindow,
  };

  const isolation = assertAccountIsolation(championAccount, challengerAccount);
  const equivalence = assertEquivalentStartingConditions(
    championAccount, challengerAccount, { alignmentToleranceMs: 0 });

  if (!isolation.isolated) {
    throw new Error(`ENVIRONMENT_ISOLATION_VIOLATED:${isolation.violations.join(';')}`);
  }
  if (!equivalence.equivalent) {
    throw new Error(`ENVIRONMENT_EQUIVALENCE_VIOLATED:${equivalence.violations.join(';')}`);
  }

  const authorityAudit = Object.freeze([
    Object.freeze({
      module: 'v2-intelligence-engine.cjs',
      championPolicyArtifact: CHAMPION_POLICY_MIRROR.artifact,
      challengerPolicyArtifact: CHALLENGER_POLICY.artifact,
      executionAuthority: 'RESEARCH_SHADOW',
      liveAuthorityAvailable: false,
    }),
  ]);

  return Object.freeze({
    championIdentity,
    challengerIdentity,
    championAccount: Object.freeze(championAccount),
    challengerAccount: Object.freeze(challengerAccount),
    isolation,
    equivalence,
    authorityAudit,
    blockedPendingReview: Object.freeze(['P5-1 broker account provisioning',
      'P5-2 broker connection ids', 'P5-3 equivalence run']),
    requirements: Object.freeze({
      R1: 'asserted (research stubs); broker-connected variant blocked',
      R2: 'registered, generation 1 frozen',
      R3: 'per-trade attribution ledger identity',
      R4: 'asserted equal balance/leverage/instruments/costs/session',
      R5: 'append-only ledger with duplicate refusal',
      R6: 'dashboard is a read-only ledger projection',
    }),
  });
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** Review checklist markdown for the independent reviewer. */
function renderReviewChecklist(environment, resultsMeta) {
  const m = resultsMeta || {};
  return `# iRexPro V2 Challenger — DEMO evaluation environment review checklist

Scope: OFFLINE evaluation only. P5 (broker-connected DEMO) is blocked and
nothing in this environment connects to, provisions or authorizes a broker.

## Environment assertions (fail-closed assembly)

- [x] R1 account isolation: ${environment.isolation.violations.length === 0 ? 'asserted' : 'VIOLATED'} (research stub connections A/B).
- [x] R2 engine identities: champion \`${environment.championIdentity.engineCode}\` and challenger \`${environment.challengerIdentity.engineCode}\`, generation 1 frozen, authority RESEARCH_SHADOW.
- [x] R4 equivalent starting conditions: balance ${m.startingBalanceUsd}, leverage ${m.leverage}, instruments ${Array.isArray(m.instruments) ? m.instruments.join('/') : 'EURUSD'}, identical cost basis.
- [x] R5/R6 ledger: append-only, duplicate-refusing; dashboard derived from it.

## What the reviewer should verify

1. Reproduce byte-identically: \`node apps/api/scripts/research/v2-demo-evaluation-run.cjs --seed ${m.seed || 'SEED'}\` and compare the SHA-256 hashes printed by both runs.
2. Open \`comparative-dashboard.html\`: every figure must trace to \`attribution-ledger.jsonl\` or the campaign metric objects.
3. Confirm the four broker-evidence verification checks in the dashboard's section 3 (net total, balance chain, realized match, duplicate guard).
4. Confirm the null campaign's false-positive rates are at or below the 5% nominal.
5. Confirm the known-edge campaign recovers the planted AUCs within stated uncertainty.
6. Confirm the exit-dominance attribution shares meet the >= 90% acceptance.
7. Confirm the champion baseline mirror constants equal the audited S1 constants (see the frozen canary test).

## Binding limits

- All engine comparisons are synthetic; no profitability claim is derivable.
- The only real performance datum is the V1 broker evidence window (reported as-is, negative).
- V2 is NOT promoted to LIVE; V1 remains the baseline; P5 stays blocked on this review.
`;
}

module.exports = {
  assembleDemoEvaluationEnvironment,
  renderReviewChecklist,
};
