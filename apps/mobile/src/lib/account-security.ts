import { ApiClientError } from '@irexpro/api-client';
import type { MfaSetupResponse } from '@irexpro/types';
import { api } from '@/lib/api';

// Sprint 55: normalizeCountryCode / isValidCountryCode moved to the
// RN-IMPORT-FREE pure module `account-security-logic.ts` so they can be
// unit-tested by a zero-dependency harness. Re-exported here to keep this
// module's public surface stable for existing importers.
export { normalizeCountryCode, isValidCountryCode } from '@/lib/account-security-logic';

/**
 * Start MFA enrollment using the backend's required current-password
 * re-authentication.
 *
 * The returned secret and otpauth URI are enrollment material: callers must
 * keep them memory-only and must never persist or log them.
 */
export function beginMfaSetup(password: string): Promise<MfaSetupResponse> {
  return api.beginMfaSetup(password);
}

/** Return user-facing error copy without reflecting request secrets or raw payloads. */
export function accountSecurityError(error: unknown): string {
  if (!(error instanceof ApiClientError)) {
    return 'Something went wrong. Please try again.';
  }

  if (error.statusCode === 0) {
    return 'Unable to reach the server. Check your connection and try again.';
  }
  if (error.statusCode === 401) {
    return 'Your session or current password could not be verified.';
  }
  if (error.statusCode === 400 || error.statusCode === 422) {
    return 'Check the information you entered and try again.';
  }
  if (error.statusCode === 429) {
    return 'Too many attempts. Please try again later.';
  }
  if (error.statusCode >= 500) {
    return 'This security action is temporarily unavailable. Please try again later.';
  }

  return 'The security action could not be completed.';
}

export function isSixDigitCode(value: string): boolean {
  return /^\d{6}$/u.test(value.trim());
}
