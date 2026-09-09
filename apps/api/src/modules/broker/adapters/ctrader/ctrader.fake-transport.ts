/**
 * Shared cTrader test doubles (Sprint 56 / Task 47-C2; Task 48-B port) —
 * TEST INFRASTRUCTURE.
 *
 * Imported ONLY by spec files (never by production code): a scripted fake of
 * the cTrader JSON-WebSocket server + a fake transport that records every
 * outgoing envelope (URL host-isolation assertions) and consults the scripted
 * server for responses.
 *
 * The fake server enforces the protocol invariants the real one does:
 * - ProtoOAApplicationAuthReq (2100) must be the FIRST request — anything
 *   else before it gets a ProtoErrorRes (50, CH_CLIENT_NOT_AUTHENTICATED).
 * - Responses echo the request's clientMsgId.
 * - App credentials are validated (scripted values).
 *
 * Task 48-B additions for the shared §AN contract suite:
 * - An optional send-recorder hook (bridges envelopes into the suite's
 *   ScriptedBackend request records, including the connected base URL).
 * - Failure injection (`failWith`/`restore`) answering every request with a
 *   typed error envelope whose description carries the RAW injected text
 *   (redaction is then asserted on the adapter's normalized error surface).
 * - `reset()` reinstalls the healthy default scripting for re-scripting.
 * - The account-discovery default derives `isLive` from the URL the transport
 *   actually connected to (demo host → demo account, live host → live
 *   account), so DEMO/LIVE routing works without per-mode scripting.
 * - Task 48-a additive send-failure hook: `failNextSends`/`sendFailure` make
 *   the next N send() calls throw the typed transport send error (determines
 *   the client's send-failure surface); default behavior is unchanged.
 */
import { CtraderMessageEnvelope, CTRADER_PAYLOAD_TYPE } from './ctrader-message-types';
import {
  CtraderSendRejectionReason,
  CtraderTransport,
  CtraderTransportSendError,
} from './ctrader-transport';

export type ScriptedHandler = (
  payload: Record<string, unknown>,
  envelope: CtraderMessageEnvelope,
) => CtraderMessageEnvelope | CtraderMessageEnvelope[] | null;

/** Send-recorder hook: observes every outgoing envelope + its base URL. */
export type CtraderSendRecorder = (
  envelope: CtraderMessageEnvelope,
  baseUrl: string | undefined,
) => void;

/** Mirrors the production CtraderTransport interface with recording. */
export class FakeCtraderTransport implements CtraderTransport {
  readonly sentMessages: CtraderMessageEnvelope[] = [];
  connectedUrl: string | undefined;
  /** Scripted connect outcome — 'fail' makes connect() reject (reconnect tests). */
  connectBehavior: 'ok' | 'fail' = 'ok';
  /**
   * Task 48-a additive failure hook: the next N send() calls throw a
   * CtraderTransportSendError carrying `sendFailure` — the message is NOT
   * recorded and the scripted server is NOT consulted (deterministic client
   * send-failure surface). 0 (default) keeps the healthy behavior unchanged.
   */
  failNextSends = 0;
  /** Rejection reason carried by the injected send failures. */
  sendFailure: CtraderSendRejectionReason = 'queue-overflow';
  private openState = false;
  private messageHandler: ((raw: unknown) => void) | null = null;
  private closeHandler: ((code: number | undefined, reason: string) => void) | null = null;
  private readonly server: ScriptedCtraderServer;
  private readonly recorder: CtraderSendRecorder | undefined;

  constructor(server: ScriptedCtraderServer, recorder?: CtraderSendRecorder) {
    this.server = server;
    this.recorder = recorder;
  }

  connect(url: string): Promise<void> {
    this.connectedUrl = url;
    // The server learns the host so account discovery can answer with an
    // isLive flag that MATCHES the connected environment (demo host → demo).
    this.server.noteConnectedUrl(url);
    if (this.connectBehavior === 'fail') {
      this.openState = false;
      return Promise.reject(new Error('scripted connect failure'));
    }
    this.openState = true;
    return Promise.resolve();
  }

