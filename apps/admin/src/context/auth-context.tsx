'use client';

import { createContext, useContext, useCallback, useMemo, useState, useEffect, ReactNode } from 'react';
import type { AuthUser, UserRole } from '@irexpro/types';
import type { BrowserAuthTokens } from '@irexpro/api-client/browser-auth';
import { setAccessToken, subscribeAccessToken, api, browserAuth } from '@/lib/api';

/**
 * Admin auth context — Sprint 25 hybrid strategy.
 *
 * Session restore on page refresh:
 *   - The backend sets an httpOnly refresh cookie on login.
 *   - On mount, the AuthProvider calls browserAuth.refresh(); the rotated
 *     refresh token remains cookie-only and JavaScript receives only a new
 *     access token.
 *   - If refresh succeeds, /auth/me populates the current user and roles.
 *
 * Role enforcement: the backend enforces ADMIN/SUPER_ADMIN via RolesGuard on
 * admin endpoints. The frontend checks roles[] from /auth/me for a soft UI
 * guard. The backend is the source of truth.
 *
 * Token storage: access token in memory only (NOT localStorage). Refresh token
 * in HttpOnly cookie and never in browser-readable auth response bodies.
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
  logout: () => Promise<void>;
  clearError: () => void;
  hasAdminRole: boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function checkAdminRole(user: AuthUser | null): boolean {
  if (!user?.roles || user.roles.length === 0) return false;
  return user.roles.some((r: UserRole) => r === 'ADMIN' || r === 'SUPER_ADMIN');
}

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
      const tokens = await browserAuth.login({
        identifier,
        password,
        rememberMe,
        mfaCode: mfaCode?.trim() || undefined,
      });
      storeTokens(tokens);
      await fetchMe(tokens.accessToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [storeTokens, fetchMe]);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await browserAuth.logout(accessToken, setAccessToken);
    } finally {
      setAccessTokenState(null);
      setAccessToken(null);
      setUser(null);
      setLoading(false);
    }
  }, [accessToken]);

  const clearError = useCallback(() => setError(null), []);
  const hasAdminRole = checkAdminRole(user);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    accessToken,
    loading,
    restoring,
    error,
    login,
    logout,
    clearError,
    hasAdminRole,
  }), [user, accessToken, loading, restoring, error, login, logout, clearError, hasAdminRole]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
