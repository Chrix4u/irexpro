import type { ApiClient } from '@irexpro/api-client';
import { createApiClient } from '@irexpro/api-client';
import type { BrokerRegistryCatalog } from '@irexpro/types';

/**
 * Shared API client for the mobile app.
 *
 * Reads EXPO_PUBLIC_API_BASE_URL from env (Expo inlines EXPO_PUBLIC_* vars at
 * build time). NEVER hardcodes localhost or a domain. The mobile app never
 * calls the AI engine — it is internal-only.
 *
 * Mobile typically does NOT use cookie credentials; it attaches the access
 * token via the Authorization header via getAccessToken.
 */
const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;

if (!baseUrl) {
  throw new Error(
    'EXPO_PUBLIC_API_BASE_URL is not set. Copy apps/mobile/.env.example to .env.',
  );
}

let cachedAccessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  cachedAccessToken = token;
}

/**
 * Read the current in-memory access token for the realtime auth handshake.
 * Reconnects call this getter again so token rotation is never captured stale.
 */
export function getAccessTokenValue(): string | null {
  return cachedAccessToken;
}

export interface MobileApiClient extends ApiClient {
  /** GET /broker/registry → server-authoritative catalog wrapper. */
  getBrokerRegistry(): Promise<BrokerRegistryCatalog>;
}

/**
 * Build the mobile API facade on top of the shared transport.
 * Exported so contract tests can validate the mobile-only registry extension
 * without mutating or widening the shared ApiClient interface.
 */
export function createMobileApiClient(apiBaseUrl: string): MobileApiClient {
  const baseApi = createApiClient({
    baseUrl: apiBaseUrl,
    includeCredentials: false,
    getAccessToken: () => cachedAccessToken,
  });

  return Object.assign(baseApi, {
    getBrokerRegistry: () =>
      baseApi.request<BrokerRegistryCatalog>('/broker/registry'),
  });
}

export const api: MobileApiClient = createMobileApiClient(baseUrl);
