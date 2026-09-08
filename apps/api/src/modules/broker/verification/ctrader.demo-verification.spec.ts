import { runProviderVerificationHarness } from './provider-verification-harness';

/**
 * cTrader DEMO verification harness — CREDENTIAL-GATED, OPERATOR-RUN ONLY
 * (Sprint 56 / Task 47-C5; re-integrated against the Task 48-B ported
 * cTrader adapter suite as Task 48-D).
 *
 * HOW TO RUN (authorized operator, never in CI):
 *   CTRADER_ACCESS_TOKEN=<OAuth access token from the cTrader Open API
 *   consent flow (id.ctrader.com)> \
 *   CTRADER_CTRID_ACCOUNT_ID=<ctidTraderAccountId of the DEMO account> \
 *   CTRADER_CLIENT_ID=<platform cTrader Open API app client id> \
 *   CTRADER_CLIENT_SECRET=<platform cTrader Open API app client secret> \
 *   pnpm --filter @irexpro/api exec jest \
 *     src/modules/broker/verification/ctrader.demo-verification.spec.ts
 *
 * CI NEVER sets these variables → this suite reports as SKIPPED on every CI
 * run (the `describe.skip` branch) — the suite stays credential-free.
 *
 * PLATFORM CREDENTIALS: the harness's adapter factory constructs the REAL
 * CTraderAdapter + CTraderClientService (adapters/ctrader/) with a minimal
 * read-only ConfigService view over CTRADER_CLIENT_ID/CTRADER_CLIENT_SECRET
 * (the same env vars the application's configuration maps to `broker.*`) —
 * the client service reads them through its normal constructor path, no Nest
 * module needed, nothing logged or persisted. The cTrader modules are loaded
 * via dynamic import by the harness factory, so this spec itself has no
 * static dependency on the adapter files.
 *
 * WHAT IT DOES: drives the REAL CTraderAdapter against
 * wss://demo.ctraderapi.com:5036 (JSON protocol; hard DEMO/LIVE host
 * isolation + per-account isLive cross-check inside the adapter) through the
 * full canonical checklist: connect, account info, market data, small DEMO
 * market order, position verification, SL/TP modification, partial close,
 * full close, closed-trade history, pending limit order, pending
 * modification, cancellation, open-order listing, margin info,
 * reconciliation, reconnect (full WS re-auth), provider error path.
 *
 * EVIDENCE: the run prints the SANITIZED evidence object — timestamps, step
 * statuses, provider order/position ids, sanitized details only. The access
 * token never appears.
 *
 * PRODUCTION-LIVE VERIFICATION RULE: the ONLY legitimate path to flipping
 * the cTrader provider's productionLiveVerification to VERIFIED is an
 * operator running THIS harness with real DEMO credentials, saving the
 * printed evidence (evidenceRef + verifiedAt) into the broker catalog entry
 * (registry/broker-catalog.ts) and the provider matrix
 * (docs/brokers/provider-matrix.md). TESTS NEVER FLIP IT.
 */
const accessToken = process.env.CTRADER_ACCESS_TOKEN;
const ctidAccountId = process.env.CTRADER_CTRID_ACCOUNT_ID;
const clientId = process.env.CTRADER_CLIENT_ID;
const clientSecret = process.env.CTRADER_CLIENT_SECRET;
const credentialsAvailable = Boolean(accessToken && ctidAccountId && clientId && clientSecret);

const describeCtraderHarness = credentialsAvailable ? describe : describe.skip;

describeCtraderHarness('cTrader DEMO verification harness (operator-run, credential-gated)', () => {
  it('drives the full DEMO checklist against demo.ctraderapi.com:5036 and expects overall PASS', async () => {
    const evidence = await runProviderVerificationHarness({
      brokerId: 'ctrader',
      mode: 'DEMO',
      credentials: {
        apiKey: accessToken!,
        accountId: ctidAccountId!,
      },
    });

    // Sanitized evidence — safe to print by construction (no credentials).
    console.log('cTrader DEMO verification evidence:\n', JSON.stringify(evidence, null, 2));

    expect(evidence.brokerId).toBe('ctrader');
    expect(evidence.mode).toBe('DEMO');
    expect(evidence.overall).toBe('PASS');
    // A PASS means every applicable step passed with zero failures.
    expect(evidence.summary.failed).toBe(0);
    expect(evidence.summary.passed).toBeGreaterThan(0);
  }, 300_000);

  it('never includes the access token in the sanitized evidence', async () => {
    const evidence = await runProviderVerificationHarness({
      brokerId: 'ctrader',
      mode: 'DEMO',
      credentials: { apiKey: accessToken!, accountId: ctidAccountId! },
    });
    // The OAuth access token must never surface. (The ctidTraderAccountId
    // is allowed — non-secret by entity design.)
    expect(JSON.stringify(evidence)).not.toContain(accessToken!);
  }, 300_000);
});
