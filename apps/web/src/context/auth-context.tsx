'use client';

import { createContext, useContext, useCallback, useMemo, useState, useEffect, ReactNode } from 'react';
import type { AuthUser } from '@irexpro/types';
import type { BrowserAuthTokens } from '@irexpro/api-client/browser-auth';
import { setAccessToken, subscribeAccessToken, api, browserAuth } from '@/lib/api';

/**
 * Web auth context — Sprint 25 hybrid strategy.
 *
 * Session restore on page refresh:
 *   - The backend sets an httpOnly refresh cookie on login/register.
 *   - On mount, the AuthProvider calls browserAuth.refresh() — the browser
 *     automatically sends the httpOnly cookie via credentials:'include'.
 *   - Cookie-based auth responses expose only a new access token to JavaScript;
 *     the rotated refresh token remains HttpOnly-cookie-only.
 *   - If refresh succeeds, the access token is stored in memory and /auth/me
 *     populates the current user.
 *
 * Token storage:
 *   - Access token: in memory only (NOT localStorage).
 *   - Refresh token: httpOnly cookie set by the backend. JavaScript cannot read
 *     or receive it in browser auth response bodies.
 */

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  loading: boolean;
  restoring: boolean;
  error: string | null;
  login: (
    identifier: string,
    password: string,
    rememberMe?: boolean,
    mfaCode?: string,
  ) => Promise<void>;
  register: (email: string, password: string, opts?: {
    countryCode?: string; firstName?: string; lastName?: string;
    phone?: string; rememberMe?: boolean;
  }) => Promise<void>;
  logout: () => Promise<void>;
  /** Refresh only the frontend-safe current-user state using the existing access token. */
  refreshUser: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessTokenState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const storeTokens = useCallback((tokens: BrowserAuthTokens) => {
    setAccessTokenState(tokens.accessToken);
    setAccessToken(tokens.accessToken);
  }, []);

  useEffect(() => {
    return subscribeAccessToken((token) => {
      setAccessTokenState(token);
      if (!token) setUser(null);
    });
  }, []);

  const fetchMe = useCallback(async (token: string) => {
    setAccessToken(token);
    try {
      const me = await api.me();
      setUser(me);
    } catch (err) {
      setAccessTokenState(null);
      setAccessToken(null);
      setUser(null);
      throw err;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tokens = await browserAuth.refresh();
        if (cancelled) return;
        storeTokens(tokens);
        await fetchMe(tokens.accessToken);
      } catch {
        // No cookie, expired, revoked, or invalid — unauthenticated is normal.
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => { cancelled = true; };
  }, [storeTokens, fetchMe]);

  const login = useCallback(async (
    identifier: string,
    password: string,
    rememberMe?: boolean,
    mfaCode?: string,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const normalizedMfaCode = mfaCode?.trim() || undefined;
      const tokens = await browserAuth.login({
        identifier,
        password,
        rememberMe,
        mfaCode: normalizedMfaCode,
      });
      storeTokens(tokens);
      await fetchMe(tokens.accessToken);
    } catch (err) {
      const msg = (err instanceof Error && err.message && !err.message.includes('fetch'))
        ? err.message
        : 'Something went wrong. Please try again or contact support.';
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [storeTokens, fetchMe]);

  const register = useCallback(async (
    email: string,
    password: string,
    opts?: { countryCode?: string; firstName?: string; lastName?: string; phone?: string; rememberMe?: boolean },
  ) => {
    setLoading(true);
    setError(null);
    try {
      const tokens = await browserAuth.register({ email: email || undefined, password, ...opts });
      storeTokens(tokens);
      await fetchMe(tokens.accessToken);
    } catch (err) {
      const msg = (err instanceof Error && err.message && !err.message.includes('fetch'))
        ? err.message
        : 'Something went wrong. Please try again or contact support.';
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [storeTokens, fetchMe]);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      // If the bearer has expired but the HttpOnly refresh cookie is still
      // valid, the browser facade performs one cookie refresh and then retries
      // authenticated logout so server-side sessionVersion revocation still
      // happens. It also idempotently clears the browser cookie afterward.
      await browserAuth.logout(accessToken, setAccessToken);
    } finally {
      setAccessTokenState(null);
      setAccessToken(null);
      setUser(null);
      setLoading(false);
    }
  }, [accessToken]);

  const refreshUser = useCallback(async () => {
    if (!accessToken) throw new Error('Not authenticated');
    await fetchMe(accessToken);
  }, [accessToken, fetchMe]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    accessToken,
    loading,
    restoring,
    error,
    login,
    register,
    logout,
    refreshUser,
    clearError,
  }), [
    user,
    accessToken,
    loading,
    restoring,
    error,
    login,
    register,
    logout,
    refreshUser,
    clearError,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/** True if the user is authenticated (has a user object + access token). */
export function useIsAuthenticated(): boolean {
  const { user, accessToken } = useAuth();
  return !!user && !!accessToken;
}
