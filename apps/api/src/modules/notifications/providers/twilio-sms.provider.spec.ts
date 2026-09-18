import { ConfigService } from '@nestjs/config';
import { SmsMessageType } from '../interfaces/sms-provider.interface';
import { TwilioSmsProvider } from './twilio-sms.provider';

describe('TwilioSmsProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function config(values: Record<string, string | undefined>): ConfigService {
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  }

  function configured(overrides: Record<string, string | undefined> = {}): TwilioSmsProvider {
    return new TwilioSmsProvider(
      config({
        'sms.twilio.accountSid': `AC${'a'.repeat(32)}`,
        'sms.twilio.apiKey': `SK${'b'.repeat(32)}`,
        'sms.twilio.apiSecret': 'api-secret-value-0123456789abcdef',
        'sms.twilio.fromNumber': '+233200000000',
        ...overrides,
      }),
    );
  }

  it('is fail-closed when provider configuration is placeholder or incomplete', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = new TwilioSmsProvider(
      config({
        'sms.twilio.accountSid': 'PLACEHOLDER',
        'sms.twilio.authToken': 'PLACEHOLDER',
        'sms.twilio.fromNumber': '+15005550006',
      }),
    );

    expect(provider.isLive).toBe(false);
    await expect(
      provider.sendSms({
        to: '+233244000000',
        messageType: SmsMessageType.OTP,
        templateData: { code: '123456' },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        provider: 'twilio',
        errorCode: 'PROVIDER_NOT_CONFIGURED',
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends OTP through the Twilio Messages resource with API-key basic auth', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue({ sid: 'SM123' }),
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = configured();

    expect(provider.isLive).toBe(true);
    await expect(
      provider.sendSms({
        to: '+233244000000',
        messageType: SmsMessageType.OTP,
        templateData: { code: '123456' },
        countryCode: 'GH',
      }),
    ).resolves.toEqual({
      success: true,
      provider: 'twilio',
      providerMessageId: 'SM123',
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages.json`,
    );
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual(
      expect.objectContaining({
        Authorization: expect.stringMatching(/^Basic /u),
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
    );
    const body = new URLSearchParams(options.body as string);
    expect(body.get('To')).toBe('+233244000000');
    expect(body.get('From')).toBe('+233200000000');
    expect(body.get('Body')).toContain('123456');
    expect(body.get('Body')).toContain('10 minutes');
  });

  it('sends password-reset codes with fixed reset copy', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue({ sid: 'SM456' }),
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = configured();

    await expect(
      provider.sendSms({
        to: '+233244000000',
        messageType: SmsMessageType.PASSWORD_RESET,
        templateData: { code: '654321' },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ success: true, providerMessageId: 'SM456' }),
    );

    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const body = new URLSearchParams(options.body as string);
    expect(body.get('Body')).toContain('password reset code');
    expect(body.get('Body')).toContain('654321');
  });

  it('rejects invalid destinations and malformed codes before network access', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = configured();

    await expect(
      provider.sendSms({
        to: '0244000000',
        messageType: SmsMessageType.OTP,
        templateData: { code: '123456' },
      }),
    ).resolves.toEqual(expect.objectContaining({ success: false, errorCode: 'INVALID_DESTINATION' }));

    await expect(
      provider.sendSms({
        to: '+233244000000',
        messageType: SmsMessageType.OTP,
        templateData: { code: '12345' },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ success: false, errorCode: 'UNSUPPORTED_MESSAGE_TYPE' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a stable provider failure without leaking the provider response body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({
        message: 'token secret-should-not-surface',
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = configured();

    const result = await provider.sendSms({
      to: '+233244000000',
      messageType: SmsMessageType.OTP,
      templateData: { code: '123456' },
    });

    expect(result).toEqual({
      success: false,
      provider: 'twilio',
      errorCode: 'PROVIDER_REJECTED',
      errorMessage: 'SMS provider rejected the request',
    });
    expect(JSON.stringify(result)).not.toContain('secret-should-not-surface');
  });
});
