import type { ApiClient } from '@irexpro/api-client';
import type { BrowserAuthTokens } from '@irexpro/api-client/browser-auth';
import { createApiClient } from '@irexpro/api-client';
import { createBrowserAuthClient } from '@irexpro/api-client/browser-auth';

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
let tokenGeneration = 0;
type SessionEvent = { type: 'refreshed'; accessToken: string } | { type: 'expired' };
const sessionListeners = new Set<(event: SessionEvent) => void>();

export function subscribeBrowserSession(listener: (event: SessionEvent) => void): () => void {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}

function publishSession(event: SessionEvent): void {
  for (const listener of sessionListeners) listener(event);
}

function expireBrowserSession(): void {
  if (!cachedAccessToken) return;
  setAccessToken(null);
  publishSession({ type: 'expired' });
}

export function setAccessToken(token: string | null): void {
  if (cachedAccessToken !== token) tokenGeneration++;
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
// Coordinate cookie rotation across tabs where the browser supports Web Locks.
// A refresh token is single-use; a competing tab must not rotate it concurrently.
async function withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('irexpro-browser-session-refresh', task);
  }
  return task();
}

async function requestRefresh(): Promise<{ status: number; token: string | null }> {
  const response = await fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
  });
  let payload: { accessToken?: unknown } = {};
  try { payload = await response.json(); } catch { /* drain non-JSON responses */ }
  return {
    status: response.status,
    token: response.ok && typeof payload?.accessToken === 'string' && payload.accessToken.length
      ? payload.accessToken : null,
  };
}

export function refreshBrowserSession(): Promise<BrowserAuthTokens | null> {
  if (browserSessionRefreshInFlight) return browserSessionRefreshInFlight;
  const generation = tokenGeneration;
  browserSessionRefreshInFlight = withRefreshLock(async () => {
    if (generation !== tokenGeneration) {
      return cachedAccessToken ? { accessToken: cachedAccessToken } : null;
    }
    try {
      let result = await requestRefresh();
      // A legacy tab may still be completing a cookie rotation. Confirm a
      // refusal once with the current cookie before declaring a session dead.
      if ([401, 403].includes(result.status) && cachedAccessToken &&
          generation === tokenGeneration) {
        result = await requestRefresh();
      }
      if (generation !== tokenGeneration) return null;
      if (!result.token) {
        if ([401, 403].includes(result.status)) expireBrowserSession();
        return null;
      }
      const tokens: BrowserAuthTokens = { accessToken: result.token };
      const wasSignedIn = cachedAccessToken !== null;
      setAccessToken(tokens.accessToken);
      if (wasSignedIn) publishSession({ type: 'refreshed', accessToken: tokens.accessToken });
      return tokens;
    } catch {
      return null;
    }
  }).catch(() => null).finally(() => { browserSessionRefreshInFlight = null; });
  return browserSessionRefreshInFlight;
}

let sessionVerificationInFlight: Promise<boolean> | null = null;

/**
 * Verify the actual user session, not the status of an arbitrary broker or
 * workspace API. A valid bearer must not be rotated on an unrelated 401.
 */
function recoverUnauthorized(): Promise<boolean> {
  if (sessionVerificationInFlight) return sessionVerificationInFlight;
  const token = cachedAccessToken;
  if (!token) return Promise.resolve(false);
  const generation = tokenGeneration;
  sessionVerificationInFlight = (async () => {
    try {
      const response = await fetch(`${baseUrl}/auth/me`, {
        credentials: 'include', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      await response.text();
      if (generation !== tokenGeneration) return cachedAccessToken !== null;
      // A valid session or an API outage must never trigger logout or rotation.
      if (response.status !== 401) return false;
      return Boolean(await refreshBrowserSession());
    } catch { return false; }
  })().finally(() => { sessionVerificationInFlight = null; });
  return sessionVerificationInFlight;
}

export const api: ApiClient = createApiClient({
  baseUrl,
  includeCredentials: true,
  getAccessToken: () => cachedAccessToken,
  recoverUnauthorized,
});

export const browserAuth = createBrowserAuthClient(api);

/** A focus/online/interval check shares the same verification as API recovery. */
export async function verifyBrowserSession(): Promise<void> {
  await recoverUnauthorized();
}
