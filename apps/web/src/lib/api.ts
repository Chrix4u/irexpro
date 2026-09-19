import type { ApiClient } from '@irexpro/api-client';
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

export function setAccessToken(token: string | null): void {
  cachedAccessToken = token;
}

async function recoverUnauthorized(): Promise<boolean> {
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
      setAccessToken(null);
      return false;
    }
    const payload = (await response.json()) as { accessToken?: unknown };
    if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) {
      setAccessToken(null);
      return false;
    }
    setAccessToken(payload.accessToken);
    return true;
  } catch {
    return false;
  }
}

export const api: ApiClient = createApiClient({
  baseUrl,
  includeCredentials: true,
  getAccessToken: () => cachedAccessToken,
  recoverUnauthorized,
});

export const browserAuth = createBrowserAuthClient(api);
