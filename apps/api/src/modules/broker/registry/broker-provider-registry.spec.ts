import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BrokerProviderRegistryService } from './broker-provider-registry.service';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerAccount } from '../entities/broker-account.entity';
import { BrokerCapability } from './broker-capability.enum';
import { BrokerAvailabilityStatus, BrokerConnectionRoute } from './broker-definition';

/**
 * Sprint 50 — BrokerProviderRegistryService tests.
 *
 * Directive §AB: a broker must NEVER appear as fully SUPPORTED when its
 * adapter does not exist. Directive §AU: this catalog is the single
 * server-authoritative source rendered by web/admin/mobile.
 */

const adapterWith = (brokerId: string, supported: string[]) => ({
  isSupported: jest.fn((id: string) => supported.includes(id)),
  getAdapter: jest.fn(),
  getSupportedBrokers: jest.fn().mockReturnValue([]),
  getSupportedBrokerIds: jest.fn().mockReturnValue(supported),
});

describe('BrokerProviderRegistryService', () => {
  const buildService = async (supportedAdapters: string[]) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrokerProviderRegistryService,
        {
          provide: BrokerAdapterRegistry,
          useValue: adapterWith('any', supportedAdapters),
        },
        { provide: getRepositoryToken(BrokerConnection), useValue: {} },
        { provide: getRepositoryToken(BrokerAccount), useValue: {} },
      ],
    }).compile();
    return module.get(BrokerProviderRegistryService);
  };

  describe('status honesty (Directive §AB)', () => {
    it('reports SUPPORTED only when the adapter is actually registered', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);
      const catalog = service.getCatalog();

      const mt5 = catalog.find((e) => e.id === 'metatrader5');
      expect(mt5?.status).toBe(BrokerAvailabilityStatus.SUPPORTED);
      expect(mt5?.adapterAvailable).toBe(true);
    });

    it('DOWNGRADES a SUPPORTED catalog entry to NOT_STARTED when no adapter is registered', async () => {
      // No adapters registered at all
      const service = await buildService([]);
      const catalog = service.getCatalog();

      const mt5 = catalog.find((e) => e.id === 'metatrader5');
      // Catalog says SUPPORTED but no runtime adapter → must NOT be reported SUPPORTED
      expect(mt5?.status).toBe(BrokerAvailabilityStatus.NOT_STARTED);
      expect(mt5?.adapterAvailable).toBe(false);
    });

    it('reports research-stage entries as NOT_STARTED (OANDA has no adapter by design)', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);
      const oanda = service.getCatalog().find((e) => e.id === 'oanda');
      expect(oanda?.status).toBe(BrokerAvailabilityStatus.NOT_STARTED);
      expect(oanda?.adapterAvailable).toBe(false);
      expect(service.isConnectable('oanda')).toBe(false);
    });

    it('reports partner-approval entries honestly (cTrader)', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);
      const ctrader = service.getCatalog().find((e) => e.id === 'ctrader');
      expect(ctrader?.status).toBe(BrokerAvailabilityStatus.PARTNER_APPROVAL_REQUIRED);
      expect(ctrader?.adapterAvailable).toBe(false);
    });
  });

  describe('fail-closed connectability', () => {
    it('isConnectable true only for entries with a registered adapter', async () => {
      const service = await buildService(['metatrader5']);
      expect(service.isConnectable('metatrader5')).toBe(true);
      expect(service.isConnectable('paper-broker')).toBe(false);
      expect(service.isConnectable('oanda')).toBe(false);
      expect(service.isConnectable('unknown-broker')).toBe(false);
      expect(service.isConnectable('')).toBe(false);
    });
  });

  describe('capability queries (Directive §M)', () => {
    it('resolves capabilities per broker — never guessed from name', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);

      expect(service.hasCapability('metatrader5', BrokerCapability.MARGIN_CALCULATION)).toBe(true);
      expect(service.hasCapability('metatrader5', BrokerCapability.METATRADER)).toBe(true);
      // Paper broker cannot go LIVE by design (Directive §16 isolation)
      expect(service.hasCapability('paper-broker', BrokerCapability.LIVE)).toBe(false);
      expect(service.hasCapability('paper-broker', BrokerCapability.MARGIN_CALCULATION)).toBe(true);
      expect(service.hasCapability('oanda', BrokerCapability.REST)).toBe(true);
      // Unknown broker: no capabilities
      expect(service.hasCapability('nope', BrokerCapability.REST)).toBe(false);
    });
  });

  describe('environment support (Directive §11 — explicit, never inferred)', () => {
    it('metatrader5 supports DEMO and LIVE', async () => {
      const service = await buildService(['metatrader5']);
      expect(service.supportsEnvironment('metatrader5', 'DEMO')).toBe(true);
      expect(service.supportsEnvironment('metatrader5', 'LIVE')).toBe(true);
    });

    it('paper-broker supports DEMO ONLY — LIVE isolation by design', async () => {
      const service = await buildService(['paper-broker']);
      expect(service.supportsEnvironment('paper-broker', 'DEMO')).toBe(true);
      expect(service.supportsEnvironment('paper-broker', 'LIVE')).toBe(false);
    });

    it('returns false for unknown brokers (fail closed)', async () => {
      const service = await buildService([]);
      expect(service.supportsEnvironment('unknown', 'DEMO')).toBe(false);
      expect(service.supportsEnvironment('unknown', 'LIVE')).toBe(false);
    });
  });

  describe('catalog shape', () => {
    it('returns connection routes per entry (Directive §AF — routes, not fake broker entries)', async () => {
      const service = await buildService(['metatrader5']);
      const catalog = service.getCatalog();

      // Exactly ONE MetaTrader entry — not "Pepperstone MT4" + "Pepperstone MT5" fakes
      const mtEntries = catalog.filter((e) =>
        e.connectionRoutes.includes(BrokerConnectionRoute.METATRADER),
      );
      expect(mtEntries).toHaveLength(1);

      const ctrader = catalog.find((e) => e.id === 'ctrader');
      expect(ctrader?.connectionRoutes).toEqual([BrokerConnectionRoute.CTRADER]);
    });

    it('exposes a catalog version for cache-busting and drift detection', async () => {
      const service = await buildService([]);
      expect(typeof service.catalogVersion).toBe('string');
      expect(service.catalogVersion.length).toBeGreaterThan(0);
    });

    it('getEntry returns null for unknown ids', async () => {
      const service = await buildService([]);
      expect(service.getEntry('unknown')).toBeNull();
      expect(service.getEntry('metatrader5')).not.toBeNull();
    });
  });
});
