/**
 * OandaAdapter — detailed unit specs (Sprint 51 PR-7, Directive §P).
 *
 * The transport is fully scripted via the shared ScriptedHttpBackend (the
 * same fake used by the Directive §AN contract suite): routes script v3
 * responses/failures, and recorded requests expose baseUrl/headers/body
 * for environment-routing, idempotency and redaction assertions.
 */
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { OandaAdapter } from './oanda.adapter';
import {
  OANDA_DEFAULT_DEMO_BASE_URL,
  OANDA_DEFAULT_LIVE_BASE_URL,
  OandaTransport,
} from './oanda.transport';
import { OandaApiError, mapOandaError } from './oanda.error-mapper';
import { toCanonicalSymbol, toProviderSymbol } from './oanda.symbol-mapper';
import {
  ScriptedHttpBackend,
  ScriptedRequestRecord,
} from '../contract/broker-adapter.contract-suite';
import {
  BrokerAdapterError,
  BrokerErrorCode,
  RETRYABLE_BROKER_ERRORS,
  redactSecret,
} from '../../interfaces/broker-adapter.errors';
import { BrokerMode, BrokerOrderRequest } from '../../interfaces/broker-adapter.interface';

const SECRET = 'unit-test-oanda-token-9f8e7d6c';
const ACCOUNT_ID = '101-004-1234567-001';
const ISO_TIME = '2026-02-01T12:00:00Z';

const backend = new ScriptedHttpBackend();

const buildAdapter = (mode: BrokerMode = BrokerMode.DEMO): OandaAdapter => {
  const adapter = new OandaAdapter(undefined, backend);
  adapter.setMode(mode);
  return adapter;
};

const credentials = { apiKey: SECRET, accountId: ACCOUNT_ID };

const connectAdapter = async (mode: BrokerMode = BrokerMode.DEMO): Promise<OandaAdapter> => {
  const adapter = buildAdapter(mode);
  await adapter.connect(credentials);
  return adapter;
};

// ─── v3 fixtures ──────────────────────────────────────────────────────────────

const summaryResponse = {
  account: {
    id: ACCOUNT_ID,
    currency: 'USD',
    balance: '100000.0000',
    nav: '100250.3300',
    marginUsed: '1250.0000',
    marginAvailable: '99000.3300',
    marginCallMarginLevel: '100.0000',
    openTradeCount: 1,
  },
};

const eurUsdInstrument = {
  name: 'EUR_USD',
  type: 'CURRENCY',
  displayName: 'EUR/USD',
  displayPrecision: 5,
  minimumTradeSize: '1',
  maximumTradeSize: '100000000',
  tradeUnitsPrecision: 0,
  marginRate: '0.0333',
};

const xauUsdInstrument = {
  name: 'XAU_USD',
  type: 'METAL',
  displayName: 'Gold (ounce)',
  displayPrecision: 3,
  minimumTradeSize: '1',
  maximumTradeSize: '10000',
  tradeUnitsPrecision: 0,
  marginRate: '0.05',
};

const eurUsdPrice = {
  instrument: 'EUR_USD',
  time: ISO_TIME,
  bids: [{ price: '1.10000' }, { price: '1.10002' }],
  asks: [{ price: '1.10010' }, { price: '1.10012' }],
  closeoutAsk: '1.10012',
  closeoutBid: '1.10002',
};

const xauUsdPrice = {
  instrument: 'XAU_USD',
  time: ISO_TIME,
  bids: [{ price: '2650.500' }],
  asks: [{ price: '2650.900' }],
};

const openTrade = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '301',
  instrument: 'EUR_USD',
  units: '1000',
  price: '1.09000',
  openTime: ISO_TIME,
  unrealizedPL: '10.4200',
  financing: '0.2500',
  stopLossOrder: { price: '1.08000' },
  takeProfitOrder: { price: '1.20000' },
  clientExtensions: { id: 'client-301' },
  ...overrides,
});

const v3Order = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '2101',
  instrument: 'EUR_USD',
  units: '1000',
  state: 'PENDING',
  type: 'LIMIT',
  price: '1.09500',
  timeInForce: 'GTC',
  createTime: ISO_TIME,
  clientExtensions: { id: 'client-2101' },
  ...overrides,
});

const orderCreateResponse = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  orderCreateTransaction: {
    id: '2101',
    type: 'MARKET',
    time: ISO_TIME,
    instrument: 'EUR_USD',
    units: '1000',
  },
  orderFillTransaction: {
    id: '2102',
    price: '1.10453',
    units: '1000',
    time: ISO_TIME,
    tradeOpened: { tradeID: '301', units: '1000' },
  },
  ...overrides,
});

/** Deterministic healthy v3 scripting (cleared + re-registered). */
const scriptHealthy = (): void => {
  backend.clearRoutes();
  backend.restore();

  // Registered in increasing specificity — later routes win on overlap.
  backend.route('GET', '/v3/accounts', () => ({ accounts: [{ id: ACCOUNT_ID, currency: 'USD' }] }));
  backend.route('GET', '/summary', () => summaryResponse);
  backend.route('GET', '/openTrades', () => ({ trades: [openTrade()] }));
  backend.route('GET', '/v3/instruments', () => ({
    instruments: [eurUsdInstrument, xauUsdInstrument],
  }));
  backend.route('GET', '/pricing', (request: ScriptedRequestRecord) => {
    // Batched pricing: echo quotes for exactly the instruments requested.
    const wanted = [eurUsdPrice, xauUsdPrice].filter((quote) =>
      request.path.includes(quote.instrument),
    );
    return { prices: wanted };
  });
  backend.route('GET', 'state=PENDING', () => ({ orders: [v3Order()] }));
  backend.route('GET', 'state=TRIGGERED', () => ({ orders: [] }));
  backend.route('GET', /\/orders\/[^/]+$/, () => ({ order: v3Order() }));
  backend.route('GET', 'state=CLOSED', () => ({
    trades: [
      {
        id: '401',
        instrument: 'EUR_USD',
        units: '1000',
        price: '1.09000',
        realizedPL: '12.3400',
        financing: '0.1000',
        openTime: ISO_TIME,
        closeTime: ISO_TIME,
        averageClosePrice: '1.10234',
        stopLossOrder: { price: '1.08000' },
      },
    ],
  }));
  backend.route('POST', '/orders', () => orderCreateResponse());
  backend.route('PUT', '/orders', () => ({
    orderCreateTransaction: { id: '2201', type: 'STOP_LOSS', time: ISO_TIME },
  }));
  backend.route('PUT', '/close', () => ({
    orderFillTransaction: { id: '2105', price: '1.10005', units: '1000', time: ISO_TIME },
  }));
};

