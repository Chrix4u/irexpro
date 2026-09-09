/**
 * cTrader transport outbound serialization (Task 48-a — architect finding 1).
 *
 * Deterministic, network-free: NodeWebSocketCtraderTransport is exercised
 * through the CtraderSocketFactory seam with a FakeSocket implementing
 * CtraderSocketLike (records every wire frame, controllable readyState,
 * synchronous open/close/error/message dispatch, optional onSend hook).
 *
 * Proven here:
 * 1. Exact wire order under high-concurrency submission (FIFO through the
 *    bounded queue and through interleaved single-drain writes).
 * 2. Single-drain re-entrancy (a send during an active drain only enqueues).
 * 3. Deterministic queue-overflow backpressure (queue intact, fail-fast).
 * 4. 'not-open' failures (no socket / closed socket / intentional close).
 * 5. Unintentional disconnect clears the queue; nothing further written.
 * 6. Intentional close() clears the queue; connect() resets closed state.
 * 7. Heartbeat frames never jump the request queue.
 * 8. clientMsgId/payload preservation through the queue.
 * 9. DEMO/LIVE queue independence (two transports, two sockets).
 * 10. Payload/token secrecy: message content NEVER appears in any log call.
 * 11. Reconnect-no-replay: queued frames from a dead socket are never
 *     written to a later socket.
 * 12. Malformed inbound frames dropped silently (no crash, no content log).
 */
import { Logger } from '@nestjs/common';
import { CtraderMessageEnvelope, CTRADER_PAYLOAD_TYPE } from './ctrader-message-types';
import {
  CtraderSocketFactory,
  CtraderSocketLike,
  CtraderTransportSendError,
  NodeWebSocketCtraderTransport,
} from './ctrader-transport';

const DEMO_URL = 'wss://demo.ctrader.example:5036';
const LIVE_URL = 'wss://live.ctrader.example:5036';

// WHATWG readyState numbering.
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * Deterministic WebSocket double: implements CtraderSocketLike, records every
 * wire frame verbatim, lets tests drive readyState and dispatch lifecycle
 * events synchronously, and exposes an onSend hook (re-entrancy tests).
 * close() mirrors the real socket: it transitions to CLOSED and eventually
 * dispatches the 'close' event to the registered listeners.
 */
