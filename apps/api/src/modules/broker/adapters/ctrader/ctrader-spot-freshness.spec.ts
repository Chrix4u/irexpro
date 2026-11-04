import { ConfigService } from '@nestjs/config';
import { CTraderAdapter } from './ctrader.adapter';
import { CTraderClientService } from './ctrader-client.service';
import { CtraderTransport } from './ctrader-transport';
import { FakeCtraderTransport, ScriptedCtraderServer } from './ctrader.fake-transport';
import { CTRADER_PAYLOAD_TYPE, CtraderMessageEnvelope } from './ctrader-message-types';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';

const ACCOUNT_ID = '1234567';
const CTID = 1234567;
const ACCESS_TOKEN = 'test-access-token';
const SYMBOL_ID = 101;

function fakeConfigService(): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => {
      if (key === 'broker.ctraderClientId') return 'test-client-id';
      if (key === 'broker.ctraderClientSecret') return 'test-client-secret';
      return defaultValue ?? '';
    },
  } as unknown as ConfigService;
}

class TestableCtraderClient extends CTraderClientService {
  readonly createdTransports: FakeCtraderTransport[] = [];

  constructor(private readonly scriptedServer: ScriptedCtraderServer) {
    super(fakeConfigService());
  }

  protected createTransport(): CtraderTransport {
    const transport = new FakeCtraderTransport(this.scriptedServer);
    this.createdTransports.push(transport);
    return transport;
  }
}

