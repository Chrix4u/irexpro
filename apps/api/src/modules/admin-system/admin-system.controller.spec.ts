import { AdminSystemController } from './admin-system.controller';

describe('AdminSystemController', () => {
  function controller(values: Record<string, unknown> = {}) {
    const config = {
      get: jest.fn((key: string) => values[key]),
    };
    const twilio = {
      providerId: 'twilio',
      displayName: 'Twilio',
      supportedCountries: ['*'],
      isLive: false,
    };
    const hubtel = {
      providerId: 'hubtel_sms',
      displayName: 'Hubtel SMS',
      supportedCountries: ['GH'],
      isLive: false,
    };
    const arkesel = {
      providerId: 'arkesel',
      displayName: 'Arkesel SMS',
      supportedCountries: ['GH'],
      isLive: false,
    };
    return new AdminSystemController(config as any, twilio as any, hubtel as any, arkesel as any);
  }
  it('reports readiness without exposing configured secret values', () => {
    const result = controller({
      'auth.mfaEncryptionKey': 'a'.repeat(40),
      'auth.verificationPepper': 'b'.repeat(40),
      'email.smtpUrl': 'smtps://user:secret@smtp.example.test:465',
      'email.fromAddress': 'no-reply@example.test',
      'app.webBaseUrl': 'https://example.test',
      'sms.twilio.accountSid': 'AC' + '1'.repeat(32),
      'sms.twilio.authToken': 'c'.repeat(32),
      'sms.twilio.fromNumber': '+233241234567',
      'paystack.enabled': false,
      'stripe.enabled': false,
    }).getReadiness();

    expect(result.security.mfaReady).toBe(true);
    expect(result.email.ready).toBe(true);
    expect(result.sms.twilio.accountSidFormatValid).toBe(true);
    expect(result.sms.twilio.authTokenUsable).toBe(true);
    expect(JSON.stringify(result)).not.toContain('smtp.example.test');
    expect(JSON.stringify(result)).not.toContain('c'.repeat(32));
    expect(JSON.stringify(result)).not.toContain('AC' + '1'.repeat(32));
  });
  it('fails readiness closed for placeholders and disabled payment providers', () => {
    const result = controller({
      'auth.mfaEncryptionKey': 'CHANGE_ME',
      'auth.verificationPepper': 'PLACEHOLDER',
      'email.smtpUrl': '',
      'email.fromAddress': '',
      'app.webBaseUrl': '',
      'sms.twilio.accountSid': 'placeholder',
      'sms.twilio.authToken': 'CHANGE_ME',
      'sms.twilio.fromNumber': '+233241234567',
      'paystack.enabled': false,
      'stripe.enabled': false,
    }).getReadiness();

    expect(result.security.mfaReady).toBe(false);
    expect(result.email.ready).toBe(false);
    expect(result.sms.ready).toBe(false);
    expect(result.sms.twilio.accountSidFormatValid).toBe(false);
    expect(result.sms.twilio.authTokenUsable).toBe(false);
    expect(result.payments).toEqual({
      paystackEnabled: false,
      stripeEnabled: false,
    });
  });
});
