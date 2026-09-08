/**
 * PaperBrokerAdapter — application of the shared Directive §AN broker
 * adapter contract suite (Sprint 51 PR-7).
 *
 * The paper broker is a fully in-memory adapter: it has no transport and
 * its deterministic simulation book cannot suffer a provider outage.
 * Therefore:
 *   - §AN-3 (error normalization under failure injection) is REGISTERED
 *     but skipped — there is no transport to fail.
 *   - §AN-4 (environment routing) is REGISTERED but skipped — there is
 *     no base URL by construction.
 *   - §AN-5's failing pass is tolerated (in-memory state stays healthy).
 * Every other contract category (fail-closed preconditions, decimal-string
 * invariants, secret redaction on the healthy pass, idempotency passthrough
 * on the resting order, and null-only-for-legitimate-not-found) is fully
 * enforced for the paper adapter exactly as for transport-backed providers.
 */
import {
  BrokerMode,
  IBrokerAdapter,
  DecryptedBrokerCredentials,
} from '../interfaces/broker-adapter.interface';
import {
  ContractSuiteContext,
  ScriptedBackend,
  ScriptedRequestRecord,
  runBrokerAdapterContractSuite,
} from './contract/broker-adapter.contract-suite';
import { PaperBrokerAdapter } from './paper-broker.adapter';

/**
 * Recording-only scripted backend. The paper adapter never issues transport
 * requests; this backend exists to satisfy the suite's ScriptedBackend port
 * and to prove (via §AN-4's skip flag) that no transport coupling exists.
 */
class PaperScriptedBackend implements ScriptedBackend {
  readonly requests: ScriptedRequestRecord[] = [];
  private failure: unknown = null;

  request<T>(): Promise<T> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve({} as T);
  }

  failWith(error: unknown): void {
    this.failure = error;
  }

  restore(): void {
    this.failure = null;
  }

  resetRequests(): void {
    this.requests.length = 0;
  }
}

const credentials: DecryptedBrokerCredentials = {
  apiKey: 'contract-paper-secret-token-DO-NOT-LEAK',
  accountId: 'paper-account-001',
};

const backend = new PaperScriptedBackend();

// The paper book lives INSIDE each adapter instance (no shared transport).
// The suite creates fresh adapters per assertion; the idempotency read-back
// inspects the most recent instance — the one §AN-6 just placed its resting
// LIMIT order into.
let latestAdapter: PaperBrokerAdapter | null = null;

const createAdapter = (mode: BrokerMode): IBrokerAdapter => {
  const adapter = new PaperBrokerAdapter();
  adapter.setMode(mode);
  latestAdapter = adapter;
  return adapter;
};

const ctx: ContractSuiteContext = {
  brokerId: 'paper-broker',
  supportsDemo: true,
  createAdapter,
  credentials,
  scriptedBackend: backend,
  // The paper adapter's simulation book starts healthy and deterministic —
  // "scripting the healthy backend" is a no-op reset of the failure mode.
  scriptHealthyBackend: () => {
    backend.restore();
    backend.resetRequests();
  },
  // Paper has no provider-side 404 scripting — unknown order ids are a
  // legitimate null by construction (§AN-7b still asserts the null).
  scriptOrderNotFound: undefined,
  observedIdempotencyKey: async () => {
    // The suite's §AN-6 just placed a resting LIMIT order into the MOST
    // RECENT adapter instance; the paper book's provider-side record carries
    // the idempotency key as its clientOrderId fallback.
    if (!latestAdapter) return null;
    const orders = await latestAdapter.listOrders();
    const resting = orders.find((o) => o.clientOrderId?.startsWith('contract-an6'));
    return resting?.clientOrderId ?? null;
  },
  pricedInstrument: 'EURUSD',
  options: {
    skipEnvironmentRouting: true,
    skipTransportFailureInjection: true,
  },
};

const registered = runBrokerAdapterContractSuite('PaperBrokerAdapter', ctx);

// The suite must have registered all eight contract assertion titles —
// skipped ones included — so no category silently disappears.
describe('PaperBrokerAdapter contract suite registration', () => {
  it('registers all Directive §AN assertion categories', () => {
    expect(registered.length).toBe(8);
  });
});