  send(message: CtraderMessageEnvelope): void {
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      throw new CtraderTransportSendError(
        this.sendFailure,
        'scripted cTrader fake-transport send failure',
      );
    }
    this.sentMessages.push(message);
    this.recorder?.(message, this.connectedUrl);
    const responses = this.server.handle(message);
    if (responses) {
      for (const response of Array.isArray(responses) ? responses : [responses]) {
        this.receive(response);
      }
    }
  }

  /** Injects a raw inbound message (server push / scripted events). */
  receive(raw: unknown): void {
    if (this.messageHandler) {
      this.messageHandler(raw);
    }
  }

  onMessage(handler: (raw: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number | undefined, reason: string) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.openState = false;
  }

  isOpen(): boolean {
    return this.openState;
  }

  /** Simulates an unexpected server-side disconnect. */
  simulateClose(code = 1000): void {
    this.openState = false;
    if (this.closeHandler) {
      this.closeHandler(code, 'simulated close');
    }
  }

  /** Sent payloads filtered by payloadType. */
  sentPayloads(payloadType: number): Array<Record<string, unknown>> {
    return this.sentMessages
      .filter((message) => message.payloadType === payloadType)
      .map((message) => (message.payload ?? {}) as Record<string, unknown>);
  }
}

/** The scripted cTrader server shared across (re)connected fake transports. */
export class ScriptedCtraderServer {
  private readonly handlers = new Map<number, ScriptedHandler>();
  private readonly oneShotHandlers = new Map<number, ScriptedHandler>();
  readonly requests: CtraderMessageEnvelope[] = [];
  appAuthenticated = false;
  clientId = 'test-client-id';
  clientSecret = 'test-client-secret';
  /** URL of the most recent fake-transport connection (drives isLive). */
  private lastConnectedUrl: string | undefined;
  /** Active failure injection (raw text carried in the error description). */
  private failureDescription: string | undefined;

  constructor() {
    this.installDefaultHandlers();
  }

  /** Replaces the handler for a payloadType. */
  on(payloadType: number, handler: ScriptedHandler): this {
    this.handlers.set(payloadType, handler);
    return this;
  }

  /** One-shot override — the NEXT request of this payloadType uses it. */
  failNext(payloadType: number, response: CtraderMessageEnvelope | null): this {
    this.oneShotHandlers.set(payloadType, () => response);
    return this;
  }

  /**
   * Failure injection (§AN-3/§AN-5/§AN-7a): every subsequent request is
   * answered with a typed error envelope whose description carries the RAW
   * injected text — credential-shaped markers included, so redaction is
   * provable on the adapter's normalized error surface.
   */
  failWith(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.failureDescription = message;
  }

  /** Clears the failure injection (backend "healthy" again). */
  restore(): void {
    this.failureDescription = undefined;
  }

  /** Reinstalls the healthy default scripting (handlers, auth, one-shots). */
  reset(): void {
    this.handlers.clear();
    this.oneShotHandlers.clear();
    this.failureDescription = undefined;
    this.appAuthenticated = false;
    this.installDefaultHandlers();
  }

  /** Records the host a fake transport connected to (drives isLive). */
  noteConnectedUrl(url: string): void {
    this.lastConnectedUrl = url;
  }

  /** True when the scripted server is "serving" the LIVE host. */
  isLiveConnection(): boolean {
    return this.lastConnectedUrl?.includes('live.') ?? false;
  }

  handle(
    envelope: CtraderMessageEnvelope,
  ): CtraderMessageEnvelope | CtraderMessageEnvelope[] | null {
    this.requests.push(envelope);
    const oneShot = this.oneShotHandlers.get(envelope.payloadType);
    if (oneShot) {
      this.oneShotHandlers.delete(envelope.payloadType);
      return oneShot(envelope.payload ?? {}, envelope);
    }
    if (
      !this.appAuthenticated &&
      envelope.payloadType !== CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ &&
      envelope.payloadType !== CTRADER_PAYLOAD_TYPE.HEARTBEAT_EVENT
    ) {
      return {
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.PROTO_ERROR_RES,
        payload: {
          errorCode: 'CH_CLIENT_NOT_AUTHENTICATED',
          description: 'Application must authenticate first',
        },
      };
    }
    if (this.failureDescription !== undefined) {
      return {
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
        payload: {
          errorCode: 'SERVER_IS_UNDER_MAINTENANCE',
          description: this.failureDescription,
        },
      };
    }
    const handler = this.handlers.get(envelope.payloadType);
    if (!handler) {
      return null; // no scripted behavior → the request will time out
    }
    return handler(envelope.payload ?? {}, envelope);
  }

