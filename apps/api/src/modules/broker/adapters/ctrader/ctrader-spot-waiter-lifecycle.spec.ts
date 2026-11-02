import { ConfigService } from '@nestjs/config';
import { CTraderAdapter } from './ctrader.adapter';
import { CTraderClientService } from './ctrader-client.service';
import { CtraderTransport } from './ctrader-transport';
import { FakeCtraderTransport, ScriptedCtraderServer } from './ctrader.fake-transport';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import { CTRADER_PAYLOAD_TYPE } from './ctrader-message-types';

const ACCOUNT_ID = '1234567';
const ACCESS_TOKEN = 'test-access-token';

function fakeConfigService(): ConfigService {
  const values: Record<string, string> = {
    'broker.ctraderClientId': 'test-client-id',
    'broker.ctraderClientSecret': 'test-client-secret',
  };
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue ?? '',
  } as unknown as ConfigService;
}

class TestableCtraderClient extends CTraderClientService {
  readonly createdTransports: FakeCtraderTransport[] = [];

  constructor(private readonly server: ScriptedCtraderServer) {
    super(fakeConfigService());
  }

  protected createTransport(): CtraderTransport {
    const transport = new FakeCtraderTransport(this.server);
    this.createdTransports.push(transport);
    return transport;
  }
}

describe('cTrader spot waiter lifecycle', () => {
  let server: ScriptedCtraderServer;
  let client: TestableCtraderClient;
  let adapter: CTraderAdapter;

  beforeEach(() => {
    server = new ScriptedCtraderServer();
    client = new TestableCtraderClient(server);
    adapter = new CTraderAdapter(client);
  });

  afterEach(async () => {
    await client.onModuleDestroy();
  });

  it('does not leak an unhandled spot waiter when subscribe fails before the event is awaited', async () => {
    await adapter.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
    server.on(CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ, (_payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
      payload: {
        errorCode: 'SUBSCRIPTION_FAILED',
        description: 'subscription refused',
      },
    }));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const error = await adapter.getCurrentPrice('EUR/USD').catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(BrokerAdapterError);
      expect(error).toMatchObject({ code: BrokerErrorCode.BROKER_SERVER_ERROR });

      // Reproduce the production shutdown path while the abandoned spot-event
      // waiter is still registered. A leaked waiter rejects here and surfaces
      // as an unhandled rejection on the next event-loop turn.
      await client.onModuleDestroy();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