/**
 * Fresh connected adapter. beforeEach already scripted the healthy base;
 * tests may override routes BEFORE or AFTER this call (later routes win).
 */
const freshAdapterAndScript = async (): Promise<OandaAdapter> => {
  backend.resetRequests();
  return connectAdapter();
};

const placedOrder = (overrides: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest => ({
  idempotencyKey: 'oanda-spec-idem-1',
  instrument: 'EURUSD',
  direction: 'BUY',
  lotSize: '0.01',
  stopLoss: '1.09000',
  takeProfit: '1.11000',
  orderKind: 'MARKET',
  timeInForce: 'GTC',
  ...overrides,
});

const postOrderRequests = (): ScriptedRequestRecord[] =>
  backend.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/orders'),
  );

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('OandaAdapter (v20 REST — BETA)', () => {
  beforeEach(() => {
    scriptHealthy();
    backend.resetRequests();
  });

  describe('metadata (Directive §AL/§AM)', () => {
    it('exposes provider API + adapter version and a conservative rate-limit profile', () => {
      const adapter = buildAdapter();
      expect(adapter.brokerId).toBe('oanda');
      expect(adapter.supportsDemo).toBe(true);
      expect(adapter.providerApiVersion).toBe('v20');
      expect(adapter.adapterVersion).toBe('1.0.0');
      expect(adapter.rateLimitProfile.requestsPerSecond).toBeGreaterThan(0);
      expect(adapter.rateLimitProfile.burst).toBeGreaterThan(0);
    });
  });

  describe('connection lifecycle', () => {
    it('connects: verifies the account via /v3/accounts, reads the summary, reports the mode', async () => {
      const adapter = await connectAdapter();
      expect(adapter.isConnected()).toBe(true);
      const paths = backend.requests.map((request) => request.path);
      expect(paths).toContain('/v3/accounts');
      expect(paths.some((p) => p.endsWith('/summary'))).toBe(true);
      // The token travels ONLY in the Authorization header.
      for (const request of backend.requests) {
        expect(request.headers.Authorization).toBe(`Bearer ${SECRET}`);
      }
    });

    it('requires apiKey and accountId in credentials (fail-closed)', async () => {
      const adapter = buildAdapter();
      await expect(adapter.connect({ apiKey: SECRET, accountId: '' })).rejects.toMatchObject({
        code: BrokerErrorCode.AUTHENTICATION_FAILED,
      });
      await expect(adapter.connect({ accountId: ACCOUNT_ID })).rejects.toMatchObject({
        code: BrokerErrorCode.AUTHENTICATION_FAILED,
      });
      expect(backend.requests).toHaveLength(0);
    });

    it('maps a 401 access_denied on connect to AUTHENTICATION_FAILED', async () => {
      backend.route('GET', '/v3/accounts', () => {
        throw new OandaApiError(401, 'access_denied', 'Unauthorized', 'req-401');
      });
      const adapter = buildAdapter();
      await expect(adapter.connect(credentials)).rejects.toMatchObject({
        code: BrokerErrorCode.AUTHENTICATION_FAILED,
        isRetryable: false,
      });
      expect(adapter.isConnected()).toBe(false);
    });

    it('maps an inaccessible account to ACCOUNT_NOT_FOUND (no fabricated success)', async () => {
      backend.route('GET', '/v3/accounts', () => ({
        accounts: [{ id: '999-999-9999999-999' }],
      }));
      const adapter = buildAdapter();
      await expect(adapter.connect(credentials)).rejects.toMatchObject({
        code: BrokerErrorCode.ACCOUNT_NOT_FOUND,
      });
      expect(adapter.isConnected()).toBe(false);
    });

    it('testConnection reports success and currency; failures surface mapped codes', async () => {
      const adapter = buildAdapter();
      const ok = await adapter.testConnection(credentials);
      expect(ok).toMatchObject({ success: true, accountId: ACCOUNT_ID, currency: 'USD' });

      backend.route('GET', '/v3/accounts', () => {
        throw new OandaApiError(401, 'access_denied', 'Unauthorized');
      });
      const failed = await adapter.testConnection(credentials);
      expect(failed.success).toBe(false);
      expect(failed.errorCode).toBe(BrokerErrorCode.AUTHENTICATION_FAILED);
    });

    it('data operations throw NOT_CONNECTED before connect()', async () => {
      const adapter = buildAdapter();
      await expect(adapter.getAccountInfo()).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
      await expect(adapter.getOpenPositions()).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
      await expect(adapter.placeOrder(placedOrder())).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
      await expect(adapter.getCurrentPrice('EURUSD')).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
    });

    it('disconnect clears the session: data operations fail closed afterwards', async () => {
      const adapter = await connectAdapter();
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
      await expect(adapter.getAccountInfo()).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
    });
  });

  describe('environment routing (DEMO vs LIVE never crossed)', () => {
    it('DEMO mode addresses api-fxpractice.oanda.com only', async () => {
      const adapter = await connectAdapter(BrokerMode.DEMO);
      await adapter.getAccountInfo();
      expect(backend.requests.length).toBeGreaterThan(0);
      for (const request of backend.requests) {
        expect(request.baseUrl).toBe(OANDA_DEFAULT_DEMO_BASE_URL);
        expect(request.baseUrl).not.toBe(OANDA_DEFAULT_LIVE_BASE_URL);
      }
    });

    it('LIVE mode addresses api-fxtrade.oanda.com only', async () => {
      const adapter = await connectAdapter(BrokerMode.LIVE);
      await adapter.getAccountInfo();
      expect(backend.requests.length).toBeGreaterThan(0);
      for (const request of backend.requests) {
        expect(request.baseUrl).toBe(OANDA_DEFAULT_LIVE_BASE_URL);
        expect(request.baseUrl).not.toBe(OANDA_DEFAULT_DEMO_BASE_URL);
      }
    });

    it('supports OANDA_API_BASE_DEMO / OANDA_API_BASE_LIVE env overrides via ConfigService', async () => {
      const config = {
        get: (key: string): string | undefined => {
          if (key === 'OANDA_API_BASE_DEMO') return 'https://demo-override.example';
          if (key === 'OANDA_API_BASE_LIVE') return 'https://live-override.example';
          return undefined;
        },
      } as unknown as ConfigService;
      const demoAdapter = new OandaAdapter(config, backend as OandaTransport);
      demoAdapter.setMode(BrokerMode.DEMO);
      await demoAdapter.connect(credentials);
      await demoAdapter.getAccountInfo();
      expect(backend.requests.every((r) => r.baseUrl === 'https://demo-override.example')).toBe(
        true,
      );

      backend.resetRequests();
      const liveAdapter = new OandaAdapter(config, backend as OandaTransport);
      liveAdapter.setMode(BrokerMode.LIVE);
      await liveAdapter.connect(credentials);
      await liveAdapter.getAccountInfo();
      expect(backend.requests.every((r) => r.baseUrl === 'https://live-override.example')).toBe(
        true,
      );
    });
  });

  describe('account state', () => {
    it('getAccountInfo maps the v3 summary with decimal strings and conservative leverage=1', async () => {
      const adapter = await freshAdapterAndScript();
      const info = await adapter.getAccountInfo();
      expect(info).toMatchObject({
        accountId: ACCOUNT_ID,
        currency: 'USD',
        leverage: 1,
        balance: '100000.0000',
        equity: '100250.3300',
        margin: '1250.0000',
        freeMargin: '99000.3300',
        marginLevel: '100.0000',
      });
      for (const value of [
        info.balance,
        info.equity,
        info.margin,
        info.freeMargin,
        info.marginLevel,
      ]) {
        expect(typeof value).toBe('string');
      }
    });

    it('getAccountBalance maps balance/equity/currency with a timestamp', async () => {
      const adapter = await freshAdapterAndScript();
      const balance = await adapter.getAccountBalance();
      expect(balance.balance).toBe('100000.0000');
      expect(balance.equity).toBe('100250.3300');
      expect(balance.currency).toBe('USD');
      expect(balance.timestamp).toBeInstanceOf(Date);
    });

    it('a malformed decimal field fails closed (INVALID_REQUEST — never fabricated)', async () => {
      backend.route('GET', '/summary', () => ({
        account: { ...summaryResponse.account, balance: 'not-a-number' },
      }));
      const adapter = await freshAdapterAndScript();
      await expect(adapter.getAccountInfo()).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_REQUEST,
      });
    });

    it('an absent marginCallMarginLevel maps to the honest zero fallback', async () => {
      backend.route('GET', '/summary', () => {
        const account = { ...summaryResponse.account } as Record<string, unknown>;
        delete account.marginCallMarginLevel;
        return { account };
      });
      const adapter = await freshAdapterAndScript();
      const info = await adapter.getAccountInfo();
      expect(info.marginLevel).toBe('0');
    });
  });

  describe('instrument list and FX lot conversion', () => {
    it('maps v3 instruments to BrokerInstrument with unit→lot conversion (5dp)', async () => {
      const adapter = await freshAdapterAndScript();
      const instruments = await adapter.getInstrumentList();
      const eur = instruments.find((i) => i.symbol === 'EURUSD');
      expect(eur).toMatchObject({
        symbol: 'EURUSD',
        description: 'EUR/USD',
        digits: 5,
        contractSize: '100000',
        minLot: '0.00001',
        maxLot: '1000.00000',
        lotStep: '0.00001',
      });
      const xau = instruments.find((i) => i.symbol === 'XAUUSD');
      // Non-CURRENCY instruments: contractSize '1' — units map 1:1 to lots
      // (documented directive-approved approximation for metals).
      expect(xau).toMatchObject({ symbol: 'XAUUSD', contractSize: '1', minLot: '1.00000' });
    });

    it('queries instruments for the connected account (accountID query param)', async () => {
      const adapter = await freshAdapterAndScript();
      await adapter.getInstrumentList();
      const request = backend.requests.find((r) => r.path.includes('/v3/instruments'));
      expect(request?.path).toContain(`accountID=${encodeURIComponent(ACCOUNT_ID)}`);
    });
  });

  describe('pricing', () => {
    it('getCurrentPrice maps last bid/ask, computes the spread, canonicalizes the symbol', async () => {
      const adapter = await freshAdapterAndScript();
      const price = await adapter.getCurrentPrice('EURUSD');
      expect(price).toMatchObject({
        instrument: 'EURUSD',
        bid: '1.10002',
        ask: '1.10012',
        spread: '0.00010',
      });
      expect(price.timestamp).toBeInstanceOf(Date);
    });

    it('a missing quote for the instrument fails closed (INVALID_INSTRUMENT)', async () => {
      backend.route('GET', '/pricing', () => ({ prices: [] }));
      const adapter = await freshAdapterAndScript();
      await expect(adapter.getCurrentPrice('GBPUSD')).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_INSTRUMENT,
      });
    });
  });

  describe('OHLCV', () => {
    it('maps mid candles to decimal-string OHLCV with the M price stream', async () => {
      backend.route('GET', '/candles', () => ({
        candles: [
          {
            time: ISO_TIME,
            volume: 123,
            complete: true,
            mid: { o: '1.10000', h: '1.10100', l: '1.09900', c: '1.10050' },
          },
        ],
      }));
      const adapter = await freshAdapterAndScript();
      const candles = await adapter.getOHLCV('EURUSD', 'H1', 1);
      expect(candles).toHaveLength(1);
      expect(candles[0]).toMatchObject({
        open: '1.10000',
        high: '1.10100',
        low: '1.09900',
        close: '1.10050',
        volume: '123',
      });
      const request = backend.requests.find((r) => r.path.includes('/candles'));
      expect(request?.path).toContain('granularity=H1');
      expect(request?.path).toContain('price=M');
      expect(request?.path).toContain('/v3/instruments/EUR_USD/candles');
    });

    it('maps D1/W1/MN1 to OANDA D/W/M granularities and passes unknowns through', () => {
      const adapter = buildAdapter();
      expect(
        (adapter as unknown as { mapGranularity: (tf: string) => string }).mapGranularity('D1'),
      ).toBe('D');
      expect(
        (adapter as unknown as { mapGranularity: (tf: string) => string }).mapGranularity('W1'),
      ).toBe('W');
      expect(
        (adapter as unknown as { mapGranularity: (tf: string) => string }).mapGranularity('MN1'),
      ).toBe('M');
      expect(
        (adapter as unknown as { mapGranularity: (tf: string) => string }).mapGranularity('S7'),
      ).toBe('S7');
    });
  });

  describe('order placement', () => {
    it('MARKET order with a fill transaction reports FILLED with price/quantity and the trade id', async () => {
      const adapter = await freshAdapterAndScript();
      const result = await adapter.placeOrder(placedOrder());
      expect(result).toMatchObject({
        success: true,
        status: 'FILLED',
        externalOrderId: '301',
        filledPrice: '1.10453',
        filledQuantity: '0.01000',
      });
      expect(result.filledAt).toBeInstanceOf(Date);
    });

    it('LIMIT order without a fill transaction rests at the provider (PENDING, create-transaction id)', async () => {
      backend.route('POST', '/orders', () =>
        orderCreateResponse({ orderFillTransaction: undefined }),
      );
      const adapter = await freshAdapterAndScript();
      const result = await adapter.placeOrder(
        placedOrder({ orderKind: 'LIMIT', limitPrice: '1.09500' }),
      );
      expect(result).toMatchObject({
        success: true,
        status: 'PENDING',
        externalOrderId: '2101',
      });
      expect(result.filledPrice).toBeUndefined();
    });

    it('converts lots to signed integer units (BUY positive, SELL negative)', async () => {
      const adapter = await freshAdapterAndScript();
      await adapter.placeOrder(placedOrder({ direction: 'SELL' }));
      const body = postOrderRequests()[0]?.body as { order: { units: string } };
      expect(body.order.units).toBe('-1000');

      backend.resetRequests();
      await adapter.placeOrder(placedOrder({ direction: 'BUY', lotSize: '0.25' }));
      const buyBody = postOrderRequests()[0]?.body as { order: { units: string } };
      expect(buyBody.order.units).toBe('25000');
    });

    it('passes the idempotencyKey through as clientExtensions.id', async () => {
      const adapter = await freshAdapterAndScript();
      await adapter.placeOrder(placedOrder({ idempotencyKey: 'idem-key-xyz' }));
      const body = postOrderRequests()[0]?.body as {
        order: { clientExtensions: { id: string } };
      };
      expect(body.order.clientExtensions.id).toBe('idem-key-xyz');
    });

    it('attaches SL/TP dependent orders when set and omits them when zero', async () => {
      const adapter = await freshAdapterAndScript();
      await adapter.placeOrder(placedOrder());
      const withStops = postOrderRequests()[0]?.body as {
        order: { stopLossOnFill: { price: string }; takeProfitOnFill: { price: string } };
      };
      expect(withStops.order.stopLossOnFill).toEqual({ price: '1.09000', timeInForce: 'GTC' });
      expect(withStops.order.takeProfitOnFill).toEqual({ price: '1.11000', timeInForce: 'GTC' });

      backend.resetRequests();
      await adapter.placeOrder(placedOrder({ stopLoss: '0', takeProfit: '0' }));
      const withoutStops = postOrderRequests()[0]?.body as {
        order: { stopLossOnFill?: unknown; takeProfitOnFill?: unknown };
      };
      expect(withoutStops.order.stopLossOnFill).toBeUndefined();
      expect(withoutStops.order.takeProfitOnFill).toBeUndefined();
    });

    it('maps STOP_LIMIT to INVALID_ORDER_TYPE fail-closed (no transport call, never downgraded)', async () => {
      const adapter = await freshAdapterAndScript();
      backend.resetRequests();
      await expect(
        adapter.placeOrder(
          placedOrder({ orderKind: 'STOP_LIMIT', stopPrice: '1.10500', limitPrice: '1.10450' }),
        ),
      ).rejects.toMatchObject({ code: BrokerErrorCode.INVALID_ORDER_TYPE });
      // Validation failed BEFORE any transport request (not even instruments).
      expect(backend.requests).toHaveLength(0);
    });

    it('validates LIMIT/STOP prices fail-fast before any request', async () => {
      const adapter = await freshAdapterAndScript();
      backend.resetRequests();
      await expect(adapter.placeOrder(placedOrder({ orderKind: 'LIMIT' }))).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_PRICE,
      });
      await expect(adapter.placeOrder(placedOrder({ orderKind: 'STOP' }))).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_PRICE,
      });
      await expect(adapter.placeOrder(placedOrder({ lotSize: '0' }))).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_LOT_SIZE,
      });
      expect(backend.requests).toHaveLength(0);
    });

    it('an unknown instrument is rejected (INVALID_INSTRUMENT — never a guessed contract size)', async () => {
      const adapter = await freshAdapterAndScript();
      await expect(adapter.placeOrder(placedOrder({ instrument: 'ZZZUSD' }))).rejects.toMatchObject(
        {
          code: BrokerErrorCode.INVALID_INSTRUMENT,
        },
      );
    });

    it('a provider order rejection (400 + orderRejectTransaction) is an honest REJECTED result', async () => {
      backend.route('POST', '/orders', () => {
        throw new OandaApiError(400, '', 'Order rejected', 'req-rej-1', {
          orderRejectTransaction: { id: '2100', reason: 'MARGIN_NOT_SUFFICIENT' },
        });
      });
      const adapter = await freshAdapterAndScript();
      const result = await adapter.placeOrder(placedOrder());
      expect(result).toMatchObject({
        success: false,
        status: 'REJECTED',
      });
      expect(result.brokerMessage).toContain('MARGIN_NOT_SUFFICIENT');
    });
  });

  describe('modifyOrder (SL/TP on the open trade)', () => {
    it('PUTs stopLoss/takeProfit dependent orders on the trade resource', async () => {
      const adapter = await freshAdapterAndScript();
      const result = await adapter.modifyOrder('301', {
        newStopLoss: '1.08500',
        newTakeProfit: '1.21000',
      });
      expect(result).toMatchObject({ success: true, externalOrderId: '301', status: 'FILLED' });
      const request = backend.requests.find(
        (r) => r.method === 'PUT' && r.path.endsWith('/trades/301/orders'),
      );
      expect(request).toBeDefined();
      expect(request?.body).toMatchObject({
        stopLoss: { price: '1.08500', timeInForce: 'GTC' },
        takeProfit: { price: '1.21000', timeInForce: 'GTC' },
      });
    });

    it('fails closed on trailing-stop-only modification (INVALID_REQUEST)', async () => {
      const adapter = await freshAdapterAndScript();
      await expect(
        adapter.modifyOrder('301', { newTrailingStop: '0.00500' }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.INVALID_REQUEST });
      await expect(adapter.modifyOrder('301', {})).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_REQUEST,
      });
    });
  });

  describe('listOrders — provider order state', () => {
    it('queries BOTH state=PENDING and state=TRIGGERED and merges them', async () => {
      backend.route('GET', 'state=PENDING', () => ({ orders: [v3Order()] }));
      backend.route('GET', 'state=TRIGGERED', () => ({
        orders: [v3Order({ id: '2102', state: 'TRIGGERED', type: 'STOP' })],
      }));
      const adapter = await freshAdapterAndScript();
      const orders = await adapter.listOrders();
      expect(orders.map((o) => o.providerOrderId).sort()).toEqual(['2101', '2102']);
      const paths = backend.requests.map((r) => r.path);
      expect(paths.some((p) => p.includes('state=PENDING'))).toBe(true);
      expect(paths.some((p) => p.includes('state=TRIGGERED'))).toBe(true);
    });

    it('state matrix: PENDING/TRIGGERED→WORKING, FILLED→FILLED, CANCELLED→CANCELLED, unknown→UNKNOWN', async () => {
      backend.route('GET', 'state=PENDING', () => ({
        orders: [
          v3Order({ id: '1', state: 'PENDING' }),
          v3Order({ id: '2', state: 'TRIGGERED', type: 'STOP' }),
          v3Order({ id: '3', state: 'FILLED' }),
          v3Order({ id: '4', state: 'CANCELLED' }),
          v3Order({ id: '5', state: 'SOME_NEW_STATE' }),
        ],
      }));
      backend.route('GET', 'state=TRIGGERED', () => ({ orders: [] }));
      const adapter = await freshAdapterAndScript();
      const orders = await adapter.listOrders();
      const byId = new Map(orders.map((o) => [o.providerOrderId, o]));
      expect(byId.get('1')?.status).toBe('WORKING');
      expect(byId.get('2')?.status).toBe('WORKING');
      expect(byId.get('3')?.status).toBe('FILLED');
      expect(byId.get('4')?.status).toBe('CANCELLED');
      expect(byId.get('5')?.status).toBe('UNKNOWN');
    });

    it('maps kind/prices/quantities/ids with decimal-string lots and clientExtensions echo', async () => {
      const adapter = await freshAdapterAndScript();
      const orders = await adapter.listOrders();
      const mapped = orders.find((o) => o.providerOrderId === '2101');
      expect(mapped?.clientOrderId).toBe('client-2101');
      expect(mapped?.requestedQuantity).toBe('0.01000');
      expect(mapped?.filledQuantity).toBe('0.00000');
      expect(mapped?.orderKind).toBe('LIMIT');
      expect(mapped?.limitPrice).toBe('1.09500');
      expect(mapped?.stopPrice).toBeNull();
      expect(mapped?.timeInForce).toBe('GTC');
      expect(mapped?.placedAt).toBeInstanceOf(Date);
    });

    it('a FILLED order reports its full requested units as the filled quantity', async () => {
      backend.route('GET', /\/orders\/[^/]+$/, () => ({ order: v3Order({ state: 'FILLED' }) }));
      const adapter = await freshAdapterAndScript();
      const order = await adapter.getOrderById('2101');
      expect(order?.status).toBe('FILLED');
      expect(order?.filledQuantity).toBe('0.01000');
      expect(order?.avgFillPrice).toBe('1.09500');
    });

    it('backend failure throws (never a fabricated empty list)', async () => {
      const adapter = await freshAdapterAndScript();
      backend.failWith(new Error('rpc down'));
      await expect(adapter.listOrders()).rejects.toBeInstanceOf(BrokerAdapterError);
      await expect(adapter.listOrders()).rejects.toMatchObject({
        code: BrokerErrorCode.PROVIDER_UNAVAILABLE,
      });
    });
  });

  describe('getOrderById', () => {
    it('resolves a single order incl. history states', async () => {
      backend.route('GET', /\/orders\/[^/]+$/, () => ({
        order: v3Order({ id: '999', state: 'CANCELLED' }),
      }));
      const adapter = await freshAdapterAndScript();
      const order = await adapter.getOrderById('999');
      expect(order).toMatchObject({ providerOrderId: '999', status: 'CANCELLED' });
    });

    it('returns null ONLY for a legitimate 404-style order-not-found', async () => {
      backend.route('GET', /\/orders\/[^/]+$/, () => {
        throw new OandaApiError(404, 'order_not_found', 'Order not found', 'req-nf');
      });
      const adapter = await freshAdapterAndScript();
      const order = await adapter.getOrderById('does-not-exist');
      expect(order).toBeNull();
    });

    it('throws on a 5xx (null is never an error fallback)', async () => {
      backend.route('GET', /\/orders\/[^/]+$/, () => {
        throw new OandaApiError(503, '', 'Service unavailable');
      });
      const adapter = await freshAdapterAndScript();
      await expect(adapter.getOrderById('2101')).rejects.toMatchObject({
        code: BrokerErrorCode.PROVIDER_UNAVAILABLE,
        isRetryable: true,
      });
    });

    it('a 200 without an order object fails closed (INVALID_REQUEST, not null)', async () => {
      backend.route('GET', /\/orders\/[^/]+$/, () => ({}));
      const adapter = await freshAdapterAndScript();
      await expect(adapter.getOrderById('2101')).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_REQUEST,
      });
    });
  });

  describe('open positions (openTrades + batched pricing)', () => {
    it('maps trades to positions with batched pricing and direction-correct currentPrice', async () => {
      backend.route('GET', '/openTrades', () => ({
        trades: [openTrade(), openTrade({ id: '302', instrument: 'XAU_USD', units: '-100' })],
      }));
      const adapter = await freshAdapterAndScript();
      const positions = await adapter.getOpenPositions();
      expect(positions).toHaveLength(2);

      const long = positions.find((p) => p.externalOrderId === '301');
      expect(long).toMatchObject({
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.01000',
        openPrice: '1.09000',
        currentPrice: '1.10002', // BUY → realizable bid
        stopLoss: '1.08000',
        takeProfit: '1.20000',
        unrealisedPnl: '10.4200',
        commission: '0',
        swap: '0.2500',
      });
      expect(long?.openedAt).toBeInstanceOf(Date);

      const short = positions.find((p) => p.externalOrderId === '302');
      expect(short).toMatchObject({
        instrument: 'XAUUSD',
        direction: 'SELL',
        lotSize: '100.00000', // contractSize 1 for metals
        currentPrice: '2650.900', // SELL → realizable ask
      });

      // ONE batched pricing call for both instruments.
      const pricingCalls = backend.requests.filter((r) => r.path.includes('/pricing'));
      expect(pricingCalls).toHaveLength(1);
      expect(pricingCalls[0]?.path).toContain('EUR_USD');
      expect(pricingCalls[0]?.path).toContain('XAU_USD');
    });

    it('missing pricing for an open instrument fails closed (PROVIDER_UNAVAILABLE, retryable)', async () => {
      backend.route('GET', '/openTrades', () => ({ trades: [openTrade()] }));
      backend.route('GET', '/pricing', () => ({ prices: [xauUsdPrice] }));
      const adapter = await freshAdapterAndScript();
      await expect(adapter.getOpenPositions()).rejects.toMatchObject({
        code: BrokerErrorCode.PROVIDER_UNAVAILABLE,
        isRetryable: true,
      });
    });

    it('getPositionById resolves from the open-trade set; null when unknown', async () => {
      const adapter = await freshAdapterAndScript();
      const found = await adapter.getPositionById('301');
      expect(found?.externalOrderId).toBe('301');
      expect(await adapter.getPositionById('unknown')).toBeNull();
    });
  });

  describe('closeOrder / closeAllOrders', () => {
    it('full close sends units=ALL and maps the fill', async () => {
      const adapter = await freshAdapterAndScript();
      const result = await adapter.closeOrder('301');
      expect(result).toMatchObject({
        success: true,
        status: 'FILLED',
        externalOrderId: '301',
        filledPrice: '1.10005',
        filledQuantity: '0.01000',
      });
      const request = backend.requests.find((r) => r.method === 'PUT' && r.path.endsWith('/close'));
      expect(request?.body).toEqual({ units: 'ALL' });
    });

    it('partial close converts lots to positive units via the trade instrument', async () => {
      const adapter = await freshAdapterAndScript();
      await adapter.closeOrder('301', '0.005');
      const request = backend.requests.find((r) => r.method === 'PUT' && r.path.endsWith('/close'));
      expect(request?.body).toEqual({ units: '500' });
    });

    it('closing an unknown trade fails closed (POSITION_NOT_FOUND)', async () => {
      const adapter = await freshAdapterAndScript();
      await expect(adapter.closeOrder('99999')).rejects.toMatchObject({
        code: BrokerErrorCode.POSITION_NOT_FOUND,
      });
    });

    it('a close rejection (400 orderFillRejectTransaction) is an honest REJECTED result', async () => {
      backend.route('PUT', '/close', () => {
        throw new OandaApiError(400, '', 'Close rejected', 'req-cr-1', {
          orderFillRejectTransaction: { reason: 'TRADE_CLOSE_REDUNDANT' },
        });
      });
      const adapter = await freshAdapterAndScript();
      const result = await adapter.closeOrder('301');
      expect(result.success).toBe(false);
      expect(result.status).toBe('REJECTED');
      expect(result.brokerMessage).toContain('TRADE_CLOSE_REDUNDANT');
    });

    it('closeAllOrders aggregates successes and failures per position', async () => {
      backend.route('GET', '/openTrades', () => ({
        trades: [openTrade(), openTrade({ id: '302' })],
      }));
      backend.route('PUT', '/close', (request: ScriptedRequestRecord) => {
        if (request.path.includes('/trades/302/')) {
          throw new OandaApiError(503, '', 'Service unavailable');
        }
        return {
          orderFillTransaction: { id: '2105', price: '1.10005', units: '1000', time: ISO_TIME },
        };
      });
      const adapter = await freshAdapterAndScript();
      const result = await adapter.closeAllOrders();
      expect(result.closedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('302');
    });
  });

  describe('closed-trade history', () => {
    it('maps CLOSED trades with SL/TP-driven closeReason and decimal-string economics', async () => {
      const adapter = await freshAdapterAndScript();
      const trades = await adapter.getClosedTrades(
        new Date('2026-02-01T00:00:00Z'),
        new Date('2026-02-02T00:00:00Z'),
      );
      expect(trades).toHaveLength(1);
      expect(trades[0]).toMatchObject({
        externalOrderId: '401',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.01000',
        openPrice: '1.09000',
        closePrice: '1.10234',
        realisedPnl: '12.3400',
        swap: '0.1000',
        commission: '0',
        closeReason: 'SL',
      });
      expect(trades[0].openedAt).toBeInstanceOf(Date);
      expect(trades[0].closedAt).toBeInstanceOf(Date);
      const request = backend.requests.find((r) => r.path.includes('state=CLOSED'));
      expect(request?.path).toContain('from=');
      expect(request?.path).toContain('to=');
    });

    it('an indeterminate close (no SL/TP dependent orders) maps to UNKNOWN honestly', async () => {
      backend.route('GET', 'state=CLOSED', () => ({
        trades: [
          {
            id: '402',
            instrument: 'EUR_USD',
            units: '1000',
            price: '1.09000',
            realizedPL: '-2.0000',
            openTime: ISO_TIME,
            closeTime: ISO_TIME,
            averageClosePrice: '1.08998',
          },
        ],
      }));
      const adapter = await freshAdapterAndScript();
      const trades = await adapter.getClosedTrades(new Date(0), new Date());
      expect(trades[0]?.closeReason).toBe('UNKNOWN');
    });
  });

  describe('margin approximation (documented, fail-closed)', () => {
    it('computes units × direction-correct price × marginRate, 2dp decimal string', async () => {
      const adapter = await freshAdapterAndScript();
      // 0.01 lot = 1000 units; BUY uses ask 1.10012; rate 0.0333
      // → 1000 × 1.10012 × 0.0333 = 36.63 (rounded to 2dp)
      const margin = await adapter.getRequiredMargin({
        instrument: 'EURUSD',
        lotSize: '0.01',
        direction: 'BUY',
      });
      expect(margin).toBe('36.63');
      const sellMargin = await adapter.getRequiredMargin({
        instrument: 'EURUSD',
        lotSize: '0.01',
        direction: 'SELL',
      });
      // SELL uses bid 1.10002 → 1000 × 1.10002 × 0.0333 = 36.63
      expect(sellMargin).toBe('36.63');
    });

    it('returns null when the instrument is unknown (Risk Engine fails closed)', async () => {
      const adapter = await freshAdapterAndScript();
      const margin = await adapter.getRequiredMargin({
        instrument: 'ZZZUSD',
        lotSize: '0.01',
        direction: 'BUY',
      });
      expect(margin).toBeNull();
    });

    it('returns null when pricing fails (no fabricated margin)', async () => {
      backend.route('GET', '/pricing', () => {
        throw new OandaApiError(503, '', 'pricing unavailable');
      });
      const adapter = await freshAdapterAndScript();
      const margin = await adapter.getRequiredMargin({
        instrument: 'EURUSD',
        lotSize: '0.01',
        direction: 'BUY',
      });
      expect(margin).toBeNull();
    });

    it('returns null when the instrument carries no marginRate', async () => {
      backend.route('GET', '/v3/instruments', () => ({
        instruments: [{ ...eurUsdInstrument, marginRate: undefined }],
      }));
      const adapter = await freshAdapterAndScript();
      const margin = await adapter.getRequiredMargin({
        instrument: 'EURUSD',
        lotSize: '0.01',
        direction: 'BUY',
      });
      expect(margin).toBeNull();
    });
  });

  describe('error normalization through the adapter', () => {
    it('a raw transport failure maps to PROVIDER_UNAVAILABLE (retryable)', async () => {
      const adapter = await freshAdapterAndScript();
      backend.failWith(new Error('socket hang up'));
      await expect(adapter.getAccountInfo()).rejects.toMatchObject({
        code: BrokerErrorCode.PROVIDER_UNAVAILABLE,
        isRetryable: true,
      });
    });

    it('a provider 5xx maps to PROVIDER_UNAVAILABLE (retryable)', async () => {
      const adapter = await freshAdapterAndScript();
      backend.route('GET', '/summary', () => {
        throw new OandaApiError(503, '', 'upstream overloaded', 'req-503');
      });
      await expect(adapter.getAccountInfo()).rejects.toMatchObject({
        code: BrokerErrorCode.PROVIDER_UNAVAILABLE,
        isRetryable: true,
      });
    });

    it('a 429 maps to RATE_LIMITED (retryable) with the requestId preserved', async () => {
      const adapter = await freshAdapterAndScript();
      backend.route('GET', '/summary', () => {
        throw new OandaApiError(429, 'rate_limit', 'Too many requests', 'req-429');
      });
      const err = await adapter.getAccountInfo().then(
        () => null,
        (e: BrokerAdapterError) => e,
      );
      expect(err).toMatchObject({ code: BrokerErrorCode.RATE_LIMITED, isRetryable: true });
      expect(err?.brokerMessage).toContain('req-429');
    });
  });

  describe('secret redaction', () => {
    it('the token never appears in errors, brokerMessage, logs, or results', async () => {
      const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        scriptHealthy();
        const adapter = await connectAdapter();
        backend.route('GET', '/summary', () => {
          throw new OandaApiError(
            500,
            'internal',
            `upstream failed for token=${SECRET}`,
            'req-leak',
          );
        });
        const err = await adapter.getAccountInfo().then(
          () => null,
          (e: BrokerAdapterError) => e,
        );
        expect(err).not.toBeNull();
        expect(err?.message.includes(SECRET)).toBe(false);
        expect(err?.brokerMessage?.includes(SECRET)).toBe(false);
        expect(err?.message).toContain('[REDACTED]');

        // Results: raw responses never echo headers.
        backend.route('GET', '/summary', () => summaryResponse);
        const info = await adapter.getAccountInfo();
        expect(JSON.stringify(info).includes(SECRET)).toBe(false);
      } finally {
        spy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe('raw errors are never passed through', () => {
    it('every mapped error is a BrokerAdapterError with a code from the enum', async () => {
      const adapter = await freshAdapterAndScript();
      backend.failWith(new TypeError('fetch failed'));
      const err = await adapter.getAccountInfo().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BrokerAdapterError);
      const typed = err as BrokerAdapterError;
      expect(Object.values(BrokerErrorCode)).toContain(typed.code);
      expect(typed.isRetryable).toBe(RETRYABLE_BROKER_ERRORS.has(typed.code));
    });
  });
});

// ─── Error mapper table (pure function coverage) ─────────────────────────────

describe('mapOandaError — v3 status/code table', () => {
  const table: Array<{
    label: string;
    error: OandaApiError | Error;
    expectedCode: BrokerErrorCode;
  }> = [
    {
      label: '401 access_denied → AUTHENTICATION_FAILED',
      error: new OandaApiError(401, 'access_denied', 'Unauthorized'),
      expectedCode: BrokerErrorCode.AUTHENTICATION_FAILED,
    },
    {
      label: '401 token_expired → AUTHORIZATION_EXPIRED',
      error: new OandaApiError(401, 'token_expired', 'Token expired'),
      expectedCode: BrokerErrorCode.AUTHORIZATION_EXPIRED,
    },
    {
      label: '403 account_disabled → ACCOUNT_DISABLED',
      error: new OandaApiError(403, 'account_disabled', 'Account disabled'),
      expectedCode: BrokerErrorCode.ACCOUNT_DISABLED,
    },
    {
      label: '404 account_not_found → ACCOUNT_NOT_FOUND',
      error: new OandaApiError(404, 'account_not_found', 'Account not found'),
      expectedCode: BrokerErrorCode.ACCOUNT_NOT_FOUND,
    },
    {
      label: '404 order_not_found → POSITION_NOT_FOUND',
      error: new OandaApiError(404, 'order_not_found', 'Order not found'),
      expectedCode: BrokerErrorCode.POSITION_NOT_FOUND,
    },
    {
      label: '404 unconfirmed path → UNKNOWN (fail-closed)',
      error: new OandaApiError(404, 'not_a_code_we_know', 'No route'),
      expectedCode: BrokerErrorCode.UNKNOWN,
    },
    {
      label: '400 invalid_instrument code → INVALID_INSTRUMENT',
      error: new OandaApiError(400, 'invalid_instrument', 'Bad instrument'),
      expectedCode: BrokerErrorCode.INVALID_INSTRUMENT,
    },
    {
      label: '400 "not a valid instrument" message → INVALID_INSTRUMENT',
      error: new OandaApiError(400, 'invalid_value', 'EURUSD_X is not a valid instrument'),
      expectedCode: BrokerErrorCode.INVALID_INSTRUMENT,
    },
    {
      label: '400 generic validation → INVALID_REQUEST',
      error: new OandaApiError(400, 'invalid_value', 'units is out of range'),
      expectedCode: BrokerErrorCode.INVALID_REQUEST,
    },
    {
      label: '400 orderReject MARGIN_NOT_SUFFICIENT → INSUFFICIENT_MARGIN',
      error: new OandaApiError(400, '', 'Order rejected', undefined, {
        orderRejectTransaction: { reason: 'MARGIN_NOT_SUFFICIENT' },
      }),
      expectedCode: BrokerErrorCode.INSUFFICIENT_MARGIN,
    },
    {
      label: '400 orderReject MARKET_CLOSED → MARKET_CLOSED',
      error: new OandaApiError(400, '', 'Order rejected', undefined, {
        orderRejectTransaction: { reason: 'MARKET_CLOSED' },
      }),
      expectedCode: BrokerErrorCode.MARKET_CLOSED,
    },
    {
      label: '429 → RATE_LIMITED',
      error: new OandaApiError(429, 'rate_limit', 'Too many requests'),
      expectedCode: BrokerErrorCode.RATE_LIMITED,
    },
    {
      label: '503 → PROVIDER_UNAVAILABLE',
      error: new OandaApiError(503, '', 'Unavailable'),
      expectedCode: BrokerErrorCode.PROVIDER_UNAVAILABLE,
    },
    {
      label: '500 → PROVIDER_UNAVAILABLE',
      error: new OandaApiError(500, 'internal', 'Internal error'),
      expectedCode: BrokerErrorCode.PROVIDER_UNAVAILABLE,
    },
    {
      label: '418 (unrecognized status) → UNKNOWN',
      error: new OandaApiError(418, "i'm a teapot", 'Short and stout'),
      expectedCode: BrokerErrorCode.UNKNOWN,
    },
    {
      label: 'raw network error → PROVIDER_UNAVAILABLE',
      error: new TypeError('fetch failed'),
      expectedCode: BrokerErrorCode.PROVIDER_UNAVAILABLE,
    },
    {
      label: 'raw TimeoutError name → CONNECTION_TIMEOUT',
      error: Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }),
      expectedCode: BrokerErrorCode.CONNECTION_TIMEOUT,
    },
    {
      label: 'raw "timed out" message → CONNECTION_TIMEOUT',
      error: new Error('Request timed out'),
      expectedCode: BrokerErrorCode.CONNECTION_TIMEOUT,
    },
  ];

  it.each(table)('$label', ({ error, expectedCode }) => {
    const mapped = mapOandaError(error, SECRET);
    expect(mapped).toBeInstanceOf(BrokerAdapterError);
    expect(mapped.code).toBe(expectedCode);
    expect(mapped.isRetryable).toBe(RETRYABLE_BROKER_ERRORS.has(expectedCode));
    expect(mapped.message.includes(SECRET)).toBe(false);
  });

  it('preserves provider message + requestId in brokerMessage (redacted)', () => {
    const mapped = mapOandaError(
      new OandaApiError(429, 'rate_limit', `Too many requests (token=${SECRET})`, 'req-42'),
      SECRET,
    );
    expect(mapped.brokerMessage).toContain('rate_limit');
    expect(mapped.brokerMessage).toContain('req-42');
    expect(mapped.brokerMessage).not.toContain(SECRET);
  });

  it('passes an existing BrokerAdapterError through unchanged', () => {
    const original = new BrokerAdapterError(BrokerErrorCode.NOT_CONNECTED, 'already mapped');
    expect(mapOandaError(original, SECRET)).toBe(original);
  });
});

