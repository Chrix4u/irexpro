import { NotFoundException } from '@nestjs/common';
import type { ISmsProvider } from '../interfaces/sms-provider.interface';
import { SmsProviderRegistry } from './sms-provider.registry';

function provider(
  providerId: string,
  supportedCountries: string[],
  isLive: boolean,
): ISmsProvider {
  return {
    providerId,
    displayName: providerId,
    supportedCountries,
    isLive,
    sendSms: jest.fn(),
  };
}

describe('SmsProviderRegistry', () => {
  it('never selects registered placeholder/non-live providers', () => {
    const registry = new SmsProviderRegistry();
    registry.register(provider('hubtel_sms', ['GH'], false));
    registry.register(provider('arkesel', ['GH', 'NG'], false));
    registry.register(provider('twilio', ['*'], true));

    expect(registry.selectProvider('GH').providerId).toBe('twilio');
  });

  it('uses a live preferred provider only when it supports the country or wildcard', () => {
    const registry = new SmsProviderRegistry();
    registry.register(provider('regional', ['GH'], true));
    registry.register(provider('twilio', ['*'], true));

    expect(registry.selectProvider('GH', 'regional').providerId).toBe('regional');
    expect(registry.selectProvider('GB', 'regional').providerId).toBe('twilio');
  });

  it('fails closed when no configured live provider can serve the country', () => {
    const registry = new SmsProviderRegistry();
    registry.register(provider('hubtel_sms', ['GH'], false));

    expect(() => registry.selectProvider('GH')).toThrow(NotFoundException);
  });

  it('normalizes country codes before routing', () => {
    const registry = new SmsProviderRegistry();
    registry.register(provider('regional', ['GH'], true));

    expect(registry.selectProvider(' gh ').providerId).toBe('regional');
  });
});
