import { ApiClientError } from '@irexpro/api-client';
import type { MfaSetupResponse } from '@irexpro/types';
import { api } from '@/lib/api';
import { isMfaSetupExpiredRejectionMessage } from '@/lib/account-security-logic';

// Sprint 55: normalizeCountryCode / isValidCountryCode moved to the
// RN-IMPORT-FREE pure module `account-security-logic.ts` so they can be
// unit-tested by a zero-dependency harness. Re-exported here to keep this
// module's public surface stable for existing importers.
export { normalizeCountryCode, isValidCountryCode } from '@/lib/account-security-logic';

// Sprint 55 Phase G/H: isSixDigitCode was absorbed by the pure module as
// validateSixDigitCode (same semantics). Re-exported for surface parity.
export { validateSixDigitCode } from '@/lib/account-security-logic';

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

/**
 * Sanitized error copy for rejected one-time codes (TOTP enable, phone
 * verification). A 401 on these endpoints means the submitted code did not
 * match, so it gets code-specific copy; every other status code falls back
 * to the generic sanitized mapper. The raw server message is never used.
 */
export function verificationCodeError(error: unknown): string {
  if (error instanceof ApiClientError && error.statusCode === 401) {
    return "That code didn't match. Check the code and try again.";
  }
  return accountSecurityError(error);
}

/**
 * Whether an enable/disable MFA rejection is the backend's "MFA setup
 * expired; start setup again" 400 (the enrollment response carries no expiry
 * field, so the marker must be matched from the sanitized error surface).
 *
 * Detection only — the raw message is never rendered; callers substitute
 * their own static restart copy.
 */
export function isMfaSetupExpiredRejection(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.statusCode === 400 &&
    isMfaSetupExpiredRejectionMessage(error.message)
  );
}
