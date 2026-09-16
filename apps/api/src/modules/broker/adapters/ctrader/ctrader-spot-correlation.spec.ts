/**
 * cTrader SPOT event correlation — adversarial two-account coverage (Sprint 56
 * correction round 3, architect finding 3; Task 2-a).
 *
 * ONE cTrader environment connection (DEMO) legitimately carries MANY
 * authorized accounts — ProtoOASpotEvent (2131) frames for account B are
 * delivered on the SAME transport as account A's. A waiter registered for
 * account A's quote must NEVER be satisfied by account B's event (cross-
 * account price bleed), nor by a wrong symbol, nor by a partial quote.
 *
 * Client-level tests replicate the adapter's EXACT fetchSpotQuote predicate
 * (payloadType 2131 + ctidTraderAccountId + symbolId + complete bid/ask);
 * the adapter-level test drives the real CTraderAdapter.getCurrentPrice for
 * two adapters sharing ONE client, with B's event injected first.
 *
 * Events are injected through the fake transport's public receive() — the
 * same path the scripted server uses to deliver server-initiated frames.
 * Timing: real short waits only (≤ 300 ms probes, ≤ 500 ms waiter timeouts)
 * — the suite stays well under 15 s.
 */
import { ConfigService } from '@nestjs/config';
import { CTraderAdapter } from './ctrader.adapter';
import { CTraderClientService } from './ctrader-client.service';
import { CtraderTransport } from './ctrader-transport';
import { FakeCtraderTransport, ScriptedCtraderServer } from './ctrader.fake-transport';
import {
  CTRADER_PAYLOAD_TYPE,
  CtraderMessageEnvelope,
  CtraderSpotEventPayload,
} from './ctrader-message-types';
import { BrokerErrorCode } from '../../interfaces/broker-adapter.errors';

const ACCOUNT_A = '1234567';
const ACCOUNT_B = '7654321';
const CTID_A = 1234567;
const CTID_B = 7654321;
const ACCESS_TOKEN = 'test-access-token';
const SYMBOL_ID = 101; // EUR/USD in the scripted symbol list

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

/** A complete SPOT_EVENT envelope for one account/symbol pair. */
function spotEvent(
  ctid: number,
  symbolId: number,
  bid: number,
  ask: number,
  timestamp = 1757000000123,
): CtraderMessageEnvelope {
  return {
    payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
    payload: { ctidTraderAccountId: ctid, symbolId, bid, ask, timestamp },
  };
}

/**
 * EXACT predicate from CTraderAdapter.fetchSpotQuote (architect finding 3):
 * payloadType 2131 + ctidTraderAccountId + symbolId + complete bid/ask.
 * Copied VERBATIM (the production predicate is a private closure) so the
 * client-level tests assert the same correlation the adapter relies on.
 */
function adapterSpotPredicate(
  ctid: number,
  symbolId: number,
): (message: CtraderMessageEnvelope) => boolean {
  return (message) => {
    if (message.payloadType !== CTRADER_PAYLOAD_TYPE.SPOT_EVENT) return false;
    const payload = message.payload as Partial<CtraderSpotEventPayload> | undefined | null;
    return (
      payload?.ctidTraderAccountId === ctid &&
      payload?.symbolId === symbolId &&
      payload.bid != null &&
      payload.ask != null
    );
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * True when `promise` is STILL unsettled after `ms` (settlement — fulfillment
 * OR rejection — resolves false; both outcomes are handled so a racing
 * rejection never becomes an unhandled promise rejection).
 */
function pendingAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    delay(ms).then(() => true),
    promise.then(
      () => false,
      () => false,
    ),
  ]);
}

/** Polls until a condition holds (bounded — fails the test on timeout). */
async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition was not met within the timeout');
    }
    await delay(5);
  }
}

