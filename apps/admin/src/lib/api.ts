import type { ApiClient } from '@irexpro/api-client';
import { createApiClient } from '@irexpro/api-client';
import { createBrowserAuthClient } from '@irexpro/api-client/browser-auth';

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

if (!baseUrl) {
  throw new Error(
    'NEXT_PUBLIC_API_BASE_URL is not set. Copy apps/admin/.env.example to .env.local.',
  );
}

let cachedAccessToken: string | null = null;
const accessTokenListeners = new Set<(token: string | null) => void>();

export function setAccessToken(token: string | null): void {
  cachedAccessToken = token;
  for (const listener of accessTokenListeners) listener(token);
}

export function subscribeAccessToken(
  listener: (token: string | null) => void,
): () => void {
  accessTokenListeners.add(listener);
  return () => accessTokenListeners.delete(listener);
}

async function refreshAccessTokenFromCookie(): Promise<string | null> {
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
      return null;
    }
    const payload = (await response.json()) as { accessToken?: unknown };
    if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) {
      setAccessToken(null);
      return null;
    }
    setAccessToken(payload.accessToken);
    return payload.accessToken;
  } catch {
    return null;
  }
}

export const api: ApiClient = createApiClient({
  baseUrl,
  includeCredentials: true,
  getAccessToken: () => cachedAccessToken,
  onUnauthorized: refreshAccessTokenFromCookie,
});

export const browserAuth = createBrowserAuthClient(api);
