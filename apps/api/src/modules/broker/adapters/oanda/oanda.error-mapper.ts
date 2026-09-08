import {
  BrokerAdapterError,
  BrokerErrorCode,
  RETRYABLE_BROKER_ERRORS,
  redactSecret,
} from '../../interfaces/broker-adapter.errors';
import { OandaErrorBody } from './oanda.transport';

/**
 * OANDA v20 error carrier — thrown by the transport for non-2xx responses.
 * Retains the raw body so endpoint-specific handling (e.g. order rejection
 * transactions) can inspect provider detail without string parsing.
 */
export class OandaApiError extends Error {
  constructor(
    public readonly status: number,
    /** Provider error code string from the v3 error body (may be empty). */
    public readonly providerCode: string,
    message: string,
    /** Provider requestId — preserved for diagnostics, never a secret. */
    public readonly requestId?: string,
    /** Raw parsed error body (orderRejectTransaction etc.). */
    public readonly body?: OandaErrorBody,
  ) {
    super(message);
    this.name = 'OandaApiError';
  }
}

/**
 * Normalize an order-rejection body (POST /orders 400) — the v3 rejection
 * transaction carries the provider's refusal reason.
 */
export function oandaOrderRejectReason(body: OandaErrorBody | undefined): string | null {
  const reject = body?.orderRejectTransaction as { reason?: string } | undefined;
  return typeof reject?.reason === 'string' ? reject.reason : null;
}

/** True when the v3 body is an order rejection transaction payload. */
export function isOandaOrderRejection(body: OandaErrorBody | undefined): boolean {
  return oandaOrderRejectReason(body) !== null || body?.orderRejectTransaction !== undefined;
}

function looksLikeTimeout(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  const message = (err as { message?: string }).message ?? '';
  return (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    message.toLowerCase().includes('timeout') ||
    message.toLowerCase().includes('timed out')
  );
}

/**
 * Map OANDA v3 error bodies ({code, message|errorMessage, requestId}) and
 * HTTP statuses to the typed BrokerAdapterError surface (Directive §P).
 *
 * Error mapping table:
 * | Provider signal                                  | BrokerErrorCode           | Retryable |
 * | ------------------------------------------------ | ------------------------- | --------- |
 * | 401 / access_denied / unauthorized               | AUTHENTICATION_FAILED     | no        |
 * | 401 / token_expired / authorization_expired      | AUTHORIZATION_EXPIRED     | no        |
 * | 403 / account_disabled / account_suspended       | ACCOUNT_DISABLED          | no        |
 * | 403 (other)                                      | AUTHENTICATION_FAILED     | no        |
 * | 404 / code contains "account"                    | ACCOUNT_NOT_FOUND         | no        |
 * | 404 / code contains "order"/"trade"/"position"   | POSITION_NOT_FOUND        | no        |
 * | 404 (unconfirmed path)                           | UNKNOWN                   | no        |
 * | 400 / invalid_instrument or instrument message   | INVALID_INSTRUMENT        | no        |
 * | 400 / MARGIN_NOT_SUFFICIENT                      | INSUFFICIENT_MARGIN       | no        |
 * | 400 / MARKET_CLOSED                              | MARKET_CLOSED             | no        |
 * | 400 / invalid_value / invalid_request etc.       | INVALID_REQUEST           | no        |
 * | 429                                              | RATE_LIMITED              | yes      |
 * | 5xx                                              | PROVIDER_UNAVAILABLE      | yes      |
 * | raw timeout / abort                              | CONNECTION_TIMEOUT        | yes      |
 * | other raw transport failure                      | PROVIDER_UNAVAILABLE      | yes      |
 * | anything unrecognized                            | UNKNOWN                   | no        |
 *
 * `isRetryable` is derived from RETRYABLE_BROKER_ERRORS — a single source
 * of truth, so mapped errors are ALWAYS consistent with the set.
 * `brokerMessage` preserves the provider message + requestId (redacted of
 * the credential token) for diagnostics.
 */
