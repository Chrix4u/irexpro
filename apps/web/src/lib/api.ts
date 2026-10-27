import type { ApiClient } from '@irexpro/api-client';
import type { BrowserAuthTokens } from '@irexpro/api-client/browser-auth';
import { createApiClient } from '@irexpro/api-client';
import { createBrowserAuthClient } from '@irexpro/api-client/browser-auth';
import { setSelectedTraderBrokerId } from '@/lib/trader-broker-context';

/**
 * Shared API client for the web app.
 *
 * Reads NEXT_PUBLIC_API_BASE_URL from env — NEVER hardcodes localhost or a
 * domain. If the env var is missing, this throws at module load so the misconfig
 * is caught immediately rather than producing silent wrong-URL calls.
 *
 * credentials: 'include' is set so the httpOnly refresh-token cookie (set by the
 * backend) is sent with auth requests. The access token is attached via the
 * Authorization header by the getAccessToken getter and remains memory-only.
 * Browser auth uses the dedicated facade below so refresh tokens are never
 * returned in JavaScript-readable login/register/refresh response bodies.
 */
const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

if (!baseUrl) {
  throw new Error(
    'NEXT_PUBLIC_API_BASE_URL is not set. Copy apps/web/.env.example to .env.local.',
  );
}

let cachedAccessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  cachedAccessToken = token;
}

let browserSessionRefreshInFlight: Promise<BrowserAuthTokens | null> | null = null;

/**
 * Rotate the browser refresh cookie at most once at a time.
 *
 * Refresh tokens are single-use/rotating, so session restore and an API 401
 * recovery must share the same promise. Otherwise two concurrent refreshes can
 * race: the winner rotates the cookie and the loser incorrectly looks like an
 * expired session.
 */
export function refreshBrowserSession(): Promise<BrowserAuthTokens | null> {
  if (browserSessionRefreshInFlight) return browserSessionRefreshInFlight;

  browserSessionRefreshInFlight = (async () => {
    try {
      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        // Consume the response body before returning. In browser/CI builds the
        // API base can intentionally point at the Next.js server; a 404 HTML
        // response that is left unread can keep Chromium's fetch request open
        // and prevent Playwright/network-idle from settling. The prior shared
        // ApiClient path always consumed error bodies before throwing.
        try {
          await response.json();
        } catch {
          // The error body may be HTML or empty; reading it is what matters.
        }
        setAccessToken(null);
        return null;
      }
      const payload = (await response.json()) as { accessToken?: unknown };
      if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) {
        setAccessToken(null);
        return null;
      }
      const tokens: BrowserAuthTokens = { accessToken: payload.accessToken };
      setAccessToken(tokens.accessToken);
      return tokens;
    } catch {
      return null;
    } finally {
      browserSessionRefreshInFlight = null;
    }
  })();

  return browserSessionRefreshInFlight;
}

async function recoverUnauthorized(): Promise<boolean> {
  return Boolean(await refreshBrowserSession());
}

const apiClient: ApiClient = createApiClient({
  baseUrl,
  includeCredentials: true,
  getAccessToken: () => cachedAccessToken,
  recoverUnauthorized,
});

// Capital-allocation reads/writes are the trader workspace's explicit broker
// selection boundary. Mirror that selection into the web data-layer context so
// execution history stays pinned to the same account even when no trading
// session is active. The original ApiClient methods remain authoritative for
// transport and validation.
const getCapitalAllocation = apiClient.getCapitalAllocation.bind(apiClient);
apiClient.getCapitalAllocation = async (brokerConnectionId: string) => {
  setSelectedTraderBrokerId(brokerConnectionId);
  return getCapitalAllocation(brokerConnectionId);
};

const setCapitalAllocation = apiClient.setCapitalAllocation.bind(apiClient);
apiClient.setCapitalAllocation = async (input) => {
  setSelectedTraderBrokerId(input.brokerConnectionId);
  return setCapitalAllocation(input);
};

export const api: ApiClient = apiClient;
export const browserAuth = createBrowserAuthClient(api);
