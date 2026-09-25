import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { BrokerAdapterRegistry } from './broker-adapter.registry';
import { BrokerMode, IBrokerAdapter } from '../interfaces/broker-adapter.interface';
import { BrokerModule } from '../broker.module';
import { MetaTraderAdapter } from './metatrader.adapter';
import { PaperBrokerAdapter } from './paper-broker.adapter';
import { CTraderAdapter } from './ctrader/ctrader.adapter';
import { CTraderClientService } from './ctrader/ctrader-client.service';
import { OandaAdapter } from './oanda/oanda.adapter';
import { MetaApiClientService } from '../services/metaapi-client.service';
import { PaperBrokerStateStore } from '../services/paper-broker-state.store';

const makeAdapter = (brokerId: string, brokerName: string): IBrokerAdapter => ({
  brokerId,
  brokerName,
  supportsDemo: true,
  setMode: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  testConnection: jest.fn(),
  isConnected: jest.fn().mockReturnValue(false),
  getAccountInfo: jest.fn(),
  getAccountBalance: jest.fn(),
  getOpenPositions: jest.fn(),
  getPositionById: jest.fn(),
  getInstrumentList: jest.fn(),
  getCurrentPrice: jest.fn(),
  getOHLCV: jest.fn(),
  placeOrder: jest.fn(),
  modifyOrder: jest.fn(),
  closeOrder: jest.fn(),
  closeAllOrders: jest.fn(),
  getClosedTrades: jest.fn(),
  // Sprint 50 PR-4: provider order-state read surface
  listOrders: jest.fn(),
  getOrderById: jest.fn(),
  // Sprint 32 Gate 2: required margin capability
  getRequiredMargin: jest.fn().mockResolvedValue(null),
  // Round 6 §7: the declared order capability contract
  getOrderCapabilities: jest.fn().mockReturnValue({
    brokerId,
    supportedOrderKinds: ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'],
    requirements: {
      MARKET: { limitPriceRequired: false, stopPriceRequired: false },
      LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
      STOP: { limitPriceRequired: false, stopPriceRequired: true },
      STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
    },
    marketSlTpAttachedAtPlacement: true,
  }),
});

