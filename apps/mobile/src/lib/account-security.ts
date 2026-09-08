import type { MfaSetupResponse } from '@irexpro/types';
import { api } from '@/lib/api';

// Sprint 55: normalizeCountryCode / isValidCountryCode moved to the
// RN-IMPORT-FREE pure module `account-security-logic.ts` so they can be
// unit-tested by a zero-dependency harness. Re-exported here to keep this
// module's public surface stable for existing importers.
export { normalizeCountryCode, isValidCountryCode } from '@/lib/account-security-logic';

// Sprint 55 Phase G/H: isSixDigitCode was absorbed by the pure module as
// validateSixDigitCode (same semantics). Re-exported for surface parity.
export { validateSixDigitCode } from '@/lib/account-security-logic';

// Sprint 55 (Task 41): the sanitized error mappers (accountSecurityError,
// verificationCodeError, isMfaSetupExpiredRejection) moved to the
// RN-IMPORT-FREE `account-security-errors.ts` so the error-copy policy is
// unit-testable by the zero-dependency harness (this module imports `./api`,
// which is not Node-loadable). Re-exported here to keep the public surface
// stable for existing importers.
export {
  accountSecurityError,
  isMfaSetupExpiredRejection,
  verificationCodeError,
} from '@/lib/account-security-errors';

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
