/**
 * Harness self-verification for the shared broker-adapter contract suite
 * (Sprint 51 PR-7 — Directive §AN).
 *
 * Proves the harness works in three ways:
 *  1. A fully-compliant TOY adapter (injectable transport, NOT_CONNECTED
 *     guards, decimal strings, error normalization, environment routing,
 *     redaction, idempotency passthrough) passes the generated suite.
 *  2. The generator registers exactly the Directive §AN assertion groups.
 *  3. The exported helpers DETECT violations (a number where a decimal
 *     string is required is surfaced, not silently accepted).
 */
import {
  BrokerAdapterError,
  BrokerErrorCode,
  redactSecret,
} from '../../interfaces/broker-adapter.errors';
import {
  BrokerAccountInfo,
  BrokerBalance,
  BrokerCloseAllResult,
  BrokerClosedTrade,
  BrokerConnectionResult,
  BrokerConnectionTestResult,
  BrokerInstrument,
  BrokerMode,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerOrderState,
  BrokerPosition,
  BrokerPrice,
  DecryptedBrokerCredentials,
  IBrokerAdapter,
  OHLCV,
} from '../../interfaces/broker-adapter.interface';
import {
  collectMoneyValues,
  CONTRACT_ASSERTION_TITLES,
  isDecimalString,
  runBrokerAdapterContractSuite,
  ScriptedBackend,
  ScriptedHttpBackend,
  ScriptedRequestRecord,
} from './broker-adapter.contract-suite';

const TOY_DEMO_BASE = 'https://demo.toy-broker.example';
const TOY_LIVE_BASE = 'https://live.toy-broker.example';
const TOY_SECRET = 'toy-contract-secret-token-abcdef';
const TOY_ACCOUNT = 'toy-account-1';
const TOY_ISO = '2026-02-01T10:00:00Z';

const toyAccount = {
  id: TOY_ACCOUNT,
  currency: 'USD',
  balance: '100.2500',
  nav: '101.0000',
  marginUsed: '10.0000',
  marginAvailable: '91.0000',
};

const toyPrice = { instrument: 'TOYUSD', bid: '1.10000', ask: '1.10010', time: TOY_ISO };

const toyPosition = {
  id: 'p1',
  instrument: 'TOYUSD',
  units: '1000',
  price: '1.09000',
  unrealizedPL: '10.0000',
  financing: '0.0000',
  openTime: TOY_ISO,
};

/**
 * ToyContractAdapter — minimal transport-backed adapter that satisfies the
 * whole Directive §AN contract. It exercises the same injectable-transport
 * pattern as the OANDA v20 adapter, proving the suite is provider-agnostic.
 */
class ToyContractAdapter implements IBrokerAdapter {
  readonly brokerId = 'toy-contract';
  readonly brokerName = 'Toy Contract Adapter';
  readonly supportsDemo = true;

  private mode: BrokerMode = BrokerMode.DEMO;
  private connected = false;
  private token = '';

  constructor(private readonly transport: ScriptedBackend) {}

  setMode(mode: BrokerMode): void {
    this.mode = mode;
  }

