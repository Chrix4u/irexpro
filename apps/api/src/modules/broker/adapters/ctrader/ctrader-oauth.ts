/**
 * cTrader Open API OAuth2 helpers (Sprint 56 / Task 47-C2; Task 48-B port) —
 * PURE functions.
 *
 * VERIFIED FLOW (help.ctrader.com/open-api/account-authentication):
 * 1. The user authorizes the platform application at
 *    https://id.ctrader.com/my/settings/openapi/grantingaccess/
 *      ?client_id=…&redirect_uri=…&scope=trading&product=web
 * 2. The authorization code (TTL 60 s) is exchanged at the token endpoint
 *    GET https://openapi.ctrader.com/apps/token
 *      ?grant_type=authorization_code&code=…&redirect_uri=…&client_id=…&client_secret=…
 *    → JSON { accessToken, tokenType: "bearer", expiresIn ≈ 2 628 000 (~30d),
 *             refreshToken, errorCode?, description? }
 * 3. Refresh tokens are non-expiring (invalidated on use / on re-auth) and can
 *    be exchanged with grant_type=refresh_token.
 *
 * The HTTP call itself (native fetch) lives in CTraderClientService — these
 * helpers build/validate URLs and parse responses so they are unit-testable.
 * Client secrets NEVER appear in errors thrown here (only in the request URL
 * built for the token endpoint, which is only ever sent, never logged).
 */
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import { redactString } from '../../../../common/utils/redact-sensitive.util';

/** Official OAuth consent page where a user grants the app trading access. */
export const CTRADER_AUTHORIZATION_BASE_URL =
  'https://id.ctrader.com/my/settings/openapi/grantingaccess/';

/** Official token endpoint (GET, query-string parameters, JSON response). */
export const CTRADER_TOKEN_ENDPOINT = 'https://openapi.ctrader.com/apps/token';

export interface CtraderOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds (≈ 2 628 000 for a fresh grant). */
  expiresIn: number;
}

/**
 * Builds the user-consent URL the platform shows to a cTrader user.
 * `scope` is 'trading' (full) or 'accounts' (view-only).
 */
export function buildCtraderAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  scope: 'trading' | 'accounts' = 'trading',
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    product: 'web',
  });
  return `${CTRADER_AUTHORIZATION_BASE_URL}?${params.toString()}`;
}

export interface CtraderTokenExchangeRequest {
  grantType: 'authorization_code' | 'refresh_token';
  /** Required for grantType === 'authorization_code'. */
  code?: string;
  /** Required for grantType === 'refresh_token'. */
  refreshToken?: string;
  /** Required for authorization_code grants. */
  redirectUri?: string;
  clientId: string;
  clientSecret: string;
}

/** Builds the GET token-endpoint URL for an authorization-code or refresh grant. */
export function buildCtraderTokenRequestUrl(request: CtraderTokenExchangeRequest): string {
  const params = new URLSearchParams({ grant_type: request.grantType });
  if (request.grantType === 'authorization_code') {
    if (!request.code) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'authorization_code grant requires a code parameter.',
      );
    }
    if (!request.redirectUri) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'authorization_code grant requires a redirectUri parameter.',
      );
    }
    params.set('code', request.code);
    params.set('redirect_uri', request.redirectUri);
  } else {
    if (!request.refreshToken) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'refresh_token grant requires a refreshToken parameter.',
      );
    }
    params.set('refresh_token', request.refreshToken);
  }
  params.set('client_id', request.clientId);
  params.set('client_secret', request.clientSecret);
  return `${CTRADER_TOKEN_ENDPOINT}?${params.toString()}`;
}

/**
 * Parses the token-endpoint JSON body. Fails CLOSED with a typed
 * AUTHENTICATION_FAILED (redacted provider text) when the exchange was
 * rejected — a successful-looking body without tokens never slips through.
 */
export function parseCtraderTokenResponse(body: unknown): CtraderOAuthTokens {
  if (body === null || typeof body !== 'object') {
    throw new BrokerAdapterError(
      BrokerErrorCode.AUTHENTICATION_FAILED,
      'cTrader token endpoint returned an unusable response body.',
    );
  }
  const record = body as Record<string, unknown>;
  const errorCode = typeof record.errorCode === 'string' ? record.errorCode : undefined;
  if (errorCode) {
    const description =
      typeof record.description === 'string' ? redactString(record.description) : undefined;
    throw new BrokerAdapterError(
      BrokerErrorCode.AUTHENTICATION_FAILED,
      description ?? `cTrader token exchange failed: ${errorCode}`,
    );
  }
  const accessToken = typeof record.accessToken === 'string' ? record.accessToken : '';
  const refreshToken = typeof record.refreshToken === 'string' ? record.refreshToken : '';
  const expiresIn = typeof record.expiresIn === 'number' ? record.expiresIn : NaN;
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new BrokerAdapterError(
      BrokerErrorCode.AUTHENTICATION_FAILED,
      'cTrader token response is missing accessToken/refreshToken/expiresIn.',
    );
  }
  return { accessToken, refreshToken, expiresIn };
}
