import type { ConfigService } from '@nestjs/config';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from './broker-provider-registry.service';

const workerToken = 'w'.repeat(32);

function registry(pool: Record<string, unknown>, enabled = true): BrokerProviderRegistryService {
  const adapters = {
    isSupported: jest.fn((id: string) => id === 'direct-mt5'),
  } as unknown as BrokerAdapterRegistry;
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'broker.hostedMt5Enabled') return enabled;
      if (key === 'broker.hostedMt5WorkerToken') return workerToken;
      return fallback;
    }),
  } as unknown as ConfigService;
  const presence = { getPoolReadiness: jest.fn().mockReturnValue(pool) } as any;
  return new BrokerProviderRegistryService(adapters, config, presence);
}

describe('Hosted MT5 worker-backed registry readiness', () => {
  it('fails closed when rollout is enabled but no fresh iRexPro worker is online', () => {
    const service = registry({
      ready: false,
      reason: 'NO_FRESH_WORKER',
      freshWorkers: 0,
      readyWorkers: 0,
      availableWorkers: 0,
      totalSpareSessions: 0,
    });

    expect(service.getEntry('direct-mt5')?.hostedMt5Readiness).toEqual({
      ready: false,
      code: 'HOSTED_MT5_NO_WORKER',
      message: expect.stringMatching(/online execution worker/i),
    });
  });

  it('fails closed with a capacity-specific result when all ready workers are full', () => {
    const service = registry({
      ready: false,
      reason: 'NO_CAPACITY',
      freshWorkers: 1,
      readyWorkers: 1,
      availableWorkers: 0,
      totalSpareSessions: 0,
    });

    expect(service.getEntry('direct-mt5')?.hostedMt5Readiness).toEqual({
      ready: false,
      code: 'HOSTED_MT5_NO_CAPACITY',
      message: expect.stringMatching(/capacity/i),
    });
  });

  it('advertises Hosted MT5 only when a fresh ready worker has spare capacity', () => {
    const service = registry({
      ready: true,
      reason: 'READY',
      freshWorkers: 2,
      readyWorkers: 2,
      availableWorkers: 1,
      totalSpareSessions: 3,
    });

    expect(service.getEntry('direct-mt5')?.hostedMt5Readiness).toEqual({
      ready: true,
      code: 'READY',
      message: null,
    });
  });
});
