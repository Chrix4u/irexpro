/**
 * Sanitized error mappers for the account/security center.
 *
 * RN-IMPORT-FREE MODULE (like `account-security-logic.ts`): this file must
 * never import `react`, `react-native`, or any Expo package — only plain
 * TypeScript plus the shared `@irexpro/api-client` error class, which is itself
 * runtime-safe outside React Native. A zero-dependency harness transpiles and
 * evaluates this module directly, so the error-copy policy of the whole
 * account-security center is unit-testable in Node.
 *
 * The mappers discriminate errors via `error instanceof ApiClientError` and
 * the numeric `statusCode` only. Raw server messages and payloads are never
 * reflected into user-facing copy (the single exception is documented below,
 * and it is detection-only, never rendered).
 */

import { ApiClientError } from '@irexpro/api-client';

import { isMfaSetupExpiredRejectionMessage } from './account-security-logic';

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
