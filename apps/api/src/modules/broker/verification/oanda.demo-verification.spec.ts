import { runProviderVerificationHarness } from './provider-verification-harness';

/**
 * OANDA practice verification harness — CREDENTIAL-GATED, OPERATOR-RUN ONLY
 * (Sprint 56 / Task 47-C5; re-integrated onto new main's OANDA v20 adapter
 * as Task 48-D).
 *
 * HOW TO RUN (authorized operator, never in CI):
 *   OANDA_PRACTICE_TOKEN=<personal access token from the fxTrade practice
 *   portal — Manage API Access> \
 *   OANDA_PRACTICE_ACCOUNT_ID=<e.g. 101-001-1234567-001> \
 *   pnpm --filter @irexpro/api exec jest \
 *     src/modules/broker/verification/oanda.demo-verification.spec.ts
 *
 * CI NEVER sets these variables → this suite reports as SKIPPED on every CI
 * run (the `describe.skip` branch) — the suite stays credential-free.
 *
 * WHAT IT DOES: drives the REAL new-main OandaAdapter (v20 REST, environment-
 * separated base URLs) against https://api-fxpractice.oanda.com (hard DEMO
 * host isolation inside the adapter) through the full canonical checklist:
 * connect, account info, market data, small DEMO market order (2 × instrument
 * minLot, 0.01 floor), position verification, SL/TP modification (trade
 * dependent orders), partial close, full close, closed-trade history, pending
 * limit order (10% below market), open-order listing, margin info,
 * reconciliation, reconnect, provider error path.
 *
 * WORKING-ORDER STEPS (Phase 5 truth — none is expected to skip anymore):
 * - pending-modify: the v20 modifyOrder surface routes by LOOKUP — a working
 *   pending order is REPLACED via PUT /v3/accounts/{id}/orders/{orderId}
 *   (restating the order's current definition plus the modified SL/TP; the
 *   harness retargets the REPLACEMENT order id the endpoint returns), while
 *   an open trade keeps the PUT /trades/{id}/orders dependent-orders path;
 * - pending-cancel: cancelOrder IS exposed (Round 7, Fix 3) as a concrete
 *   additive method (intentionally off the IBrokerAdapter interface — the
 *   harness narrows with 'cancelOrder' in adapter), so the step runs.
 * (A SKIPPED step never counts against overall; skips remain honest for any
 * step whose PRECONDITION did not pass — e.g. no working order to modify.)
 *
 * EVIDENCE: the run prints the SANITIZED evidence object (console.log) — it
 * contains only timestamps, step statuses, provider order ids, instrument
 * names and sanitized details. No token ever appears (the harness never
 * records credentials; the evidence shape has no credential fields).
 *
 * PRODUCTION-LIVE VERIFICATION RULE: the ONLY legitimate path to flipping
 * the OANDA provider's productionLiveVerification to VERIFIED is an operator
 * running THIS harness with real practice credentials, saving the printed
 * evidence (evidenceRef + verifiedAt) into the broker catalog entry
 * (registry/broker-catalog.ts) and the provider matrix
 * (docs/brokers/provider-matrix.md). TESTS NEVER FLIP IT — a green paper
 * harness run or unit test is NOT provider verification evidence.
 */
const token = process.env.OANDA_PRACTICE_TOKEN;
const accountId = process.env.OANDA_PRACTICE_ACCOUNT_ID;
const credentialsAvailable = Boolean(token && accountId);

const describeOandaHarness = credentialsAvailable ? describe : describe.skip;

describeOandaHarness('OANDA practice verification harness (operator-run, credential-gated)', () => {
  it('drives the full DEMO checklist against api-fxpractice and expects overall PASS', async () => {
    const evidence = await runProviderVerificationHarness({
      brokerId: 'oanda',
      mode: 'DEMO',
      credentials: {
        apiKey: token!,
        accountId: accountId!,
      },
    });

    // Sanitized evidence — safe to print by construction (no credentials).
    console.log('OANDA practice verification evidence:\n', JSON.stringify(evidence, null, 2));

    expect(evidence.brokerId).toBe('oanda');
    expect(evidence.mode).toBe('DEMO');
    expect(evidence.overall).toBe('PASS');
    // A PASS means every executed step passed with zero failures (skips for
    // unmapped surfaces are honest and expected — see the header).
    expect(evidence.summary.failed).toBe(0);
    expect(evidence.summary.passed).toBeGreaterThan(0);
  }, 300_000);

  it('never includes the token in the sanitized evidence', async () => {
    const evidence = await runProviderVerificationHarness({
      brokerId: 'oanda',
      mode: 'DEMO',
      credentials: { apiKey: token!, accountId: accountId! },
    });
    // The personal access token must never surface. (The account id IS
    // allowed — non-secret by entity design, like every adapter surface.)
    expect(JSON.stringify(evidence)).not.toContain(token!);
  }, 300_000);
});
