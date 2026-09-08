import { ConfigService } from '@nestjs/config';
import { CTraderClientService } from './ctrader-client.service';
import { CtraderTransport } from './ctrader-transport';
import { FakeCtraderTransport, ScriptedCtraderServer } from './ctrader.fake-transport';
import {
  CTRADER_ENVIRONMENT_URLS,
  CTRADER_PAYLOAD_TYPE,
  CtraderMessageEnvelope,
} from './ctrader-message-types';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import { buildCtraderAuthorizationUrl, parseCtraderTokenResponse } from './ctrader-oauth';

const ACCOUNT_ID = '1234567';
const ACCESS_TOKEN = 'test-access-token';

function fakeConfigService(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue ?? '',
  } as unknown as ConfigService;
}

/**
 * Testable client: shadows the protected transport factory with fakes bound
 * to the scripted server (mirrors how production injects
 * NodeWebSocketCtraderTransport).
 */
class TestableCtraderClient extends CTraderClientService {
  readonly createdTransports: FakeCtraderTransport[] = [];
  /** Per-created-transport connect behavior ('ok' | 'fail'); defaults to 'ok'. */
  readonly connectBehaviors: Array<'ok' | 'fail'> = [];

  constructor(
    server: ScriptedCtraderServer,
    config: ConfigService = fakeConfigService({
      'broker.ctraderClientId': 'test-client-id',
      'broker.ctraderClientSecret': 'test-client-secret',
    }),
  ) {
    super(config);
    this.server = server;
  }

  private readonly server: ScriptedCtraderServer;

  protected createTransport(): CtraderTransport {
    const behavior = this.connectBehaviors.shift() ?? 'ok';
    const transport = new FakeCtraderTransport(this.server);
    transport.connectBehavior = behavior;
    this.createdTransports.push(transport);
    return transport;
  }
}

