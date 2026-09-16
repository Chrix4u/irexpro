import { ConfigService } from '@nestjs/config';
import { CTraderAdapter } from './ctrader.adapter';
import { CTraderClientService } from './ctrader-client.service';
import { CtraderTransport } from './ctrader-transport';
import { FakeCtraderTransport, ScriptedCtraderServer } from './ctrader.fake-transport';
import { BrokerMode, BrokerConnectionResult } from '../../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import {
  CTRADER_ENVIRONMENT_URLS,
  CTRADER_PAYLOAD_TYPE,
  CtraderMessageEnvelope,
} from './ctrader-message-types';

const ACCOUNT_ID = '1234567';
const SECOND_ACCOUNT_ID = '7654321';
const ACCESS_TOKEN = 'test-access-token';
const SECRET_MARKER = 'SK_CTRADER_ADAPTER_LEAK_9f8e7d6c';

function fakeConfigService(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue ?? '',
  } as unknown as ConfigService;
}

/** Testable client: shadows the transport factory with the fake transport. */
class TestableCtraderClient extends CTraderClientService {
  readonly createdTransports: FakeCtraderTransport[] = [];

  constructor(server: ScriptedCtraderServer) {
    super(
      fakeConfigService({
        'broker.ctraderClientId': 'test-client-id',
        'broker.ctraderClientSecret': 'test-client-secret',
      }),
    );
    this.server = server;
  }

  private readonly server: ScriptedCtraderServer;

  protected createTransport(): CtraderTransport {
    const transport = new FakeCtraderTransport(this.server);
    this.createdTransports.push(transport);
    return transport;
  }
}

function buildHarness(): {
  server: ScriptedCtraderServer;
  client: TestableCtraderClient;
  adapter: CTraderAdapter;
} {
  const server = new ScriptedCtraderServer();
  const client = new TestableCtraderClient(server);
  const adapter = new CTraderAdapter(client);
  return { server, client, adapter };
}

function findRequest(
  server: ScriptedCtraderServer,
  payloadType: number,
): CtraderMessageEnvelope | undefined {
  return server.requests.find((r) => r.payloadType === payloadType);
}

function echo(
  payloadType: number,
  payload: Record<string, unknown>,
  envelope: CtraderMessageEnvelope,
): CtraderMessageEnvelope {
  return { clientMsgId: envelope.clientMsgId, payloadType, payload };
}

