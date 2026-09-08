import type { LoginRequest, RegisterRequest } from '@irexpro/types';
import type { ApiClient } from './index';

/** Browser-safe auth response. The refresh token is delivered only by HttpOnly cookie. */
export interface BrowserAuthTokens {
  accessToken: string;
}

export interface BrowserAuthClient {
  register(body: RegisterRequest): Promise<BrowserAuthTokens>;
  login(body: LoginRequest): Promise<BrowserAuthTokens>;
  refresh(): Promise<BrowserAuthTokens>;
  /**
   * Revoke every other session while rotating this browser session's HttpOnly
   * refresh cookie. Returns only a new access token — the refresh token stays
   * HttpOnly.
   */
  revokeOtherSessions(): Promise<BrowserAuthTokens>;
  /**
   * Revoke the browser session when possible, then deterministically clear the
   * HttpOnly refresh cookie and the caller's in-memory access token.
   */
  logout(
    currentAccessToken: string | null,
    setAccessToken: (token: string | null) => void,
  ): Promise<void>;
}

/**
 * Browser-only auth facade.
 *
 * Web/Admin never receive a refresh token in a JavaScript-readable response:
 * - login/register explicitly request cookie transport;
 * - refresh relies on the HttpOnly cookie and receives only a new access token;
 * - revokeOtherSessions asks the backend to rotate the HttpOnly cookie in place
 *   of returning a body refresh token;
 * - mobile/native continues to use ApiClient.login/register/refresh and body tokens.
 */
export function createBrowserAuthClient(api: ApiClient): BrowserAuthClient {
  const register = (body: RegisterRequest) =>
    api.request<BrowserAuthTokens>('/auth/register?refreshTransport=cookie', {
      method: 'POST',
      body: JSON.stringify(body),
    });

  const login = (body: LoginRequest) =>
    api.request<BrowserAuthTokens>('/auth/login?refreshTransport=cookie', {
      method: 'POST',
      body: JSON.stringify(body),
    });

  const refresh = () =>
    api.request<BrowserAuthTokens>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({}),
    });

  const revokeOtherSessions = () =>
    api.request<BrowserAuthTokens>(
      '/auth/sessions/revoke-others?refreshTransport=cookie',
      { method: 'POST' },
    );

  const clearBrowserCookie = () =>
    api.request<void>('/auth/browser-session', { method: 'DELETE' });

  const logout = async (
    currentAccessToken: string | null,
    setAccessToken: (token: string | null) => void,
  ): Promise<void> => {
    let revoked = false;

    try {
      if (currentAccessToken) {
        try {
          await api.logout();
          revoked = true;
        } catch {
          // The bearer may simply be expired/revoked while the HttpOnly refresh
          // cookie is still valid. Recover once through cookie refresh below.
        }
      }

      if (!revoked) {
        try {
          const fresh = await refresh();
          setAccessToken(fresh.accessToken);
          await api.logout();
        } catch {
          // Local logout still completes. The idempotent cookie-clear endpoint
          // below removes a surviving browser refresh cookie whenever the API
          // is reachable, even if bearer-based revocation could not complete.
        }
      }
    } finally {
      setAccessToken(null);
      try {
        await clearBrowserCookie();
      } catch {
        // Network/server failure cannot be repaired client-side; callers still
        // clear all JavaScript-held auth state deterministically.
      }
    }
  };

  return { register, login, refresh, revokeOtherSessions, logout };
}
