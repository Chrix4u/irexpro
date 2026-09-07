import { registerAs } from '@nestjs/config';

export default registerAs('auth', () => ({
  jwtSecret: process.env.JWT_SECRET,
  accessTokenExpiry: process.env.JWT_ACCESS_EXPIRY ?? '15m',
  refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY ?? '7d',
  argon2MemoryCost: parseInt(process.env.ARGON2_MEMORY_COST ?? '65536', 10),
  argon2TimeCost: parseInt(process.env.ARGON2_TIME_COST ?? '3', 10),
  argon2Parallelism: parseInt(process.env.ARGON2_PARALLELISM ?? '1', 10),
  // Independent auth-domain key for encrypting TOTP seeds at rest.
  // Do not reuse broker/payment/application secrets for this purpose.
  mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY,
  // Pending TOTP enrollment is intentionally short-lived. A stale seed must
  // not remain eligible for later activation indefinitely.
  mfaSetupTtlSeconds: parseInt(process.env.MFA_SETUP_TTL_SECONDS ?? '600', 10),
  // Independent HMAC key material for low-entropy phone verification codes.
  verificationPepper: process.env.AUTH_VERIFICATION_PEPPER,
}));
