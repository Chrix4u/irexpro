import { mapApiError } from './error-mapping';

/**
 * Error mapping tests — UX feature.
 *
 * Verifies that API error codes map to safe user-facing messages
 * and never expose SQL errors, stack traces, or secrets.
 */
describe('mapApiError', () => {
  it('should map TRADING_NOT_READY to a safe message', () => {
    const error = {
      statusCode: 403,
      code: 'TRADING_NOT_READY',
      message: 'Your trading setup is not ready.',
      missingSteps: ['PROFILE', 'BROKER_CONNECTION'],
    };
    const result = mapApiError(error);
    expect(result.message).toBe('Your trading setup is not ready.');
    expect(result.code).toBe('TRADING_NOT_READY');
    expect(result.missingSteps).toBeDefined();
    expect(result.missingSteps?.length).toBeGreaterThan(0);
  });

  it('should read typed codes and missing steps from ApiClientError.raw', () => {
    const error = {
      statusCode: 403,
      message: 'Your trading setup is not ready.',
      raw: {
        statusCode: 403,
        code: 'TRADING_NOT_READY',
        message: 'Your trading setup is not ready.',
        missingSteps: ['PROFILE', 'BROKER_CONNECTION'],
      },
    };
    const result = mapApiError(error);
    expect(result.code).toBe('TRADING_NOT_READY');
    expect(result.missingSteps).toEqual(['/onboarding/profile', '/onboarding/broker']);
  });

  it('should preserve a safe actionable 4xx broker explanation', () => {
    const detail =
      'Broker connection authorization status is AUTHORIZED — the connection is not executable. Re-authorize the connection before starting a session.';
    const error = {
      statusCode: 409,
      message: detail,
      raw: { statusCode: 409, message: detail },
    };
    expect(mapApiError(error).message).toBe(detail);
  });

  it('should preserve a safe 403 domain explanation instead of replacing it with generic permission copy', () => {
    const detail = 'Connect and validate a DEMO account for this broker before enabling this action.';
    const error = {
      statusCode: 403,
      message: detail,
      raw: { statusCode: 403, message: detail },
    };
    expect(mapApiError(error).message).toBe(detail);
  });

  it('should map VALIDATION_ERROR to a safe message', () => {
    const error = { statusCode: 400, code: 'VALIDATION_ERROR', message: 'password must be at least 12 characters' };
    const result = mapApiError(error);
    expect(result.message).toBe('Please check the highlighted fields and try again.');
    expect(result.message).not.toContain('password');
  });

  it('should map UNAUTHORIZED to a session expired message', () => {
    const error = { statusCode: 401, code: 'UNAUTHORIZED' };
    const result = mapApiError(error);
    expect(result.message).toBe('Your session has expired. Please sign in again.');
  });

  it('should map FORBIDDEN to a permission message when no safe detail exists', () => {
    const error = { statusCode: 403, code: 'FORBIDDEN' };
    const result = mapApiError(error);
    expect(result.message).toBe("You don't have permission to perform this action.");
  });

  it('should map BROKER_CONNECTION_FAILED to a safe message', () => {
    const error = { statusCode: 400, code: 'BROKER_CONNECTION_FAILED' };
    const result = mapApiError(error);
    expect(result.message).toBe('The broker connection test failed. Please check your credentials.');
  });

  it('should map BROKER_HEALTH_STALE to a safe message', () => {
    const error = { statusCode: 403, code: 'BROKER_HEALTH_STALE' };
    const result = mapApiError(error);
    expect(result.message).toBe('Your broker health check is outdated. Please test your connection.');
  });

  it('should map RISK_LIMIT_EXCEEDED to a safe message', () => {
    const error = { statusCode: 403, code: 'RISK_LIMIT_EXCEEDED' };
    const result = mapApiError(error);
    expect(result.message).toBe('The requested action exceeds your risk limits.');
  });

  it('should map network errors to a safe message', () => {
    const error = new Error('Network error contacting API: fetch failed');
    const result = mapApiError(error);
    expect(result.message).toBe('Unable to reach the server. Please check your connection.');
  });

  it('should map unknown errors to a safe default', () => {
    const error = new Error('QueryFailedError: invalid input syntax for type uuid');
    const result = mapApiError(error);
    expect(result.message).toBe('Something went wrong. Please try again.');
    expect(result.message).not.toContain('QueryFailedError');
    expect(result.message).not.toContain('uuid');
  });

  it('should never expose SQL errors even when wrapped in a 4xx response', () => {
    const error = {
      statusCode: 400,
      message: 'QueryFailedError: relation "identity.users" does not exist',
      raw: { statusCode: 400, message: 'QueryFailedError: relation "identity.users" does not exist' },
    };
    const result = mapApiError(error);
    expect(result.message).toBe('Something went wrong. Please try again.');
    expect(result.message).not.toContain('relation');
    expect(result.message).not.toContain('identity.users');
  });

  it('should never expose server-side 5xx diagnostics', () => {
    const error = {
      statusCode: 500,
      message: 'Internal provider failure at /home/app/services/provider.ts:42',
      raw: { statusCode: 500, message: 'Internal provider failure at /home/app/services/provider.ts:42' },
    };
    const result = mapApiError(error);
    expect(result.message).toBe('Unable to reach the server. Please check your connection.');
    expect(result.message).not.toContain('/home/app');
  });

  it('should never expose stack traces', () => {
    const error = { stack: 'at QueryFailedError (/node_modules/typeorm/...)' };
    const result = mapApiError(error);
    expect(result.message).not.toContain('stack');
    expect(result.message).not.toContain('typeorm');
  });

  it('should never expose credentials or tokens', () => {
    const error = { statusCode: 400, message: 'apiKey=super_secret_key connection failed' };
    const result = mapApiError(error);
    expect(result.message).not.toContain('super_secret_key');
    expect(result.message).not.toContain('apiKey');
  });
});