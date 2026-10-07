import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ExternalSignalApiKeyGuard,
  EXTERNAL_SIGNAL_API_KEY_HEADER,
} from './external-signal-api-key.guard';

function contextWith(key?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: key ? { [EXTERNAL_SIGNAL_API_KEY_HEADER]: key } : {},
      }),
    }),
  } as any;
}

describe('ExternalSignalApiKeyGuard', () => {
  it('fails closed when external signals are disabled', () => {
    const config = {
      get: jest.fn((name: string, fallback?: unknown) =>
        name === 'externalSignals.enabled' ? false : fallback,
      ),
    } as unknown as ConfigService;
    const guard = new ExternalSignalApiKeyGuard(config);
    expect(() => guard.canActivate(contextWith('x'.repeat(32)))).toThrow(UnauthorizedException);
  });

  it('accepts the exact configured relay key when enabled', () => {
    const key = 'k'.repeat(40);
    const config = {
      get: jest.fn((name: string, fallback?: unknown) => {
        if (name === 'externalSignals.enabled') return true;
        if (name === 'externalSignals.apiKey') return key;
        return fallback;
      }),
    } as unknown as ConfigService;
    const guard = new ExternalSignalApiKeyGuard(config);
    expect(guard.canActivate(contextWith(key))).toBe(true);
  });

  it('rejects an invalid relay key', () => {
    const config = {
      get: jest.fn((name: string, fallback?: unknown) => {
        if (name === 'externalSignals.enabled') return true;
        if (name === 'externalSignals.apiKey') return 'a'.repeat(40);
        return fallback;
      }),
    } as unknown as ConfigService;
    const guard = new ExternalSignalApiKeyGuard(config);
    expect(() => guard.canActivate(contextWith('b'.repeat(40)))).toThrow(UnauthorizedException);
  });
});
