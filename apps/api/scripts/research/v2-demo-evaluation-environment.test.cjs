'use strict';
/** Tests for the DEMO evaluation environment (P5 preparation, offline). */

const test = require('node:test');
const assert = require('node:assert');

const {
  assembleDemoEvaluationEnvironment,
  renderReviewChecklist,
} = require('./v2-demo-evaluation-environment.cjs');

test('environment assembly is fail-closed and satisfies R1/R2/R4', () => {
  const env = assembleDemoEvaluationEnvironment({});
  assert.strictEqual(env.isolation.isolated, true);
  assert.strictEqual(env.equivalence.equivalent, true);
  assert.strictEqual(env.championIdentity.executionAuthority, 'RESEARCH_SHADOW');
  assert.strictEqual(env.challengerIdentity.executionAuthority, 'RESEARCH_SHADOW');
  assert.strictEqual(env.championIdentity.generation, 1);
  assert.strictEqual(env.challengerIdentity.generation, 1);
  assert.ok(env.blockedPendingReview.length === 3);
  assert.ok(env.requirements.R1.includes('asserted'));
  assert.ok(env.requirements.R6.includes('read-only'));
});

test('shared credentials are contamination: isolation contract refuses', () => {
  // Direct proof via the contract:
  const { assertAccountIsolation } = require('./v2-challenger-attribution.cjs');
  const base = assembleDemoEvaluationEnvironment({});
  const shared = { ...base.challengerAccount,
    connectionId: base.championAccount.connectionId };
  const verdict = assertAccountIsolation(base.championAccount, shared);
  assert.strictEqual(verdict.isolated, false);
  assert.ok(verdict.violations.includes('CONNECTION_ID_SHARED'));
});

test('equivalence violations are typed and surfaced', () => {
  const env = assembleDemoEvaluationEnvironment({});
  const drifted = { ...env.challengerAccount, startingBalance: 49999 };
  const { assertEquivalentStartingConditions } = require('./v2-challenger-attribution.cjs');
  const verdict = assertEquivalentStartingConditions(env.championAccount, drifted, {});
  assert.strictEqual(verdict.equivalent, false);
  assert.ok(verdict.violations.includes('STARTING_BALANCE_MISMATCH'));
});

test('authority audit: no live authority exists in the research stack', () => {
  const env = assembleDemoEvaluationEnvironment({});
  for (const entry of env.authorityAudit) {
    assert.strictEqual(entry.executionAuthority, 'RESEARCH_SHADOW');
    assert.strictEqual(entry.liveAuthorityAvailable, false);
  }
});

test('the review checklist states the P5 boundary and reproduction steps', () => {
  const env = assembleDemoEvaluationEnvironment({});
  const md = renderReviewChecklist(env, { seed: 20261128 });
  assert.ok(md.includes('OFFLINE evaluation only'));
  assert.ok(md.includes('blocked'));
  assert.ok(md.includes('v2-demo-evaluation-run.cjs --seed 20261128'));
  assert.ok(md.includes('no profitability claim'));
  assert.ok(md.includes('NOT promoted to LIVE'));
  assert.ok(md.includes('SHA-256'));
});
