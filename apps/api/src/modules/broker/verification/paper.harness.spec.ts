import { BrokerAccountInfo } from '../interfaces/broker-adapter.interface';
import { PaperBrokerAdapter } from '../adapters/paper-broker.adapter';
import {
  PROVIDER_VERIFICATION_STEPS,
  runProviderVerificationHarness,
} from './provider-verification-harness';

/**
 * Paper-broker verification harness proof — the ALWAYS-ON CI proof that the
 * harness itself works end-to-end (Task 47-C5; re-integrated Task 48-D).
 *
 * The paper provider has NO secrets, so this spec is NOT credential-gated and
 * runs green in CI on every build. It drives the REAL PaperBrokerAdapter
 * through the FULL canonical checklist (all 18 steps, none skipped) with the
 * real harness entry point — the same `runProviderVerificationHarness` the
 * operator-gated OANDA/cTrader specs use. The realistic paper lifecycle
 * (working LIMIT orders, partial closes, closed-trade history, working-order
 * cancellation, deterministic price feed) is what makes every step exercisable.
 *
 * THIS IS NOT PROVIDER VERIFICATION EVIDENCE: a green run here proves the
 * harness machinery, NOT that any real provider works. The ONLY legitimate
 * path to flipping a provider's productionLiveVerification to VERIFIED is an
 * authorized operator running the credential-gated harnesses
 * (oanda.demo-verification.spec.ts / ctrader.demo-verification.spec.ts) with
 * real provider credentials and recording the sanitized evidence
 * (evidenceRef + verifiedAt) in the broker catalog + provider matrix.
 * Tests NEVER flip it.
 */
describe('provider verification harness — paper broker (always-on CI proof)', () => {
  it('drives the full canonical checklist against the real paper adapter and passes deterministically', async () => {
    const evidence = await runProviderVerificationHarness({
      brokerId: 'paper-broker',
      mode: 'DEMO',
      credentials: { accountId: 'paper-account-001' },
    });

    // The sanitized evidence is safe to print — no credentials by construction.
    console.log('paper harness evidence:', JSON.stringify(evidence));

    expect(evidence.overall).toBe('PASS');
    expect(evidence.brokerId).toBe('paper-broker');
    expect(evidence.mode).toBe('DEMO');
    // Every canonical step ran, in order, and every single one passed
    // (the paper adapter implements the full trading surface).
    expect(evidence.steps.map((s) => s.name)).toEqual([...PROVIDER_VERIFICATION_STEPS]);
    expect(evidence.steps.every((s) => s.status === 'PASS')).toBe(true);
    expect(evidence.summary).toEqual({
      passed: PROVIDER_VERIFICATION_STEPS.length,
      failed: 0,
      skipped: 0,
    });
    // Order-lifecycle honesty: the market order step carries a provider order
    // id and the order-history step proves the cancelled pending order is gone.
    const marketOrder = evidence.steps.find((s) => s.name === 'market-order');
    expect(marketOrder?.providerOrderId).toMatch(/^paper-order-\d+$/);
    expect(evidence.steps.find((s) => s.name === 'order-history')?.detail).toContain('absent');
  });

  it('never leaks the supplied credential material into the sanitized evidence', async () => {
    const marker = 'PAPER_HARNESS_SECRET_MARKER_7f3e2d1c0b9a';
    const evidence = await runProviderVerificationHarness({
      brokerId: 'paper-broker',
      mode: 'DEMO',
      credentials: { accountId: 'paper-account-001', apiKey: marker },
    });
    expect(evidence.overall).toBe('PASS');
    expect(JSON.stringify(evidence)).not.toContain(marker);
  });

  it('rejects non-DEMO modes fail-closed (the harness never trades LIVE)', async () => {
    await expect(
      runProviderVerificationHarness({
        brokerId: 'paper-broker',
        // Deliberately mistyped at the call site to prove the runtime guard.
        mode: 'LIVE' as unknown as 'DEMO',
        credentials: { accountId: 'paper-account-001' },
      }),
    ).rejects.toThrow('DEMO');
  });

  it('FAILS a step when a provider money field is a JavaScript number (decimal-string discipline)', async () => {
    // A leaking adapter that returns float money — exactly the contract
    // violation the harness exists to catch.
    const leaky = new NumberMoneyPaperAdapter();
    const evidence = await runProviderVerificationHarness({
      brokerId: 'paper-broker',
      mode: 'DEMO',
      credentials: { accountId: 'paper-account-001' },
      adapter: leaky,
    });

    expect(evidence.overall).toBe('FAIL');
    const accountInfo = evidence.steps.find((s) => s.name === 'account-info');
    expect(accountInfo?.status).toBe('FAIL');
    expect(accountInfo?.detail).toContain('balance must be a decimal string — received number');
    // The failure is honest and isolated: every other step still ran.
    expect(evidence.summary.failed).toBe(1);
    expect(evidence.summary.passed).toBe(PROVIDER_VERIFICATION_STEPS.length - 1);
  });
});

/** Paper adapter with a deliberate float-money defect injected into account info. */
class NumberMoneyPaperAdapter extends PaperBrokerAdapter {
  async getAccountInfo(): Promise<BrokerAccountInfo> {
    const base = await super.getAccountInfo();
    return { ...base, balance: 10000.5 } as unknown as BrokerAccountInfo;
  }
}
