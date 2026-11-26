import type { AuthTokens, AuthUser } from '@irexpro/types';

interface LoginDependencies {
  login: (credentials: { identifier: string; password: string }) => Promise<AuthTokens>;
  me: () => Promise<AuthUser>;
  setAccessToken: (token: string | null) => void;
  saveTokens: (tokens: AuthTokens) => Promise<void>;
  clearTokens: () => Promise<void>;
}

/** Validate identity before persisting a new credential pair. */
export async function establishLogin(
  dependencies: LoginDependencies,
  identifier: string,
  password: string,
): Promise<{ user: AuthUser; accessToken: string }> {
  const normalizedIdentifier = identifier.trim();
  if (!normalizedIdentifier || !password) throw new Error('MISSING_CREDENTIALS');
  let persistenceStarted = false;
  dependencies.setAccessToken(null);
  try {
    const tokens = await dependencies.login({ identifier: normalizedIdentifier, password });
    dependencies.setAccessToken(tokens.accessToken);
    const user = await dependencies.me();
    persistenceStarted = true;
    await dependencies.saveTokens(tokens);
    return { user, accessToken: tokens.accessToken };
  } catch (error) {
    dependencies.setAccessToken(null);
    if (persistenceStarted) await dependencies.clearTokens();
    throw error;
  }
}