describe('CTraderClientService', () => {
  let server: ScriptedCtraderServer;
  let client: TestableCtraderClient;

  beforeEach(() => {
    server = new ScriptedCtraderServer();
    client = new TestableCtraderClient(server);
  });

  afterEach(async () => {
    await client.onModuleDestroy();
    jest.useRealTimers();
  });

  // ─── Handshake ordering (app auth 2100 FIRST) ──────────────────────────────

  it('sends ProtoOAApplicationAuthReq (2100) before anything else, then account auth (2102)', async () => {
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);

    expect(server.requests[0].payloadType).toBe(CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ);
    expect(server.requests[0].payload).toMatchObject({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    });
    expect(server.requests[1].payloadType).toBe(CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ);
    expect(server.requests[1].payload).toMatchObject({
      ctidTraderAccountId: 1234567,
      accessToken: ACCESS_TOKEN,
    });
  });

  it('is idempotent: a second ensureAccountSession for the same account sends no new 2102', async () => {
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);

    const accountAuths = server.requests.filter(
      (r) => r.payloadType === CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ,
    );
    expect(accountAuths).toHaveLength(1);
  });

  it('fails closed with AUTHENTICATION_FAILED when the platform cTrader app credentials are unconfigured', async () => {
    const unconfigured = new TestableCtraderClient(server, fakeConfigService());
    await expect(
      unconfigured.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN),
    ).rejects.toMatchObject({
      code: BrokerErrorCode.AUTHENTICATION_FAILED,
      message: expect.stringContaining('CTRADER_CLIENT_ID'),
    });
  });

  it('maps a 2100 rejection (CH_CLIENT_AUTH_FAILURE) to AUTHENTICATION_FAILED', async () => {
    server.on(CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ, (_payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
      payload: { errorCode: 'CH_CLIENT_AUTH_FAILURE', description: 'Wrong credentials' },
    }));
    await expect(
      client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN),
    ).rejects.toMatchObject({ code: BrokerErrorCode.AUTHENTICATION_FAILED });
  });

  it('fails closed on an unexpected app-auth response payloadType', async () => {
    server.on(CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ, (_payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: 9999,
      payload: {},
    }));
    await expect(
      client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN),
    ).rejects.toMatchObject({ code: BrokerErrorCode.UNKNOWN });
  });

  it('exposes session state through hasAccountSession/isEnvConnected and clears it on removal', async () => {
    expect(client.isAvailable()).toBe(true);
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);
    expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
    expect(client.isEnvConnected('DEMO')).toBe(true);
    // LIVE isolation: a different environment has no connection.
    expect(client.isEnvConnected('LIVE')).toBe(false);

    await client.removeAccountSession('DEMO', ACCOUNT_ID);
    expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(false);
    expect(client.isEnvConnected('DEMO')).toBe(false);
    expect(client.createdTransports[0].isOpen()).toBe(false);
  });

  // ─── DEMO/LIVE host isolation (hard invariant) ─────────────────────────────

  it('connects DEMO and LIVE to their own hosts and never crosses them', async () => {
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);
    expect(client.createdTransports[0].connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.DEMO);

    const liveClient = new TestableCtraderClient(server);
    await liveClient.ensureAccountSession('LIVE', ACCOUNT_ID, ACCESS_TOKEN);
    expect(liveClient.createdTransports[0].connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.LIVE);
    expect(liveClient.createdTransports[0].connectedUrl).not.toBe(CTRADER_ENVIRONMENT_URLS.DEMO);
    await liveClient.onModuleDestroy();
  });

  // ─── clientMsgId echo matching ─────────────────────────────────────────────

  it('resolves requests by the ECHOED clientMsgId and never by another id', async () => {
    jest.useFakeTimers();
    server.on(CTRADER_PAYLOAD_TYPE.TRADER_REQ, (_payload, _envelope) => ({
      clientMsgId: 'someone-elses-request-id',
      payloadType: CTRADER_PAYLOAD_TYPE.TRADER_RES,
      payload: {},
    }));

    const promise = client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
      ctidTraderAccountId: 1234567,
    });
    // Attach the rejection assertion BEFORE advancing time so the rejection
    // is always handled (never an unhandled promise rejection).
    const assertion = expect(promise).rejects.toMatchObject({
      code: BrokerErrorCode.CONNECTION_TIMEOUT,
    });
    // Wrong-echo responses must NOT resolve the request…
    await jest.advanceTimersByTimeAsync(9_000);
    // …but a response echoing OUR id resolves immediately.
    server.on(CTRADER_PAYLOAD_TYPE.TRADER_REQ, (_payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.TRADER_RES,
      payload: { matched: true },
    }));
    // The original request already consumed its send; re-request to prove the
    // echo path resolves (the first promise times out below).
    const second = client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
      ctidTraderAccountId: 1234567,
    });
    const resolved = await second;
    expect(resolved.payloadType).toBe(CTRADER_PAYLOAD_TYPE.TRADER_RES);

    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('times out unanswered requests after 10s with CONNECTION_TIMEOUT (retryable)', async () => {
    jest.useFakeTimers();
    server.on(CTRADER_PAYLOAD_TYPE.TRADER_REQ, () => null);

    const promise = client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
      ctidTraderAccountId: 1234567,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      code: BrokerErrorCode.CONNECTION_TIMEOUT,
      isRetryable: true,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('rejects pending requests with CONNECTION_LOST when the transport dies', async () => {
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);
    server.on(CTRADER_PAYLOAD_TYPE.TRADER_REQ, () => null);
    const promise = client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
      ctidTraderAccountId: 1234567,
    });
    client.createdTransports[0].simulateClose();
    await expect(promise).rejects.toMatchObject({
      code: BrokerErrorCode.CONNECTION_LOST,
      isRetryable: true,
    });
    // The client guards sessions as gone after the loss.
    expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(false);
  });

  // ─── Heartbeat (payloadType 51, every 10s) ─────────────────────────────────

  it('sends a ProtoHeartbeatEvent (payloadType 51) every 10 seconds', async () => {
    jest.useFakeTimers();
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);
    const transport = client.createdTransports[0];

    expect(transport.sentMessages.filter((m) => m.payloadType === 51)).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(transport.sentMessages.filter((m) => m.payloadType === 51)).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(transport.sentMessages.filter((m) => m.payloadType === 51)).toHaveLength(4);

    const heartbeat = transport.sentMessages.find((m) => m.payloadType === 51)!;
    expect(heartbeat.payload).toEqual({});
    expect(heartbeat.clientMsgId).toBeUndefined();
  });

  // ─── Rate limiter (50/s general, 5/s historical — fail closed locally) ─────

  it('rejects the 51st general request within a second with RATE_LIMITED', async () => {
    jest.useFakeTimers();
    // The handshake (2100 app auth + 2102 account auth) itself consumes 2 of
    // the 50 general-rate tokens — the limiter counts EVERY request.
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);

    for (let i = 0; i < 48; i++) {
      await client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
        ctidTraderAccountId: 1234567,
      });
    }
    await expect(
      client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
        ctidTraderAccountId: 1234567,
      }),
    ).rejects.toMatchObject({ code: BrokerErrorCode.RATE_LIMITED, isRetryable: true });
  });

  it('rejects the 6th historical request within a second with RATE_LIMITED (5/s)', async () => {
    jest.useFakeTimers();
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);

    for (let i = 0; i < 5; i++) {
      await client.request('DEMO', CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ, {
        ctidTraderAccountId: 1234567,
      });
    }
    await expect(
      client.request('DEMO', CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ, {
        ctidTraderAccountId: 1234567,
      }),
    ).rejects.toMatchObject({ code: BrokerErrorCode.RATE_LIMITED });
  });

  it('refills the bucket after the rate-limit window passes', async () => {
    jest.useFakeTimers();
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);

    for (let i = 0; i < 5; i++) {
      await client.request('DEMO', CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ, {
        ctidTraderAccountId: 1234567,
      });
    }
    await expect(
      client.request('DEMO', CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ, {
        ctidTraderAccountId: 1234567,
      }),
    ).rejects.toMatchObject({ code: BrokerErrorCode.RATE_LIMITED });

    await jest.advanceTimersByTimeAsync(1_000);
    await expect(
      client.request('DEMO', CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ, {
        ctidTraderAccountId: 1234567,
      }),
    ).resolves.toMatchObject({ payloadType: CTRADER_PAYLOAD_TYPE.DEAL_LIST_RES });
  });

  // ─── Reconnect: exponential backoff 3s→6s, re-auth, host isolation ─────────

  it('reconnects with 3s then 6s backoff, re-authenticates the app AND the account', async () => {
    jest.useFakeTimers();
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);
    expect(client.createdTransports).toHaveLength(1);

    // First loss → 3s backoff → successful reconnect + re-auth.
    client.createdTransports[0].simulateClose();
    await jest.advanceTimersByTimeAsync(2_999);
    expect(client.createdTransports).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(client.createdTransports).toHaveLength(2);
    expect(client.createdTransports[1].connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.DEMO);
    expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);

    const appAuths = server.requests.filter(
      (r) => r.payloadType === CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ,
    );
    const accountAuths = server.requests.filter(
      (r) => r.payloadType === CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ,
    );
    expect(appAuths).toHaveLength(2);
    expect(accountAuths).toHaveLength(2);

    // Second loss → the next reconnect ATTEMPT fails at connect → 6s backoff.
    client.connectBehaviors.push('fail');
    client.createdTransports[1].simulateClose();
    await jest.advanceTimersByTimeAsync(3_000); // first attempt (connect fails)
    expect(client.createdTransports).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(5_999); // still inside the 6s backoff
    expect(client.createdTransports).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(client.createdTransports).toHaveLength(4);
    expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
    expect(client.createdTransports[3].connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.DEMO);
  });

  // ─── Account discovery (2149) ──────────────────────────────────────────────

  it('maps discovered accounts with isLive and brokerTitleShort', async () => {
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);
    const accounts = await client.discoverAccounts('DEMO', ACCESS_TOKEN);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      ctidTraderAccountId: 1234567,
      isLive: false,
      traderLogin: 1234567,
      brokerTitleShort: 'Test Broker',
    });
  });

  it('maps discovery errors (CH_ACCESS_TOKEN_INVALID) to AUTHENTICATION_FAILED', async () => {
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);
    server.on(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, (_payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
      payload: { errorCode: 'CH_ACCESS_TOKEN_INVALID', description: 'token revoked' },
    }));
    await expect(client.discoverAccounts('DEMO', ACCESS_TOKEN)).rejects.toMatchObject({
      code: BrokerErrorCode.AUTHENTICATION_FAILED,
    });
  });

  // ─── Event waiting (server-initiated messages) ─────────────────────────────

  it('resolves awaitEvent for server-initiated events and times out otherwise', async () => {
    jest.useFakeTimers();
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN);
    const transport = client.createdTransports[0];

    const waiter = client.awaitEvent(
      'DEMO',
      (message) => message.payloadType === CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
    );
    const spotEvent: CtraderMessageEnvelope = {
      payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
      payload: { symbolId: 101, bid: 108650, ask: 108700 },
    };
    transport.receive(spotEvent);
    await expect(waiter).resolves.toMatchObject({
      payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
      payload: { symbolId: 101, bid: 108650, ask: 108700 },
    });

    const lonely = client.awaitEvent(
      'DEMO',
      (message) => message.payloadType === CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
    );
    const lonelyAssertion = expect(lonely).rejects.toMatchObject({
      code: BrokerErrorCode.CONNECTION_TIMEOUT,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await lonelyAssertion;
  });

  it('rejects awaitEvent when the environment is not connected', async () => {
    await expect(client.awaitEvent('LIVE', () => true)).rejects.toMatchObject({
      code: BrokerErrorCode.NOT_CONNECTED,
    });
  });

  // ─── OAuth (token endpoint via native fetch; pure URL builders) ────────────

  describe('OAuth', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('builds the user-consent authorization URL (scope=trading, product=web)', () => {
      const url = buildCtraderAuthorizationUrl('my-client-id', 'https://app.example.com/callback');
      expect(url).toContain('https://id.ctrader.com/my/settings/openapi/grantingaccess/');
      expect(url).toContain(encodeURIComponent('my-client-id'));
      expect(url).toContain(encodeURIComponent('https://app.example.com/callback'));
      expect(url).toContain('scope=trading');
      expect(url).toContain('product=web');
    });

    it('exchanges an authorization code through the token endpoint (native fetch)', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: 'new-access-token',
          tokenType: 'bearer',
          expiresIn: 2_628_000,
          refreshToken: 'new-refresh-token',
        }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const tokens = await client.exchangeToken({
        grantType: 'authorization_code',
        code: 'the-code',
        redirectUri: 'https://app.example.com/callback',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      });

      expect(tokens).toEqual({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 2_628_000,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain('https://openapi.ctrader.com/apps/token');
      expect(calledUrl).toContain('grant_type=authorization_code');
      expect(calledUrl).toContain('client_id=test-client-id');
      expect(calledUrl).toContain('client_secret=test-client-secret');
    });

    it('fails closed with AUTHENTICATION_FAILED when the token endpoint rejects', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ errorCode: 'INVALID_CODE' }),
      }) as unknown as typeof fetch;
      await expect(
        client.exchangeToken({
          grantType: 'authorization_code',
          code: 'bad',
          redirectUri: 'https://app.example.com/callback',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
        }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.AUTHENTICATION_FAILED });
    });

    it('fails closed on HTTP errors and unreachable endpoints', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as unknown as typeof fetch;
      await expect(client.refreshAccessToken('the-refresh-token')).rejects.toMatchObject({
        code: BrokerErrorCode.AUTHENTICATION_FAILED,
      });

      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
      await expect(client.refreshAccessToken('the-refresh-token')).rejects.toMatchObject({
        code: BrokerErrorCode.CONNECTION_TIMEOUT,
      });
    });

    it('parses token responses defensively (pure parser)', () => {
      expect(() => parseCtraderTokenResponse({ accessToken: 'x' })).toThrow(
        expect.objectContaining({ code: BrokerErrorCode.AUTHENTICATION_FAILED }),
      );
      expect(() => parseCtraderTokenResponse('not-an-object')).toThrow(BrokerAdapterError);
    });
  });
});
