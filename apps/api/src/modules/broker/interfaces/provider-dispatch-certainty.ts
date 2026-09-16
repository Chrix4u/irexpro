/**
 * ProviderDispatchCertainty — the normalized WRITE-CERTAINTY contract for
 * STATE-CHANGING broker operations (Sprint 56 correction round 4, architect
 * findings 5-6).
 *
 * THE RULE THIS TYPE ENFORCES (production-critical execution semantics):
 * a broker operation can be technically retryable at the NETWORK level but
 * UNSAFE to repeat at the BUSINESS-operation level. A lost response to a
 * PLACE/CLOSE/CANCEL/MODIFY does NOT mean the order did not execute — the
 * provider may have filled it. Resending blindly can double a live
 * position. Internal OrderService idempotency prevents a SECOND CALLER from
 * initially dispatching the same internal order, but it does NOT prove that
 * resending an already-started provider operation is safe.
 *
 * Automatic retry of a STATE-CHANGING provider operation is allowed ONLY for
 * `DEFINITELY_NOT_SENT` — failures where the provider operation provably
 * never left iRexPro:
 *   - local execution-control / authorization / validation rejection;
 *   - local rate-limit rejection BEFORE transport enqueue;
 *   - outbound queue capacity failure BEFORE enqueue (deterministic);
 *   - connection known closed BEFORE write (deterministic);
 *   - any failure classified by the adapter as pre-send.
 *
 * `MAY_HAVE_REACHED_PROVIDER` failures (provider response timeout AFTER
 * write; connection loss AFTER an attempted write; a transport write attempt
 * whose provider receipt is uncertain; process/transport interruption after
 * submission begins) become RECONCILIATION_PENDING immediately — an
 * uncertain write is NOT failure and is NOT permission to resend; it is an
 * UNRESOLVED PROVIDER OUTCOME resolved only by provider-side reconciliation.
 *
 * `SENT_RESPONSE_RECEIVED` means the provider answered this request — the
 * outcome is authoritative (success or an explicit provider rejection);
 * retry semantics follow the provider's own error classification (e.g. a
 * MARKET_CLOSED rejection is terminal for this attempt).
 *
 * NO provider deduplication is assumed: cTrader clientOrderId / label /
 * comment (or MetaTrader/OANDA idempotency fields) are NOT treated as
 * broker-side exactly-once guarantees unless official provider documentation
 * explicitly guarantees that behavior. This module claims no such evidence.
 *
 * Read-only operations (account state, market data, order lists) may keep an
 * appropriate retry policy — duplicate reads do not create financial side
 * effects. The execution retry policy is split: STATE-CHANGING writes obey
 * the certainty rule above; reads keep their transport-level retryability.
 */
import { BrokerAdapterError, BrokerErrorCode } from './broker-adapter.errors';

export enum ProviderDispatchCertainty {
  /** The state-changing request provably never left iRexPro — safe to retry. */
  DEFINITELY_NOT_SENT = 'DEFINITELY_NOT_SENT',
  /** The provider answered — the outcome is authoritative for this request. */
  SENT_RESPONSE_RECEIVED = 'SENT_RESPONSE_RECEIVED',
  /** The request may have reached the provider — NEVER auto-resend; reconcile. */
  MAY_HAVE_REACHED_PROVIDER = 'MAY_HAVE_REACHED_PROVIDER',
}

/** Failure classes that are DEFINITELY not sent (safe-retry allowlist). */
export const CERTAINLY_NOT_SENT_REASONS: readonly string[] = ['queue-overflow', 'not-open'];

/**
 * Default write-certainty classification for a BrokerAdapterError CODE when
 * the throw site could not classify more precisely (transport-level frame
 * accounting knows better; this is the adapter-level fallback):
 * - LOCAL pre-send failures (validation / not-connected / decryption) →
 *   DEFINITELY_NOT_SENT — nothing left iRexPro;
 * - uncertain transports (timeout after write, connection lost, provider
 *   unavailable) → MAY_HAVE_REACHED_PROVIDER — reconcile, never resend;
 * - everything else (provider-ANSWERED rejections: auth, margin, market
 *   closed, duplicate, server errors) → SENT_RESPONSE_RECEIVED.
 */
export function defaultCertaintyForCode(code: BrokerErrorCode): ProviderDispatchCertainty {
  switch (code) {
    case BrokerErrorCode.INVALID_PRICE:
    case BrokerErrorCode.INVALID_ORDER_TYPE:
    case BrokerErrorCode.INVALID_LOT_SIZE:
    case BrokerErrorCode.INVALID_INSTRUMENT:
    case BrokerErrorCode.NOT_CONNECTED:
    case BrokerErrorCode.DECRYPTION_FAILED:
    // Round 7.1 (P0-1): an environment mismatch is detected BEFORE any
    // state-changing provider call — nothing left iRexPro.
    case BrokerErrorCode.ENVIRONMENT_MISMATCH:
      return ProviderDispatchCertainty.DEFINITELY_NOT_SENT;
    case BrokerErrorCode.CONNECTION_TIMEOUT:
    case BrokerErrorCode.CONNECTION_LOST:
    case BrokerErrorCode.PROVIDER_UNAVAILABLE:
    case BrokerErrorCode.UNKNOWN:
      // Uncertain transports and UNCLASSIFIED failures — conservatively
      // uncertain: never auto-resent; reconciliation resolves them.
      return ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER;
    default:
      return ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED;
  }
}

/**
 * Fills in the write-certainty classification on an adapter error when the
 * transport/throw site did not provide one. Already-classified errors
 * (transport frame accounting, explicit post-send classification) pass
 * through UNCHANGED — the more precise classification always wins.
 */
export function withDefaultCertainty(error: BrokerAdapterError): BrokerAdapterError {
  if (error.dispatchCertainty) {
    return error;
  }
  return new BrokerAdapterError(
    error.code,
    error.message,
    error.brokerMessage,
    error.isRetryable,
    defaultCertaintyForCode(error.code),
  );
}
