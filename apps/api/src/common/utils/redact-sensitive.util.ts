/**
 * Sensitive-field redaction utility — Hotfix.
 *
 * Recursively redacts sensitive values from objects before logging.
 * Used by AllExceptionsFilter to prevent secrets from appearing in logs.
 *
 * Redacted keys (case-insensitive):
 *   password, passwordHash, currentPassword, newPassword, mfaSecret,
 *   authorization, cookie, set-cookie, refreshToken, accessToken,
 *   resetToken, resetCode, verificationCode, apiKey, apiSecret,
 *   encryptedCredentials, credentialIv, credentialTag, encryptionKey
 */

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'mfasecret',
  'authorization',
  'cookie',
  'set-cookie',
  'refreshtoken',
  'accesstoken',
  'resettoken',
  'resetcode',
  'verificationcode',
  'apikey',
  'apisecret',
  'encryptedcredentials',
  'credentialiv',
  'credentialtag',
  'encryptionkey',
  'smtpurl',
]);

/**
 * Redact sensitive values in an object recursively.
 * Returns a new object with sensitive values replaced by '[REDACTED]'.
 * Does NOT mutate the original object.
 */
export function redactSensitive<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj) as T;
  if (typeof obj !== 'object') return obj;
  if (obj instanceof Date) return obj;
  if (obj instanceof RegExp) return obj;
  if (obj instanceof Error) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitive(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSensitive(value);
    }
  }
  return result as T;
}

/**
 * Extract safe information from a database error (QueryFailedError).
 * Returns only: name, message (sanitized), and PostgreSQL error code.
 * Never includes query parameters, complete entities, or stack traces in the
 * returned object (the stack is logged separately at debug level).
 */
export function sanitizeDatabaseError(err: unknown): {
  name: string;
  message: string;
  code?: string;
  detail?: string;
} {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string; code?: string; detail?: string };
    return {
      name: e.name ?? 'UnknownError',
      message: e.message ? redactString(e.message) : 'Database error',
      code: e.code,
      detail: e.detail ? redactString(e.detail) : undefined,
    };
  }
  return { name: 'UnknownError', message: 'Database error' };
}

/**
 * Redact sensitive values from a string (e.g. error message).
 */
/** Sanitizes credential-shaped `key=value` / `key: value` fragments out of free text (exported for adapter error normalization). */
export function redactString(str: string): string {
  let result = str;
  result = result.replace(
    /(password|secret|token|key|credential)\s*[:=]\s*[^\s,;}]+/gi,
    '$1=[REDACTED]',
  );
  return result;
}