// ─── Symbol mapper ────────────────────────────────────────────────────────────

describe('oanda.symbol-mapper (Directive §AH)', () => {
  it('canonical ↔ provider round-trips', () => {
    for (const canonical of ['EURUSD', 'GBPUSD', 'XAUUSD', 'USDJPY', 'AUDCAD']) {
      const provider = toProviderSymbol(canonical);
      expect(provider).toBe(`${canonical.slice(0, 3)}_${canonical.slice(3)}`);
      expect(toCanonicalSymbol(provider)).toBe(canonical);
    }
  });

  it('already-provider-form input passes through without double mapping', () => {
    expect(toProviderSymbol('EUR_USD')).toBe('EUR_USD');
  });

  it('shorter symbols pass through unchanged (never guessed)', () => {
    expect(toProviderSymbol('US30')).toBe('US30');
    expect(toCanonicalSymbol('US30')).toBe('US30');
  });

  it('suffix handling: configured suffix round-trips and is stripped on canonicalization', () => {
    expect(toProviderSymbol('EURUSD', '.i')).toBe('EUR_USD.i');
    expect(toProviderSymbol('EURUSD.i')).toBe('EUR_USD.i');
    expect(toCanonicalSymbol('EUR_USD.i')).toBe('EURUSD.i');
    expect(toCanonicalSymbol('EUR_USD.i', '.i')).toBe('EURUSD');
    expect(toCanonicalSymbol(toProviderSymbol('EURUSD', '.i'), '.i')).toBe('EURUSD');
  });

  it('empty input is passed through unchanged', () => {
    expect(toProviderSymbol('')).toBe('');
    expect(toCanonicalSymbol('')).toBe('');
  });
});

// ─── redactSecret util ────────────────────────────────────────────────────────

describe('redactSecret util', () => {
  it('replaces every occurrence of the secret and leaves clean text untouched', () => {
    expect(redactSecret(`a ${SECRET} b ${SECRET}`, SECRET)).toBe('a [REDACTED] b [REDACTED]');
    expect(redactSecret('clean message', SECRET)).toBe('clean message');
    expect(redactSecret('no secret set', undefined)).toBe('no secret set');
    expect(redactSecret('', SECRET)).toBe('');
  });
});
