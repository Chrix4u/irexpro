/**
 * Mock the MetaAPI SDK at the module level so the SDK never initialises its
 * internal HTTP clients, WebSocket connections, or timers when the module is
 * imported.  MetaApiClientService is already fully mocked via
 * mockMetaApiClientService(), but without this module-level mock the SDK is
 * still required/executed during the Jest worker's module load phase, which
 * can leave open handles that prevent the worker from exiting cleanly.
 */
jest.mock('metaapi.cloud-sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    metatraderAccountApi: {
      getAccount: jest.fn(),
    },
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { MetaTraderAdapter } from './metatrader.adapter';
import { MetaApiClientService } from '../services/metaapi-client.service';
import { BrokerMode } from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import { ProviderDispatchCertainty } from '../interfaces/provider-dispatch-certainty';

// ─── MetaAPI SDK mock ─────────────────────────────────────────────────────────

const mockConnection = {
  connect: jest.fn().mockResolvedValue(undefined),
  waitSynchronized: jest.fn().mockResolvedValue(undefined),
  isSynchronized: jest.fn().mockReturnValue(true),
  close: jest.fn().mockResolvedValue(undefined),
  getAccountInformation: jest.fn().mockResolvedValue({
    login: '123456',
    type: 'ACCOUNT_TRADE_MODE_DEMO',
    currency: 'USD',
    leverage: 100,
    balance: 10000.5,
    equity: 10050.25,
    margin: 200.0,
    freeMargin: 9850.25,
    marginLevel: 5025.12,
  }),
  getPositions: jest.fn().mockResolvedValue([
    {
      id: 'pos-1',
      symbol: 'EURUSD',
      type: 'POSITION_TYPE_BUY',
      volume: 0.1,
      openPrice: 1.085,
      currentPrice: 1.0865,
      stopLoss: 1.08,
      takeProfit: 1.09,
      profit: 15.0,
      time: new Date('2026-01-01T10:00:00Z'),
      commission: -0.5,
      swap: 0.0,
    },
  ]),
  getPosition: jest.fn().mockResolvedValue(null),
  getSymbols: jest.fn().mockResolvedValue(['EURUSD', 'GBPUSD', 'USDJPY']),
  // Round 7 Fix 1 — per-symbol specification source (MetatraderSymbolSpecification).
  // Unknown symbols resolve null (the "specification not provable" case).
  getSymbolSpecification: jest.fn((symbol: string) => {
    const specs: Record<string, Record<string, unknown>> = {
      EURUSD: {
        symbol: 'EURUSD',
        digits: 5,
        tickSize: 0.00001,
        minVolume: 0.01,
        maxVolume: 100,
        volumeStep: 0.01,
        contractSize: 100000,
      },
      GBPUSD: {
        symbol: 'GBPUSD',
        digits: 5,
        tickSize: 0.00001,
        minVolume: 0.01,
        maxVolume: 100,
        volumeStep: 0.01,
        contractSize: 100000,
      },
      USDJPY: {
        symbol: 'USDJPY',
        digits: 3,
        tickSize: 0.001,
        minVolume: 0.01,
        maxVolume: 50,
        volumeStep: 0.01,
        contractSize: 100000,
      },
      XAUUSD: {
        symbol: 'XAUUSD',
        digits: 2,
        tickSize: 0.01,
        minVolume: 0.01,
        maxVolume: 20,
        volumeStep: 0.01,
        contractSize: 100,
      },
    };
    return Promise.resolve(specs[symbol] ?? null);
  }),
  // Round 7 Fix 2 — working-order cancellation primitive.
  cancelOrder: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    orderId: 'pending-limit-buy-1',
    message: 'Request completed',
  }),
  subscribeToMarketData: jest.fn().mockResolvedValue(undefined),
  unsubscribeFromMarketData: jest.fn().mockResolvedValue(undefined),
  getSymbolPrice: jest.fn().mockResolvedValue({
    bid: 1.0864,
    ask: 1.0865,
    time: new Date(),
  }),
  createMarketBuyOrder: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    positionId: 'order-xyz',
    message: 'Request completed',
  }),
  createMarketSellOrder: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    positionId: 'order-abc',
    message: 'Request completed',
  }),
  // Sprint 50 PR-3 — pending-order SDK primitives (LIMIT/STOP/STOP_LIMIT)
  createLimitBuyOrder: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    orderId: 'pending-limit-buy-1',
    message: 'Request completed',
  }),
  createLimitSellOrder: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    orderId: 'pending-limit-sell-1',
    message: 'Request completed',
  }),
  createStopBuyOrder: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    orderId: 'pending-stop-buy-1',
    message: 'Request completed',
  }),
  createStopSellOrder: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    orderId: 'pending-stop-sell-1',
    message: 'Request completed',
  }),
  createStopLimitBuyOrder: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    orderId: 'pending-stop-limit-buy-1',
    message: 'Request completed',
  }),
  createStopLimitSellOrder: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    orderId: 'pending-stop-limit-sell-1',
    message: 'Request completed',
  }),
  modifyPosition: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    message: 'Request completed',
  }),
  closePosition: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    message: 'Request completed',
  }),
  closePositionPartially: jest.fn().mockResolvedValue({
    stringCode: 'TRADE_RETCODE_DONE',
    numericCode: 10009,
    message: 'Request completed',
  }),
  getDealsByTimeRange: jest.fn().mockResolvedValue([
    {
      id: 'deal-1',
      type: 'DEAL_TYPE_SELL',
      symbol: 'EURUSD',
      volume: 0.1,
      price: 1.09,
      profit: 50.0,
      time: new Date('2026-01-02T15:00:00Z'),
      commission: -0.5,
      swap: -0.1,
      entryType: 'DEAL_ENTRY_OUT',
      reason: 'DEAL_REASON_TP',
    },
  ]),
};

