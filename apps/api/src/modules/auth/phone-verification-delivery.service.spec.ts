import { SmsMessageType } from '../notifications/interfaces/sms-provider.interface';
import { SmsProviderRegistry } from '../notifications/registry/sms-provider.registry';
import { PhoneVerificationDeliveryService } from './phone-verification-delivery.service';

describe('PhoneVerificationDeliveryService', () => {
  function setup(result = { success: true, provider: 'twilio' }) {
    const provider = {
      providerId: 'twilio',
      displayName: 'Twilio',
      supportedCountries: ['*'],
      isLive: true,
      sendSms: jest.fn().mockResolvedValue(result),
    };
    const registry = {
      selectProvider: jest.fn().mockReturnValue(provider),
    } as unknown as SmsProviderRegistry;
    return {
      provider,
      registry,
      service: new PhoneVerificationDeliveryService(registry),
    };
  }

  it('reports configured only when a live provider can be selected', () => {
    const { service, registry } = setup();

    expect(service.isConfigured('GH')).toBe(true);
    expect(registry.selectProvider).toHaveBeenCalledWith('GH');
  });

  it('fails closed when no live provider is available', () => {
    const registry = {
      selectProvider: jest.fn().mockImplementation(() => {
        throw new Error('none');
      }),
    } as unknown as SmsProviderRegistry;
    const service = new PhoneVerificationDeliveryService(registry);

    expect(service.isConfigured('GH')).toBe(false);
  });

  it('routes the verification code through the shared provider registry', async () => {
    const { service, provider, registry } = setup();

    await expect(
      service.sendVerificationCode('+233244000000', '123456', 'GH'),
    ).resolves.toBe(true);

    expect(registry.selectProvider).toHaveBeenCalledWith('GH');
    expect(provider.sendSms).toHaveBeenCalledWith({
      to: '+233244000000',
      messageType: SmsMessageType.OTP,
      templateData: { code: '123456' },
      countryCode: 'GH',
    });
  });

  it('rejects malformed destination/challenge before provider selection', async () => {
    const { service, provider, registry } = setup();

    await expect(service.sendVerificationCode('0244000000', '123456', 'GH')).resolves.toBe(false);
    await expect(
      service.sendVerificationCode('+233244000000', '12345', 'GH'),
    ).resolves.toBe(false);

    expect(registry.selectProvider).not.toHaveBeenCalled();
    expect(provider.sendSms).not.toHaveBeenCalled();
  });

  it('returns false when the provider does not accept the message', async () => {
    const { service } = setup({
      success: false,
      provider: 'twilio',
      errorCode: 'PROVIDER_REJECTED',
      errorMessage: 'SMS provider rejected the request',
    });

    await expect(
      service.sendVerificationCode('+233244000000', '123456', 'GH'),
    ).resolves.toBe(false);
  });
});
