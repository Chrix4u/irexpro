import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BrokerAdapterRegistry } from './broker-adapter.registry';
import { IBrokerAdapter } from '../interfaces/broker-adapter.interface';

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
});

describe('BrokerAdapterRegistry', () => {
  let module: TestingModule;
  let registry: BrokerAdapterRegistry;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [BrokerAdapterRegistry],
    }).compile();

    registry = module.get<BrokerAdapterRegistry>(BrokerAdapterRegistry);
  });

  afterEach(async () => {
    await module.close();
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
});