function spotEvent(timestamp: number, bid: number, ask: number): CtraderMessageEnvelope {
  return {
    payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
    payload: {
      ctidTraderAccountId: CTID,
      symbolId: SYMBOL_ID,
      bid,
      ask,
      timestamp,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pendingAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    delay(ms).then(() => true),
    promise.then(
      () => false,
      () => false,
    ),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met within timeout');
    await delay(5);
  }
}

describe('cTrader current-price freshness', () => {
  let server: ScriptedCtraderServer;
  let client: TestableCtraderClient;

  beforeEach(() => {
    server = new ScriptedCtraderServer();
    client = new TestableCtraderClient(server);

    server.on(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
      payload: {
        accessToken: payload.accessToken,
        permissionScope: 1,
        ctidTraderAccount: [
          {
            ctidTraderAccountId: CTID,
            isLive: false,
            traderLogin: CTID,
            brokerTitleShort: 'Test Broker',
          },
        ],
      },
    }));

    server.on(CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_RES,
      payload: { ctidTraderAccountId: payload.ctidTraderAccountId },
    }));
  });

  afterEach(async () => {
    await client.onModuleDestroy();
  });

  it('diagnoses account-scoped missing and stale spot evidence without admitting prices', async () => {
    const adapter = new CTraderAdapter(client);
    await adapter.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
    jest.spyOn(client, 'awaitEvent').mockImplementation((_env, predicate) => {
      // Same environment, unrelated account: must not disclose its activity.
      predicate({
        payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
        payload: { ctidTraderAccountId: CTID + 1, symbolId: SYMBOL_ID, bid: 100, ask: 200 },
      });
      predicate({
        payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
        payload: { ctidTraderAccountId: CTID, symbolId: SYMBOL_ID, bid: 100 },
      });
      predicate({
        payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
        payload: { ctidTraderAccountId: CTID, symbolId: SYMBOL_ID, bid: 100, ask: 200 },
      });
      predicate(spotEvent(Date.now() - 10 * 60_000, 100, 200));
      predicate(spotEvent(Date.now() + 10 * 60_000, 100, 200));
      return Promise.reject(
        new BrokerAdapterError(
          BrokerErrorCode.CONNECTION_TIMEOUT,
          'Timed out waiting for a cTrader DEMO event.',
          undefined,
          true,
        ),
      );
    });

    await expect(adapter.getCurrentPrice('EUR/USD')).rejects.toThrow(
      /matching=4, partial=1, invalidTimestamp=1, staleTimestamp=1, futureTimestamp=1/,
    );
    const unsubscribed = server.requests.filter(
      (request) => request.payloadType === CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_REQ,
    );
    expect(unsubscribed).toHaveLength(1);
  });

  it('distinguishes a silent acknowledged spot subscription from unusable events', async () => {
    const adapter = new CTraderAdapter(client);
    await adapter.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
    jest
      .spyOn(client, 'awaitEvent')
      .mockRejectedValue(
        new BrokerAdapterError(
          BrokerErrorCode.CONNECTION_TIMEOUT,
          'Timed out waiting for a cTrader DEMO event.',
          undefined,
          true,
        ),
      );
    await expect(adapter.getCurrentPrice('EUR/USD')).rejects.toThrow(
      /matching=0, partial=0, invalidTimestamp=0, staleTimestamp=0, futureTimestamp=0/,
    );
  });

  it('recovers a duplicate provider spot subscription with one scoped unsubscribe and retry', async () => {
    const adapter = new CTraderAdapter(client);
    await adapter.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
    let active = true;
    server.on(CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ, (payload, envelope) => {
      if (active)
        return {
          clientMsgId: envelope.clientMsgId,
          payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
          payload: {
            errorCode: 'ALREADY_SUBSCRIBED',
            description: 'An attempt to subscribe twice',
          },
        };
      active = true;
      return {
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_RES,
        payload: { ctidTraderAccountId: payload.ctidTraderAccountId },
      };
    });
    server.on(CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_REQ, (payload, envelope) => {
      active = false;
      return {
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_RES,
        payload: { ctidTraderAccountId: payload.ctidTraderAccountId },
      };
    });
    const pending = adapter.getCurrentPrice('EUR/USD');
    await waitFor(
      () =>
        server.requests.filter((r) => r.payloadType === CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ)
          .length === 2,
    );
    expect(
      server.requests.filter((r) => r.payloadType === CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_REQ),
    ).toHaveLength(1);
    expect(
      server.requests
        .filter((r) => r.payloadType === CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ)
        .every((r) => r.payload?.subscribeToSpotTimestamp === true),
    ).toBe(true);
    expect(await pendingAfter(pending, 50)).toBe(true);
    client.createdTransports[0]!.receive(spotEvent(Date.now() - 12 * 60_000, 109_000, 109_500));
    expect(await pendingAfter(pending, 50)).toBe(true);
    client.createdTransports[0]!.receive(spotEvent(Date.now(), 109_000, 109_500));
    await expect(pending).resolves.toMatchObject({ bid: '1.09000', ask: '1.09500' });
    await waitFor(
      () =>
        server.requests.filter((r) => r.payloadType === CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_REQ)
          .length === 2,
    );
    expect(active).toBe(false);
  });

  it('fails closed if the duplicate subscription cleanup is rejected', async () => {
    const adapter = new CTraderAdapter(client);
    await adapter.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
    server.on(CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ, (_p, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
      payload: { errorCode: 'ALREADY_SUBSCRIBED', description: 'An attempt to subscribe twice' },
    }));
    server.on(CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_REQ, (_p, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
      payload: { errorCode: 'UNSUBSCRIBE_FAILED', description: 'Provider refused cleanup' },
    }));
    await expect(adapter.getCurrentPrice('EUR/USD')).rejects.toThrow(/Provider refused cleanup/);
    expect(
      server.requests.filter((r) => r.payloadType === CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ),
    ).toHaveLength(1);
    expect(
      server.requests.filter((r) => r.payloadType === CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_REQ),
    ).toHaveLength(1);
  });

  it('opts in to provider timestamps, rejecting missing and stale spot timestamps', async () => {
    const adapter = new CTraderAdapter(client);
    await adapter.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
    const transport = client.createdTransports[0];

    const pricePromise = adapter.getCurrentPrice('EUR/USD');
    await waitFor(() =>
      server.requests.some(
        (request) =>
          request.payloadType === CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ &&
          request.payload?.ctidTraderAccountId === CTID,
      ),
    );

    const subscription = server.requests.find(
      (request) => request.payloadType === CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ,
    );
    // Without the opt-in, Spotware may omit timestamp; our freshness waiter
    // would never accept any event, resulting in repeated ten-second timeouts.
    expect(subscription?.payload).toMatchObject({ subscribeToSpotTimestamp: true });

    transport.receive({
      payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
      payload: {
        ctidTraderAccountId: CTID,
        symbolId: SYMBOL_ID,
        bid: 107_000,
        ask: 107_500,
      },
    });
    expect(await pendingAfter(pricePromise, 50)).toBe(true);

    transport.receive(spotEvent(Date.now() - 10 * 60_000, 107_000, 107_500));
    expect(await pendingAfter(pricePromise, 150)).toBe(true);

    transport.receive(spotEvent(Date.now(), 109_000, 109_500));
    await expect(pricePromise).resolves.toMatchObject({
      instrument: 'EUR/USD',
      bid: '1.09000',
      ask: '1.09500',
    });
  });
});
