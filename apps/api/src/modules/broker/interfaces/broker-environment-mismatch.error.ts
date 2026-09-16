import { BrokerMode } from './broker-adapter.interface';

/**
 * BrokerEnvironmentMismatchError — Round 7.1 (P0-1) typed fail-closed error.
 *
 * Thrown whenever a BROKER-OBSERVED account environment (the provider's own
 * classification — e.g. MetaApi's account `type`) CONTRADICTS the
 * environment a connection was DECLARED with (LIVE vs DEMO). A mislabeled
 * environment is a SECURITY event:
 *
 *   - a LIVE provider account declared as DEMO would execute REAL money
 *     under DEMO semantics (demo-authorization path, no LIVE verification
 *     gates, no LIVE risk freshness windows);
 *   - a DEMO provider account declared as LIVE would silently inherit LIVE
 *     authority semantics it must never have.
 *
 * The error is thrown ONLY after the fail-closed durable side effects have
 * been attempted (guarded SUSPENDED transition, adapter release, trading
 * authority invalidation, CRITICAL audit, realtime event) — the throw then
 * makes the CALLER fail closed too (risk evaluation, reconciliation run, or
 * provider dispatch all refuse to proceed on a mislabeled connection).
 *
 * The declared/observed pair and the detection source are carried on the
 * error so callers, audits and tests can assert the exact mismatch without
 * parsing message strings.
 */
export class BrokerEnvironmentMismatchError extends Error {
  constructor(
    public readonly declaredAccountType: BrokerMode | string,
    public readonly providerObservedAccountType: BrokerMode | string,
    public readonly detectionSource: string,
  ) {
    super(
      `Environment mismatch (${detectionSource}): the provider reports a ` +
        `${providerObservedAccountType} account, but this connection was declared ` +
        `${declaredAccountType} — refusing to trust the observation (fail-closed).`,
    );
    this.name = 'BrokerEnvironmentMismatchError';
  }
}