  /** Builds an echo response envelope. */
  static response(
    payloadType: number,
    payload: Record<string, unknown> = {},
  ): CtraderMessageEnvelope {
    return { payloadType, payload };
  }

  private installDefaultHandlers(): void {
    this.on(CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_REQ, (payload, envelope) => {
      if (payload.clientId !== this.clientId || payload.clientSecret !== this.clientSecret) {
        return {
          clientMsgId: envelope.clientMsgId,
          payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
          payload: { errorCode: 'CH_CLIENT_AUTH_FAILURE', description: 'Wrong app credentials' },
        };
      }
      this.appAuthenticated = true;
      return {
        ...ScriptedCtraderServer.response(CTRADER_PAYLOAD_TYPE.APPLICATION_AUTH_RES),
        clientMsgId: envelope.clientMsgId,
      };
    });
    this.on(CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_RES,
      payload: { ctidTraderAccountId: payload.ctidTraderAccountId },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
      payload: {
        accessToken: payload.accessToken,
        permissionScope: 1,
        ctidTraderAccount: [
          {
            ctidTraderAccountId: 1234567,
            // isLive follows the host the transport actually connected to —
            // the DEMO host serves a demo account, the LIVE host a live one.
            isLive: this.isLiveConnection(),
            traderLogin: 1234567,
            brokerTitleShort: 'Test Broker',
          },
        ],
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.TRADER_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.TRADER_RES,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        trader: {
          ctidTraderAccountId: payload.ctidTraderAccountId,
          balance: 10053099944,
          depositAssetId: 1,
          leverageInCents: 30000,
          accountType: 0,
          brokerName: 'Test Broker',
          moneyDigits: 8,
          traderLogin: 1234567,
        },
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.ASSET_LIST_REQ, (_payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.ASSET_LIST_RES,
      payload: {
        asset: [
          { assetId: 1, name: 'USD', displayName: 'United States Dollar', digits: 2 },
          { assetId: 2, name: 'EUR', displayName: 'Euro', digits: 2 },
        ],
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.SYMBOLS_LIST_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.SYMBOLS_LIST_RES,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        symbol: [
          { symbolId: 101, symbolName: 'EUR/USD', enabled: true },
          { symbolId: 102, symbolName: 'GBP/USD', enabled: true },
        ],
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.SYMBOL_BY_ID_REQ, (payload, envelope) => {
      const ids = Array.isArray(payload.symbolId) ? (payload.symbolId as number[]) : [];
      return {
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.SYMBOL_BY_ID_RES,
        payload: {
          symbol: ids.map((symbolId) => ({
            symbolId,
            digits: 5,
            pipPosition: 4,
            minVolume: 1000,
            maxVolume: 100000000,
            stepVolume: 1000,
            lotSize: 10000000,
            tradingMode: 0,
          })),
        },
      };
    });
    this.on(CTRADER_PAYLOAD_TYPE.RECONCILE_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.RECONCILE_RES,
      payload: { ctidTraderAccountId: payload.ctidTraderAccountId, position: [], order: [] },
    }));
    // ProtoOAOrderDetailsReq (2181) — the single-order lookup surface
    // (getOrderById). Echoes a working LIMIT order; specs override via on().
    this.on(CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.ORDER_DETAILS_RES,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        order: {
          orderId: payload.orderId,
          tradeData: {
            symbolId: 101,
            volume: 1_000_000,
            tradeSide: 1,
            openTimestamp: 1757000000000,
          },
          orderType: 2, // LIMIT
          orderStatus: 1, // ACCEPTED (working)
          limitPrice: 1.09,
          executedVolume: 0,
          utcLastUpdateTimestamp: 1757000000000,
        },
        deal: [],
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.GET_POSITION_UNREALIZED_PNL_RES,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        positionUnrealizedPnL: [],
        moneyDigits: 2,
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.NEW_ORDER_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        executionType: 3, // ORDER_FILLED
        position: {
          positionId: 7654321,
          tradeData: {
            symbolId: payload.symbolId,
            volume: payload.volume,
            tradeSide: payload.tradeSide,
            openTimestamp: 1757000000000,
          },
          positionStatus: 1,
          swap: 0,
          price: 1.0865,
        },
        order: {
          orderId: 7654322,
          tradeData: {
            symbolId: payload.symbolId,
            volume: payload.volume,
            tradeSide: payload.tradeSide,
            openTimestamp: 1757000000000,
          },
          orderType: payload.orderType,
          orderStatus: 2,
          executedVolume: payload.volume,
          executionPrice: 1.08651,
          clientOrderId: payload.clientOrderId,
        },
        deal: {
          dealId: 7654323,
          orderId: 7654322,
          positionId: 7654321,
          volume: payload.volume,
          filledVolume: payload.volume,
          symbolId: payload.symbolId,
          createTimestamp: 1757000000000,
          executionTimestamp: 1757000000123,
          executionPrice: 1.08651,
          tradeSide: payload.tradeSide,
          dealStatus: 2,
        },
        isServerEvent: false,
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.CANCEL_ORDER_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        executionType: 5, // ORDER_CANCELLED
        order: {
          orderId: payload.orderId,
          tradeData: { symbolId: 101, volume: 1000000, tradeSide: 1, openTimestamp: 1757000000000 },
          orderType: 2,
          orderStatus: 5,
        },
        isServerEvent: false,
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.AMEND_ORDER_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        executionType: 4, // ORDER_REPLACED
        isServerEvent: false,
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.AMEND_POSITION_SLTP_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        executionType: 4, // ORDER_REPLACED
        position: { positionId: payload.positionId },
        isServerEvent: false,
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.CLOSE_POSITION_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.EXECUTION_EVENT,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        executionType: 3, // ORDER_FILLED
        deal: {
          dealId: 7654399,
          orderId: 7654398,
          positionId: payload.positionId,
          volume: payload.volume,
          filledVolume: payload.volume,
          symbolId: 101,
          createTimestamp: 1757000000000,
          executionTimestamp: 1757000000456,
          executionPrice: 1.087,
          tradeSide: 2,
          dealStatus: 2,
        },
        isServerEvent: false,
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ, (payload, envelope) => {
      const symbolIds = Array.isArray(payload.symbolId) ? (payload.symbolId as number[]) : [];
      // Ack first (echoes clientMsgId), then the technical spot event with
      // the latest price — real-world ordering, event has no clientMsgId.
      return [
        {
          clientMsgId: envelope.clientMsgId,
          payloadType: CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_RES,
          payload: { ctidTraderAccountId: payload.ctidTraderAccountId },
        },
        {
          payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
          payload: {
            ctidTraderAccountId: payload.ctidTraderAccountId,
            symbolId: symbolIds[0] ?? 0,
            bid: 108650,
            ask: 108700,
            timestamp: 1757000000123,
          },
        },
      ];
    });
    this.on(CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_REQ, (_payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.UNSUBSCRIBE_SPOTS_RES,
      payload: {},
    }));
    this.on(CTRADER_PAYLOAD_TYPE.EXPECTED_MARGIN_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.EXPECTED_MARGIN_RES,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        margin: [{ volume: 1000000, buyMargin: 500000, sellMargin: 500000 }],
        moneyDigits: 2,
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.GET_TRENDBARS_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.GET_TRENDBARS_RES,
      payload: {
        ctidTraderAccountId: payload.ctidTraderAccountId,
        period: payload.period,
        symbolId: payload.symbolId,
        trendbar: [
          {
            volume: 100,
            low: 108600,
            deltaOpen: 10,
            deltaClose: 60,
            deltaHigh: 90,
            utcTimestampInMinutes: 29116666,
          },
        ],
      },
    }));
    this.on(CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ, (payload, envelope) => ({
      clientMsgId: envelope.clientMsgId,
      payloadType: CTRADER_PAYLOAD_TYPE.DEAL_LIST_RES,
      payload: { ctidTraderAccountId: payload.ctidTraderAccountId, deal: [], hasMore: false },
    }));
  }
}
