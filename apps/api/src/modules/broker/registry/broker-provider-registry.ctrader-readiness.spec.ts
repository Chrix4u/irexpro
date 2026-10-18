import type { ConfigService } from '@nestjs/config';
import type { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from './broker-provider-registry.service';

function service(configValues: Record<string, string | undefined>) {
  const adapters = {
    isSupported: jest.fn((id: string) =>
      ['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader'].includes(id),
    ),
  } as unknown as BrokerAdapterRegistry;
  const config = {
    get: jest.fn((key: string, fallback?: string) => configValues[key] ?? fallback),
  } as unknown as ConfigService;
  return new BrokerProviderRegistryService(adapters, config);
}

describe('cTrader provider application readiness', () => {
  it('fails closed with a truthful provider-approval state while Spotware app is pending', () => {
    const registry = service({
      'broker.ctraderClientId': 'client-id',
      'broker.ctraderClientSecret': 'client-secret',
      'broker.ctraderAppApprovalStatus': 'pending',
      'broker.ctraderRedirectUris':
        'https://irexpro.lightworldtech.com/onboarding/broker/callback',
    });

    expect(registry.getEntry('ctrader')?.connectionReadiness).toEqual({
      ready: false,
      code: 'PROVIDER_APP_APPROVAL_REQUIRED',
      message:
        'cTrader Open API access is awaiting Spotware application approval. Connection will unlock after the app is marked active.',
    });
  });

  it('continues to callback readiness only after the provider app is active', () => {
    const registry = service({
      'broker.ctraderClientId': 'client-id',
      'broker.ctraderClientSecret': 'client-secret',
      'broker.ctraderAppApprovalStatus': 'active',
      'broker.ctraderRedirectUris':
        'https://irexpro.lightworldtech.com/onboarding/broker/callback',
    });

    expect(registry.getEntry('ctrader')?.connectionReadiness).toMatchObject({
      ready: true,
      code: 'READY',
      channels: {
        web: { ready: true, code: 'READY', message: null },
      },
    });
  });
});
