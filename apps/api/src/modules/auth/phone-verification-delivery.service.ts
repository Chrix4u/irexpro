import { Injectable, Logger } from '@nestjs/common';
import { SmsMessageType } from '../notifications/interfaces/sms-provider.interface';
import { SmsProviderRegistry } from '../notifications/registry/sms-provider.registry';

@Injectable()
export class PhoneVerificationDeliveryService {
  private readonly logger = new Logger(PhoneVerificationDeliveryService.name);

  constructor(private readonly smsRegistry: SmsProviderRegistry) {}

  isConfigured(countryCode = 'ZZ'): boolean {
    try {
      return this.smsRegistry.selectProvider(countryCode).isLive === true;
    } catch {
      return false;
    }
  }

  async sendVerificationCode(
    to: string,
    code: string,
    countryCode = 'ZZ',
  ): Promise<boolean> {
    if (!/^\+[1-9]\d{7,14}$/u.test(to) || !/^\d{6}$/u.test(code)) {
      return false;
    }

    try {
      const provider = this.smsRegistry.selectProvider(countryCode);
      const result = await provider.sendSms({
        to,
        messageType: SmsMessageType.OTP,
        templateData: { code },
        countryCode,
      });
      if (!result.success) {
        this.logger.warn(
          `Phone verification SMS was not accepted (provider=${provider.providerId}, code=${result.errorCode ?? 'UNKNOWN'})`,
        );
      }
      return result.success;
    } catch {
      this.logger.warn('Phone verification SMS delivery is unavailable');
      return false;
    }
  }
}