describe('BrokerAdapterRegistry', () => {
  let registry: BrokerAdapterRegistry;

  beforeEach(() => {
    registry = new BrokerAdapterRegistry();
  });

  it('registers and retrieves an adapter by brokerId', () => {
    const adapter = makeAdapter('metatrader5', 'MetaTrader 5');
    registry.register(adapter);

    const retrieved = registry.getAdapter('metatrader5');
    expect(retrieved).toBe(adapter);
  });

  it('throws NotFoundException for unknown brokerId', () => {
    expect(() => registry.getAdapter('unknown_broker')).toThrow(NotFoundException);
  });

  it('isSupported() returns true for registered brokers', () => {
    registry.register(makeAdapter('metatrader5', 'MT5'));
    expect(registry.isSupported('metatrader5')).toBe(true);
    expect(registry.isSupported('oanda')).toBe(false);
  });

  it('getSupportedBrokers() returns summary of all registered adapters', () => {
    registry.register(makeAdapter('metatrader5', 'MetaTrader 5'));
    registry.register(makeAdapter('oanda', 'OANDA'));

    const brokers = registry.getSupportedBrokers();
    expect(brokers).toHaveLength(2);
    expect(brokers.map((b) => b.brokerId)).toContain('metatrader5');
    expect(brokers.map((b) => b.brokerId)).toContain('oanda');
  });

  it('registering the same brokerId twice overwrites the adapter', () => {
    const adapterV1 = makeAdapter('metatrader5', 'MT5 v1');
    const adapterV2 = makeAdapter('metatrader5', 'MT5 v2');

    registry.register(adapterV1);
    registry.register(adapterV2);

    const retrieved = registry.getAdapter('metatrader5');
    expect(retrieved.brokerName).toBe('MT5 v2');
  });

  it('falls back to a plain no-op when the alias equals the canonical brokerId', () => {
    const root = makeAdapter('ctrader', 'cTrader');
    registry.register(root, () => makeAdapter('ctrader', 'cTrader session'));
    // Same-id alias is a no-op registration (compatibility path).
    registry.registerBrokerAlias('ctrader', root);

    expect(registry.isSupported('ctrader')).toBe(true);
    expect(registry.getAdapter('ctrader')).toBe(root);
    expect(registry.getSupportedBrokerIds()).toEqual(['ctrader']);
  });

  // ─── #291 / Sprint 56 correction round 3: connection-scoped sessions ────────

  it('fails closed for account-scoped operations when no isolation factory is registered', () => {
    registry.register(makeAdapter('custom', 'Custom metadata adapter'));

    expect(() => registry.createEphemeralAdapter('custom')).toThrow(ConflictException);
    expect(() => registry.getAdapterForConnection('connection-a', 'custom')).toThrow(
      ConflictException,
    );
    expect(registry.getActiveConnectionSessionCount()).toBe(0);
  });

  it('rejects an isolation factory that returns the registered root singleton', () => {
    const root = makeAdapter('metatrader5', 'MT5 root');
    registry.register(root, () => root);

    expect(() => registry.getAdapterForConnection('connection-a', 'metatrader5')).toThrow(
      ConflictException,
    );
    expect(registry.getActiveConnectionSessionCount()).toBe(0);
  });

  it('rejects an isolation factory that returns the wrong provider adapter', () => {
    registry.register(makeAdapter('oanda', 'OANDA root'), () => makeAdapter('metatrader5', 'MT5'));

    expect(() => registry.createEphemeralAdapter('oanda')).toThrow(ConflictException);
    expect(registry.getActiveConnectionSessionCount()).toBe(0);
  });

  it('rejects a factory that reuses one mutable adapter across independent connections', () => {
    const shared = makeAdapter('metatrader5', 'MT5 incorrectly shared');
    registry.register(makeAdapter('metatrader5', 'MT5 root'), () => shared);

    const first = registry.getAdapterForConnection('connection-a', 'metatrader5');
    expect(first).toBe(shared);
    expect(() => registry.getAdapterForConnection('connection-b', 'metatrader5')).toThrow(
      ConflictException,
    );
    expect(registry.getActiveConnectionSessionCount()).toBe(1);
  });

  it('isolates mutable adapters by persisted broker connection id', () => {
    const root = makeAdapter('metatrader5', 'MT5 root');
    let sequence = 0;
    registry.register(root, () => makeAdapter('metatrader5', `MT5 session ${++sequence}`));

    const a1 = registry.getAdapterForConnection('connection-a', 'metatrader5');
    const a2 = registry.getAdapterForConnection('connection-a', 'metatrader5');
    const b = registry.getAdapterForConnection('connection-b', 'metatrader5');

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(root);
    expect(b).not.toBe(root);
    expect(registry.getActiveConnectionSessionCount()).toBe(2);
  });

  it('keeps two accounts and mixed DEMO/LIVE modes isolated under adversarial async interleaving', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sequence = 0;

    const factory = (): IBrokerAdapter => {
      const adapter = makeAdapter('metatrader5', `MT5 concurrent session ${++sequence}`);
      let mode = BrokerMode.DEMO;
      let accountId = '';

      adapter.setMode = jest.fn((nextMode: BrokerMode) => {
        mode = nextMode;
      });
      adapter.connect = jest.fn(async (credentials) => {
        accountId = credentials.accountId;
        await gate;
        return {
          success: true,
          accountId,
          accountType: mode,
          currency: 'USD',
          serverTime: new Date(),
        };
      });
      adapter.getAccountInfo = jest.fn(async () => ({
        accountId,
        currency: 'USD',
        leverage: 100,
        balance: '1000.00',
        equity: '1000.00',
        margin: '0.00',
        freeMargin: '1000.00',
        marginLevel: '0.00',
      }));
      return adapter;
    };

    registry.register(makeAdapter('metatrader5', 'MT5 root'), factory);
    const userA = registry.getAdapterForConnection('user-a-connection', 'metatrader5');
    const userB = registry.getAdapterForConnection('user-b-connection', 'metatrader5');

    userA.setMode(BrokerMode.DEMO);
    userB.setMode(BrokerMode.LIVE);
    const pendingA = userA.connect({ accountId: 'account-a' });
    const pendingB = userB.connect({ accountId: 'account-b' });

    // Both connect calls are now suspended after mutating their own session.
    // Releasing them together reproduces the race a singleton adapter cannot survive.
    release();
    const [connectedA, connectedB] = await Promise.all([pendingA, pendingB]);
    const [accountA, accountB] = await Promise.all([
      userA.getAccountInfo(),
      userB.getAccountInfo(),
    ]);

    expect(connectedA).toMatchObject({
      accountId: 'account-a',
      accountType: BrokerMode.DEMO,
    });
    expect(connectedB).toMatchObject({
      accountId: 'account-b',
      accountType: BrokerMode.LIVE,
    });
    expect(accountA.accountId).toBe('account-a');
    expect(accountB.accountId).toBe('account-b');
    expect(userA).not.toBe(userB);
  });

  it('creates uncached ephemeral adapters for pre-persistence credential tests', () => {
    const root = makeAdapter('oanda', 'OANDA root');
    let sequence = 0;
    registry.register(root, () => makeAdapter('oanda', `OANDA test ${++sequence}`));

    const first = registry.createEphemeralAdapter('oanda');
    const second = registry.createEphemeralAdapter('oanda');

    expect(first).not.toBe(second);
    expect(first).not.toBe(root);
    expect(registry.getActiveConnectionSessionCount()).toBe(0);
  });

  it('releases a connection session so reconnect gets a fresh mutable context', () => {
    const root = makeAdapter('metatrader5', 'MT5 root');
    registry.register(root, () => makeAdapter('metatrader5', 'MT5 session'));

    const before = registry.getAdapterForConnection('connection-a', 'metatrader5');
    registry.releaseAdapterForConnection('connection-a');
    const after = registry.getAdapterForConnection('connection-a', 'metatrader5');

    expect(after).not.toBe(before);
    expect(registry.getActiveConnectionSessionCount()).toBe(1);
  });

  it('releaseAdapterForConnection is idempotent', () => {
    registry.register(makeAdapter('metatrader5', 'MT5'), () =>
      makeAdapter('metatrader5', 'MT5 session'),
    );
    registry.getAdapterForConnection('connection-a', 'metatrader5');
    registry.releaseAdapterForConnection('connection-a');
    registry.releaseAdapterForConnection('connection-a');

    expect(registry.getActiveConnectionSessionCount()).toBe(0);
  });

  it('fails closed if one persisted connection id is rebound to another provider', () => {
    registry.register(makeAdapter('metatrader5', 'MT5'), () =>
      makeAdapter('metatrader5', 'MT5 session'),
    );
    registry.register(makeAdapter('oanda', 'OANDA'), () => makeAdapter('oanda', 'OANDA session'));

    registry.getAdapterForConnection('connection-a', 'metatrader5');

    expect(() => registry.getAdapterForConnection('connection-a', 'oanda')).toThrow(
      ConflictException,
    );
  });

  it('resolves aliases through the canonical factory without storing shared adapter instances', () => {
    const root = makeAdapter('ctrader', 'cTrader root');
    let sequence = 0;
    registry.register(root, () => makeAdapter('ctrader', `cTrader session ${++sequence}`));
    // Compatibility with Sprint 56: alias registration may pass the root adapter.
    registry.registerBrokerAlias('pepperstone-ctrader', root);
    registry.registerBrokerAlias('icmarkets-ctrader', root);

    const pepperstone = registry.getAdapterForConnection(
      'pepperstone-connection',
      'pepperstone-ctrader',
    );
    const icMarkets = registry.getAdapterForConnection('icmarkets-connection', 'icmarkets-ctrader');

    expect(pepperstone).not.toBe(icMarkets);
    expect(pepperstone).not.toBe(root);
    expect(icMarkets).not.toBe(root);
    expect(registry.getAdapter('pepperstone-ctrader')).toBe(root);
    expect(registry.getAdapter('icmarkets-ctrader')).toBe(root);
    expect(registry.getAdapter('pepperstone-ctrader').brokerId).toBe('ctrader');
    expect(registry.isSupported('pepperstone-ctrader')).toBe(true);
    expect(registry.isSupported('icmarkets-ctrader')).toBe(true);
    expect(registry.getSupportedBrokerIds()).toEqual(
      expect.arrayContaining(['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader']),
    );
    // Aliases stay catalog identities: one provider summary, never per-alias
    // adapter duplicates.
    expect(registry.getSupportedBrokers()).toHaveLength(1);
  });

  it('passes the requested alias broker id into the canonical isolation factory', () => {
    const root = makeAdapter('ctrader', 'cTrader root');
    const requestedBrokerIds: string[] = [];
    registry.register(root, (requestedBrokerId) => {
      requestedBrokerIds.push(requestedBrokerId);
      return makeAdapter('ctrader', `cTrader session for ${requestedBrokerId}`);
    });
    registry.registerBrokerAlias('pepperstone-ctrader', root);
    registry.registerBrokerAlias('icmarkets-ctrader', root);

    registry.createEphemeralAdapter('pepperstone-ctrader');
    registry.getAdapterForConnection('icmarkets-connection', 'icmarkets-ctrader');

    expect(requestedBrokerIds).toEqual(['pepperstone-ctrader', 'icmarkets-ctrader']);
  });

  it('keeps aliases fail-closed when the canonical provider has no isolation factory', () => {
    const root = makeAdapter('ctrader', 'cTrader metadata only');
    registry.register(root);
    registry.registerBrokerAlias('pepperstone-ctrader', 'ctrader');

    expect(() => registry.createEphemeralAdapter('pepperstone-ctrader')).toThrow(ConflictException);
    expect(() => registry.getAdapterForConnection('connection-a', 'pepperstone-ctrader')).toThrow(
      ConflictException,
    );
    expect(registry.getActiveConnectionSessionCount()).toBe(0);
  });

  it('refuses alias rebinding and adapter-identity mismatch', () => {
    const ctrader = makeAdapter('ctrader', 'cTrader');
    const oanda = makeAdapter('oanda', 'OANDA');
    registry.register(ctrader, () => makeAdapter('ctrader', 'cTrader session'));
    registry.register(oanda, () => makeAdapter('oanda', 'OANDA session'));
    registry.registerBrokerAlias('pepperstone-ctrader', ctrader);

    expect(() => registry.registerBrokerAlias('pepperstone-ctrader', oanda)).toThrow(
      ConflictException,
    );
    expect(() =>
      registry.registerBrokerAlias(
        'icmarkets-ctrader',
        makeAdapter('ctrader', 'unregistered cTrader object'),
      ),
    ).toThrow(ConflictException);
  });

  it('refuses to register an alias before its canonical provider is registered', () => {
    expect(() => registry.registerBrokerAlias('pepperstone-ctrader', 'ctrader')).toThrow(
      NotFoundException,
    );
  });

  it('a later primary registration replaces the alias mapping (operator-controlled init only)', () => {
    // #291 register semantics: registering a PRIMARY adapter whose id is
    // currently an alias key replaces the mapping (module-init code path,
    // operator-controlled — never user input). Alias-over-primary stays a
    // Conflict (previous test).
    const root = makeAdapter('ctrader', 'cTrader');
    registry.register(root, () => makeAdapter('ctrader', 'cTrader session'));
    registry.registerBrokerAlias('pepperstone-ctrader', root);

    const dedicated = makeAdapter('pepperstone-ctrader', 'Pepperstone dedicated');
    registry.register(dedicated, () => makeAdapter('pepperstone-ctrader', 'Pepperstone session'));

    expect(registry.getAdapter('pepperstone-ctrader')).toBe(dedicated);
    // The alias MAPPING is gone: the id resolves to the primary registration,
    // and a supported-id listing contains it exactly once.
    expect(registry.isSupported('pepperstone-ctrader')).toBe(true);
    expect(
      registry.getSupportedBrokerIds().filter((id) => id === 'pepperstone-ctrader'),
    ).toHaveLength(1);
  });
});