const mockAccount = {
  state: 'DEPLOYED',
  deploy: jest.fn(),
  waitDeployed: jest.fn(),
  getRPCConnection: jest.fn().mockReturnValue(mockConnection),
  getHistoricalCandles: jest.fn().mockResolvedValue([
    {
      time: new Date('2026-01-01'),
      open: 1.08,
      high: 1.09,
      low: 1.07,
      close: 1.085,
      tickVolume: 5000,
    },
    {
      time: new Date('2026-01-02'),
      open: 1.085,
      high: 1.095,
      low: 1.083,
      close: 1.09,
      tickVolume: 4800,
    },
  ]),
};

const mockMetaApiClientService = () => ({
  isAvailable: jest.fn().mockReturnValue(true),
  getOrCreateConnection: jest.fn().mockResolvedValue(mockConnection),
  testAccountAccess: jest
    .fn()
    .mockResolvedValue({ success: true, accountType: 'DEMO', currency: 'USD' }),
  removeConnection: jest.fn().mockResolvedValue(undefined),
  hasConnection: jest.fn().mockReturnValue(true),
  connectionPool: new Map([
    [
      'acc-uuid-123',
      {
        account: mockAccount,
        connection: mockConnection,
        connectedAt: new Date(),
        accountId: 'acc-uuid-123',
      },
    ],
  ]),
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MetaTraderAdapter', () => {
  let module: TestingModule;
  let adapter: MetaTraderAdapter;
  let metaApiClient: ReturnType<typeof mockMetaApiClientService>;

  const testCredentials = { accountId: 'acc-uuid-123' };

  beforeEach(async () => {
    jest.clearAllMocks();

    module = await Test.createTestingModule({
      providers: [
        MetaTraderAdapter,
        { provide: MetaApiClientService, useFactory: mockMetaApiClientService },
      ],
    }).compile();

    adapter = module.get<MetaTraderAdapter>(MetaTraderAdapter);
    metaApiClient = module.get(MetaApiClientService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('Adapter identity', () => {
    it('has correct brokerId', () => {
      expect(adapter.brokerId).toBe('metatrader5');
    });

    it('supports demo mode', () => {
      expect(adapter.supportsDemo).toBe(true);
    });
  });

  describe('connect()', () => {
    it('connects and returns account info', async () => {
      const result = await adapter.connect(testCredentials);

      expect(result.success).toBe(true);
      expect(result.currency).toBe('USD');
      expect(result.accountType).toBe(BrokerMode.DEMO);
      expect(metaApiClient.getOrCreateConnection).toHaveBeenCalledWith('acc-uuid-123');
    });

    it('resolves DEMO account type from MetaAPI mode string', async () => {
      const result = await adapter.connect(testCredentials);
      expect(result.accountType).toBe(BrokerMode.DEMO);
    });

    // ─── Round 7.1 (P0-1): provider-observed environment classification ────

    it('P0-1: resolves LIVE from the provider-reported account type (a real-money account is classified LIVE)', async () => {
      (mockConnection.getAccountInformation as jest.Mock).mockResolvedValueOnce({
        login: '123456',
        type: 'ACCOUNT_TRADE_MODE_LIVE',
        currency: 'USD',
        leverage: 100,
        balance: 10000.5,
        equity: 10050.25,
        margin: 200.0,
        freeMargin: 9850.25,
        marginLevel: 5025.12,
      });
      const result = await adapter.connect(testCredentials);
      expect(result.success).toBe(true);
      expect(result.accountType).toBe(BrokerMode.LIVE);
    });

    it('P0-1: classifies a CONTEST account as DEMO (competition money is NOT real money — a LIVE-declared connection pointing at one must fail closed upstream)', async () => {
      (mockConnection.getAccountInformation as jest.Mock).mockResolvedValueOnce({
        login: '123456',
        type: 'ACCOUNT_TRADE_MODE_CONTEST',
        currency: 'USD',
        leverage: 100,
        balance: 10000.5,
        equity: 10050.25,
        margin: 200.0,
        freeMargin: 9850.25,
        marginLevel: 5025.12,
      });
      const result = await adapter.connect(testCredentials);
      expect(result.success).toBe(true);
      expect(result.accountType).toBe(BrokerMode.DEMO);
    });

    it('P0-1: normalizes provider casing (a lowercase "demo" is still DEMO)', async () => {
      (mockConnection.getAccountInformation as jest.Mock).mockResolvedValueOnce({
        login: '123456',
        type: 'demo',
        currency: 'USD',
        leverage: 100,
        balance: 1,
        equity: 1,
        margin: 0,
        freeMargin: 1,
        marginLevel: 0,
      });
      const result = await adapter.connect(testCredentials);
      expect(result.accountType).toBe(BrokerMode.DEMO);
    });

    it('P0-1: a SILENT provider (no account type) echoes the requested mode — the declared-vs-observed gate is vacuous, never guessed', async () => {
      (mockConnection.getAccountInformation as jest.Mock).mockResolvedValueOnce({
        login: '123456',
        type: undefined,
        currency: 'USD',
        leverage: 100,
        balance: 1,
        equity: 1,
        margin: 0,
        freeMargin: 1,
        marginLevel: 0,
      });
      // Mode DEMO set by the service before connect.
      const result = await adapter.connect(testCredentials);
      expect(result.success).toBe(true);
      expect(result.accountType).toBe(BrokerMode.DEMO);
    });

    it('throws BrokerAdapterError on MetaAPI failure', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      (metaApiClient.getOrCreateConnection as jest.Mock).mockRejectedValueOnce(
        new Error('authentication failed'),
      );
      await expect(adapter.connect(testCredentials)).rejects.toThrow(BrokerAdapterError);
      jest.restoreAllMocks();
    });

    it('maps authentication errors to AUTHENTICATION_FAILED code', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      (metaApiClient.getOrCreateConnection as jest.Mock).mockRejectedValueOnce(
        new Error('authentication failed'),
      );
      try {
        await adapter.connect(testCredentials);
      } catch (err) {
        expect((err as BrokerAdapterError).code).toBe(BrokerErrorCode.AUTHENTICATION_FAILED);
      }
      jest.restoreAllMocks();
    });

    it('does NOT log credentials', async () => {
      const logSpy = jest.spyOn(adapter['logger'], 'log');
      await adapter.connect(testCredentials);
      const logCalls = logSpy.mock.calls.flatMap((args) => args.map(String));
      expect(logCalls.join(' ')).not.toContain('apiKey');
      expect(logCalls.join(' ')).not.toContain('apiSecret');
    });
  });

  describe('testConnection()', () => {
    it('returns success result on valid account', async () => {
      const result = await adapter.testConnection(testCredentials);
      expect(result.success).toBe(true);
      expect(result.accountType).toBe(BrokerMode.DEMO);
    });

    it('returns failure result without throwing on MetaAPI error', async () => {
      (metaApiClient.testAccountAccess as jest.Mock).mockResolvedValueOnce({
        success: false,
        error: 'Account not found',
      });
      const result = await adapter.testConnection(testCredentials);
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('Account not found');
    });
  });

  describe('isConnected()', () => {
    it('returns false before connect()', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('returns true after successful connect()', async () => {
      await adapter.connect(testCredentials);
      expect(adapter.isConnected()).toBe(true);
    });
  });

  describe('getAccountInfo()', () => {
    it('returns account info with decimal string values', async () => {
      await adapter.connect(testCredentials);
      const info = await adapter.getAccountInfo();

      expect(info.currency).toBe('USD');
      expect(info.leverage).toBe(100);
      // All monetary values must be strings, never numbers
      expect(typeof info.balance).toBe('string');
      expect(typeof info.equity).toBe('string');
      expect(typeof info.margin).toBe('string');
      expect(typeof info.freeMargin).toBe('string');
      // Values must not contain floats (e.g. 10000.5 should be "10000.50000000")
      expect(info.balance).toMatch(/^\d+\.\d{8}$/);
    });
  });

  describe('getAccountBalance()', () => {
    it('returns balance as decimal strings', async () => {
      await adapter.connect(testCredentials);
      const balance = await adapter.getAccountBalance();

      expect(typeof balance.balance).toBe('string');
      expect(typeof balance.equity).toBe('string');
      expect(balance.currency).toBe('USD');
      expect(balance.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('getOpenPositions()', () => {
    it('maps MetaAPI positions to BrokerPosition shape', async () => {
      await adapter.connect(testCredentials);
      const positions = await adapter.getOpenPositions();

      expect(positions).toHaveLength(1);
      const pos = positions[0];
      expect(pos.externalOrderId).toBe('pos-1');
      expect(pos.instrument).toBe('EURUSD');
      expect(pos.direction).toBe('BUY');
      expect(typeof pos.lotSize).toBe('string');
      expect(typeof pos.openPrice).toBe('string');
      expect(typeof pos.unrealisedPnl).toBe('string');
    });
  });

  describe('getInstrumentList() — per-symbol specifications (Round 7, fail-closed)', () => {
    beforeEach(async () => {
      await adapter.connect(testCredentials);
    });

    it('returns PROVEN per-symbol provider values (digits/minLot/maxLot/lotStep/contractSize)', async () => {
      const instruments = await adapter.getInstrumentList();
      expect(instruments).toHaveLength(3);

      const eurUsd = instruments.find((i) => i.symbol === 'EURUSD');
      expect(eurUsd).toEqual({
        symbol: 'EURUSD',
        description: 'EURUSD',
        digits: 5,
        minLot: '0.01000000',
        maxLot: '100.00000000',
        lotStep: '0.01000000',
        contractSize: '100000.00000000',
      });
      expect(mockConnection.getSymbolSpecification).toHaveBeenCalledWith('EURUSD');

      // Provider truth per symbol — NOT the old hardcoded digits=5/maxLot 100.
      const usdJpy = instruments.find((i) => i.symbol === 'USDJPY');
      expect(usdJpy?.digits).toBe(3);
      expect(usdJpy?.maxLot).toBe('50.00000000');
    });

    it('non-FX contract sizes come from the provider — NOT the fabricated 100000 FX constant', async () => {
      mockConnection.getSymbols.mockResolvedValueOnce(['EURUSD', 'XAUUSD']);
      const instruments = await adapter.getInstrumentList();

      const xau = instruments.find((i) => i.symbol === 'XAUUSD');
      expect(xau).toBeDefined();
      // Gold: 100 oz per lot per the BROKER's specification — the value the
      // RiskOrderGeometryService contractSize proof must see on LIVE.
      expect(xau?.contractSize).toBe('100.00000000');
      expect(xau?.contractSize).not.toBe('100000.00000000');
      expect(xau?.digits).toBe(2);
      expect(xau?.maxLot).toBe('20.00000000');
    });

    it('OMITS symbols whose specification is not provable (fail-closed — never FX fallback)', async () => {
      mockConnection.getSymbols.mockResolvedValueOnce(['EURUSD', 'BOGUS', 'USDJPY']);
      const instruments = await adapter.getInstrumentList();

      expect(instruments.map((i) => i.symbol)).toEqual(['EURUSD', 'USDJPY']);
      const bogus = instruments.find((i) => i.symbol === 'BOGUS');
      expect(bogus).toBeUndefined();
    });

    it('OMITS symbols whose specification lookup FAILS (other symbols still listed)', async () => {
      mockConnection.getSymbols.mockResolvedValueOnce(['BOGUS', 'EURUSD']);
      mockConnection.getSymbolSpecification.mockRejectedValueOnce(
        new Error('invalid symbol — unknown symbol'),
      );
      const instruments = await adapter.getInstrumentList();

      expect(instruments.map((i) => i.symbol)).toEqual(['EURUSD']);
    });

    it('OMITS symbols whose specification resolves with malformed/non-positive geometry', async () => {
      mockConnection.getSymbols.mockResolvedValueOnce(['BADGEO', 'EURUSD']);
      mockConnection.getSymbolSpecification.mockResolvedValueOnce({
        symbol: 'BADGEO',
        digits: 5,
        minVolume: 0,
        maxVolume: 100,
        volumeStep: 0.01,
        contractSize: 0,
      });
      const instruments = await adapter.getInstrumentList();

      expect(instruments.map((i) => i.symbol)).toEqual(['EURUSD']);
    });

    it('caches per-symbol specifications within the TTL (no repeated provider lookups)', async () => {
      await adapter.getInstrumentList();
      expect(mockConnection.getSymbolSpecification).toHaveBeenCalledTimes(3);

      mockConnection.getSymbolSpecification.mockClear();
      await adapter.getInstrumentList();
      expect(mockConnection.getSymbolSpecification).not.toHaveBeenCalled();
    });

    it('re-queries the provider after the 60s cache TTL expires', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(1_000_000);
        await adapter.getInstrumentList();
        expect(mockConnection.getSymbolSpecification).toHaveBeenCalledTimes(3);

        // Still inside the TTL — served from the cache.
        mockConnection.getSymbolSpecification.mockClear();
        nowSpy.mockReturnValue(1_000_000 + 59_999);
        await adapter.getInstrumentList();
        expect(mockConnection.getSymbolSpecification).not.toHaveBeenCalled();

        // Past the TTL — fresh provider lookups per symbol.
        nowSpy.mockReturnValue(1_000_000 + 60_001);
        await adapter.getInstrumentList();
        expect(mockConnection.getSymbolSpecification).toHaveBeenCalledTimes(3);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('throws BrokerAdapterError when getSymbols itself fails (no fabricated catalog)', async () => {
      mockConnection.getSymbols.mockRejectedValueOnce(new Error('connection lost'));
      await expect(adapter.getInstrumentList()).rejects.toMatchObject({
        code: BrokerErrorCode.CONNECTION_LOST,
      });
    });
  });

  describe('placeOrder()', () => {
    beforeEach(async () => {
      await adapter.connect(testCredentials);
    });

    it('places a BUY order and returns FILLED status', async () => {
      const result = await adapter.placeOrder({
        idempotencyKey: 'idem-key-001',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.1',
        stopLoss: '1.08000',
        takeProfit: '1.09000',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('FILLED');
      expect(result.externalOrderId).toBe('order-xyz');
    });

    it('embeds idempotencyKey in the order comment', async () => {
      await adapter.placeOrder({
        idempotencyKey: 'idem-key-abc',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.1',
        stopLoss: '1.08000',
        takeProfit: '1.09000',
      });

      expect(mockConnection.createMarketBuyOrder).toHaveBeenCalledWith(
        'EURUSD',
        0.1,
        1.08,
        1.09,
        expect.objectContaining({
          comment: 'idem-key-abc',
          clientId: 'idem-key-abc',
        }),
      );
    });

    it('places a SELL order and returns FILLED status', async () => {
      const result = await adapter.placeOrder({
        idempotencyKey: 'idem-key-002',
        instrument: 'GBPUSD',
        direction: 'SELL',
        lotSize: '0.05',
        stopLoss: '1.27000',
        takeProfit: '1.25000',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('FILLED');
      expect(mockConnection.createMarketSellOrder).toHaveBeenCalled();
    });

    it('prefers the caller-supplied clientOrderId over the idempotency key', async () => {
      await adapter.placeOrder({
        idempotencyKey: 'idem-key-abc',
        clientOrderId: 'stable-client-42',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.1',
        stopLoss: '1.08000',
        takeProfit: '1.09000',
      });

      expect(mockConnection.createMarketBuyOrder).toHaveBeenCalledWith(
        'EURUSD',
        0.1,
        1.08,
        1.09,
        expect.objectContaining({
          comment: 'idem-key-abc',
          clientId: 'stable-client-42',
        }),
      );
    });

    // ─── Sprint 50 PR-3 — normalized order-kind dispatch ──────────────────

    it('LIMIT BUY → createLimitBuyOrder with the limit price, returns PENDING', async () => {
      const result = await adapter.placeOrder({
        idempotencyKey: 'idem-l',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.1',
        stopLoss: '1.08000',
        takeProfit: '1.09000',
        orderKind: 'LIMIT',
        limitPrice: '1.08100',
      });

      expect(mockConnection.createLimitBuyOrder).toHaveBeenCalledWith(
        'EURUSD',
        0.1,
        1.081,
        1.08,
        1.09,
        expect.objectContaining({ comment: 'idem-l' }),
      );
      expect(result.success).toBe(true);
      expect(result.status).toBe('PENDING');
      expect(result.externalOrderId).toBe('pending-limit-buy-1');
      expect(result.filledAt).toBeUndefined();
    });

    it('LIMIT SELL → createLimitSellOrder', async () => {
      await adapter.placeOrder({
        idempotencyKey: 'idem-ls',
        instrument: 'EURUSD',
        direction: 'SELL',
        lotSize: '0.1',
        stopLoss: '1.09000',
        takeProfit: '1.07000',
        orderKind: 'LIMIT',
        limitPrice: '1.08900',
      });
      expect(mockConnection.createLimitSellOrder).toHaveBeenCalledWith(
        'EURUSD',
        0.1,
        1.089,
        1.09,
        1.07,
        expect.anything(),
      );
    });

    it('STOP BUY → createStopBuyOrder with the stop price, returns PENDING', async () => {
      const result = await adapter.placeOrder({
        idempotencyKey: 'idem-sb',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.1',
        stopLoss: '1.08000',
        takeProfit: '1.09000',
        orderKind: 'STOP',
        stopPrice: '1.08600',
      });
      expect(mockConnection.createStopBuyOrder).toHaveBeenCalledWith(
        'EURUSD',
        0.1,
        1.086,
        1.08,
        1.09,
        expect.anything(),
      );
      expect(result.status).toBe('PENDING');
    });

    it('STOP_LIMIT → createStopLimitBuyOrder with stop + limit prices', async () => {
      const result = await adapter.placeOrder({
        idempotencyKey: 'idem-sl',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.1',
        stopLoss: '1.08000',
        takeProfit: '1.09000',
        orderKind: 'STOP_LIMIT',
        stopPrice: '1.08600',
        limitPrice: '1.08650',
      });
      expect(mockConnection.createStopLimitBuyOrder).toHaveBeenCalledWith(
        'EURUSD',
        0.1,
        1.086,
        1.0865,
        1.08,
        1.09,
        expect.anything(),
      );
      expect(result.status).toBe('PENDING');
      expect(result.externalOrderId).toBe('pending-stop-limit-buy-1');
    });

    it('LIMIT order WITHOUT a limitPrice fails fast (INVALID_PRICE, no SDK call)', async () => {
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'idem-bad',
          instrument: 'EURUSD',
          direction: 'BUY',
          lotSize: '0.1',
          stopLoss: '1.08000',
          takeProfit: '1.09000',
          orderKind: 'LIMIT',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PRICE' });
      expect(mockConnection.createLimitBuyOrder).not.toHaveBeenCalled();
    });

    it('STOP_LIMIT with a non-positive limitPrice fails fast (never downgraded)', async () => {
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'idem-bad2',
          instrument: 'EURUSD',
          direction: 'BUY',
          lotSize: '0.1',
          stopLoss: '1.08000',
          takeProfit: '1.09000',
          orderKind: 'STOP_LIMIT',
          stopPrice: '1.08600',
          limitPrice: '-1',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PRICE' });
      expect(mockConnection.createStopLimitBuyOrder).not.toHaveBeenCalled();
    });

    it('unknown order kind fails fast (INVALID_ORDER_TYPE)', async () => {
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'idem-kind',
          instrument: 'EURUSD',
          direction: 'BUY',
          lotSize: '0.1',
          stopLoss: '1.08000',
          takeProfit: '1.09000',
          orderKind: 'TRAILING' as never,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ORDER_TYPE' });
    });

    it('defaults to MARKET when orderKind is omitted (backward compatible)', async () => {
      const result = await adapter.placeOrder({
        idempotencyKey: 'idem-default',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.1',
        stopLoss: '1.08000',
        takeProfit: '1.09000',
      });
      expect(mockConnection.createMarketBuyOrder).toHaveBeenCalled();
      expect(result.status).toBe('FILLED');
    });

    it('returns FAILED status when broker rejects the order', async () => {
      (mockConnection.createMarketBuyOrder as jest.Mock).mockResolvedValueOnce({
        stringCode: 'TRADE_RETCODE_REJECT',
        numericCode: 10004,
        message: 'Trade request rejected',
      });

      const result = await adapter.placeOrder({
        idempotencyKey: 'idem-key-003',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.1',
        stopLoss: '1.08000',
        takeProfit: '1.09000',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('REJECTED');
    });
  });

  describe('modifyOrder()', () => {
    it('modifies stop loss and take profit', async () => {
      await adapter.connect(testCredentials);
      const result = await adapter.modifyOrder('pos-1', {
        newStopLoss: '1.07500',
        newTakeProfit: '1.09500',
      });

      expect(result.success).toBe(true);
      expect(mockConnection.modifyPosition).toHaveBeenCalledWith('pos-1', 1.075, 1.095);
    });
  });

  describe('closeOrder()', () => {
    beforeEach(async () => await adapter.connect(testCredentials));

    it('closes full position', async () => {
      const result = await adapter.closeOrder('pos-1');
      expect(result.success).toBe(true);
      expect(mockConnection.closePosition).toHaveBeenCalledWith('pos-1');
    });

    it('closes partial position when lotSize is provided', async () => {
      const result = await adapter.closeOrder('pos-1', '0.05');
      expect(result.success).toBe(true);
      expect(mockConnection.closePositionPartially).toHaveBeenCalledWith('pos-1', 0.05);
    });
  });

  describe('cancelOrder (additive concrete surface — Round 7, Fix 2)', () => {
    beforeEach(async () => await adapter.connect(testCredentials));

    it('cancels a working order via the MetaApi RPC cancelOrder command', async () => {
      const result = await adapter.cancelOrder('pending-limit-buy-1');
      expect(mockConnection.cancelOrder).toHaveBeenCalledWith('pending-limit-buy-1');
      expect(result).toMatchObject({
        success: true,
        externalOrderId: 'pending-limit-buy-1',
        status: 'FILLED',
        brokerMessage: 'Request completed',
      });
      expect(result.rawResponse).toMatchObject({ stringCode: 'TRADE_RETCODE_DONE' });
    });

    it('maps a terminal retcode rejection (10004) to an honest REJECTED result', async () => {
      mockConnection.cancelOrder.mockResolvedValueOnce({
        stringCode: 'TRADE_RETCODE_REJECT',
        numericCode: 10004,
        message: 'Trade request rejected',
      });
      const result = await adapter.cancelOrder('555');
      expect(result.success).toBe(false);
      expect(result.status).toBe('REJECTED');
      expect(result.brokerMessage).toBe('Trade request rejected');
    });

    it('maps a non-DONE terminal answer to FAILED (never success)', async () => {
      mockConnection.cancelOrder.mockResolvedValueOnce({
        stringCode: 'TRADE_RETCODE_INVALID',
        numericCode: 10013,
        message: 'Invalid request',
      });
      const result = await adapter.cancelOrder('556');
      expect(result).toMatchObject({ success: false, status: 'FAILED' });
    });

    it('fails closed with NOT_CONNECTED (DEFINITELY_NOT_SENT) before connect()', async () => {
      await adapter.disconnect();
      const err = (await adapter.cancelOrder('555').catch((e) => e)) as BrokerAdapterError;
      expect(err).toBeInstanceOf(BrokerAdapterError);
      expect(err.code).toBe(BrokerErrorCode.NOT_CONNECTED);
      expect(err.dispatchCertainty).toBe(ProviderDispatchCertainty.DEFINITELY_NOT_SENT);
      expect(mockConnection.cancelOrder).not.toHaveBeenCalled();
    });

    it('maps a timeout to CONNECTION_TIMEOUT with MAY_HAVE_REACHED_PROVIDER (reconcile, never resend)', async () => {
      mockConnection.cancelOrder.mockRejectedValueOnce(new Error('request timed out'));
      const err = (await adapter.cancelOrder('555').catch((e) => e)) as BrokerAdapterError;
      expect(err).toBeInstanceOf(BrokerAdapterError);
      expect(err.code).toBe(BrokerErrorCode.CONNECTION_TIMEOUT);
      expect(err.isRetryable).toBe(true);
      expect(err.dispatchCertainty).toBe(ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER);
    });

    it('maps a gateway 401 to AUTHENTICATION_FAILED with DEFINITELY_NOT_SENT (safe to retry)', async () => {
      mockConnection.cancelOrder.mockRejectedValueOnce(
        Object.assign(new Error('authentication failed'), { status: 401 }),
      );
      const err = (await adapter.cancelOrder('555').catch((e) => e)) as BrokerAdapterError;
      expect(err.code).toBe(BrokerErrorCode.AUTHENTICATION_FAILED);
      expect(err.dispatchCertainty).toBe(ProviderDispatchCertainty.DEFINITELY_NOT_SENT);
    });

    it('maps a terminal-answered unknown ticket to POSITION_NOT_FOUND (SENT_RESPONSE_RECEIVED)', async () => {
      mockConnection.cancelOrder.mockRejectedValueOnce(new Error('Order not found'));
      const err = (await adapter.cancelOrder('555').catch((e) => e)) as BrokerAdapterError;
      expect(err.code).toBe(BrokerErrorCode.POSITION_NOT_FOUND);
      expect(err.dispatchCertainty).toBe(ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED);
    });
  });

  describe('getOHLCV()', () => {
    it('returns candles with decimal string values', async () => {
      await adapter.connect(testCredentials);
      const candles = await adapter.getOHLCV('EURUSD', 'H1', 2);

      expect(candles).toHaveLength(2);
      expect(typeof candles[0].open).toBe('string');
      expect(typeof candles[0].close).toBe('string');
      expect(candles[0].timestamp).toBeInstanceOf(Date);
    });

    it('passes an explicit historical cursor to MetaAPI', async () => {
      await adapter.connect(testCredentials);
      const before = new Date('2025-01-01T00:00:00.000Z');

      await adapter.getOHLCV('EURUSD', 'H1', 2, before);

      expect(mockAccount.getHistoricalCandles).toHaveBeenLastCalledWith('EURUSD', '1h', before, 2);
    });
  });

  describe('getClosedTrades()', () => {
    it('returns only DEAL_ENTRY_OUT deals mapped to BrokerClosedTrade', async () => {
      await adapter.connect(testCredentials);
      const trades = await adapter.getClosedTrades(new Date('2026-01-01'), new Date('2026-01-03'));

      expect(trades).toHaveLength(1);
      expect(trades[0].instrument).toBe('EURUSD');
      expect(trades[0].closeReason).toBe('TP');
      expect(typeof trades[0].realisedPnl).toBe('string');
    });
  });

  describe('Error mapping (mapError)', () => {
    const cases: [string, BrokerErrorCode, boolean][] = [
      ['authentication failed', BrokerErrorCode.AUTHENTICATION_FAILED, false],
      ['request timed out', BrokerErrorCode.CONNECTION_TIMEOUT, true],
      ['rate limit exceeded — too many requests', BrokerErrorCode.RATE_LIMITED, true],
      ['market closed — trade disabled', BrokerErrorCode.MARKET_CLOSED, false],
      ['insufficient margin — not enough money', BrokerErrorCode.INSUFFICIENT_MARGIN, false],
      ['position not found', BrokerErrorCode.POSITION_NOT_FOUND, false],
      ['internal server error', BrokerErrorCode.BROKER_SERVER_ERROR, true],
      ['some completely random message', BrokerErrorCode.UNKNOWN, false],
    ];

    it.each(cases)('maps "%s" to %s (retryable=%s)', (message, expectedCode, expectedRetryable) => {
      const err = adapter.mapError(new Error(message));
      expect(err.code).toBe(expectedCode);
      expect(err.isRetryable).toBe(expectedRetryable);
    });

    it('returns a pre-classified BrokerAdapterError instance unchanged', () => {
      const existing = new BrokerAdapterError(
        BrokerErrorCode.UNKNOWN,
        'test',
        undefined,
        false,
        ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
      );
      const result = adapter.mapError(existing);
      expect(result).toBe(existing);
    });

    it('fills in write certainty for an unclassified BrokerAdapterError (round 4, finding 6)', () => {
      // The identity of the instance is not preserved — the certainty fill
      // constructs the classified error — but code/message/retryability are.
      const existing = new BrokerAdapterError(BrokerErrorCode.UNKNOWN, 'test');
      const result = adapter.mapError(existing);
      expect(result).not.toBe(existing);
      expect(result.code).toBe(BrokerErrorCode.UNKNOWN);
      expect(result.message).toBe('test');
      expect(result.isRetryable).toBe(false);
      expect(result.dispatchCertainty).toBe(ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER);
    });
  });
});
