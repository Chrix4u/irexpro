/**
 * Mobile secure token storage using Expo SecureStore.
 *
 * Sprint 25: tokens (access + refresh) are persisted in the platform secure
 * storage (iOS Keychain / Android Keystore) via expo-secure-store. This
 * survives app restarts so the user stays logged in. AsyncStorage is
 * prohibited (mobile equivalent of localStorage — vulnerable to backup
 * extraction and not encrypted at rest).
 *
 * Keys are namespaced with 'irexpro-' to avoid collisions.
 */

import * as SecureStore from 'expo-secure-store';
import type { AuthTokens } from '@irexpro/types';

const ACCESS_TOKEN_KEY = 'irexpro-access-token';
const REFRESH_TOKEN_KEY = 'irexpro-refresh-token';
const BROKER_OAUTH_PENDING_KEY = 'irexpro-broker-oauth-pending';

export interface PendingBrokerOAuthContext {
  brokerId: string;
  flowId: string;
  createdAt: string;
}

export async function saveTokens(tokens: AuthTokens): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, tokens.accessToken, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, tokens.refreshToken, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

export async function getAccessToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function getRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => {});
  // Pending OAuth context is user-bound. Never retain it across logout/account changes.
  await SecureStore.deleteItemAsync(BROKER_OAUTH_PENDING_KEY).catch(() => {});
}

export async function savePendingBrokerOAuth(
  context: PendingBrokerOAuthContext,
): Promise<void> {
  await SecureStore.setItemAsync(BROKER_OAUTH_PENDING_KEY, JSON.stringify(context), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

export async function getPendingBrokerOAuth(): Promise<PendingBrokerOAuthContext | null> {
  try {
    const raw = await SecureStore.getItemAsync(BROKER_OAUTH_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingBrokerOAuthContext>;
    if (
      typeof parsed.brokerId !== 'string' ||
      typeof parsed.flowId !== 'string' ||
      typeof parsed.createdAt !== 'string'
    ) {
      return null;
    }
    return {
      brokerId: parsed.brokerId,
      flowId: parsed.flowId,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export async function clearPendingBrokerOAuth(): Promise<void> {
  await SecureStore.deleteItemAsync(BROKER_OAUTH_PENDING_KEY).catch(() => {});
}