// ─── REAL wiring: the production BrokerModule factory contract (cTrader) ─────

describe('BrokerModule — connection-scoped cTrader adapter factory wiring', () => {
  let registry: BrokerAdapterRegistry;
  let ctraderClientStub: CTraderClientService;

  beforeEach(() => {
    // The REAL BrokerModule class with its REAL onModuleInit wiring — exactly
    // the registration the production Nest graph performs (direct construction
    // avoids dragging the DB/queue infrastructure into a unit spec; the
    // registration logic itself is the unit under test).
    registry = new BrokerAdapterRegistry();
    ctraderClientStub = { isAvailable: () => false } as unknown as CTraderClientService;
    const configService = new ConfigService();
    const metaApiClient = {} as unknown as MetaApiClientService;
    const brokerModule = new BrokerModule(
      registry,
      new MetaTraderAdapter(metaApiClient),
      new PaperBrokerAdapter(),
      new OandaAdapter(configService),
      new CTraderAdapter(ctraderClientStub),
      metaApiClient,
      configService,
      ctraderClientStub,
      {
        load: jest.fn().mockResolvedValue(null),
        loadBootstrap: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
      } as unknown as PaperBrokerStateStore,
    );
    brokerModule.onModuleInit();
  });

  it('passes the persisted connection id into the PAPER adapter factory', async () => {
    const paper = registry.getAdapterForConnection('paper-connection-1', 'paper-broker');
    expect(paper).toBeInstanceOf(PaperBrokerAdapter);
    await expect(
      paper.connect({ accountId: 'paper-account-001' }),
    ).resolves.toMatchObject({ success: true, accountId: 'paper-account-001' });
  });

  it('registers every canonical provider WITH an isolation factory (no metadata-only gaps)', () => {
    for (const brokerId of ['metatrader5', 'paper-broker', 'oanda', 'ctrader']) {
      expect(() => registry.createEphemeralAdapter(brokerId)).not.toThrow();
    }
  });

  it('cTrader family aliases share the canonical factory, NEVER a mutable adapter object', () => {
    const root = registry.getAdapter('ctrader');
    expect(root).toBeInstanceOf(CTraderAdapter);

    const direct = registry.getAdapterForConnection('conn-direct', 'ctrader');
    const pepperstone = registry.getAdapterForConnection('conn-pepperstone', 'pepperstone-ctrader');
    const icmarkets = registry.getAdapterForConnection('conn-icmarkets', 'icmarkets-ctrader');

    // Architect finding 1: three distinct mutable adapter contexts — one per
    // persisted BrokerConnection.id, none of them the root/metadata instance.
    expect(direct).toBeInstanceOf(CTraderAdapter);
    expect(pepperstone).toBeInstanceOf(CTraderAdapter);
    expect(icmarkets).toBeInstanceOf(CTraderAdapter);
    expect(direct).not.toBe(pepperstone);
    expect(pepperstone).not.toBe(icmarkets);
    expect(direct).not.toBe(root);
    expect(pepperstone).not.toBe(root);
    expect(icmarkets).not.toBe(root);
    // Canonical provider id preserved on every isolated instance.
    expect(direct.brokerId).toBe('ctrader');
    expect(pepperstone.brokerId).toBe('ctrader');
    expect(icmarkets.brokerId).toBe('ctrader');
    expect(registry.getActiveConnectionSessionCount()).toBe(3);
  });

  it('isolated cTrader adapters wrap the SHARED provider client (infrastructure stays shared)', () => {
    // Finding 1: one mutable adapter context per connection, but the
    // lower-level provider infrastructure (client/env connections) is shared
    // where safe — every isolated adapter must be built on the SAME client
    // instance the platform owns.
    const a = registry.getAdapterForConnection('conn-shared-a', 'ctrader') as CTraderAdapter;
    const b = registry.getAdapterForConnection('conn-shared-b', 'ctrader') as CTraderAdapter;
    const clientOf = (adapter: CTraderAdapter): unknown =>
      (adapter as unknown as { client: CTraderClientService }).client;
    expect(clientOf(a)).toBe(ctraderClientStub);
    expect(clientOf(b)).toBe(ctraderClientStub);
  });

  it('preserves the requested alias brokerId on the isolated adapter (broker-specific verification)', () => {
    // Architect finding 2: the factory receives the REQUESTED id — the alias
    // identity survives into the isolated context for broker-specific
    // verification, while brokerId stays canonical.
    const pepperstone = registry.getAdapterForConnection(
      'conn-pepperstone-2',
      'pepperstone-ctrader',
    ) as CTraderAdapter;
    const icmarkets = registry.getAdapterForConnection(
      'conn-icmarkets-2',
      'icmarkets-ctrader',
    ) as CTraderAdapter;
    const generic = registry.getAdapterForConnection('conn-generic', 'ctrader') as CTraderAdapter;
    const ephemeral = registry.createEphemeralAdapter('icmarkets-ctrader') as CTraderAdapter;

    expect(pepperstone.requestedBrokerId).toBe('pepperstone-ctrader');
    expect(icmarkets.requestedBrokerId).toBe('icmarkets-ctrader');
    expect(generic.requestedBrokerId).toBe('ctrader');
    expect(ephemeral.requestedBrokerId).toBe('icmarkets-ctrader');
    // Ephemeral credential-test adapters are uncached.
    expect(registry.getActiveConnectionSessionCount()).toBe(3);
  });

  it('the metadata root cTrader adapter stays the documented default identity (agnostic)', () => {
    const root = registry.getAdapter('ctrader') as CTraderAdapter;
    expect(root.requestedBrokerId).toBe('ctrader');
  });

  it('releases connection sessions through the module-wired registry', () => {
    registry.getAdapterForConnection('conn-release', 'ctrader');
    expect(registry.getActiveConnectionSessionCount()).toBe(1);
    registry.releaseAdapterForConnection('conn-release');
    expect(registry.getActiveConnectionSessionCount()).toBe(0);
    // A fresh context after release is a NEW adapter object.
    const fresh = registry.getAdapterForConnection('conn-release', 'ctrader');
    expect(fresh).toBeInstanceOf(CTraderAdapter);
    expect(fresh.brokerId).toBe('ctrader');
  });

  it('all other production consumers keep working through the metadata surface', () => {
    // getAdapter remains a metadata/root lookup (brokerName for connection
    // records, catalog summaries) — unchanged behavior for metadata reads.
    expect(registry.getAdapter('metatrader5')).toBeInstanceOf(MetaTraderAdapter);
    expect(registry.getAdapter('paper-broker')).toBeInstanceOf(PaperBrokerAdapter);
    expect(registry.getAdapter('oanda')).toBeInstanceOf(OandaAdapter);
    expect(
      registry
        .getSupportedBrokers()
        .map((b) => b.brokerId)
        .sort(),
    ).toEqual(['ctrader', 'metatrader5', 'oanda', 'paper-broker']);
  });
});