class FakeSocket implements CtraderSocketLike {
  readonly sentFrames: string[] = [];
  readyState: number = CONNECTING;
  /** Number of close(code, reason) API calls the transport made. */
  closedViaApi = 0;
  lastCloseCode: number | undefined;
  lastCloseReason: string | undefined;
  /** Synchronous hook invoked on EVERY send() (re-entrancy scenarios). */
  onSend?: (frame: string, socket: FakeSocket) => void;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sentFrames.push(data);
    this.onSend?.(data, this);
  }

  close(code = 1000, reason = ''): void {
    this.closedViaApi += 1;
    this.lastCloseCode = code;
    this.lastCloseReason = reason;
    this.readyState = CLOSED;
    this.emit('close', { code, reason });
  }

  // ─── Test dispatch helpers ────────────────────────────────────────────────

  dispatchOpen(): void {
    this.readyState = OPEN;
    this.emit('open', {});
  }

  dispatchClose(code = 1006, reason = 'unintentional'): void {
    this.readyState = CLOSED;
    this.emit('close', { code, reason });
  }

  dispatchMessage(data: unknown): void {
    this.emit('message', { data });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

/** Transport + a factory that records every socket it hands out. */
function createHarness(options: { queueCapacity?: number; connectTimeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const factory: CtraderSocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const transport = new NodeWebSocketCtraderTransport({ socketFactory: factory, ...options });
  return { transport, sockets };
}

/** A request-shaped envelope with a distinctive clientMsgId. */
function requestEnvelope(clientMsgId: string, payloadType = 100): CtraderMessageEnvelope {
  return { clientMsgId, payloadType, payload: { clientMsgId } };
}

type ParsedFrame = { clientMsgId?: string; payloadType: number; payload?: Record<string, unknown> };

function parsedFrames(socket: FakeSocket): ParsedFrame[] {
  return socket.sentFrames.map((frame) => JSON.parse(frame));
}

describe('NodeWebSocketCtraderTransport (bounded outbound serialization)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves exact wire order under high-concurrency submission (300 sequential + 50 concurrent)', async () => {
    const { transport, sockets } = createHarness();
    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];

    // Phase 1: 300 sequential sends while CONNECTING (queued, nothing on the wire).
    const expected: string[] = [];
    for (let i = 0; i < 300; i++) {
      const id = `seq-${i}`;
      expected.push(id);
      transport.send(requestEnvelope(id));
    }
    expect(socket.sentFrames).toHaveLength(0);

    // The queue flushes on open in EXACT submission order.
    socket.dispatchOpen();
    await connectPromise;
    expect(socket.sentFrames).toHaveLength(300);

    // Phase 2: 50 "concurrent" sends in one synchronous burst while OPEN —
    // each send re-enters drain(); serialization must keep submission order.
    const burst = Array.from({ length: 50 }, (_, i) => `conc-${i}`);
    for (const id of burst) {
      transport.send(requestEnvelope(id));
    }
    expected.push(...burst);

    expect(socket.sentFrames).toHaveLength(350);
    expect(parsedFrames(socket).map((frame) => frame.clientMsgId)).toEqual(expected);
  });

  it('single-drain re-entrancy: a send during an active drain only enqueues (no lost/duplicated frames, no recursion)', async () => {
    const { transport, sockets } = createHarness();
    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];
    socket.dispatchOpen();
    await connectPromise;

    let reentrancyBudget = 1;
    socket.onSend = () => {
      if (reentrancyBudget > 0) {
        reentrancyBudget -= 1;
        // Synchronous re-entrant send WHILE the drain loop is writing — the
        // draining guard must route it to the queue, and the active loop must
        // pick it up (completing this test at all proves no infinite recursion).
        transport.send({ payloadType: CTRADER_PAYLOAD_TYPE.HEARTBEAT_EVENT, payload: {} });
      }
    };
    transport.send(requestEnvelope('first'));
    transport.send(requestEnvelope('second'));

    expect(socket.sentFrames).toHaveLength(3); // nothing lost, nothing duplicated
    const frames = parsedFrames(socket);
    expect(frames[0].clientMsgId).toBe('first');
    expect(frames[1].payloadType).toBe(CTRADER_PAYLOAD_TYPE.HEARTBEAT_EVENT);
    expect(frames[2].clientMsgId).toBe('second');

    // The transport is healthy afterwards (queue empty, drain finished).
    transport.send(requestEnvelope('third'));
    expect(socket.sentFrames).toHaveLength(4);
    expect(parsedFrames(socket).at(-1)?.clientMsgId).toBe('third');
  });

  it('enforces the queue ceiling deterministically (capacity 5 while CONNECTING: 5 OK, 6th throws, the 5 flush in order)', async () => {
    const { transport, sockets } = createHarness({ queueCapacity: 5 });
    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];

    for (let i = 0; i < 5; i++) {
      transport.send(requestEnvelope(`q-${i}`));
    }
    expect(socket.sentFrames).toHaveLength(0);

    let caught: CtraderTransportSendError | null = null;
    try {
      transport.send(requestEnvelope('overflow'));
    } catch (error) {
      caught = error as CtraderTransportSendError;
    }
    expect(caught).toBeInstanceOf(CtraderTransportSendError);
    expect(caught!.reason).toBe('queue-overflow');
    expect(caught!.message).not.toContain('overflow'); // no payload/clientMsgId data

    // The rejected message was never enqueued: exactly the 5 accepted frames
    // flush — in order — once the socket opens.
    socket.dispatchOpen();
    await connectPromise;
    expect(socket.sentFrames).toHaveLength(5);
    expect(parsedFrames(socket).map((frame) => frame.clientMsgId)).toEqual([
      'q-0',
      'q-1',
      'q-2',
      'q-3',
      'q-4',
    ]);
  });

  it("throws 'not-open' when sending with no socket, after socket close, and after intentional close()", async () => {
    // 1. Never connected — no socket at all.
    const fresh = new NodeWebSocketCtraderTransport({
      socketFactory: () => new FakeSocket(),
    });
    expect(() => fresh.send(requestEnvelope('no-socket'))).toThrow(CtraderTransportSendError);
    expect(() => fresh.send(requestEnvelope('no-socket'))).toThrow(
      expect.objectContaining({ reason: 'not-open' }),
    );

    // 2. Connected + open, then the socket dies (unintentional).
    const { transport, sockets } = createHarness();
    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];
    socket.dispatchOpen();
    await connectPromise;
    socket.dispatchClose(1006, 'peer gone');
    expect(() => transport.send(requestEnvelope('after-close'))).toThrow(
      expect.objectContaining({ reason: 'not-open' }),
    );

    // 3. Intentional close() — the pending connect rejects safely too.
    const { transport: second } = createHarness();
    const secondConnect = second.connect(DEMO_URL);
    second.close();
    await expect(secondConnect).rejects.toThrow('closed before open');
    expect(() => second.send(requestEnvelope('after-intentional'))).toThrow(
      expect.objectContaining({ reason: 'not-open' }),
    );
  });

  it('clears the queue on unintentional disconnect: nothing further written, close handler invoked once', async () => {
    const { transport, sockets } = createHarness();
    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];
    const closeHandler = jest.fn();
    transport.onClose(closeHandler);

    transport.send(requestEnvelope('queued-1'));
    transport.send(requestEnvelope('queued-2'));
    transport.send(requestEnvelope('queued-3'));

    socket.dispatchClose(1006, 'peer gone');
    // The pending connect rejects safely (queued+pending never replayed).
    await expect(connectPromise).rejects.toThrow('closed before open');
    expect(closeHandler).toHaveBeenCalledTimes(1);
    expect(closeHandler).toHaveBeenCalledWith(1006, 'peer gone');
    expect(socket.sentFrames).toHaveLength(0); // nothing was written (never opened)

    // The cleared queue is GONE: the transport refuses further sends.
    expect(() => transport.send(requestEnvelope('late'))).toThrow(
      expect.objectContaining({ reason: 'not-open' }),
    );
  });

  it('intentional close() clears the queue, closes the socket with 1000, and connect() resets the closed state', async () => {
    const { transport, sockets } = createHarness();
    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];

    transport.send(requestEnvelope('queued-1'));
    transport.send(requestEnvelope('queued-2'));
    transport.close();
    // Intentional close settles the pending connect safely.
    await expect(connectPromise).rejects.toThrow('closed before open');

    expect(socket.closedViaApi).toBe(1);
    expect(socket.lastCloseCode).toBe(1000);
    expect(socket.lastCloseReason).toBe('client-initiated close');
    expect(() => transport.send(requestEnvelope('after-close'))).toThrow(
      expect.objectContaining({ reason: 'not-open' }),
    );

    // Queue cleared: a late 'open' on the closed socket writes nothing.
    socket.dispatchOpen();
    expect(socket.sentFrames).toHaveLength(0);

    // connect() resets the closed state — a NEW connection accepts sends again
    // (and the old queued frames do NOT ride the new socket).
    const reconnectPromise = transport.connect(DEMO_URL);
    const second = sockets[1];
    second.dispatchOpen();
    await reconnectPromise;
    transport.send(requestEnvelope('fresh'));
    expect(second.sentFrames).toHaveLength(1);
    expect(parsedFrames(second)[0].clientMsgId).toBe('fresh');
  });

  it('keeps heartbeat frames strictly FIFO — they never jump the request queue', async () => {
    const { transport, sockets } = createHarness();
    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];

    transport.send(requestEnvelope('req-1'));
    transport.send({ payloadType: CTRADER_PAYLOAD_TYPE.HEARTBEAT_EVENT, payload: {} });
    transport.send(requestEnvelope('req-2'));
    transport.send({ payloadType: CTRADER_PAYLOAD_TYPE.HEARTBEAT_EVENT, payload: {} });
    transport.send(requestEnvelope('req-3'));

    socket.dispatchOpen();
    await connectPromise;
    const frames = parsedFrames(socket);
    expect(frames.map((frame) => frame.payloadType)).toEqual([100, 51, 100, 51, 100]);
    // Heartbeats carry no clientMsgId; requests keep theirs, in order.
    expect(frames.filter((f) => f.payloadType === 51).map((f) => f.clientMsgId)).toEqual([
      undefined,
      undefined,
    ]);
    expect(frames.filter((f) => f.payloadType === 100).map((f) => f.clientMsgId)).toEqual([
      'req-1',
      'req-2',
      'req-3',
    ]);
  });

  it('preserves clientMsgId and payload content through the queue', async () => {
    const { transport, sockets } = createHarness();
    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];

    const messages: CtraderMessageEnvelope[] = [
      {
        clientMsgId: 'id-alpha',
        payloadType: 2100,
        payload: { clientId: 'app-id', nested: { a: 1 } },
      },
      { clientMsgId: 'id-beta', payloadType: 2102, payload: { ctidTraderAccountId: 1234567 } },
      { clientMsgId: 'id-gamma', payloadType: 51, payload: {} },
    ];
    for (const message of messages) {
      transport.send(message);
    }
    socket.dispatchOpen();
    await connectPromise;

    expect(socket.sentFrames).toHaveLength(3);
    const frames = parsedFrames(socket);
    expect(frames.map((frame) => frame.clientMsgId)).toEqual(['id-alpha', 'id-beta', 'id-gamma']);
    expect(frames[0].payload).toEqual({ clientId: 'app-id', nested: { a: 1 } });
    expect(frames[1].payload).toEqual({ ctidTraderAccountId: 1234567 });
    expect(frames[2].payload).toEqual({});
  });

  it('keeps DEMO and LIVE outbound queues fully independent (A never writes to B)', async () => {
    const demo = createHarness();
    const live = createHarness();
    const demoConnect = demo.transport.connect(DEMO_URL);
    const liveConnect = live.transport.connect(LIVE_URL);

    demo.transport.send(requestEnvelope('demo-1'));
    demo.transport.send(requestEnvelope('demo-2'));
    live.transport.send(requestEnvelope('live-1'));
    live.transport.send(requestEnvelope('live-2'));

    // Only DEMO's socket opens — LIVE must still have written NOTHING.
    demo.sockets[0].dispatchOpen();
    await demoConnect;
    expect(demo.sockets[0].sentFrames).toHaveLength(2);
    expect(live.sockets[0].sentFrames).toHaveLength(0);

    live.sockets[0].dispatchOpen();
    await liveConnect;
    expect(parsedFrames(demo.sockets[0]).map((f) => f.clientMsgId)).toEqual(['demo-1', 'demo-2']);
    expect(parsedFrames(live.sockets[0]).map((f) => f.clientMsgId)).toEqual(['live-1', 'live-2']);
    expect(demo.sockets[0].sentFrames).toHaveLength(2); // unchanged by LIVE opening
  });

  it('never logs payload or token content (any log level, any code path)', async () => {
    const TOKEN = 'SEKRIT-TRANSPORT-TOKEN';
    const logged: string[] = [];
    // Spy the PROTOTYPE: every transport instance in this spec (incl. the
    // timeout one below) routes through it — no log call can escape.
    const levels = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
    const spies = levels.map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
        );
      }),
    );

    try {
      const { transport, sockets } = createHarness({ queueCapacity: 1 });
      const connectPromise = transport.connect(DEMO_URL);
      const socket = sockets[0];

      // A message whose payload carries a fake token (queued while CONNECTING).
      transport.send({
        clientMsgId: 'secret-1',
        payloadType: 2102,
        payload: { accessToken: TOKEN },
      });
      // Queue-overflow failure (capacity 1).
      expect(() =>
        transport.send({
          clientMsgId: 'secret-2',
          payloadType: 2102,
          payload: { accessToken: TOKEN },
        }),
      ).toThrow(CtraderTransportSendError);
      // Malformed inbound frame carrying the token (dropped silently).
      socket.dispatchMessage(`{"accessToken":"${TOKEN}"`);
      // Unintentional close with a queued message (settles the connect).
      socket.dispatchClose(1006, 'peer gone');
      await expect(connectPromise).rejects.toThrow('closed before open');
      // not-open failure.
      expect(() =>
        transport.send({ clientMsgId: 'secret-3', payloadType: 51, payload: {} }),
      ).toThrow(CtraderTransportSendError);

      // Connect-timeout log path (never opens — exercises the warn line).
      const { transport: slow } = createHarness({ connectTimeoutMs: 1 });
      await expect(slow.connect(DEMO_URL)).rejects.toThrow('timeout');

      // The spied surface saw logs (the timeout path executed) — and NONE of
      // them carry token or payload content.
      expect(logged.length).toBeGreaterThan(0);
      const everything = logged.join('\n');
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain('accessToken');
      expect(everything).not.toContain('secret-1');
      expect(everything).not.toContain('secret-2');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it('never replays queued frames from a dead connection onto a later socket (no auto-replay)', async () => {
    const { transport, sockets } = createHarness();
    const connectPromise = transport.connect(DEMO_URL);
    const first = sockets[0];

    transport.send(requestEnvelope('r-1'));
    transport.send(requestEnvelope('r-2'));
    transport.send(requestEnvelope('r-3'));
    expect(first.sentFrames).toHaveLength(0); // still CONNECTING

    // The socket dies BEFORE ever opening (settles the pending connect).
    first.dispatchClose(1006, 'lost before open');
    await expect(connectPromise).rejects.toThrow('closed before open');

    // Reconnect — even on the SAME transport instance (worst case; production
    // uses a fresh instance): the old queued frames must NOT ride the new socket.
    const reconnectPromise = transport.connect(DEMO_URL);
    const second = sockets[1];
    second.dispatchOpen();
    await reconnectPromise;

    expect(first.sentFrames).toHaveLength(0);
    expect(second.sentFrames).toHaveLength(0);
  });

  it('drops malformed inbound frames silently — no crash, no content logged', async () => {
    const { transport, sockets } = createHarness();
    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];
    socket.dispatchOpen();
    await connectPromise;

    const received: unknown[] = [];
    transport.onMessage((raw) => received.push(raw));
    const logged: string[] = [];
    const logger = (transport as unknown as { logger: Record<string, jest.Mock> }).logger;
    const spies = ['log', 'warn', 'error'].map((level) =>
      jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.join(' '));
      }),
    );

    try {
      socket.dispatchMessage('this is not json {{{');
      socket.dispatchMessage(12345); // non-text frame
      socket.dispatchMessage('{"clientMsgId":"truncated'); // truncated JSON
      expect(received).toHaveLength(0);
      expect(logged).toHaveLength(0); // not even a warning — and never content

      // The pump survives: a valid frame still flows through.
      socket.dispatchMessage(JSON.stringify({ payloadType: 51, payload: {} }));
      expect(received).toHaveLength(1);
      expect((received[0] as CtraderMessageEnvelope).payloadType).toBe(51);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