  private get baseUrl(): string {
    return this.mode === BrokerMode.DEMO ? TOY_DEMO_BASE : TOY_LIVE_BASE;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new BrokerAdapterError(BrokerErrorCode.NOT_CONNECTED, 'toy: not connected');
    }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.connected) {
      throw new BrokerAdapterError(BrokerErrorCode.NOT_CONNECTED, 'toy: not connected');
    }
    try {
      return await this.transport.request<T>(
        method,
        this.baseUrl,
        path,
        { Authorization: `Bearer ${this.token}` },
        body,
      );
    } catch (err) {
      const message = (err as Error).message ?? 'toy transport failure';
      const redacted = redactSecret(message, this.token);
      throw new BrokerAdapterError(
        BrokerErrorCode.PROVIDER_UNAVAILABLE,
        `toy request failed: ${redacted}`,
        redacted,
        true,
      );
    }
  }

  async connect(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult> {
    this.token = credentials.apiKey ?? '';
    try {
      const accounts = await this.transport.request<{ accounts: Array<{ id: string }> }>(
        'GET',
        this.baseUrl,
        '/accounts',
        { Authorization: `Bearer ${this.token}` },
        undefined,
      );
      if (!accounts.accounts.some((entry) => entry.id === credentials.accountId)) {
        throw new BrokerAdapterError(BrokerErrorCode.ACCOUNT_NOT_FOUND, 'toy: account not found');
      }
    } catch (err) {
      if (err instanceof BrokerAdapterError) throw err;
      const message = redactSecret((err as Error).message ?? 'toy connect failure', this.token);
      throw new BrokerAdapterError(BrokerErrorCode.AUTHENTICATION_FAILED, message);
    }
    this.connected = true;
    return {
      success: true,
      accountId: credentials.accountId,
      accountType: this.mode,
      currency: 'USD',
      serverTime: new Date(TOY_ISO),
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.token = '';
  }

  async testConnection(
    credentials: DecryptedBrokerCredentials,
  ): Promise<BrokerConnectionTestResult> {
    return {
      success: true,
      accountId: credentials.accountId,
      accountType: this.mode,
      currency: 'USD',
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getAccountInfo(): Promise<BrokerAccountInfo> {
    this.assertConnected();
    const account = await this.call<typeof toyAccount>('GET', '/account');
    return {
      accountId: account.id,
      currency: account.currency,
      leverage: 1,
      balance: String(account.balance),
      equity: String(account.nav),
      margin: String(account.marginUsed),
      freeMargin: String(account.marginAvailable),
      marginLevel: '100.0000',
    };
  }

  async getAccountBalance(): Promise<BrokerBalance> {
    this.assertConnected();
    const account = await this.call<typeof toyAccount>('GET', '/account');
    return {
      balance: String(account.balance),
      equity: String(account.nav),
      currency: account.currency,
      timestamp: new Date(TOY_ISO),
    };
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    this.assertConnected();
    const trades = await this.call<
      Array<{
        id: string;
        units: string;
        instrument: string;
        price: string;
        unrealizedPL: string;
        financing: string;
        openTime: string;
      }>
    >('GET', '/positions');
    const price = await this.call<typeof toyPrice>('GET', '/price');
    return trades.map((trade) => ({
      externalOrderId: trade.id,
      instrument: trade.instrument,
      direction: parseFloat(trade.units) >= 0 ? 'BUY' : 'SELL',
      lotSize: '0.01000',
      openPrice: String(trade.price),
      currentPrice: String(price.bid),
      stopLoss: '1.08000',
      takeProfit: '1.20000',
      unrealisedPnl: String(trade.unrealizedPL),
      openedAt: new Date(trade.openTime),
      commission: '0',
      swap: String(trade.financing),
    }));
  }

  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> {
    this.assertConnected();
    const positions = await this.getOpenPositions();
    return positions.find((position) => position.externalOrderId === externalOrderId) ?? null;
  }

  async getRequiredMargin(): Promise<string | null> {
    this.assertConnected();
    return null;
  }

  async getInstrumentList(): Promise<BrokerInstrument[]> {
    this.assertConnected();
    return [
      {
        symbol: 'TOYUSD',
        description: 'Toy vs USD',
        digits: 5,
        minLot: '0.01',
        maxLot: '10.00',
        lotStep: '0.01',
        contractSize: '100000',
      },
    ];
  }

  async getCurrentPrice(instrument: string): Promise<BrokerPrice> {
    this.assertConnected();
    const price = await this.call<typeof toyPrice>('GET', '/price');
    const spread = (parseFloat(price.ask) - parseFloat(price.bid)).toFixed(5);
    return {
      instrument,
      bid: String(price.bid),
      ask: String(price.ask),
      spread,
      timestamp: new Date(price.time),
    };
  }

  async getOHLCV(): Promise<OHLCV[]> {
    this.assertConnected();
    return [];
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    this.assertConnected();
    const fill = await this.call<{ id: string; price: string; units: string }>('POST', '/orders', {
      order: {
        type: order.orderKind ?? 'MARKET',
        instrument: order.instrument,
        units: order.direction === 'BUY' ? '1000' : '-1000',
        clientExtensions: { id: order.idempotencyKey },
      },
    });
    return {
      success: true,
      externalOrderId: fill.id,
      filledPrice: String(fill.price),
      filledQuantity: '0.01000',
      filledAt: new Date(TOY_ISO),
      status: 'FILLED',
      rawResponse: fill,
    };
  }

  async modifyOrder(): Promise<BrokerOrderResult> {
    this.assertConnected();
    throw new BrokerAdapterError(BrokerErrorCode.INVALID_REQUEST, 'toy: modify not mapped');
  }

  async closeOrder(): Promise<BrokerOrderResult> {
    this.assertConnected();
    return { success: true, status: 'FILLED', externalOrderId: 'toy-close' };
  }

  async closeAllOrders(): Promise<BrokerCloseAllResult> {
    this.assertConnected();
    return { closedCount: 0, failedCount: 0, errors: [] };
  }

  async getClosedTrades(): Promise<BrokerClosedTrade[]> {
    this.assertConnected();
    return [];
  }

  async listOrders(): Promise<BrokerOrderState[]> {
    this.assertConnected();
    const response = await this.call<{ orders: Array<Record<string, string>> }>(
      'GET',
      '/orders?state=PENDING',
    );
    return response.orders.map((order) => ({
      providerOrderId: order.id,
      clientOrderId: order.clientExtensions,
      status: 'WORKING' as const,
      instrument: order.instrument,
      direction: 'BUY' as const,
      requestedQuantity: '0.01000',
      filledQuantity: '0.00000',
      orderKind: 'LIMIT' as const,
      limitPrice: order.price,
      timeInForce: order.timeInForce,
    }));
  }

  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> {
    this.assertConnected();
    const order = await this.call<Record<string, string> | null>(
      'GET',
      `/orders/${providerOrderId}`,
    );
    if (order === null) return null;
    return {
      providerOrderId: order.id,
      clientOrderId: order.clientExtensions,
      status: 'WORKING' as const,
      instrument: order.instrument,
      direction: 'BUY' as const,
      requestedQuantity: '0.01000',
      filledQuantity: '0.00000',
      orderKind: 'LIMIT' as const,
      limitPrice: order.price,
      timeInForce: order.timeInForce,
    };
  }
}

// ─── Harness context ──────────────────────────────────────────────────────────

const backend = new ScriptedHttpBackend();

const scriptHealthyToyBackend = (): void => {
  backend.clearRoutes();
  backend.restore();
  // Anchored patterns: '/accounts' and '/account' must not substring-collide.
  backend.route('GET', /^\/accounts$/, () => ({ accounts: [{ id: TOY_ACCOUNT }] }));
  backend.route('GET', /^\/account$/, () => toyAccount);
  backend.route('GET', '/price', () => toyPrice);
  backend.route('GET', '/positions', () => [toyPosition]);
  backend.route('POST', '/orders', () => ({ id: 'toy-o1', price: '1.10005', units: '1000' }));
  backend.route('GET', 'state=PENDING', () => ({ orders: [] }));
  backend.route('GET', /\/orders\/[^/]+$/, () => null);
};

const toyCtx = {
  brokerId: 'toy-contract',
  supportsDemo: true,
  createAdapter: (mode: BrokerMode): IBrokerAdapter => {
    const adapter = new ToyContractAdapter(backend);
    adapter.setMode(mode);
    return adapter;
  },
  credentials: { apiKey: TOY_SECRET, accountId: TOY_ACCOUNT },
  scriptedBackend: backend,
  scriptHealthyBackend: scriptHealthyToyBackend,
  scriptOrderNotFound: () => {
    backend.route('GET', /\/orders\/[^/]+$/, () => null);
  },
  observedIdempotencyKey: async (): Promise<string | null> => {
    const posted = backend.requests.find(
      (request: ScriptedRequestRecord) =>
        request.method === 'POST' && request.path.endsWith('/orders'),
    );
    const body = posted?.body as { order?: { clientExtensions?: { id?: string } } } | undefined;
    return body?.order?.clientExtensions?.id ?? null;
  },
  pricedInstrument: 'TOYUSD',
  expectedDemoBaseUrl: TOY_DEMO_BASE,
  expectedLiveBaseUrl: TOY_LIVE_BASE,
};

const registeredTitles = runBrokerAdapterContractSuite(
  'ToyContractAdapter (harness proof)',
  toyCtx,
);

// ─── Harness meta-tests ───────────────────────────────────────────────────────

describe('runBrokerAdapterContractSuite harness (Directive §AN)', () => {
  it('registers exactly the Directive §AN assertion groups', () => {
    expect(registeredTitles).toEqual([...CONTRACT_ASSERTION_TITLES]);
  });

  it('every registered title covers a distinct contract category', () => {
    expect(registeredTitles).toHaveLength(8);
    const unique = new Set(registeredTitles);
    expect(unique.size).toBe(registeredTitles.length);
  });

  describe('violation detection (the harness must not silently accept breaks)', () => {
    it('isDecimalString accepts decimal strings and rejects numbers, NaN, exponents, garbage', () => {
      expect(isDecimalString('1.10000')).toBe(true);
      expect(isDecimalString('-12.34')).toBe(true);
      expect(isDecimalString('0')).toBe(true);
      expect(isDecimalString(12.3)).toBe(false); // numbers are NEVER decimal strings
      expect(isDecimalString('NaN')).toBe(false);
      expect(isDecimalString('1.1e-5')).toBe(false);
      expect(isDecimalString('abc')).toBe(false);
      expect(isDecimalString('')).toBe(false);
      expect(isDecimalString(null)).toBe(false);
      expect(isDecimalString(undefined)).toBe(false);
    });

    it('collectMoneyValues surfaces money/quantity values including nested arrays', () => {
      const result = {
        balance: '100.00',
        positions: [
          { lotSize: '0.01', openPrice: '1.09', nested: { swap: '0.25' } },
          { lotSize: '0.02', openPrice: '1.10', nested: { swap: '0.50' } },
        ],
        leverage: 100, // NOT a money key — must be ignored
        rawResponse: { balance: 999 }, // raw subtrees must be skipped
      };
      const values = collectMoneyValues(result);
      expect(values).toEqual(['100.00', '0.01', '1.09', '0.25', '0.02', '1.10', '0.50']);
    });

    it('a NUMBER where a decimal string is required is detected as a violation', () => {
      const values = collectMoneyValues({ balance: 12.3 });
      expect(values).toEqual([12.3]);
      expect(values.every(isDecimalString)).toBe(false);
    });
  });
});
