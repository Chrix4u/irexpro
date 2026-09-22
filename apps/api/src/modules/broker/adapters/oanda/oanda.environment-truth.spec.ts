/**
 * OandaAdapter — environment-truth hardening (October UAT hardening — WS4).
 *
 * The audit found OANDA runtime environment truth was echo/config derived:
 * connect()/testConnection() returned `accountType: this.mode`, so the
 * declared-vs-observed mismatch gate could never trip. These specs pin the
 * deterministic DEMO/LIVE separation built on the strongest fact OANDA
 * actually exposes — the ENVIRONMENT-SCOPED ENDPOINT (api-fxpractice vs
 * api-fxtrade) — with an honest truth-source label
 * (CONFIG_AND_ENDPOINT_VERIFIED, NEVER PROVIDER_OBSERVED for OANDA).
 */
import { Logger } from '@nestjs/common';
import { OandaAdapter, resolveOandaEndpointEnvironment } from './oanda.adapter';
import { OANDA_DEFAULT_DEMO_BASE_URL, OANDA_DEFAULT_LIVE_BASE_URL } from './oanda.transport';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import { BrokerMode } from '../../interfaces/broker-adapter.interface';
import { ScriptedHttpBackend } from '../contract/broker-adapter.contract-suite';

const SECRET = 'env-truth-oanda-token-1a2b3c4d';
const ACCOUNT_ID = '101-004-7654321-001';

const backend = new ScriptedHttpBackend();

const credentials = { apiKey: SECRET, accountId: ACCOUNT_ID };

const accountsResponse = {
  accounts: [{ id: ACCOUNT_ID, currency: 'USD' }],
};

const summaryResponse = {
  account: {
    id: ACCOUNT_ID,
    currency: 'USD',
    balance: '100000.0000',
    nav: '100250.3300',
    marginUsed: '1250.0000',
    marginAvailable: '99000.3300',
    marginCallMarginLevel: '800.0000',
  },
};

// The scripted backend resolves the route's return value AS the response
// body (same contract as the existing adapter specs).
const scriptHappyPaths = () => {
  backend.route('GET', '/v3/accounts', () => accountsResponse);
  backend.route('GET', '/summary', () => summaryResponse);
};

// ─── resolveOandaEndpointEnvironment (pure) ────────────────────────────────

describe('resolveOandaEndpointEnvironment', () => {
  it('classifies the official practice host as DEMO / CONFIG_AND_ENDPOINT_VERIFIED', () => {
    expect(resolveOandaEndpointEnvironment(OANDA_DEFAULT_DEMO_BASE_URL)).toEqual({
      environment: BrokerMode.DEMO,
      source: 'CONFIG_AND_ENDPOINT_VERIFIED',
    });
  });

  it('classifies the official trade host as LIVE / CONFIG_AND_ENDPOINT_VERIFIED', () => {
    expect(resolveOandaEndpointEnvironment(OANDA_DEFAULT_LIVE_BASE_URL)).toEqual({
      environment: BrokerMode.LIVE,
      source: 'CONFIG_AND_ENDPOINT_VERIFIED',
    });
  });

  it('a custom endpoint is honest UNVERIFIED (environment null) — never a claim', () => {
    expect(resolveOandaEndpointEnvironment('https://oanda-proxy.internal.test')).toEqual({
      environment: null,
      source: 'UNVERIFIED',
    });
  });

  it('an unparseable URL is UNVERIFIED, never a crash', () => {
    expect(resolveOandaEndpointEnvironment('not a url')).toEqual({
      environment: null,
      source: 'UNVERIFIED',
    });
  });

  it('NEVER claims PROVIDER_OBSERVED — OANDA v20 exposes no environment field', () => {
    const sources = [
      OANDA_DEFAULT_DEMO_BASE_URL,
      OANDA_DEFAULT_LIVE_BASE_URL,
      'https://custom.example',
    ].map((url) => resolveOandaEndpointEnvironment(url).source);
    expect(sources).not.toContain('PROVIDER_OBSERVED');
  });
});

// ─── connect() enforcement ─────────────────────────────────────────────────