export function mapOandaError(err: unknown, secret: string | undefined): BrokerAdapterError {
  if (err instanceof BrokerAdapterError) return err;

  if (err instanceof OandaApiError) {
    const code = mapStatusAndProviderCode(err);
    const providerDetail =
      err.providerCode.length > 0 ? `[${err.providerCode}] ${err.message}` : err.message;
    const brokerMessage =
      err.requestId !== undefined
        ? `${providerDetail} (requestId: ${err.requestId})`
        : providerDetail;
    return new BrokerAdapterError(
      code,
      redactSecret(`OANDA request failed: ${err.message}`, secret),
      redactSecret(brokerMessage, secret),
      RETRYABLE_BROKER_ERRORS.has(code),
    );
  }

  // Raw transport/network failures (no HTTP status).
  const message = (err as { message?: string })?.message ?? 'unknown OANDA transport error';
  if (looksLikeTimeout(err)) {
    return new BrokerAdapterError(
      BrokerErrorCode.CONNECTION_TIMEOUT,
      redactSecret(`OANDA connection timeout: ${message}`, secret),
      redactSecret(message, secret),
      RETRYABLE_BROKER_ERRORS.has(BrokerErrorCode.CONNECTION_TIMEOUT),
    );
  }
  return new BrokerAdapterError(
    BrokerErrorCode.PROVIDER_UNAVAILABLE,
    redactSecret(`OANDA provider unavailable: ${message}`, secret),
    redactSecret(message, secret),
    RETRYABLE_BROKER_ERRORS.has(BrokerErrorCode.PROVIDER_UNAVAILABLE),
  );
}

function mapStatusAndProviderCode(err: OandaApiError): BrokerErrorCode {
  const providerCode = err.providerCode.toLowerCase();
  const message = err.message.toLowerCase();

  if (err.status === 401) {
    if (
      providerCode.includes('token_expired') ||
      providerCode.includes('expired_token') ||
      providerCode.includes('authorization_expired')
    ) {
      return BrokerErrorCode.AUTHORIZATION_EXPIRED;
    }
    return BrokerErrorCode.AUTHENTICATION_FAILED;
  }

  if (err.status === 403) {
    if (providerCode.includes('account_disabled') || providerCode.includes('account_suspended')) {
      return BrokerErrorCode.ACCOUNT_DISABLED;
    }
    return BrokerErrorCode.AUTHENTICATION_FAILED;
  }

  if (err.status === 404) {
    // Fail-closed: only CODE-CONFIRMED 404s are interpreted. An unconfirmed
    // 404 (e.g. a wrong path) must never masquerade as "order not found".
    if (providerCode.includes('account')) return BrokerErrorCode.ACCOUNT_NOT_FOUND;
    if (
      providerCode.includes('order') ||
      providerCode.includes('trade') ||
      providerCode.includes('position')
    ) {
      return BrokerErrorCode.POSITION_NOT_FOUND;
    }
    return BrokerErrorCode.UNKNOWN;
  }

  if (err.status === 400) {
    const rejectReason = oandaOrderRejectReason(err.body)?.toLowerCase() ?? '';
    if (
      providerCode.includes('margin_not_sufficient') ||
      rejectReason.includes('margin_not_sufficient') ||
      message.includes('insufficient margin')
    ) {
      return BrokerErrorCode.INSUFFICIENT_MARGIN;
    }
    if (
      providerCode.includes('market_closed') ||
      rejectReason.includes('market_closed') ||
      message.includes('market is closed')
    ) {
      return BrokerErrorCode.MARKET_CLOSED;
    }
    if (
      providerCode.includes('invalid_instrument') ||
      /instrument .*(not (?:valid|found|supported))/.test(message) ||
      /not a valid instrument/.test(message) ||
      /not a valid instrument/.test(rejectReason)
    ) {
      return BrokerErrorCode.INVALID_INSTRUMENT;
    }
    return BrokerErrorCode.INVALID_REQUEST;
  }

  if (err.status === 429) return BrokerErrorCode.RATE_LIMITED;
  if (err.status >= 500) return BrokerErrorCode.PROVIDER_UNAVAILABLE;

  return BrokerErrorCode.UNKNOWN;
}
