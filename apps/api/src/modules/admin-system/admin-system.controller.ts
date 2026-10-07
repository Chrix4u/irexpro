import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RoleName } from '../users/entities/role.entity';
import { TwilioSmsProvider } from '../notifications/providers/twilio-sms.provider';
import { HubtelSmsProvider } from '../notifications/providers/hubtel-sms.provider';
import { ArkeselSmsProvider } from '../notifications/providers/arkesel-sms.provider';

interface ProviderReadiness {
  id: string;
  displayName: string;
  live: boolean;
  supportedCountries: string[];
}

@Controller('admin/system')
@UseGuards(RolesGuard)
@Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
export class AdminSystemController {
  constructor(
    private readonly config: ConfigService,
    private readonly twilio: TwilioSmsProvider,
    private readonly hubtel: HubtelSmsProvider,
    private readonly arkesel: ArkeselSmsProvider,
  ) {}
  @Get('readiness')
  getReadiness() {
    const mfaKey = this.config.get<string>('auth.mfaEncryptionKey') ?? '';
    const verificationPepper = this.config.get<string>('auth.verificationPepper') ?? '';
    const smtpUrl = this.config.get<string>('email.smtpUrl') ?? '';
    const emailFrom = this.config.get<string>('email.fromAddress') ?? '';
    const webBaseUrl = this.config.get<string>('app.webBaseUrl') ?? '';

    const twilioAccountSid = this.config.get<string>('sms.twilio.accountSid') ?? '';
    const twilioAuthToken = this.config.get<string>('sms.twilio.authToken') ?? '';
    const twilioApiKey = this.config.get<string>('sms.twilio.apiKey') ?? '';
    const twilioApiSecret = this.config.get<string>('sms.twilio.apiSecret') ?? '';
    const twilioFrom = this.config.get<string>('sms.twilio.fromNumber') ?? '';

    const smsProviders: ProviderReadiness[] = [this.twilio, this.hubtel, this.arkesel].map(
      (provider) => ({
        id: provider.providerId,
        displayName: provider.displayName,
        live: provider.isLive,
        supportedCountries: [...provider.supportedCountries],
      }),
    );
    const emailReady = Boolean(smtpUrl.trim() && emailFrom.trim() && webBaseUrl.trim());
    const mfaReady = this.usableSecret(mfaKey, 32) && this.usableSecret(verificationPepper, 32);
    const smsReady = smsProviders.some((provider) => provider.live);

    return {
      generatedAt: new Date().toISOString(),
      security: {
        mfaReady,
        mfaEncryptionConfigured: this.usableSecret(mfaKey, 32),
        verificationPepperConfigured: this.usableSecret(verificationPepper, 32),
      },
      email: {
        ready: emailReady,
        smtpConfigured: Boolean(smtpUrl.trim()),
        fromAddressConfigured: Boolean(emailFrom.trim()),
        webBaseUrlConfigured: Boolean(webBaseUrl.trim()),
      },
      sms: {
        ready: smsReady,
        providers: smsProviders,
        twilio: {
          ready: this.twilio.isLive,
          accountSidConfigured: Boolean(twilioAccountSid.trim()),
          accountSidFormatValid: /^AC[0-9a-f]{32}$/iu.test(twilioAccountSid.trim()),
          authTokenConfigured: Boolean(twilioAuthToken.trim()),
          authTokenUsable: this.usableSecret(twilioAuthToken, 16),
          apiKeyConfigured: Boolean(twilioApiKey.trim()),
          apiSecretConfigured: Boolean(twilioApiSecret.trim()),
          apiKeyPairUsable:
            /^SK[0-9a-f]{32}$/iu.test(twilioApiKey.trim()) &&
            this.usableSecret(twilioApiSecret, 16),
          fromNumberConfigured: Boolean(twilioFrom.trim()),
          fromNumberFormatValid: /^\+[1-9]\d{7,14}$/u.test(twilioFrom.trim()),
        },
      },
      payments: {
        paystackEnabled: this.config.get<boolean>('paystack.enabled') === true,
        stripeEnabled: this.config.get<boolean>('stripe.enabled') === true,
      },
    };
  }

  private usableSecret(value: string, minLength: number): boolean {
    const trimmed = value.trim();
    const normalized = trimmed.toUpperCase();
    return (
      trimmed.length >= minLength &&
      !normalized.includes('PLACEHOLDER') &&
      !normalized.includes('CHANGE_ME')
    );
  }
}