describe('OandaAdapter.connect — environment truth enforcement (WS4)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    backend.clearRoutes();
    backend.resetRequests();
  });

  afterEach(() => {
    backend.clearRoutes();
    backend.resetRequests();
    jest.restoreAllMocks();
  });

  it('DEMO on the practice endpoint connects and reports endpoint-verified DEMO truth', async () => {
    scriptHappyPaths();
    const adapter = new OandaAdapter(undefined, backend);
    adapter.setMode(BrokerMode.DEMO);

    const result = await adapter.connect(credentials);

    expect(result.success).toBe(true);
    // The OBSERVED account type is the endpoint-derived environment — not a
    // mode echo.
    expect(result.accountType).toBe(BrokerMode.DEMO);
    expect(result.environmentTruth).toEqual({
      environment: BrokerMode.DEMO,
      source: 'CONFIG_AND_ENDPOINT_VERIFIED',
    });
  });

  it('LIVE on the trade endpoint reports endpoint-verified LIVE truth', async () => {
    scriptHappyPaths();
    const adapter = new OandaAdapter(undefined, backend);
    adapter.setMode(BrokerMode.LIVE);

    const result = await adapter.connect(credentials);

    expect(result.success).toBe(true);
    expect(result.accountType).toBe(BrokerMode.LIVE);
    expect(result.environmentTruth).toEqual({
      environment: BrokerMode.LIVE,
      source: 'CONFIG_AND_ENDPOINT_VERIFIED',
    });
  });

  it('a LIVE request routed at the PRACTICE endpoint fails closed (ENVIRONMENT_MISMATCH)', async () => {
    // The LIVE base URL config points at the practice host — the declared
    // LIVE environment contradicts the endpoint-scoped environment.
    const config = {
      get: (key: string) =>
        key === 'OANDA_API_BASE_LIVE' ? OANDA_DEFAULT_DEMO_BASE_URL : undefined,
    } as never;
    const adapter = new OandaAdapter(config, backend);
    adapter.setMode(BrokerMode.LIVE);

    await expect(adapter.connect(credentials)).rejects.toMatchObject({
      code: BrokerErrorCode.ENVIRONMENT_MISMATCH,
    });
    // Fail-closed BEFORE any provider call — nothing scripted, nothing sent.
    expect(backend.requests.length).toBe(0);
  });

  it('a DEMO request routed at the TRADE endpoint fails closed (ENVIRONMENT_MISMATCH)', async () => {
    const config = {
      get: (key: string) =>
        key === 'OANDA_API_BASE_DEMO' ? OANDA_DEFAULT_LIVE_BASE_URL : undefined,
    } as never;
    const adapter = new OandaAdapter(config, backend);
    adapter.setMode(BrokerMode.DEMO);

    await expect(adapter.connect(credentials)).rejects.toMatchObject({
      code: BrokerErrorCode.ENVIRONMENT_MISMATCH,
    });
    expect(backend.requests.length).toBe(0);
  });

  it('a custom endpoint CANNOT attest a declared LIVE environment — fails closed', async () => {
    const config = {
      get: (key: string) =>
        key === 'OANDA_API_BASE_LIVE' ? 'https://oanda-proxy.internal.test' : undefined,
    } as never;
    const adapter = new OandaAdapter(config, backend);
    adapter.setMode(BrokerMode.LIVE);

    await expect(adapter.connect(credentials)).rejects.toMatchObject({
      code: BrokerErrorCode.ENVIRONMENT_MISMATCH,
    });
    expect(backend.requests.length).toBe(0);
  });

  it('a custom endpoint with DEMO proceeds with the honest UNVERIFIED label (virtual funds)', async () => {
    scriptHappyPaths();
    const config = {
      get: (key: string) =>
        key === 'OANDA_API_BASE_DEMO' ? 'https://oanda-proxy.internal.test' : undefined,
    } as never;
    const adapter = new OandaAdapter(config, backend);
    adapter.setMode(BrokerMode.DEMO);

    const result = await adapter.connect(credentials);

    expect(result.success).toBe(true);
    expect(result.accountType).toBe(BrokerMode.DEMO);
    expect(result.environmentTruth).toEqual({
      environment: null,
      source: 'UNVERIFIED',
    });
  });

  it('setMode(LIVE) alone NEVER makes the observed type LIVE when the endpoint says practice', async () => {
    scriptHappyPaths();
    // Default config: DEMO mode addresses the practice host. A client
    // flipping the mode cannot relabel the environment.
    const adapter = new OandaAdapter(undefined, backend);
    adapter.setMode(BrokerMode.DEMO);
    const result = await adapter.connect(credentials);

    expect(result.accountType).toBe(BrokerMode.DEMO);
    expect(result.environmentTruth?.environment).toBe(BrokerMode.DEMO);
  });
});

// ─── testConnection() enforcement ──────────────────────────────────────────

describe('OandaAdapter.testConnection — environment truth enforcement (WS4)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    backend.clearRoutes();
    backend.resetRequests();
  });

  afterEach(() => {
    backend.clearRoutes();
    backend.resetRequests();
    jest.restoreAllMocks();
  });

  it('reports the endpoint-derived environment with the honest source label', async () => {
    scriptHappyPaths();
    const adapter = new OandaAdapter(undefined, backend);
    adapter.setMode(BrokerMode.DEMO);

    const result = await adapter.testConnection(credentials);

    expect(result.success).toBe(true);
    expect(result.accountType).toBe(BrokerMode.DEMO);
    expect(result.environmentTruth).toEqual({
      environment: BrokerMode.DEMO,
      source: 'CONFIG_AND_ENDPOINT_VERIFIED',
    });
  });

  it('never green-lights a mislabeled environment (LIVE declared, practice endpoint)', async () => {
    const config = {
      get: (key: string) =>
        key === 'OANDA_API_BASE_LIVE' ? OANDA_DEFAULT_DEMO_BASE_URL : undefined,
    } as never;
    const adapter = new OandaAdapter(config, backend);
    adapter.setMode(BrokerMode.LIVE);

    const result = await adapter.testConnection(credentials);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(BrokerErrorCode.ENVIRONMENT_MISMATCH);
  });

  it('the typed error carries no credential material', async () => {
    const config = {
      get: (key: string) =>
        key === 'OANDA_API_BASE_LIVE' ? OANDA_DEFAULT_DEMO_BASE_URL : undefined,
    } as never;
    const adapter = new OandaAdapter(config, backend);
    adapter.setMode(BrokerMode.LIVE);

    try {
      await adapter.connect(credentials);
      fail('expected ENVIRONMENT_MISMATCH');
    } catch (err) {
      const adapterError = err as BrokerAdapterError;
      expect(adapterError.code).toBe(BrokerErrorCode.ENVIRONMENT_MISMATCH);
      expect(adapterError.message).not.toContain(SECRET);
      expect(adapterError.brokerMessage ?? '').not.toContain(SECRET);
    }
  });
});
