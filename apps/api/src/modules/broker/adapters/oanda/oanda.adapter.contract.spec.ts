/**
 * OandaAdapter — full application of the shared Directive §AN contract
 * suite (Sprint 51 PR-7). The suite is driven against the REAL adapter
 * with the REAL v20 REST contract scripted through the shared
 * ScriptedHttpBackend, proving the OANDA adapter satisfies every contract
 * category a broker adapter must pass.
 */
import {
  ContractSuiteContext,
  runBrokerAdapterContractSuite,
  ScriptedHttpBackend,
  ScriptedRequestRecord,
} from '../contract/broker-adapter.contract-suite';
import { OandaAdapter } from './oanda.adapter';
import { OANDA_DEFAULT_DEMO_BASE_URL, OANDA_DEFAULT_LIVE_BASE_URL } from './oanda.transport';
import { OandaApiError } from './oanda.error-mapper';
import { BrokerMode, IBrokerAdapter } from '../../interfaces/broker-adapter.interface';

const SECRET = 'contract-oanda-secret-token-DO-NOT-LEAK';
const ACCOUNT_ID = '101-004-1234567-001';
const ISO_TIME = '2026-02-01T12:00:00Z';

const backend = new ScriptedHttpBackend();

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

const eurUsdPrice = {
  instrument: 'EUR_USD',
  time: ISO_TIME,
  bids: [{ price: '1.10000' }, { price: '1.10002' }],
  asks: [{ price: '1.10010' }, { price: '1.10012' }],
};

const openTrade = {
  id: '301',
  instrument: 'EUR_USD',
  units: '1000',
  price: '1.09000',
  openTime: ISO_TIME,
  unrealizedPL: '10.4200',
  financing: '0.2500',
  stopLossOrder: { price: '1.08000' },
  takeProfitOrder: { price: '1.20000' },
};

const scriptHealthyOandaBackend = (): void => {
  backend.clearRoutes();
  backend.restore();
  // Anchored pattern: the accounts-list path must not substring-collide with
  // account-scoped sub-paths (/summary, /openTrades, /pricing, /orders...).
  backend.route('GET', /^\/v3\/accounts$/, () => ({
    accounts: [{ id: ACCOUNT_ID, currency: 'USD' }],
  }));
  backend.route('GET', '/summary', () => ({
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
  }));
  backend.route('GET', '/v3/instruments', () => ({ instruments: [eurUsdInstrument] }));
  backend.route('GET', '/pricing', () => ({ prices: [eurUsdPrice] }));
  backend.route('POST', '/orders', () => ({
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
  }));
  backend.route('GET', '/openTrades', () => ({ trades: [openTrade] }));
  backend.route('GET', 'state=PENDING', () => ({
    orders: [
      {
        id: '2101',
        instrument: 'EUR_USD',
        units: '1000',
        state: 'PENDING',
        type: 'LIMIT',
        price: '1.09500',
        timeInForce: 'GTC',
        createTime: ISO_TIME,
        clientExtensions: { id: 'client-2101' },
      },
    ],
  }));
  backend.route('GET', 'state=TRIGGERED', () => ({ orders: [] }));
  backend.route('GET', 'state=CLOSED', () => ({ trades: [] }));
};

const ctx: ContractSuiteContext = {
  brokerId: 'oanda',
  supportsDemo: true,
  createAdapter: (mode: BrokerMode): IBrokerAdapter => {
    const adapter = new OandaAdapter(undefined, backend);
    adapter.setMode(mode);
    return adapter;
  },
  credentials: { apiKey: SECRET, accountId: ACCOUNT_ID },
  scriptedBackend: backend,
  scriptHealthyBackend: scriptHealthyOandaBackend,
  scriptOrderNotFound: () => {
    // Legitimate v20 404-style answer for a single-order lookup.
    backend.route('GET', /\/orders\/[^/]+$/, () => {
      throw new OandaApiError(404, 'order_not_found', 'Order not found', 'req-nf');
    });
  },
  observedIdempotencyKey: async (): Promise<string | null> => {
    const posted = backend.requests.find(
      (request: ScriptedRequestRecord) =>
        request.method === 'POST' && request.path.endsWith('/orders'),
    );
    const body = posted?.body as { order?: { clientExtensions?: { id?: string } } } | undefined;
    return body?.order?.clientExtensions?.id ?? null;
  },
  pricedInstrument: 'EURUSD',
  expectedDemoBaseUrl: OANDA_DEFAULT_DEMO_BASE_URL,
  expectedLiveBaseUrl: OANDA_DEFAULT_LIVE_BASE_URL,
};

runBrokerAdapterContractSuite('OandaAdapter (v20 REST)', ctx);