describe('CTraderAdapter', () => {
  let server: ScriptedCtraderServer;
  let client: TestableCtraderClient;
  let adapter: CTraderAdapter;

  beforeEach(() => {
    ({ server, client, adapter } = buildHarness());
  });

  afterEach(async () => {
    await client.onModuleDestroy();
  });

  async function connectDemo(accountId = ACCOUNT_ID): Promise<BrokerConnectionResult> {
    return adapter.connect({ apiKey: ACCESS_TOKEN, accountId });
  }

  // ─── Connection lifecycle ───────────────────────────────────────────────────

  describe('connect / disconnect', () => {
    it('connects DEMO mode to the DEMO host (hard URL isolation) and returns account info', async () => {
      const result = await connectDemo();

      expect(result.success).toBe(true);
      expect(result.accountId).toBe(ACCOUNT_ID);
      expect(result.accountType).toBe(BrokerMode.DEMO);
      expect(result.currency).toBe('USD');
      expect(result.serverTime).toBeInstanceOf(Date);
      expect(client.createdTransports[0].connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.DEMO);
      // App auth (2100) → account auth (2102) → discovery (2149) → trader (2121)
      // → asset list (2112) all happened on the demo connection.
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.TRADER_REQ)).toBeDefined();
      expect(adapter.isConnected()).toBe(true);
    });

    it('connects LIVE mode to the LIVE host and never the demo host', async () => {
      // The scripted server derives isLive from the host the transport
      // connected to — the LIVE connection serves a live account.
      adapter.setMode(BrokerMode.LIVE);

      const result = await connectDemo();

      expect(result.accountType).toBe(BrokerMode.LIVE);
      expect(client.createdTransports[0].connectedUrl).toBe(CTRADER_ENVIRONMENT_URLS.LIVE);
      expect(client.createdTransports[0].connectedUrl).not.toBe(CTRADER_ENVIRONMENT_URLS.DEMO);
    });

    it('fails closed when the account isLive flag mismatches the selected environment', async () => {
      // Script a DEMO account while LIVE mode (and the live host) is selected.
      server.on(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
          {
            accessToken: payload.accessToken,
            ctidTraderAccount: [
              { ctidTraderAccountId: Number(ACCOUNT_ID), isLive: false, traderLogin: 1234567 },
            ],
          },
          envelope,
        ),
      );
      adapter.setMode(BrokerMode.LIVE);
      await expect(connectDemo()).rejects.toMatchObject({
        code: BrokerErrorCode.AUTHENTICATION_FAILED,
        message: expect.stringContaining('DEMO'),
      });
    });

    it('fails closed when the account is not granted to the access token', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
          {
            accessToken: payload.accessToken,
            ctidTraderAccount: [
              { ctidTraderAccountId: 4242424, isLive: false, traderLogin: 4242424 },
            ],
          },
          envelope,
        ),
      );
      await expect(connectDemo()).rejects.toMatchObject({
        code: BrokerErrorCode.AUTHENTICATION_FAILED,
        message: expect.stringContaining('not granted'),
      });
    });

    it('fails closed without an access token (credentials.apiKey)', async () => {
      await expect(adapter.connect({ accountId: ACCOUNT_ID })).rejects.toMatchObject({
        code: BrokerErrorCode.AUTHENTICATION_FAILED,
        message: expect.stringContaining('access token'),
      });
    });

    it('fails closed on an int64 account id outside the safe-integer range', async () => {
      await expect(
        adapter.connect({ apiKey: ACCESS_TOKEN, accountId: '9007199254740993' }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.BROKER_SERVER_ERROR });
    });

    it('maps connect failures to a sanitized testConnection result', async () => {
      const result = await adapter.testConnection({ accountId: ACCOUNT_ID });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(BrokerErrorCode.AUTHENTICATION_FAILED);
      expect(result.errorMessage).not.toContain(ACCESS_TOKEN);
    });

    it('testConnection succeeds through the normal connect path', async () => {
      const result = await adapter.testConnection({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
      expect(result).toMatchObject({
        success: true,
        accountId: ACCOUNT_ID,
        accountType: BrokerMode.DEMO,
        currency: 'USD',
      });
    });

    it('isConnected flips false after disconnect', async () => {
      await connectDemo();
      expect(adapter.isConnected()).toBe(true);
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });

    it('fails closed with NOT_CONNECTED for every trading call before connect()', async () => {
      await expect(adapter.getAccountInfo()).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'k1',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.1',
          stopLoss: '0',
          takeProfit: '0',
        }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.NOT_CONNECTED });
      await expect(adapter.closeOrder('123')).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
      await expect(adapter.getClosedTrades(new Date(), new Date())).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
    });
  });

  // ─── placeOrder: 2106 wire building ─────────────────────────────────────────

  describe('placeOrder — MARKET order building', () => {
    it('builds ProtoOANewOrderReq with orderType/tradeSide/volume cents and idempotency everywhere', async () => {
      await connectDemo();

      const result = await adapter.placeOrder({
        idempotencyKey: 'idem-key-001',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.10',
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'MARKET',
      });

      const newOrder = findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!;
      expect(newOrder.payload).toMatchObject({
        ctidTraderAccountId: 1234567,
        symbolId: 101,
        orderType: 1, // MARKET
        tradeSide: 1, // BUY
        volume: 1_000_000, // 0.10 lots × 10 000 000 cents/lot
        timeInForce: 3, // IMMEDIATE_OR_CANCEL for MARKET
        clientOrderId: 'idem-key-001',
        label: 'idem-key-001',
        comment: 'idem-key-001',
      });
      // No protection fields on the MARKET wire request (proto forbids them).
      expect(newOrder.payload).not.toHaveProperty('stopLoss');
      expect(newOrder.payload).not.toHaveProperty('takeProfit');
      expect(newOrder.payload).not.toHaveProperty('limitPrice');

      expect(result.success).toBe(true);
      expect(result.status).toBe('FILLED');
      expect(result.externalOrderId).toBe('7654321');
      expect(result.filledPrice).toBe('1.08651');
      expect(result.filledQuantity).toBe('0.1'); // deal.filledVolume as lots
      expect(result.filledAt).toEqual(new Date(1757000000123));
    });

    it('maps timeInForce FOK to FILL_OR_KILL (4) on the wire', async () => {
      await connectDemo();
      await adapter.placeOrder({
        idempotencyKey: 'k-fok',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'MARKET',
        timeInForce: 'FOK',
      });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!.payload).toMatchObject({
        timeInForce: 4,
      });
    });

    it('maps timeInForce DAY to GOOD_TILL_DATE (1) with an end-of-day expirationTimestamp', async () => {
      await connectDemo();
      await adapter.placeOrder({
        idempotencyKey: 'k-day',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'LIMIT',
        limitPrice: '1.085',
        timeInForce: 'DAY',
      });
      const payload = findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!.payload;
      expect(payload).toMatchObject({ timeInForce: 1 });
      const expiration = (payload as { expirationTimestamp?: number }).expirationTimestamp;
      expect(expiration).toBeGreaterThan(Date.now());
      // Next UTC midnight — at most 24h away.
      expect(expiration!).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
      expect(new Date(expiration!).toISOString().endsWith('T00:00:00.000Z')).toBe(true);
    });

    it('routes a caller-supplied clientOrderId into the proto clientOrderId field', async () => {
      await connectDemo();
      await adapter.placeOrder({
        idempotencyKey: 'idem-key-002',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'LIMIT',
        limitPrice: '1.085',
        clientOrderId: 'stable-caller-order-id-42',
      });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!.payload).toMatchObject({
        clientOrderId: 'stable-caller-order-id-42',
        label: 'idem-key-002', // idempotency key still on label/comment
        comment: 'idem-key-002',
      });
    });

    it('maps SELL direction to tradeSide 2', async () => {
      await connectDemo();
      await adapter.placeOrder({
        idempotencyKey: 'k',
        instrument: 'EUR/USD',
        direction: 'SELL',
        lotSize: '0.01',
        stopLoss: '0',
        takeProfit: '0',
      });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!.payload).toMatchObject({
        tradeSide: 2,
        volume: 100_000,
      });
    });

    it('attaches MARKET-order SL/TP to the filled position via 2110 (proto: unsupported on 2106)', async () => {
      await connectDemo();

      await adapter.placeOrder({
        idempotencyKey: 'k-protected',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.10',
        stopLoss: '1.08000',
        takeProfit: '1.11000',
        orderKind: 'MARKET',
      });

      const amend = findRequest(server, CTRADER_PAYLOAD_TYPE.AMEND_POSITION_SLTP_REQ)!;
      expect(amend.payload).toMatchObject({
        ctidTraderAccountId: 1234567,
        positionId: 7654321, // the position from the execution event
        stopLoss: 1.08,
        takeProfit: 1.11,
      });
    });

    it('resolves instruments by normalized name (EURUSD, EUR/USD, eur-usd are the same symbol)', async () => {
      await connectDemo();
      for (const alias of ['EURUSD', 'EUR/USD', 'eur-usd']) {
        await adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: alias,
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
        });
        expect(findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!.payload).toMatchObject({
          symbolId: 101,
        });
      }
    });

    it('fails closed with INVALID_INSTRUMENT before any order request for an unknown symbol', async () => {
      await connectDemo();
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'NOPE/XXX',
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
        }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.INVALID_INSTRUMENT });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)).toBeUndefined();
    });

    it('fails closed with INVALID_LOT_SIZE for volumes not representable in whole cents', async () => {
      await connectDemo();
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.00000005',
          stopLoss: '0',
          takeProfit: '0',
        }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.INVALID_LOT_SIZE });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)).toBeUndefined();
    });

    it('routes the request to the connectionReference account when provided', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
          {
            accessToken: payload.accessToken,
            ctidTraderAccount: [
              { ctidTraderAccountId: 1234567, isLive: false, traderLogin: 1234567 },
              { ctidTraderAccountId: 7654321, isLive: false, traderLogin: 7654321 },
            ],
          },
          envelope,
        ),
      );
      await connectDemo(ACCOUNT_ID);
      await connectDemo(SECOND_ACCOUNT_ID);

      await adapter.placeOrder({
        idempotencyKey: 'k',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '0',
        takeProfit: '0',
        connectionReference: SECOND_ACCOUNT_ID,
      });

      const newOrder = findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!;
      expect(newOrder.payload).toMatchObject({ ctidTraderAccountId: 7654321 });
    });
  });

  describe('placeOrder — LIMIT / STOP / STOP_LIMIT wire building', () => {
    it('builds a LIMIT order with limitPrice + absolute SL/TP + GOOD_TILL_CANCEL', async () => {
      await connectDemo();
      await adapter.placeOrder({
        idempotencyKey: 'k-limit',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.10',
        stopLoss: '1.08000',
        takeProfit: '1.11000',
        orderKind: 'LIMIT',
        limitPrice: '1.08500',
      });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!.payload).toMatchObject({
        orderType: 2, // LIMIT
        limitPrice: 1.085,
        timeInForce: 2, // GOOD_TILL_CANCEL
        stopLoss: 1.08,
        takeProfit: 1.11,
      });
    });

    it('builds a STOP order with stopPrice and no limitPrice', async () => {
      await connectDemo();
      await adapter.placeOrder({
        idempotencyKey: 'k-stop',
        instrument: 'EUR/USD',
        direction: 'SELL',
        lotSize: '0.10',
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'STOP',
        stopPrice: '1.09500',
      });
      const payload = findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!.payload;
      expect(payload).toMatchObject({ orderType: 3, stopPrice: 1.095 });
      expect(payload).not.toHaveProperty('limitPrice');
    });

    it('builds a STOP_LIMIT order with both stopPrice and limitPrice', async () => {
      await connectDemo();
      await adapter.placeOrder({
        idempotencyKey: 'k-stoplimit',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.10',
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'STOP_LIMIT',
        stopPrice: '1.09000',
        limitPrice: '1.09500',
      });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)!.payload).toMatchObject({
        orderType: 6, // STOP_LIMIT
        stopPrice: 1.09,
        limitPrice: 1.095,
      });
    });

    it('fails closed with INVALID_PRICE when prices are missing (guard)', async () => {
      await connectDemo();
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
          orderKind: 'LIMIT',
        }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.INVALID_PRICE });
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
          orderKind: 'STOP',
        }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.INVALID_PRICE });
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
          orderKind: 'STOP_LIMIT',
          stopPrice: '1.09',
        }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.INVALID_PRICE });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ)).toBeUndefined();
    });
  });

  // ─── placeOrder: execution event mapping (the ASYNC order response) ─────────

  describe('placeOrder — ProtoOAExecutionEvent mapping', () => {
    async function scriptExecution(executionType: number): Promise<void> {
      server.on(CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            executionType,
            order: { orderId: 888, orderType: payload.orderType, orderStatus: 2 },
          },
          envelope,
        ),
      );
      await connectDemo();
    }

    it('maps ORDER_PARTIAL_FILL (11) to a FILLED result', async () => {
      await scriptExecution(11);
      const result = await adapter.placeOrder({
        idempotencyKey: 'k',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '0',
        takeProfit: '0',
      });
      expect(result.status).toBe('FILLED');
      expect(result.success).toBe(true);
      expect(result.brokerMessage).toContain('partially filled');
    });

    it('maps ORDER_ACCEPTED (2) to a PENDING result with the orderId', async () => {
      await scriptExecution(2);
      const result = await adapter.placeOrder({
        idempotencyKey: 'k',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'LIMIT',
        limitPrice: '1.085',
      });
      expect(result).toMatchObject({ status: 'PENDING', success: true, externalOrderId: '888' });
    });

    it('maps ORDER_REJECTED (7) to a REJECTED result with the errorCode message', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            executionType: 7,
            errorCode: 'TRADING_BAD_VOLUME',
            order: { orderId: 889, orderStatus: 3 },
          },
          envelope,
        ),
      );
      await connectDemo();
      const result = await adapter.placeOrder({
        idempotencyKey: 'k',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '0',
        takeProfit: '0',
      });
      expect(result).toMatchObject({
        status: 'REJECTED',
        success: false,
        brokerMessage: 'TRADING_BAD_VOLUME',
      });
    });

    it('reports filledQuantity for a PARTIAL fill (Sprint 50 PR-3)', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            executionType: 11, // ORDER_PARTIAL_FILL
            order: {
              orderId: 890,
              orderType: payload.orderType,
              orderStatus: 1,
              executedVolume: 300_000, // 0.03 of the requested 0.10 lots
            },
            deal: {
              dealId: 891,
              orderId: 890,
              positionId: 892,
              volume: 1_000_000,
              filledVolume: 300_000,
              symbolId: payload.symbolId,
              createTimestamp: 1757000000000,
              executionTimestamp: 1757000000123,
              executionPrice: 1.08651,
              tradeSide: payload.tradeSide,
              dealStatus: 3, // PARTIALLY_FILLED
            },
          },
          envelope,
        ),
      );
      await connectDemo();

      const result = await adapter.placeOrder({
        idempotencyKey: 'k-partial',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.10',
        stopLoss: '0',
        takeProfit: '0',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('FILLED');
      expect(result.brokerMessage).toContain('partially filled');
      expect(result.filledQuantity).toBe('0.03'); // 300 000 cents as lots
      expect(result.filledPrice).toBe('1.08651');
    });

    it('fails closed with a typed protocol error when an account event answers an order request', async () => {
      await scriptExecution(10); // DEPOSIT_WITHDRAW — never a new-order response
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
        }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.BROKER_SERVER_ERROR });
    });
  });

  // ─── placeOrder: provider error mapping ────────────────────────────────────

  describe('placeOrder — provider error mapping', () => {
    it.each([
      ['NOT_ENOUGH_MONEY', BrokerErrorCode.INSUFFICIENT_MARGIN],
      ['TRADING_BAD_VOLUME', BrokerErrorCode.INVALID_LOT_SIZE],
      ['SYMBOL_NOT_FOUND', BrokerErrorCode.INVALID_INSTRUMENT],
      ['MARKET_CLOSED', BrokerErrorCode.MARKET_CLOSED],
      ['CH_CLIENT_AUTH_FAILURE', BrokerErrorCode.AUTHENTICATION_FAILED],
      ['REQUEST_FREQUENCY_EXCEEDED', BrokerErrorCode.RATE_LIMITED],
      ['PROTECTION_IS_TOO_CLOSE_TO_MARKET', BrokerErrorCode.INVALID_REQUEST],
    ])('maps the ProtoOAOrderErrorEvent errorCode %s to %s', async (errorCode, expected) => {
      server.on(CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.ORDER_ERROR_EVENT,
          { ctidTraderAccountId: payload.ctidTraderAccountId, errorCode, description: 'rejected' },
          envelope,
        ),
      );
      await connectDemo();
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
        }),
      ).rejects.toMatchObject({ code: expected });
    });

    it('maps a ProtoOAErrorRes (2142) answer to a typed error', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
          { errorCode: 'NOT_ENOUGH_MONEY', description: 'insufficient funds' },
          envelope,
        ),
      );
      await connectDemo();
      await expect(
        adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
        }),
      ).rejects.toMatchObject({ code: BrokerErrorCode.INSUFFICIENT_MARGIN });
    });

    it('never leaks credential-shaped raw provider text (redaction)', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.ORDER_ERROR_EVENT,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            errorCode: 'CH_CLIENT_AUTH_FAILURE',
            description: `apiKey=${SECRET_MARKER} rejected by provider`,
          },
          envelope,
        ),
      );
      await connectDemo();
      const assertion = expect(
        adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
        }),
      ).rejects.toThrow(BrokerAdapterError);
      await assertion;
      // The error message must carry the redacted form, never the marker.
      try {
        await adapter.placeOrder({
          idempotencyKey: 'k',
          instrument: 'EUR/USD',
          direction: 'BUY',
          lotSize: '0.01',
          stopLoss: '0',
          takeProfit: '0',
        });
      } catch (err) {
        const message = (err as BrokerAdapterError).message;
        expect(message).not.toContain(SECRET_MARKER);
        expect(message).toContain('[REDACTED]');
        expect((err as BrokerAdapterError).brokerMessage ?? '').not.toContain(SECRET_MARKER);
      }
    });
  });

  // ─── Reconciliation mapping (2124) ─────────────────────────────────────────

  function scriptReconcile(positions: unknown[], orders: unknown[]): void {
    server.on(CTRADER_PAYLOAD_TYPE.RECONCILE_REQ, (payload, envelope) =>
      echo(
        CTRADER_PAYLOAD_TYPE.RECONCILE_RES,
        { ctidTraderAccountId: payload.ctidTraderAccountId, position: positions, order: orders },
        envelope,
      ),
    );
  }

  const SAMPLE_POSITION = {
    positionId: 7654321,
    tradeData: {
      symbolId: 101,
      volume: 1_000_000,
      tradeSide: 1,
      openTimestamp: 1757000000000,
      label: 'irexpro',
    },
    positionStatus: 1, // OPEN
    swap: -120,
    price: 1.0865,
    stopLoss: 1.08,
    takeProfit: 1.1,
    usedMargin: 300_000,
    commission: 250,
    moneyDigits: 2,
  };

  describe('getOpenPositions / getPositionById', () => {
    it('maps reconciled positions to BrokerPosition (lots, prices, PnL, commission, swap)', async () => {
      scriptReconcile([SAMPLE_POSITION], []);
      server.on(CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_RES,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            positionUnrealizedPnL: [
              { positionId: 7654321, grossUnrealizedPnL: 15000, netUnrealizedPnL: 12345 },
            ],
            moneyDigits: 2,
          },
          envelope,
        ),
      );
      await connectDemo();

      const positions = await adapter.getOpenPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({
        externalOrderId: '7654321',
        instrument: 'EUR/USD',
        direction: 'BUY',
        lotSize: '0.1',
        openPrice: '1.0865',
        currentPrice: '1.08675', // mid of scripted spot 108650/108700
        stopLoss: '1.08',
        takeProfit: '1.1',
        unrealisedPnl: '123.45',
        openedAt: new Date(1757000000000),
        commission: '2.50',
        swap: '-1.20',
      });
    });

    it('ignores non-OPEN positions (CLOSED/CREATED) and returns null for unknown ids', async () => {
      scriptReconcile(
        [
          { ...SAMPLE_POSITION, positionId: 111, positionStatus: 2 },
          { ...SAMPLE_POSITION, positionId: 222, positionStatus: 3 },
        ],
        [],
      );
      await connectDemo();

      expect(await adapter.getOpenPositions()).toHaveLength(0);
      expect(await adapter.getPositionById('111')).toBeNull();
    });

    it('returns a single mapped position by id', async () => {
      scriptReconcile([SAMPLE_POSITION], []);
      server.on(CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_RES,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            positionUnrealizedPnL: [],
            moneyDigits: 2,
          },
          envelope,
        ),
      );
      await connectDemo();

      const position = await adapter.getPositionById('7654321');
      expect(position?.externalOrderId).toBe('7654321');
      expect(position?.instrument).toBe('EUR/USD');
      expect(position?.unrealisedPnl).toBe('0.00');
    });
  });

  describe('listOrders (Sprint 50 PR-4 — provider order state)', () => {
    it('maps WORKING orders from reconciliation into BrokerOrderState and filters non-contract types', async () => {
      scriptReconcile(
        [],
        [
          {
            orderId: 555,
            tradeData: {
              symbolId: 101,
              volume: 1_000_000,
              tradeSide: 2,
              openTimestamp: 1757000000000,
            },
            orderType: 2, // LIMIT
            orderStatus: 1, // ACCEPTED (working)
            limitPrice: 1.09,
            stopLoss: 1.08,
            takeProfit: 1.1,
            executedVolume: 0,
            clientOrderId: 'caller-order-id-555',
            timeInForce: 2, // GOOD_TILL_CANCEL
            utcLastUpdateTimestamp: 1757000009999,
          },
          {
            orderId: 556,
            tradeData: {
              symbolId: 101,
              volume: 1_000_000,
              tradeSide: 1,
              openTimestamp: 1757000000000,
            },
            orderType: 4, // STOP_LOSS_TAKE_PROFIT — outside the normalized contract
            orderStatus: 1,
          },
          {
            orderId: 557,
            tradeData: {
              symbolId: 101,
              volume: 1_000_000,
              tradeSide: 1,
              openTimestamp: 1757000000000,
            },
            orderType: 2,
            orderStatus: 2, // FILLED — not working
          },
        ],
      );
      await connectDemo();

      const orders = await adapter.listOrders();
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        providerOrderId: '555',
        clientOrderId: 'caller-order-id-555',
        status: 'WORKING',
        instrument: 'EUR/USD',
        direction: 'SELL',
        requestedQuantity: '0.1',
        filledQuantity: '0',
        orderKind: 'LIMIT',
        limitPrice: '1.09',
        stopPrice: null,
        avgFillPrice: null,
        timeInForce: 'GTC',
        placedAt: new Date(1757000000000),
        updatedAt: new Date(1757000009999),
      });
    });

    it('maps a partially executed WORKING order to PARTIALLY_FILLED', async () => {
      scriptReconcile(
        [],
        [
          {
            orderId: 558,
            tradeData: {
              symbolId: 101,
              volume: 1_000_000,
              tradeSide: 1,
              openTimestamp: 1757000000000,
            },
            orderType: 2, // LIMIT
            orderStatus: 1, // ACCEPTED — still working
            limitPrice: 1.09,
            executedVolume: 400_000, // 0.04 of the requested 0.10
            executionPrice: 1.0866,
            timeInForce: 3, // IOC
          },
        ],
      );
      await connectDemo();

      const orders = await adapter.listOrders();
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        providerOrderId: '558',
        status: 'PARTIALLY_FILLED',
        requestedQuantity: '0.1',
        filledQuantity: '0.04',
        avgFillPrice: '1.0866',
        timeInForce: 'IOC',
      });
    });

    it('fails closed with NOT_CONNECTED before connect()', async () => {
      await expect(adapter.listOrders()).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
    });
  });

  describe('getOrderById (2181 — including completed orders)', () => {
    it('maps a ProtoOAOrderDetailsRes into BrokerOrderState', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_RES,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            order: {
              orderId: 555,
              tradeData: {
                symbolId: 101,
                volume: 1_000_000,
                tradeSide: 2,
                openTimestamp: 1757000000000,
              },
              orderType: 2, // LIMIT
              orderStatus: 1, // ACCEPTED
              limitPrice: 1.09,
              executedVolume: 0,
              clientOrderId: 'caller-order-id-555',
              timeInForce: 2,
              utcLastUpdateTimestamp: 1757000009999,
            },
            deal: [],
          },
          envelope,
        ),
      );
      await connectDemo();

      const order = await adapter.getOrderById('555');
      expect(order).toMatchObject({
        providerOrderId: '555',
        clientOrderId: 'caller-order-id-555',
        status: 'WORKING',
        instrument: 'EUR/USD',
        direction: 'SELL',
        requestedQuantity: '0.1',
        filledQuantity: '0',
        orderKind: 'LIMIT',
        limitPrice: '1.09',
        timeInForce: 'GTC',
        placedAt: new Date(1757000000000),
        updatedAt: new Date(1757000009999),
      });
      expect(order?.raw).toMatchObject({ orderId: 555 });
    });

    it('maps terminal (history) orders — FILLED with avgFillPrice', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_RES,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            order: {
              orderId: 777,
              tradeData: {
                symbolId: 101,
                volume: 1_000_000,
                tradeSide: 1,
                openTimestamp: 1757000000000,
              },
              orderType: 1, // MARKET
              orderStatus: 2, // FILLED (history)
              executionPrice: 1.08651,
              executedVolume: 1_000_000,
            },
            deal: [],
          },
          envelope,
        ),
      );
      await connectDemo();

      const order = await adapter.getOrderById('777');
      expect(order).toMatchObject({
        providerOrderId: '777',
        status: 'FILLED',
        orderKind: 'MARKET',
        requestedQuantity: '0.1',
        filledQuantity: '0.1',
        avgFillPrice: '1.08651',
      });
    });

    it('returns null ONLY for a legitimate ORDER_NOT_FOUND answer', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_REQ, (payload, envelope) => ({
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
        payload: {
          ctidTraderAccountId: payload.ctidTraderAccountId,
          errorCode: 'ORDER_NOT_FOUND',
          description: 'No such order',
        },
      }));
      await connectDemo();

      expect(await adapter.getOrderById('999999')).toBeNull();
      // A non-numeric id is passed through verbatim — the provider rules.
      expect(await adapter.getOrderById('contract-nonexistent-order')).toBeNull();
      // The request went to the wire in both cases.
      expect(
        server.requests.filter((r) => r.payloadType === CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_REQ),
      ).toHaveLength(2);
    });

    it('fails closed with BROKER_SERVER_ERROR when the order payload is missing', async () => {
      server.on(CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_REQ, (payload, envelope) =>
        echo(CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_RES, { deal: [] }, envelope),
      );
      await connectDemo();

      await expect(adapter.getOrderById('555')).rejects.toMatchObject({
        code: BrokerErrorCode.BROKER_SERVER_ERROR,
      });
    });

    it('fails closed with NOT_CONNECTED before connect()', async () => {
      await expect(adapter.getOrderById('555')).rejects.toMatchObject({
        code: BrokerErrorCode.NOT_CONNECTED,
      });
    });
  });

  // ─── Order lifecycle operations ────────────────────────────────────────────

  describe('closeOrder (2111)', () => {
    it('closes the full position volume by default', async () => {
      scriptReconcile([SAMPLE_POSITION], []);
      await connectDemo();

      const result = await adapter.closeOrder('7654321');
      expect(result.success).toBe(true);
      expect(result.status).toBe('FILLED');
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.CLOSE_POSITION_REQ)!.payload).toMatchObject({
        ctidTraderAccountId: 1234567,
        positionId: 7654321,
        volume: 1_000_000,
      });
    });

    it('converts partial close lot sizes into cents', async () => {
      scriptReconcile([SAMPLE_POSITION], []);
      await connectDemo();

      await adapter.closeOrder('7654321', '0.05');
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.CLOSE_POSITION_REQ)!.payload).toMatchObject({
        positionId: 7654321,
        volume: 500_000,
      });
    });

    it('fails closed with INVALID_LOT_SIZE when the partial close exceeds the position volume', async () => {
      scriptReconcile([SAMPLE_POSITION], []);
      await connectDemo();

      await expect(adapter.closeOrder('7654321', '2')).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_LOT_SIZE,
      });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.CLOSE_POSITION_REQ)).toBeUndefined();
    });

    it('fails closed with POSITION_NOT_FOUND for unknown ids', async () => {
      scriptReconcile([], []);
      await connectDemo();
      await expect(adapter.closeOrder('123')).rejects.toMatchObject({
        code: BrokerErrorCode.POSITION_NOT_FOUND,
      });
    });

    it('maps an ORDER_REJECTED close execution to a REJECTED result', async () => {
      scriptReconcile([SAMPLE_POSITION], []);
      server.on(CTRADER_PAYLOAD_TYPE.CLOSE_POSITION_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            executionType: 7, // ORDER_REJECTED
            errorCode: 'POSITION_NOT_OPEN',
          },
          envelope,
        ),
      );
      await connectDemo();

      const result = await adapter.closeOrder('7654321');
      expect(result).toMatchObject({
        success: false,
        status: 'REJECTED',
        brokerMessage: 'POSITION_NOT_OPEN',
      });
    });
  });

  describe('modifyOrder (2110 positions / 2109 orders)', () => {
    it('amends an open POSITION via ProtoOAAmendPositionSLTPReq with absolute prices', async () => {
      scriptReconcile([SAMPLE_POSITION], []);
      await connectDemo();

      const result = await adapter.modifyOrder('7654321', {
        newStopLoss: '1.075',
        newTakeProfit: '1.11',
      });
      expect(result.success).toBe(true);
      expect(
        findRequest(server, CTRADER_PAYLOAD_TYPE.AMEND_POSITION_SLTP_REQ)!.payload,
      ).toMatchObject({
        ctidTraderAccountId: 1234567,
        positionId: 7654321,
        stopLoss: 1.075,
        takeProfit: 1.11,
      });
    });

    it('amends a WORKING ORDER via ProtoOAAmendOrderReq (SL/TP fields)', async () => {
      scriptReconcile(
        [],
        [
          {
            orderId: 555,
            tradeData: {
              symbolId: 101,
              volume: 1_000_000,
              tradeSide: 1,
              openTimestamp: 1757000000000,
            },
            orderType: 2,
            orderStatus: 1,
          },
        ],
      );
      await connectDemo();

      const result = await adapter.modifyOrder('555', { newStopLoss: '1.07' });
      expect(result.success).toBe(true);
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.AMEND_ORDER_REQ)!.payload).toMatchObject({
        ctidTraderAccountId: 1234567,
        orderId: 555,
        stopLoss: 1.07,
      });
    });

    it('fails closed with POSITION_NOT_FOUND when neither a position nor an order matches', async () => {
      scriptReconcile([], []);
      await connectDemo();
      await expect(adapter.modifyOrder('123', { newStopLoss: '1.07' })).rejects.toMatchObject({
        code: BrokerErrorCode.POSITION_NOT_FOUND,
      });
    });
  });

  describe('cancelOrder (2108)', () => {
    const WORKING_ORDER = [
      {
        orderId: 555,
        tradeData: { symbolId: 101, volume: 1_000_000, tradeSide: 1, openTimestamp: 1757000000000 },
        orderType: 2,
        orderStatus: 1,
      },
    ];

    it('cancels a working order through ProtoOACancelOrderReq', async () => {
      scriptReconcile([], WORKING_ORDER);
      await connectDemo();

      const result = await adapter.cancelOrder('555');
      expect(result.success).toBe(true);
      expect(result.status).toBe('FILLED');
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.CANCEL_ORDER_REQ)!.payload).toMatchObject({
        ctidTraderAccountId: 1234567,
        orderId: 555,
      });
    });

    it('fails closed with POSITION_NOT_FOUND for unknown order ids', async () => {
      scriptReconcile([], []);
      await connectDemo();
      await expect(adapter.cancelOrder('123')).rejects.toMatchObject({
        code: BrokerErrorCode.POSITION_NOT_FOUND,
      });
    });

    it('maps ORDER_CANCEL_REJECTED (8) to a REJECTED result', async () => {
      scriptReconcile([], WORKING_ORDER);
      server.on(CTRADER_PAYLOAD_TYPE.CANCEL_ORDER_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            executionType: 8,
            errorCode: 'UNABLE_TO_CANCEL_ORDER',
          },
          envelope,
        ),
      );
      await connectDemo();

      const result = await adapter.cancelOrder('555');
      expect(result).toMatchObject({ success: false, status: 'REJECTED' });
    });
  });

  describe('closeAllOrders', () => {
    it('closes every open position sequentially and reports counts', async () => {
      scriptReconcile([SAMPLE_POSITION, { ...SAMPLE_POSITION, positionId: 7654399 }], []);
      await connectDemo();

      const result = await adapter.closeAllOrders();
      expect(result.closedCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(result.errors).toHaveLength(0);
      const closes = server.requests.filter(
        (r) => r.payloadType === CTRADER_PAYLOAD_TYPE.CLOSE_POSITION_REQ,
      );
      expect(closes).toHaveLength(2);
    });

    it('counts per-position failures honestly', async () => {
      scriptReconcile([SAMPLE_POSITION], []);
      server.on(CTRADER_PAYLOAD_TYPE.CLOSE_POSITION_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.ORDER_ERROR_EVENT,
          { errorCode: 'POSITION_LOCKED', description: 'cannot close' },
          envelope,
        ),
      );
      await connectDemo();

      const result = await adapter.closeAllOrders();
      expect(result.closedCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.errors[0]).toContain('7654321');
    });
  });

  // ─── Account state (2121 + 2187) ───────────────────────────────────────────

  describe('getAccountInfo / getAccountBalance', () => {
    it('maps the trader payload with moneyDigits + leverageInCents and computes equity/margin as decimal strings', async () => {
      scriptReconcile([SAMPLE_POSITION], []);
      server.on(CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_RES,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            positionUnrealizedPnL: [],
            moneyDigits: 2,
          },
          envelope,
        ),
      );
      await connectDemo();

      const info = await adapter.getAccountInfo();
      expect(info).toMatchObject({
        accountId: ACCOUNT_ID,
        currency: 'USD',
        leverage: 300, // 30000 cents → 1:300
        balance: '100.53099944', // 10 053 099 944 / 10^8 (documented example)
        equity: '100.53099944',
        margin: '3000.00', // position usedMargin 300 000 / 10^2
        freeMargin: '-2899.46900056',
        marginLevel: '3.35',
      });
    });

    it('sums unrealized PnL across positions into equity', async () => {
      scriptReconcile([], []);
      server.on(CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_RES,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            positionUnrealizedPnL: [
              { positionId: 1, grossUnrealizedPnL: 10000, netUnrealizedPnL: 10000 },
              { positionId: 2, grossUnrealizedPnL: 5000, netUnrealizedPnL: 5000 },
            ],
            moneyDigits: 2,
          },
          envelope,
        ),
      );
      await connectDemo();

      const balance = await adapter.getAccountBalance();
      expect(balance.balance).toBe('100.53099944');
      expect(balance.equity).toBe('250.53099944'); // + 150.00 PnL (10 000 + 5 000 / 10^2)
      expect(balance.currency).toBe('USD');
      expect(balance.timestamp).toBeInstanceOf(Date);
    });
  });

  // ─── Margin (2139) ─────────────────────────────────────────────────────────

  describe('getRequiredMargin (2139)', () => {
    function scriptMargin(buyMargin: number, sellMargin: number): void {
      server.on(CTRADER_PAYLOAD_TYPE.EXPECTED_MARGIN_REQ, (payload, envelope) =>
        echo(
          CTRADER_PAYLOAD_TYPE.EXPECTED_MARGIN_RES,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            margin: [{ volume: (payload.volume as number[])[0], buyMargin, sellMargin }],
            moneyDigits: 2,
          },
          envelope,
        ),
      );
    }

    it('uses the buy margin for BUY and the sell margin for SELL (moneyDigits applied)', async () => {
      scriptMargin(400_000, 600_000);
      await connectDemo();

      const buy = await adapter.getRequiredMargin({
        instrument: 'EUR/USD',
        lotSize: '0.10',
        direction: 'BUY',
      });
      expect(buy).toBe('4000.00');

      const sell = await adapter.getRequiredMargin({
        instrument: 'EUR/USD',
        lotSize: '0.10',
        direction: 'SELL',
      });
      expect(sell).toBe('6000.00');

      const request = findRequest(server, CTRADER_PAYLOAD_TYPE.EXPECTED_MARGIN_REQ)!;
      expect(request.payload).toMatchObject({
        ctidTraderAccountId: 1234567,
        symbolId: 101,
        volume: [1_000_000],
      });
    });

    it('returns null (Risk Engine fails closed) for unknown instruments', async () => {
      await connectDemo();
      const margin = await adapter.getRequiredMargin({
        instrument: 'NOPE/XXX',
        lotSize: '0.10',
        direction: 'BUY',
      });
      expect(margin).toBeNull();
    });
  });

  // ─── Market data (2114/2116, 2127→2131, 2137) ──────────────────────────────

  describe('getInstrumentList', () => {
    it('maps symbol details into min/max/step lots and contract size (batched 2116)', async () => {
      await connectDemo();
      const instruments = await adapter.getInstrumentList();

      expect(instruments).toHaveLength(2);
      const eurusd = instruments.find((i) => i.symbol === 'EUR/USD')!;
      expect(eurusd).toMatchObject({
        digits: 5,
        minLot: '0.0001', // 1 000 cents / 10 000 000
        maxLot: '10', // 100 000 000 cents
        lotStep: '0.0001',
        contractSize: '100000.00', // 10 000 000 cents = 100 000 units
      });
      // ONE batched SymbolById request for both symbols.
      const symbolById = findRequest(server, CTRADER_PAYLOAD_TYPE.SYMBOL_BY_ID_REQ)!;
      expect(symbolById.payload?.symbolId).toEqual([101, 102]);
    });
  });

  describe('getCurrentPrice', () => {
    it('subscribes, consumes one spot event and unsubscribes (spot ÷ 100 000)', async () => {
      await connectDemo();
      const price = await adapter.getCurrentPrice('EUR/USD');

      expect(price).toMatchObject({
        instrument: 'EUR/USD',
        bid: '1.08650',
        ask: '1.08700',
        spread: '0.00050',
        timestamp: new Date(1757000000123),
      });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ)!.payload).toMatchObject({
        symbolId: [101],
      });
      expect(findRequest(server, CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_REQ)).toBeDefined();
    });

    it('fails closed with INVALID_INSTRUMENT for unknown symbols', async () => {
      await connectDemo();
      await expect(adapter.getCurrentPrice('NOPE/XXX')).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_INSTRUMENT,
      });
    });
  });

  describe('getOHLCV (2137)', () => {
    it('maps trendbar deltas into exact OHLC decimal strings', async () => {
      await connectDemo();
      const bars = await adapter.getOHLCV('EUR/USD', 'M15', 10);

      const request = findRequest(server, CTRADER_PAYLOAD_TYPE.GET_TRENDBARS_REQ)!;
      expect(request.payload).toMatchObject({ symbolId: 101, period: 7 });

      expect(bars).toHaveLength(1);
      expect(bars[0]).toEqual({
        timestamp: new Date(29116666 * 60_000),
        open: '1.08610', // low 108600 + deltaOpen 10
        high: '1.08690', // low + deltaHigh 90
        low: '1.08600',
        close: '1.08660', // low + deltaClose 60
        volume: '100',
      });
    });

    it('fails closed with INVALID_REQUEST for unknown timeframes', async () => {
      await connectDemo();
      await expect(adapter.getOHLCV('EUR/USD', 'M7', 10)).rejects.toMatchObject({
        code: BrokerErrorCode.INVALID_REQUEST,
      });
    });
  });

  // ─── Trade history (2133, hasMore pagination) ──────────────────────────────

  describe('getClosedTrades', () => {
    function closingDeal(positionId: number, executionTimestamp: number): Record<string, unknown> {
      return {
        dealId: positionId + 1,
        orderId: positionId + 2,
        positionId,
        volume: 1_000_000,
        filledVolume: 1_000_000,
        symbolId: 101,
        createTimestamp: executionTimestamp - 500,
        executionTimestamp,
        executionPrice: 1.09,
        tradeSide: 2,
        dealStatus: 2,
        closePositionDetail: {
          entryPrice: 1.0865,
          grossProfit: 12345,
          swap: -100,
          commission: 250,
          balance: 999,
          closedVolume: 1_000_000,
          moneyDigits: 2,
        },
      };
    }

    it('paginates through hasMore pages and maps closing deals to BrokerClosedTrade', async () => {
      let call = 0;
      server.on(CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ, (payload, envelope) => {
        call += 1;
        if (call === 1) {
          return echo(
            CTRADER_PAYLOAD_TYPE.DEAL_LIST_RES,
            {
              ctidTraderAccountId: payload.ctidTraderAccountId,
              // A non-closing (opening) deal must be filtered out.
              deal: [
                {
                  dealId: 9,
                  orderId: 10,
                  positionId: 99,
                  volume: 1_000_000,
                  filledVolume: 1_000_000,
                  symbolId: 101,
                  executionTimestamp: 1757000000000,
                  tradeSide: 1,
                  dealStatus: 2,
                },
                closingDeal(7654321, 1757000100000),
              ],
              hasMore: true,
            },
            envelope,
          );
        }
        return echo(
          CTRADER_PAYLOAD_TYPE.DEAL_LIST_RES,
          {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            deal: [closingDeal(7654399, 1757000200000)],
            hasMore: false,
          },
          envelope,
        );
      });
      await connectDemo();

      const trades = await adapter.getClosedTrades(
        new Date(1757000000000),
        new Date(1757000300000),
      );

      expect(call).toBe(2);
      expect(trades).toHaveLength(2);
      expect(trades[0]).toMatchObject({
        externalOrderId: '7654321',
        instrument: 'EUR/USD',
        direction: 'SELL',
        lotSize: '0.1',
        openPrice: '1.0865',
        closePrice: '1.09',
        realisedPnl: '123.45',
        commission: '2.50',
        swap: '-1.00',
        closedAt: new Date(1757000100000),
        closeReason: 'UNKNOWN', // honest: cTrader deals carry no close reason
      });
      expect(trades[1].externalOrderId).toBe('7654399');
      // The second page advanced fromTimestamp past the last first-page deal.
      const pages = server.requests.filter(
        (r) => r.payloadType === CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ,
      );
      expect(pages[1].payload).toMatchObject({ fromTimestamp: 1757000100001 });
    });

    it('stops at the first page when hasMore is false', async () => {
      await connectDemo();
      const trades = await adapter.getClosedTrades(new Date(), new Date());
      expect(trades).toHaveLength(0);
      const pages = server.requests.filter(
        (r) => r.payloadType === CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ,
      );
      expect(pages).toHaveLength(1);
    });
  });
});
