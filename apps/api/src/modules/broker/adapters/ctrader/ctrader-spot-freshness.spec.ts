import { ConfigService } from '@nestjs/config';
import { CTraderAdapter } from './ctrader.adapter';
import { CTraderClientService } from './ctrader-client.service';
import { CtraderTransport } from './ctrader-transport';
import { FakeCtraderTransport, ScriptedCtraderServer } from './ctrader.fake-transport';
import { CTRADER_PAYLOAD_TYPE, CtraderMessageEnvelope } from './ctrader-message-types';

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

  it('ignores a stale cached spot event and waits for a fresh provider tick', async () => {
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
