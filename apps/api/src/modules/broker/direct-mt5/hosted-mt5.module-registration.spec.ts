import { MODULE_METADATA } from '@nestjs/common/constants';
import { BrokerModule } from '../broker.module';
import { HostedMt5Controller, HostedMt5WorkerController } from './hosted-mt5.controller';
import { HostedMt5Service } from './hosted-mt5.service';

describe('Hosted MT5 BrokerModule registration', () => {
  it('registers the customer and worker controllers plus hosted service', () => {
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, BrokerModule) as unknown[];
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BrokerModule) as unknown[];

    expect(controllers).toEqual(
      expect.arrayContaining([HostedMt5Controller, HostedMt5WorkerController]),
    );
    expect(providers).toEqual(expect.arrayContaining([HostedMt5Service]));
  });
});