describe('cTrader SPOT event correlation (finding 3 — two accounts, one connection)', () => {
  let server: ScriptedCtraderServer;
  let client: TestableCtraderClient;

  beforeEach(() => {
    server = new ScriptedCtraderServer();
    client = new TestableCtraderClient(server);
  });

  afterEach(async () => {
    await client.onModuleDestroy();
  });

  describe('client level — waiters on the shared environment connection', () => {
    let transport: FakeCtraderTransport;

    beforeEach(async () => {
      // TWO accounts authorized on the SAME DEMO environment connection —
      // distinct lease owners, distinct 2102 authorizations, ONE transport.
      await client.ensureAccountSession('DEMO', ACCOUNT_A, ACCESS_TOKEN, 'owner-A');
      await client.ensureAccountSession('DEMO', ACCOUNT_B, ACCESS_TOKEN, 'owner-B');
      expect(client.createdTransports).toHaveLength(1);
      transport = client.createdTransports[0];
    });

    it("account A's waiter is NOT resolved by account B's spot event on the shared connection", async () => {
      const waiter = client.awaitEvent('DEMO', adapterSpotPredicate(CTID_A, SYMBOL_ID), 500);

      // B's complete quote for the SAME symbol — delivered on A's transport.
      transport.receive(spotEvent(CTID_B, SYMBOL_ID, 111_000, 111_500));

      expect(await pendingAfter(waiter, 250)).toBe(true);

      // A's own quote resolves the waiter — with A's payload, never B's.
      transport.receive(spotEvent(CTID_A, SYMBOL_ID, 109_000, 109_500));
      const resolved = await waiter;
      expect(resolved.payloadType).toBe(CTRADER_PAYLOAD_TYPE.SPOT_EVENT);
      expect(resolved.payload).toMatchObject({
        ctidTraderAccountId: CTID_A,
        symbolId: SYMBOL_ID,
        bid: 109_000,
        ask: 109_500,
      });
    });

    it('an event for the right account but the WRONG SYMBOL does not resolve the waiter', async () => {
      const waiter = client.awaitEvent('DEMO', adapterSpotPredicate(CTID_A, SYMBOL_ID), 400);

      transport.receive(spotEvent(CTID_A, 102, 109_000, 109_500)); // GBP/USD, not EUR/USD

      expect(await pendingAfter(waiter, 150)).toBe(true);
      // Nothing ever matched → the waiter times out (never a wrong-symbol fill).
      await expect(waiter).rejects.toMatchObject({
        code: BrokerErrorCode.CONNECTION_TIMEOUT,
      });
    });

    it('an event with a missing bid or ask (partial quote) does not resolve the waiter', async () => {
      const waiter = client.awaitEvent('DEMO', adapterSpotPredicate(CTID_A, SYMBOL_ID), 400);

      transport.receive({
        payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
        payload: { ctidTraderAccountId: CTID_A, symbolId: SYMBOL_ID }, // no bid, no ask
      });
      transport.receive({
        payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
        payload: { ctidTraderAccountId: CTID_A, symbolId: SYMBOL_ID, bid: 108_650 }, // ask missing
      });
      transport.receive({
        payloadType: CTRADER_PAYLOAD_TYPE.SPOT_EVENT,
        payload: { ctidTraderAccountId: CTID_A, symbolId: SYMBOL_ID, ask: 108_700 }, // bid missing
      });
      // A non-2131 envelope carrying all the right fields must not match either
      // (the payloadType check is part of the correlation predicate).
      transport.receive({
        payloadType: CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_RES,
        payload: { ctidTraderAccountId: CTID_A, symbolId: SYMBOL_ID, bid: 108_650, ask: 108_700 },
      });

      expect(await pendingAfter(waiter, 150)).toBe(true);
      await expect(waiter).rejects.toMatchObject({
        code: BrokerErrorCode.CONNECTION_TIMEOUT,
      });
    });

    it('TWO waiters (one per account, same symbol) each resolve ONLY on their own account event', async () => {
      const waiterA = client.awaitEvent('DEMO', adapterSpotPredicate(CTID_A, SYMBOL_ID), 500);
      const waiterB = client.awaitEvent('DEMO', adapterSpotPredicate(CTID_B, SYMBOL_ID), 500);

      // B's event arrives first: B's waiter resolves, A's stays pending.
      transport.receive(spotEvent(CTID_B, SYMBOL_ID, 111_000, 111_500));
      const resolvedB = await waiterB;
      expect(resolvedB.payload).toMatchObject({ ctidTraderAccountId: CTID_B, bid: 111_000 });
      expect(await pendingAfter(waiterA, 150)).toBe(true);

      // A's event then resolves A's waiter only.
      transport.receive(spotEvent(CTID_A, SYMBOL_ID, 109_000, 109_500));
      const resolvedA = await waiterA;
      expect(resolvedA.payload).toMatchObject({ ctidTraderAccountId: CTID_A, bid: 109_000 });
      expect(resolvedA.payload).not.toMatchObject({ bid: 111_000 });
    });
  });

  // ─── Adapter level: two adapters, ONE client (connection-scoped reality) ────

  describe('adapter level — two CTraderAdapter contexts sharing one client', () => {
    /**
     * Discovery must expose BOTH accounts so each adapter context can connect
     * to its own account on the SAME DEMO environment.
     */
    function scriptTwoAccountDiscovery(): void {
      server.on(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, (payload, envelope) => ({
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
        payload: {
          accessToken: payload.accessToken,
          permissionScope: 1,
          ctidTraderAccount: [
            {
              ctidTraderAccountId: CTID_A,
              isLive: false,
              traderLogin: CTID_A,
              brokerTitleShort: 'Test Broker',
            },
            {
              ctidTraderAccountId: CTID_B,
              isLive: false,
              traderLogin: CTID_B,
              brokerTitleShort: 'Test Broker',
            },
          ],
        },
      }));
    }

    /** Suppresses the scripted auto-emit so quotes are injected adversarially. */
    function scriptAckOnlySpots(): void {
      server.on(CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ, (payload, envelope) => ({
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_RES,
        payload: { ctidTraderAccountId: payload.ctidTraderAccountId },
      }));
    }

    function subscribeSentFor(ctid: number): boolean {
      return server.requests.some(
        (r) =>
          r.payloadType === CTRADER_PAYLOAD_TYPE.SUBSCRIBE_SPOTS_REQ &&
          r.payload?.ctidTraderAccountId === ctid,
      );
    }

    it("A's getCurrentPrice never returns B's price when B's event lands first (shared client)", async () => {
      scriptTwoAccountDiscovery();
      scriptAckOnlySpots();

      const adapterA = new CTraderAdapter(client);
      const adapterB = new CTraderAdapter(client);
      await adapterA.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_A });
      await adapterB.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_B });
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_A)).toBe(1);
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_B)).toBe(1);
      // ONE shared DEMO transport carries both accounts' events.
      expect(client.createdTransports).toHaveLength(1);
      const transport = client.createdTransports[0];

      // A requests a quote; wait until its waiter is registered + subscribed.
      const priceA = adapterA.getCurrentPrice('EUR/USD');
      await waitFor(() => subscribeSentFor(CTID_A));

      // B's quote for the same symbol is delivered FIRST on the shared
      // transport — it must NOT satisfy A's pending quote request.
      transport.receive(spotEvent(CTID_B, SYMBOL_ID, 111_000, 111_500));
      expect(await pendingAfter(priceA, 250)).toBe(true);

      // A's own event resolves A's request with A's price — never B's.
      transport.receive(spotEvent(CTID_A, SYMBOL_ID, 109_000, 109_500));
      const price = await priceA;
      expect(price).toMatchObject({
        instrument: 'EUR/USD',
        bid: '1.09000',
        ask: '1.09500',
      });
      // B's price must never bleed into A's quote.
      expect(price.bid).not.toBe('1.11000');
      expect(price.ask).not.toBe('1.11500');
    });

    it("B's getCurrentPrice (started later) resolves with B's own event, not A's", async () => {
      scriptTwoAccountDiscovery();
      scriptAckOnlySpots();

      const adapterA = new CTraderAdapter(client);
      const adapterB = new CTraderAdapter(client);
      await adapterA.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_A });
      await adapterB.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_B });
      const transport = client.createdTransports[0];

      const priceB = adapterB.getCurrentPrice('EUR/USD');
      await waitFor(() => subscribeSentFor(CTID_B));

      // A's event is delivered while B's request is pending — no match.
      transport.receive(spotEvent(CTID_A, SYMBOL_ID, 109_000, 109_500));
      expect(await pendingAfter(priceB, 150)).toBe(true);

      transport.receive(spotEvent(CTID_B, SYMBOL_ID, 111_000, 111_500));
      const price = await priceB;
      expect(price).toMatchObject({
        instrument: 'EUR/USD',
        bid: '1.11000',
        ask: '1.11500',
      });
    });
  });
});
