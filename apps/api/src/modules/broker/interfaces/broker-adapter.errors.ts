/**
 * BrokerAdapterError — Standardised error type for all broker adapter errors.
 *
 * Every adapter maps its broker-specific errors to this class.
 * The Execution Engine uses `isRetryable` to decide whether to retry or give up.
 *
 * See: docs/architecture/09-broker-integration-architecture.md §12
 */
export class BrokerAdapterError extends Error {
  constructor(
    public readonly code: BrokerErrorCode,
    message: string,
    public readonly brokerMessage?: string,
    public readonly isRetryable: boolean = false,
  ) {
    super(message);
    this.name = 'BrokerAdapterError';
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
  UNKNOWN = 'UNKNOWN',
}

/** Map of which error codes are retryable */
export const RETRYABLE_BROKER_ERRORS = new Set<BrokerErrorCode>([
  BrokerErrorCode.CONNECTION_TIMEOUT,
  BrokerErrorCode.RATE_LIMITED,
  BrokerErrorCode.BROKER_SERVER_ERROR,
]);
