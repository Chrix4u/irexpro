/**
 * CTraderAdapter — application of the shared Directive §AN broker adapter
 * contract suite (Task 48-B port onto main's contract suite).
 *
 * The suite is driven against the REAL adapter with the REAL cTrader
 * JSON-WebSocket protocol scripted through the shared test doubles
 * (ScriptedCtraderServer + FakeCtraderTransport). A thin ScriptedBackend
 * bridge adapts the WS world to the suite's HTTP-shaped ScriptedBackend
 * port: every outgoing envelope is recorded with the base URL its
 * transport is connected to (§AN-4 DEMO/LIVE routing assertions) and
 * failure injection answers every request with a typed error envelope
 * whose description carries the RAW injected text (redaction is then
 * asserted on the adapter's normalized error surface, §AN-3/§AN-5).
 */
import { ConfigService } from '@nestjs/config';
import { BrokerMode, IBrokerAdapter } from '../../interfaces/broker-adapter.interface';
import {
  ContractSuiteContext,
  runBrokerAdapterContractSuite,
  ScriptedBackend,
  ScriptedRequestRecord,
} from '../contract/broker-adapter.contract-suite';
import { CTraderAdapter } from './ctrader.adapter';
import { CTraderClientService } from './ctrader-client.service';
import { CtraderTransport } from './ctrader-transport';
import { FakeCtraderTransport, ScriptedCtraderServer } from './ctrader.fake-transport';
import { CTRADER_ENVIRONMENT_URLS, CTRADER_PAYLOAD_TYPE } from './ctrader-message-types';

const SECRET = 'contract-ctrader-access-token-DO-NOT-LEAK';
const ACCOUNT_ID = '1234567';

function fakeConfigService(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue ?? '',
  } as unknown as ConfigService;
}

/**
 * ScriptedBackend bridge over the scripted cTrader WebSocket server. The
 * adapter never calls request() directly (it speaks WebSocket); the bridge
 * exists to satisfy the suite's port, record outgoing envelopes, and route
 * failWith/restore into the server's failure injection.
 */
class CtraderScriptedBackend implements ScriptedBackend {
  readonly requests: ScriptedRequestRecord[] = [];

  constructor(readonly server: ScriptedCtraderServer) {}

  request<T>(): Promise<T> {
    // Transport-backed cTrader requests flow through the WebSocket, never
    // through this HTTP-shaped port.
    return Promise.reject(
      new Error('contract suite: cTrader adapter speaks WebSocket — bridge request() is unused'),
    );
  }

  failWith(error: unknown): void {
    this.server.failWith(error);
  }

  restore(): void {
    this.server.restore();
  }

  resetRequests(): void {
    this.requests.length = 0;
  }

  /** Records one outgoing envelope with the URL its transport is on. */
  record(
    envelope: { payloadType: number; payload?: Record<string, unknown> | null },
    baseUrl: string | undefined,
  ): void {
    this.requests.push({
      method: 'WS',
      baseUrl: baseUrl ?? '',
      path: String(envelope.payloadType),
      headers: {},
      body: envelope.payload ?? {},
    });
  }
}

/** Testable client: shadows the transport factory with the fake transport. */
class TestableCtraderClient extends CTraderClientService {
  constructor(private readonly bridge: CtraderScriptedBackend) {
    super(
      fakeConfigService({
        'broker.ctraderClientId': 'test-client-id',
        'broker.ctraderClientSecret': 'test-client-secret',
      }),
    );
  }

  protected createTransport(): CtraderTransport {
    return new FakeCtraderTransport(this.bridge.server, (envelope, url) =>
      this.bridge.record(envelope, url),
    );
  }
}

/**
 * The harness (server + bridge + client + adapter) is FRESH per
 * createAdapter() call; created clients are collected so the file-level
 * afterEach can dispose their heartbeat timers.
 */
const server = new ScriptedCtraderServer();
const backend = new CtraderScriptedBackend(server);
const createdClients: TestableCtraderClient[] = [];

afterEach(async () => {
  for (const client of createdClients.splice(0)) {
    await client.onModuleDestroy();
  }
});

const ctx: ContractSuiteContext = {
  brokerId: 'ctrader',
  supportsDemo: true,
  createAdapter: (mode: BrokerMode): IBrokerAdapter => {
    const client = new TestableCtraderClient(backend);
    createdClients.push(client);
    const adapter = new CTraderAdapter(client);
    adapter.setMode(mode);
    return adapter;
  },
  credentials: { apiKey: SECRET, accountId: ACCOUNT_ID },
  scriptedBackend: backend,
  scriptHealthyBackend: () => {
    // Reinstall the healthy default scripting (handlers, auth, one-shots).
    server.reset();
    backend.restore();
    backend.resetRequests();
  },
  scriptOrderNotFound: () => {
    // Legitimate ORDER_NOT_FOUND answer for the single-order lookup (2181).
    server.on(CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        errorCode: 'ORDER_NOT_FOUND',
        description: 'Order not found',
      },
    }));
  },
  observedIdempotencyKey: async (): Promise<string | null> => {
    // The §AN-6 order just placed a LIMIT order — the idempotency key rode
    // the ProtoOANewOrderReq clientOrderId field (≤50 chars, full key).
    const posted = backend.requests.find(
      (request: ScriptedRequestRecord) =>
        request.path === String(CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ),
    );
    const body = posted?.body as { clientOrderId?: string } | undefined;
    return body?.clientOrderId ?? null;
  },
  pricedInstrument: 'EURUSD',
  expectedDemoBaseUrl: CTRADER_ENVIRONMENT_URLS.DEMO,
  expectedLiveBaseUrl: CTRADER_ENVIRONMENT_URLS.LIVE,
};

const registered = runBrokerAdapterContractSuite('CTraderAdapter (Open API JSON-WS)', ctx);

// The suite must have registered all eight contract assertion titles —
// skipped ones included — so no category silently disappears.
describe('CTraderAdapter contract suite registration', () => {
  it('registers all Directive §AN assertion categories', () => {
    expect(registered.length).toBe(8);
  });
});
