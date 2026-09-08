/**
 * Mobile broker-registry contract tests.
 *
 * GET /broker/registry returns the catalog wrapper
 * `{ catalogVersion, brokers: BrokerRegistryEntry[] }`. These tests lock both
 * the compile-time mobile contract and the runtime JSON passthrough so the
 * screen never regresses to treating the wrapper itself as an array.
 */
import type { MobileApiClient } from '../api';
import { createMobileApiClient } from '../api';
import type { BrokerRegistryCatalog } from '@irexpro/types';

// ── Compile-time contract ─────────────────────────────────────────────────
type RegistryResult = Awaited<ReturnType<MobileApiClient['getBrokerRegistry']>>;
const catalogShape: RegistryResult = { catalogVersion: 'v-2025-09', brokers: [] };

const catalog: BrokerRegistryCatalog = {
  catalogVersion: 'v-2025-09',
  brokers: [
    {
      id: 'metatrader5',
      name: 'MetaTrader 5',
      description: 'MetaApi bridge',
      status: 'SUPPORTED',
      productionLiveVerification: {
        status: 'VERIFIED',
        verifiedAt: null,
        evidenceRef: 'production operation — MetaApi bridge',
      },
      connectionRoutes: ['METATRADER'],
      capabilities: ['LIVE', 'DEMO'],
      authenticationType: 'SESSION_AUTH',
      environments: ['DEMO', 'LIVE'],
      regions: [],
      adapterAvailable: true,
    },
    {
      id: 'beta-broker',
      name: 'Beta Broker',
      description: '',
      status: 'BETA',
      productionLiveVerification: {
        status: 'UNVERIFIED',
        verifiedAt: null,
        evidenceRef: null,
      },
      connectionRoutes: ['NATIVE_API'],
      capabilities: ['DEMO'],
      authenticationType: 'API_TOKEN',
      environments: ['DEMO'],
      regions: [],
      adapterAvailable: true,
    },
  ],
};

describe('createMobileApiClient().getBrokerRegistry', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves the server catalog wrapper { catalogVersion, brokers }', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        (async () =>
          ({
            ok: true,
            status: 200,
            json: async () => catalog,
          }) as unknown as Response) as typeof fetch,
      );

    const client = createMobileApiClient('https://api.example.com/api/v1');
    const result = await client.getBrokerRegistry();

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/broker/registry',
      expect.objectContaining({ headers: expect.anything() }),
    );
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual(catalog);
    expect(result.catalogVersion).toBe('v-2025-09');
    expect(result.brokers).toHaveLength(2);
    expect(result.brokers[0].productionLiveVerification?.status).toBe('VERIFIED');
    expect(result.brokers[1].productionLiveVerification?.status).toBe('UNVERIFIED');
  });

  it('the typed contract is the catalog wrapper', () => {
    expect(catalogShape.catalogVersion).toBe('v-2025-09');
    expect(catalogShape.brokers).toEqual([]);
  });
});
