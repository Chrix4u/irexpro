/**
 * BrokerAdapterError — Standardised error type for all broker adapter errors.
 *
 * Every adapter maps its broker-specific errors to this class.
 * The Execution Engine uses `isRetryable` to decide whether to retry or give up.
 *
 * See: docs/architecture/09-broker-integration-architecture.md §12
 */
export class BrokerAdapterError extends Error {
  /**
   * WRITE-CERTAINTY classification (Sprint 56 correction round 4, architect
   * findings 5-6): for STATE-CHANGING operations this is the single authority
   * deciding whether an automatic retry is allowed. Absent = UNKNOWN (treated
   * conservatively as MAY_HAVE_REACHED_PROVIDER by the execution retry
   * policy — never auto-resent). Read paths may omit it.
   */
  public readonly dispatchCertainty?: import('./provider-dispatch-certainty').ProviderDispatchCertainty;

  constructor(
    public readonly code: BrokerErrorCode,
    message: string,
    public readonly brokerMessage?: string,
    public readonly isRetryable: boolean = false,
    dispatchCertainty?: import('./provider-dispatch-certainty').ProviderDispatchCertainty,
  ) {
    super(message);
    this.name = 'BrokerAdapterError';
    this.dispatchCertainty = dispatchCertainty;
  }
}

export enum BrokerErrorCode {
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  INSUFFICIENT_MARGIN = 'INSUFFICIENT_MARGIN',
  INVALID_INSTRUMENT = 'INVALID_INSTRUMENT',
  INVALID_LOT_SIZE = 'INVALID_LOT_SIZE',
  // Sprint 50 PR-3 — normalized order model validation (fail-closed:
  // an adapter must never silently downgrade a non-market order kind)
  INVALID_ORDER_TYPE = 'INVALID_ORDER_TYPE',
  INVALID_PRICE = 'INVALID_PRICE',
  DUPLICATE_ORDER = 'DUPLICATE_ORDER',
  MARKET_CLOSED = 'MARKET_CLOSED',
  POSITION_NOT_FOUND = 'POSITION_NOT_FOUND',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
  CONNECTION_LOST = 'CONNECTION_LOST',
  RATE_LIMITED = 'RATE_LIMITED',
  BROKER_SERVER_ERROR = 'BROKER_SERVER_ERROR',
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
  NOT_CONNECTED = 'NOT_CONNECTED',
  // Sprint 51 PR-7 — provider-specific mapping surface (OANDA v20). Added
  // ADDITIVELY: existing members and their semantics are untouched.
  /** Provider rejected the credential outright (e.g. OANDA 401 access_denied). */
  AUTHORIZATION_EXPIRED = 'AUTHORIZATION_EXPIRED',
  /** The provider account the credential addresses does not exist / is not accessible. */
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  /** The provider account exists but is administratively disabled. */
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  /** The provider rejected the request payload itself (validation failure). */
  INVALID_REQUEST = 'INVALID_REQUEST',
  // Round 7.1 (P0-1): the provider-observed account environment contradicts
  // the connection's DECLARED environment (LIVE vs DEMO). Detected at the
  // dispatch boundary BEFORE any state-changing provider call — provably
  // DEFINITELY_NOT_SENT (the throw site also classifies it explicitly).
  ENVIRONMENT_MISMATCH = 'ENVIRONMENT_MISMATCH',
  /** Provider-side or network-level outage (retryable). */
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  UNKNOWN = 'UNKNOWN',
}

/** Map of which error codes are retryable */
export const RETRYABLE_BROKER_ERRORS = new Set<BrokerErrorCode>([
  BrokerErrorCode.CONNECTION_TIMEOUT,
  BrokerErrorCode.RATE_LIMITED,
  BrokerErrorCode.BROKER_SERVER_ERROR,
  // Sprint 51 PR-7 — PROVIDER_UNAVAILABLE is the OANDA-mapped 5xx / network
  // outage code; retrying later can succeed. All other new members
  // (AUTHORIZATION_EXPIRED, ACCOUNT_NOT_FOUND, ACCOUNT_DISABLED,
  // INVALID_REQUEST) are NOT retryable — retrying cannot change the outcome.
  BrokerErrorCode.PROVIDER_UNAVAILABLE,
]);

/**
 * Redact secret material from a message before it is surfaced in errors,
 * broker messages, or logs (Directive §AN #5 — secret redaction).
 *
 * Pure string helper: replaces every occurrence of the secret with the
 * literal `[REDACTED]`. When the secret is empty/undefined the text is
 * returned unchanged (nothing to redact — never throws).
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length === 0) return text;
  return text.split(secret).join('[REDACTED]');
}
