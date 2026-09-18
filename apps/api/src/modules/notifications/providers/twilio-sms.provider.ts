import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ISmsProvider,
  SmsDeliveryResult,
  SmsMessageType,
  SmsSendParams,
} from '../interfaces/sms-provider.interface';

/**
 * TwilioSmsProvider — production-capable global SMS provider.
 *
 * Uses Twilio's Messages REST resource with HTTP Basic authentication.
 * The provider is fail-closed: it is considered live only when the account
 * SID, sender number, and either an API-key pair or account auth token are
 * structurally usable. Secrets, message bodies, verification codes, and
 * destination numbers are never logged.
 */
@Injectable()
export class TwilioSmsProvider implements ISmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);

  readonly providerId = 'twilio';
  readonly displayName = 'Twilio';
  readonly supportedCountries = ['*'];

  constructor(private readonly configService: ConfigService) {}

  get isLive(): boolean {
    return this.isConfigured();
  }

  isConfigured(): boolean {
    const accountSid = this.configService.get<string>('sms.twilio.accountSid');
    const authToken = this.configService.get<string>('sms.twilio.authToken');
    const apiKey = this.configService.get<string>('sms.twilio.apiKey');
    const apiSecret = this.configService.get<string>('sms.twilio.apiSecret');
    const fromNumber = this.configService.get<string>('sms.twilio.fromNumber');

    const accountValid = Boolean(accountSid && /^AC[0-9a-f]{32}$/iu.test(accountSid));
    const fromValid = Boolean(fromNumber && /^\+[1-9]\d{7,14}$/u.test(fromNumber));
    const apiKeyPairValid = Boolean(
      apiKey && apiSecret && /^SK[0-9a-f]{32}$/iu.test(apiKey) && this.isUsableSecret(apiSecret),
    );
    const accountTokenValid = Boolean(authToken && this.isUsableSecret(authToken));

    return accountValid && fromValid && (apiKeyPairValid || accountTokenValid);
  }

  async sendSms(params: SmsSendParams): Promise<SmsDeliveryResult> {
    if (!this.isConfigured()) {
      return this.failure('PROVIDER_NOT_CONFIGURED', 'SMS provider is not configured');
    }
    if (!/^\+[1-9]\d{7,14}$/u.test(params.to)) {
      return this.failure('INVALID_DESTINATION', 'Destination must be E.164 format');
    }

    const body = this.renderMessage(params);
    if (!body) {
      return this.failure(
        'UNSUPPORTED_MESSAGE_TYPE',
        'Message type is not enabled for Twilio delivery',
      );
    }

    const accountSid = this.configService.get<string>('sms.twilio.accountSid')!;
    const authToken = this.configService.get<string>('sms.twilio.authToken');
    const apiKey = this.configService.get<string>('sms.twilio.apiKey');
    const apiSecret = this.configService.get<string>('sms.twilio.apiSecret');
    const fromNumber = this.configService.get<string>('sms.twilio.fromNumber')!;
    const username = apiKey && apiSecret ? apiKey : accountSid;
    const password = apiKey && apiSecret ? apiSecret : authToken!;

    const form = new URLSearchParams({
      To: params.to,
      From: fromNumber,
      Body: body,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString(
              'base64',
            )}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        this.logger.warn(`Twilio SMS rejected by provider (status=${response.status})`);
        return this.failure('PROVIDER_REJECTED', 'SMS provider rejected the request');
      }

      const providerMessageId = await this.readProviderMessageId(response);
      return {
        success: true,
        provider: this.providerId,
        ...(providerMessageId ? { providerMessageId } : {}),
      };
    } catch {
      this.logger.warn('Twilio SMS delivery failed before provider acceptance');
      return this.failure('PROVIDER_UNAVAILABLE', 'SMS provider is temporarily unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  private renderMessage(params: SmsSendParams): string | null {
    const code = params.templateData.code;
    if (
      (params.messageType === SmsMessageType.OTP ||
        params.messageType === SmsMessageType.PASSWORD_RESET) &&
      (!code || !/^\d{6}$/u.test(code))
    ) {
      return null;
    }

    switch (params.messageType) {
      case SmsMessageType.OTP:
        return `iRexPro: Your verification code is ${code}. Valid for 10 minutes. Do not share this code.`;
      case SmsMessageType.PASSWORD_RESET:
        return `iRexPro: Your password reset code is ${code}. Valid for 10 minutes. Do not share this code.`;
      default:
        return null;
    }
  }

  private async readProviderMessageId(response: Response): Promise<string | undefined> {
    try {
      const payload = (await response.json()) as { sid?: unknown };
      return typeof payload.sid === 'string' && payload.sid.length > 0 ? payload.sid : undefined;
    } catch {
      // Twilio acceptance is already proven by the 2xx response. A malformed
      // response body must not turn an accepted message into a retryable send.
      return undefined;
    }
  }

  private failure(errorCode: string, errorMessage: string): SmsDeliveryResult {
    return {
      success: false,
      provider: this.providerId,
      errorCode,
      errorMessage,
    };
  }

  private isUsableSecret(value: string): boolean {
    const normalized = value.trim().toUpperCase();
    return (
      value.trim().length >= 16 &&
      !normalized.includes('PLACEHOLDER') &&
      !normalized.includes('CHANGE_ME')
    );
  }
}
