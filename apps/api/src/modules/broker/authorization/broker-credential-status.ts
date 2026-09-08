/**
 * BrokerCredentialStatus — lifecycle of the stored (encrypted) broker
 * credential set (Directive §14: "Credentials should support lifecycle
 * concepts such as created / verified / rotated / revoked / expired / invalid").
 *
 * SECURITY
 * - This status is metadata about the ciphertext, never the secret itself.
 * - It is safe to expose in responses (contains no credential material).
 * - `isUsable()` is fail-closed: only CREATED/VERIFIED/ROTATED are usable.
 */

export enum BrokerCredentialStatus {
  /** Credentials stored, never yet validated against the provider. */
  CREATED = 'CREATED',
  /** Credentials validated via a successful provider handshake. */
  VERIFIED = 'VERIFIED',
  /** Credentials replaced (rotated); new set is pending verification. */
  ROTATED = 'ROTATED',
  /** Authorization revoked — credential set must not be used again. */
  REVOKED = 'REVOKED',
  /** Credentials expired per provider policy (e.g. token TTL elapsed). */
  EXPIRED = 'EXPIRED',
  /** Provider rejected the credentials (auth failure). */
  INVALID = 'INVALID',
}

export const BROKER_CREDENTIAL_STATUSES: readonly BrokerCredentialStatus[] =
  Object.values(BrokerCredentialStatus);

export class BrokerCredentialLifecycle {
  /** Fail-closed usability gate — only these states may be decrypted+used. */
  static isUsable(status: BrokerCredentialStatus | null | undefined): boolean {
    return (
      status === BrokerCredentialStatus.CREATED ||
      status === BrokerCredentialStatus.VERIFIED ||
      status === BrokerCredentialStatus.ROTATED
    );
  }

  /** True when a connect failure should mark credentials INVALID (auth-class errors). */
  static isAuthFailure(errorCode: string | null | undefined): boolean {
    if (!errorCode) return false;
    const normalized = errorCode.toUpperCase();
    return (
      normalized.includes('AUTH') ||
      normalized.includes('401') ||
      normalized.includes('403') ||
      normalized.includes('CREDENTIAL') ||
      normalized.includes('TOKEN') ||
      normalized.includes('KEY')
    );
  }
}
