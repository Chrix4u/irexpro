import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SmsProviderRegistry } from './registry/sms-provider.registry';
import { TwilioSmsProvider } from './providers/twilio-sms.provider';
import { HubtelSmsProvider } from './providers/hubtel-sms.provider';
import { ArkeselSmsProvider } from './providers/arkesel-sms.provider';

@Module({
  imports: [ConfigModule],
  providers: [SmsProviderRegistry, TwilioSmsProvider, HubtelSmsProvider, ArkeselSmsProvider],
  exports: [SmsProviderRegistry, TwilioSmsProvider, HubtelSmsProvider, ArkeselSmsProvider],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private registry: SmsProviderRegistry,
    private twilio: TwilioSmsProvider,
    private hubtelSms: HubtelSmsProvider,
    private arkesel: ArkeselSmsProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.twilio);
    this.registry.register(this.hubtelSms);
    this.registry.register(this.arkesel);
  }
}
