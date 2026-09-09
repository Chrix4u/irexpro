import { ConfigService } from '@nestjs/config';
import { CTraderClientService, CTRADER_MAX_IN_FLIGHT_REQUESTS } from './ctrader-client.service';
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
const OWNER = 'spec-owner';

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

  /** Test seam for the audit-point-4 bounded-transport tests. */
  setInFlightCeiling(limit: number): void {
    this.maxInFlightRequests = limit;
  }

  get inFlightCeiling(): number {
    return this.maxInFlightRequests;
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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);

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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);

    const accountAuths = server.requests.filter(
      (r) => r.payloadType === CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ,
    );
    expect(accountAuths).toHaveLength(1);
  });

  it('fails closed with AUTHENTICATION_FAILED when the platform cTrader app credentials are unconfigured', async () => {
    const unconfigured = new TestableCtraderClient(server, fakeConfigService());
    await expect(
      unconfigured.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER),
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
      client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER),
    ).rejects.toMatchObject({ code: BrokerErrorCode.AUTHENTICATION_FAILED });
  });

  it('fails closed on an unexpected app-auth response payloadType', async () => {
    server.on(CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ, (_payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: 9999,
      payload: {},
    }));
    await expect(
      client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER),
    ).rejects.toMatchObject({ code: BrokerErrorCode.UNKNOWN });
  });

  it('exposes session state through hasAccountSession/isEnvConnected and clears it on removal', async () => {
    expect(client.isAvailable()).toBe(true);
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
    expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
    expect(client.isEnvConnected('DEMO')).toBe(true);
    // LIVE isolation: a different environment has no connection.
    expect(client.isEnvConnected('LIVE')).toBe(false);

    await client.removeAccountSession('DEMO', ACCOUNT_ID, OWNER);
    expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(false);
    expect(client.isEnvConnected('DEMO')).toBe(false);
    expect(client.createdTransports[0].isOpen()).toBe(false);
  });

  // ─── DEMO/LIVE host isolation (hard invariant) ─────────────────────────────

  it('connects DEMO and LIVE to their own hosts and never crosses them', async () => {
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
    expect(client.createdTransports[0].connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.DEMO);

    const liveClient = new TestableCtraderClient(server);
    await liveClient.ensureAccountSession('LIVE', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);

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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);

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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);

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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
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
    await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
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

  // ─── Correction round 1 (audit points 1/2/3/4/5) ───────────────────────────

  describe('bounded serialized transport (audit point 4)', () => {
    it('enforces the in-flight ceiling: requests past the ceiling fail FAST (retryable, never queued)', async () => {
      const limited = new TestableCtraderClient(server);
      limited.setInFlightCeiling(3);
      // No scripted TRADER_REQ answer → requests stay pending.
      server.on(CTRADER_PAYLOAD_TYPE.TRADER_REQ, () => null);
      await limited.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      const transport = limited.createdTransports[0];

      const pending = [
        limited.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, { ctidTraderAccountId: 1234567 }),
        limited.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, { ctidTraderAccountId: 1234567 }),
        limited.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, { ctidTraderAccountId: 1234567 }),
      ];
      await expect(
        limited.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, { ctidTraderAccountId: 1234567 }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.RATE_LIMITED, isRetryable: true });

      // Bounded memory: the wire carries exactly the ceiling's worth of
      // requests — nothing queued past it, no retry/replay duplication.
      expect(
        transport.sentMessages.filter((m) => m.payloadType === CTRADER_PAYLOAD_TYPE.TRADER_REQ),
      ).toHaveLength(3);

      // Disconnect: ALL in-flight requests reject safely (no orphan promises).
      transport.simulateClose();
      await Promise.all(
        pending.map((p) =>
          expect(p).rejects.toMatchObject({
            code: BrokerErrorCode.CONNECTION_LOST,
            isRetryable: true,
          }),
        ),
      );
    });

    it('correlates concurrent requests to their OWN echoed clientMsgId (no cross-talk)', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      const transport = client.createdTransports[0];
      const before = transport.sentMessages.filter(
        (m) => m.payloadType === CTRADER_PAYLOAD_TYPE.TRADER_REQ,
      ).length;

      // 20 CONCURRENT sends in one macrotask — the scripted server echoes
      // clientMsgId; every request must resolve with ITS OWN id, proving the
      // correlation map stays consistent under concurrent dispatch.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
            ctidTraderAccountId: 1234567,
            label: `concurrent-${i}`,
          }),
        ),
      );
      const ids = results.map((r) => r.clientMsgId);
      expect(new Set(ids).size).toBe(20);
      // Wire ordering: sent messages preserve issue order (serialized frame
      // emission — Node's WebSocket.send is atomic per message).
      const sent = transport.sentMessages
        .filter((m) => m.payloadType === CTRADER_PAYLOAD_TYPE.TRADER_REQ)
        .slice(before);
      expect(sent.map((m) => m.clientMsgId)).toEqual(ids);
    });

    it('ships the production in-flight ceiling at the documented 500 bound', () => {
      // Defense-in-depth bound: 50 req/s general (+5/s historical) with a
      // 10 s request timeout yields a worst legal steady state ≈ 505 — the
      // ceiling sits exactly at that boundary, so a stalling provider can
      // never accumulate unbounded pending state even under legal load.
      expect(CTRADER_MAX_IN_FLIGHT_REQUESTS).toBe(500);
      expect(new TestableCtraderClient(server).inFlightCeiling).toBe(500);
    });
  });

  describe('heartbeat liveness hardening (audit point 3)', () => {
    it('runs EXACTLY ONE heartbeat timer across reconnects (no duplicate timers)', async () => {
      jest.useFakeTimers();
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      const transport = client.createdTransports[0];
      // Loss at t=0 — before the first 10 s heartbeat fires on the old
      // transport (stopHeartbeat clears the pending timer immediately).
      transport.simulateClose();
      await jest.advanceTimersByTimeAsync(3_000);
      const reconnected = client.createdTransports[1];
      expect(reconnected).toBeDefined();

      // 40 s on the NEW transport: heartbeats at t=13/23/33/43 s → exactly 4.
      // A duplicate timer (startHeartbeat without stop) would yield ~8.
      await jest.advanceTimersByTimeAsync(40_000);
      const countOn = (t: FakeCtraderTransport) =>
        t.sentMessages.filter((m) => m.payloadType === 51).length;
      expect(countOn(transport)).toBe(0);
      expect(countOn(reconnected)).toBe(4);
    });

    it('stops heartbeats after exhausted reconnect attempts (no zombie timers)', async () => {
      jest.useFakeTimers();
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      client.createdTransports[0].simulateClose();
      // All 5 reconnect attempts fail their connect (3+6+12+24+24 s backoff).
      client.connectBehaviors.push('fail', 'fail', 'fail', 'fail', 'fail');
      await jest.advanceTimersByTimeAsync(120_000);
      const heartbeatsEverywhere = () =>
        client.createdTransports.reduce(
          (n, t) => n + t.sentMessages.filter((m) => m.payloadType === 51).length,
          0,
        );
      // The original transport's timer was cleared at the loss (t=0) and no
      // reconnect ever completed app auth → zero heartbeats anywhere.
      expect(heartbeatsEverywhere()).toBe(0);
      // No zombie timer: another minute of wall time adds nothing.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(heartbeatsEverywhere()).toBe(0);
    });

    it('never sends a heartbeat before application authorization completes', async () => {
      jest.useFakeTimers();
      // 2100 app auth is REJECTED → the connection never authenticates.
      server.on(CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ, (_payload, envelope) => ({
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
        payload: { errorCode: 'CH_CLIENT_AUTH_FAILURE', description: 'Wrong credentials' },
      }));
      await expect(
        client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER),
      ).rejects.toMatchObject({ code: BrokerErrorCode.AUTHENTICATION_FAILED });
      await jest.advanceTimersByTimeAsync(60_000);
      for (const t of client.createdTransports) {
        expect(t.sentMessages.filter((m) => m.payloadType === 51)).toHaveLength(0);
      }
    });

    it('cleans up the heartbeat on intentional module shutdown', async () => {
      jest.useFakeTimers();
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      const transport = client.createdTransports[0];
      await client.onModuleDestroy();
      const at = transport.sentMessages.filter((m) => m.payloadType === 51).length;
      await jest.advanceTimersByTimeAsync(30_000);
      expect(transport.sentMessages.filter((m) => m.payloadType === 51).length).toBe(at);
    });
  });

  describe('demo/live connection separation hardening (audit point 2)', () => {
    it('keeps DEMO and LIVE pools fully isolated: a DEMO loss never disturbs the LIVE session', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      await client.ensureAccountSession('LIVE', '7654321', ACCESS_TOKEN, OWNER);
      const demoTransport = client.createdTransports[0];
      const liveTransport = client.createdTransports[1];

      // Hard host isolation (both connections exist simultaneously).
      expect(demoTransport.connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.DEMO);
      expect(liveTransport.connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.LIVE);

      // DEMO connection dies → the LIVE session stays fully functional.
      demoTransport.simulateClose();
      expect(client.hasAccountSession('LIVE', '7654321')).toBe(true);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(false);

      // DEMO reconnects onto the DEMO host — the original environment is
      // preserved across reconnect (never inherited from the other pool).
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      const reconnectedDemo = client.createdTransports.at(-1)!;
      expect(reconnectedDemo.connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.DEMO);
      expect(reconnectedDemo).not.toBe(liveTransport);
    });

    it('routes a request for the DEMO environment ONLY through the demo-host transport', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      await client.ensureAccountSession('LIVE', '7654321', ACCESS_TOKEN, OWNER);
      const beforeDemo = client.createdTransports[0].sentMessages.length;
      const beforeLive = client.createdTransports[1].sentMessages.length;

      await client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
        ctidTraderAccountId: 1234567,
      });

      // The demo request rode ONLY the demo transport.
      expect(client.createdTransports[0].sentMessages.length).toBeGreaterThan(beforeDemo);
      expect(client.createdTransports[1].sentMessages.length).toBe(beforeLive);
    });
  });

  describe('credential secrecy hardening (audit point 1)', () => {
    it('redacts credential-shaped fragments from provider error text (fail-closed, sanitized)', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      // The raw provider error description carries a credential-shaped
      // fragment — the surfaced BrokerAdapterError must never expose it.
      server.failWith('access token=SEKRIT-TOKEN-VALUE rejected');
      const err = await client
        .request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, { ctidTraderAccountId: 1234567 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BrokerAdapterError);
      const adapterErr = err as BrokerAdapterError;
      expect(adapterErr.message).not.toContain('SEKRIT-TOKEN-VALUE');
      expect(adapterErr.message).toContain('[REDACTED]');
      // The provider's raw error code class is surfaced (typed, no secrets).
      expect(adapterErr.code).toBe(BrokerErrorCode.BROKER_SERVER_ERROR);
    });

    it('never logs the platform client secret, access tokens, or message payloads', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      const logged: string[] = [];
      const logger = (client as unknown as { logger: Record<string, jest.Mock> }).logger;
      const spies = ['log', 'warn', 'error'].map((level) =>
        jest.spyOn(logger, level).mockImplementation((m: unknown) => {
          logged.push(String(m));
        }),
      );
      try {
        await client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, {
          ctidTraderAccountId: 1234567,
        });
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
      const all = logged.join('\n');
      expect(all).not.toContain('test-client-secret');
      expect(all).not.toContain(ACCESS_TOKEN);
      // Payload secrecy: no logged line contains any message payload text.
      expect(all).not.toContain('ctidTraderAccountId');
    });
  });

  // ─── Task 48-a: transport send-failure handling (outbound serialization) ──

  describe('transport send failures (Task 48-a — bounded outbound serialization)', () => {
    it("rejects IMMEDIATELY with retryable RATE_LIMITED when the transport send throws 'queue-overflow'", async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      const transport = client.createdTransports[0];
      transport.failNextSends = 1;
      transport.sendFailure = 'queue-overflow';

      const startedAt = Date.now();
      const err = await client
        .request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, { ctidTraderAccountId: 1234567 })
        .catch((e: unknown) => e);
      // Immediate — a leaked pending entry would instead hang for the 10 s
      // request timeout (and the suite would slow down / leave open handles).
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(err).toBeInstanceOf(BrokerAdapterError);
      expect(err).toMatchObject({
        code: BrokerErrorCode.RATE_LIMITED,
        isRetryable: true,
        message: expect.stringContaining('outbound queue is at capacity'),
      });
      // Sanitized: no payload data rides the error.
      expect((err as BrokerAdapterError).message).not.toContain('ctidTraderAccountId');
      // Nothing was written for the rejected request (send failed up front).
      expect(
        transport.sentMessages.filter((m) => m.payloadType === CTRADER_PAYLOAD_TYPE.TRADER_REQ),
      ).toHaveLength(0);
    });

    it("rejects with retryable CONNECTION_LOST when the transport send throws 'not-open'", async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      const transport = client.createdTransports[0];
      transport.failNextSends = 1;
      transport.sendFailure = 'not-open';

      await expect(
        client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, { ctidTraderAccountId: 1234567 }),
      ).rejects.toMatchObject({
        code: BrokerErrorCode.CONNECTION_LOST,
        isRetryable: true,
        message: expect.stringContaining('connection is not open'),
      });
    });

    it('survives a heartbeat send failure: sanitized warn, interval continues, requests recover', async () => {
      jest.useFakeTimers();
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, OWNER);
      const transport = client.createdTransports[0];
      const logged: string[] = [];
      const logger = (client as unknown as { logger: Record<string, jest.Mock> }).logger;
      const warnSpy = jest
        .spyOn(logger, 'warn')
        .mockImplementation((m: unknown) => void logged.push(String(m)));

      try {
        // The next transport send fails (the first heartbeat tick) — the
        // interval callback must catch it: ONE sanitized warn, no unhandled
        // rejection, no crash, and the interval keeps running.
        transport.failNextSends = 1;
        transport.sendFailure = 'queue-overflow';
        await jest.advanceTimersByTimeAsync(10_000);
        expect(
          transport.sentMessages.filter(
            (m) => m.payloadType === CTRADER_PAYLOAD_TYPE.HEARTBEAT_EVENT,
          ),
        ).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(logged[0]).toContain('heartbeat enqueue failed');
        expect(logged[0]).toContain('queue-overflow');
        expect(logged[0]).toContain('DEMO');
        expect(logged[0]).not.toContain('payload'); // sanitized — reason class only

        // The beat is skipped, not the interval: the NEXT tick succeeds.
        await jest.advanceTimersByTimeAsync(10_000);
        expect(
          transport.sentMessages.filter(
            (m) => m.payloadType === CTRADER_PAYLOAD_TYPE.HEARTBEAT_EVENT,
          ),
        ).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }

      // Send has recovered — a subsequent request resolves normally.
      await expect(
        client.request('DEMO', CTRADER_PAYLOAD_TYPE.TRADER_REQ, { ctidTraderAccountId: 1234567 }),
      ).resolves.toMatchObject({ payloadType: CTRADER_PAYLOAD_TYPE.TRADER_RES });
    });
  });
});
