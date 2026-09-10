/**
 * cTrader transport WRITE CERTAINTY + GENERATION FENCING (Sprint 56
 * correction round 4 — architect findings 3 + 4).
 *
 * Companion to ctrader-transport.spec.ts (outbound serialization); this spec
 * pins the two rewrite guarantees, network-free through the CtraderSocketFactory
 * seam with the same FakeSocket double style (wire-frame recording, manual
 * lifecycle dispatch) extended with a one-shot synchronous send-failure flag.
 *
 * Proven here (finding 3 — WRITE CERTAINTY):
 * 1. A synchronous socket.send() failure mid-drain is NEVER a silent drop: the
 *    uncertain frame is reported exactly once via onWriteFailure, the unwritten
 *    queue is cleared and REPORTED (neverWrittenClientMsgIds), the generation
 *    turns unhealthy (send() → 'not-open'), and the frame is never replayed.
 * 2. A/B/C queue ordering: the frame BEFORE the failure is on the wire, the
 *    failing frame is uncertain, the frames AFTER it are never-written.
 * 3. A re-entrant send() DURING the failure drain is enqueued by the drain
 *    guard, then cleared + reported — never lost silently.
 *
 * Proven here (finding 4 — SOCKET-IDENTITY FENCING):
 * 4. message / 5. close / 6. error / 7. late-open events from a REPLACED
 *    socket are ignored (no handler invocation, no queue clear, no settle).
 * 8. Only the ACTIVE generation's events drive state; a stale socket can
 *    never fake a close or deliver a message of a newer generation.
 * 9. transportGeneration increments per connect() (monotonic fencing counter).
 * 10. Payload/token/clientMsgId secrecy: nothing sensitive is ever logged.
 */
import { Logger } from '@nestjs/common';
import { CtraderMessageEnvelope } from './ctrader-message-types';
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
 * Deterministic WebSocket double: records every wire frame verbatim, counts
 * send ATTEMPTS (including the failing ones), can throw synchronously on the
 * next send() (one-shot failNextSend), and lets tests dispatch lifecycle
 * events synchronously. The onSend hook fires on EVERY attempt — on the
 * failing attempt it fires BEFORE the throw (the re-entrancy window mid-drain).
 */
class FakeSocket implements CtraderSocketLike {
  readonly sentFrames: string[] = [];
  /** Total send() attempts — including attempts that threw. */
  sendAttempts = 0;
  /** When true, the NEXT send() throws synchronously (one-shot). */
  failNextSend = false;
  readyState: number = CONNECTING;
  /** Number of close(code, reason) API calls the transport made. */
  closedViaApi = 0;
  lastCloseCode: number | undefined;
  lastCloseReason: string | undefined;
  /** Synchronous hook invoked on EVERY send() attempt (re-entrancy scenarios). */
  onSend?: (frame: string, socket: FakeSocket) => void;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sendAttempts += 1;
    if (this.failNextSend) {
      this.failNextSend = false;
      // The hook fires BEFORE the throw — this is the synchronous window in
      // which a re-entrant transport.send() hits the drain guard.
      this.onSend?.(data, this);
      throw new Error('fake cTrader socket send failure (scripted)');
    }
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

  dispatchError(): void {
    this.emit('error', {});
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

/**
 * Transport + a socket factory that records every socket it hands out and
 * supports a shared mutable "next socket" holder: seed() pre-places a
 * prepared socket (e.g. one whose send is pre-armed to throw) for the next
 * connect(); unseeded connects get a fresh FakeSocket.
 */
function createHarness(options: { queueCapacity?: number; connectTimeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  let nextSocket: FakeSocket | null = null;
  const seed = (socket: FakeSocket): void => {
    nextSocket = socket;
  };
  const factory: CtraderSocketFactory = () => {
    const socket = nextSocket ?? new FakeSocket();
    nextSocket = null;
    sockets.push(socket);
    return socket;
  };
  const transport = new NodeWebSocketCtraderTransport({ socketFactory: factory, ...options });
  return { transport, sockets, seed };
}

/** A request-shaped envelope with a distinctive clientMsgId (id echoed in payload). */
function requestEnvelope(
  clientMsgId: string,
  payloadType = 100,
  payload: Record<string, unknown> = { clientMsgId },
): CtraderMessageEnvelope {
  return { clientMsgId, payloadType, payload };
}

/** Every wire frame ever written, across every socket the factory handed out. */
function allWireFrames(sockets: FakeSocket[]): string[] {
  return sockets.flatMap((socket) => socket.sentFrames);
}

/** clientMsgIds of every frame that actually reached a wire. */
function wireClientMsgIds(sockets: FakeSocket[]): string[] {
  return allWireFrames(sockets)
    .map((frame) => JSON.parse(frame) as { clientMsgId?: string })
    .map((parsed) => parsed.clientMsgId)
    .filter((id): id is string => typeof id === 'string');
}

/** Asserts none of the given clientMsgIds ever reached ANY wire (no replay). */
function expectNeverOnWire(sockets: FakeSocket[], forbiddenIds: string[]): void {
  const wire = allWireFrames(sockets).join('\n');
  for (const id of forbiddenIds) {
    expect(wire).not.toContain(id);
  }
}

/**
 * Asserts a send() on an unhealthy/closed generation throws the deterministic
 * CtraderTransportSendError('not-open') — the frame was never written.
 */
function expectSendRejectsNotOpen(
  transport: NodeWebSocketCtraderTransport,
  clientMsgId: string,
): void {
  let caught: unknown = null;
  try {
    transport.send(requestEnvelope(clientMsgId));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CtraderTransportSendError);
  expect((caught as CtraderTransportSendError).reason).toBe('not-open');
}

/** Tracks a promise's settle state (both branches handled — no unhandled rejection). */
function track(promise: Promise<unknown>): () => string {
  let state = 'pending';
  void promise.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  return () => state;
}

describe('NodeWebSocketCtraderTransport write certainty + generation fencing (Sprint 56 correction round 4)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('socket.send throws synchronously on the FIRST write → the frame is NOT silently dropped', async () => {
    const { transport, sockets, seed } = createHarness();
    const writeFailure = jest.fn();
    transport.onWriteFailure(writeFailure);
    const onClose = jest.fn();
    transport.onClose(onClose);

    // A PRE-ARMED socket: the very first send() attempt throws.
    const first = new FakeSocket();
    first.failNextSend = true;
    seed(first);
    const connectPromise = transport.connect(DEMO_URL);
    first.dispatchOpen();
    await connectPromise;

    transport.send({ clientMsgId: 'm1', payloadType: 51, payload: {} });

    // Reported ONCE: m1's write attempt failed (outcome unknown), and NOTHING
    // else was queued behind it.
    expect(writeFailure).toHaveBeenCalledTimes(1);
    expect(writeFailure).toHaveBeenCalledWith({
      failedWriteClientMsgId: 'm1',
      neverWrittenClientMsgIds: [],
    });

    // The frame was ATTEMPTED exactly once — and never hit the wire: send()
    // threw, so the frame is neither on the wire nor re-queued.
    expect(first.sendAttempts).toBe(1);
    expect(first.sentFrames).toHaveLength(0);

    // The generation is unhealthy: not open, deterministic NOT_WRITTEN on send.
    expect(transport.isOpen()).toBe(false);
    expectSendRejectsNotOpen(transport, 'm1-follow-up');

    // NEVER replayed: a fresh connect() gives later drains a NEW socket — the
    // old clientMsgId never appears on ANY wire, and the old socket is never
    // asked to send again.
    const reconnect = transport.connect(DEMO_URL);
    const second = sockets[1];
    second.dispatchOpen();
    await reconnect;
    transport.send(requestEnvelope('after-failure'));
    expect(second.sentFrames).toHaveLength(1);
    expect(wireClientMsgIds(sockets)).toEqual(['after-failure']);
    expectNeverOnWire(sockets, ['m1', 'm1-follow-up']);
    expect(first.sendAttempts).toBe(1);
    // No double notification: the write-failure report IS the notification for
    // the dead generation (the zombie socket's close event stays fenced).
    expect(onClose).not.toHaveBeenCalled();
  });

  it('queue A/B/C, write failure on B → B uncertain, C never-written (reported), A already written', async () => {
    const { transport, sockets } = createHarness();
    const writeFailure = jest.fn();
    transport.onWriteFailure(writeFailure);
    const onClose = jest.fn();
    transport.onClose(onClose);

    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];
    // A, B, C queue while the socket is CONNECTING (strict FIFO).
    transport.send(requestEnvelope('A-id'));
    transport.send(requestEnvelope('B-id'));
    transport.send(requestEnvelope('C-id'));
    expect(socket.sentFrames).toHaveLength(0);

    // The single-drain writes all queued frames in ONE synchronous pass, so
    // B's failure is armed from A's own write (the onSend seam): A lands on
    // the wire, then the NEXT attempt (B) throws mid-drain.
    socket.onSend = () => {
      socket.onSend = undefined;
      socket.failNextSend = true;
    };
    socket.dispatchOpen();
    await connectPromise; // resolves — the open itself succeeded; the WRITE failed

    // A is on the wire; B is the single uncertain frame; C never reached the
    // wire but is REPORTED as never-written.
    expect(wireClientMsgIds([socket])).toEqual(['A-id']);
    expect(socket.sentFrames).toHaveLength(1);
    expect(writeFailure).toHaveBeenCalledTimes(1);
    expect(writeFailure).toHaveBeenCalledWith({
      failedWriteClientMsgId: 'B-id',
      neverWrittenClientMsgIds: ['C-id'],
    });
    expect(transport.isOpen()).toBe(false);
    // No double notification: the write-failure report replaces the close path.
    expect(onClose).not.toHaveBeenCalled();

    // Nothing is replayed afterwards: a fresh generation, fresh socket, and
    // only frames submitted AFTER the failure ride the new wire.
    const reconnect = transport.connect(DEMO_URL);
    const second = sockets[1];
    second.dispatchOpen();
    await reconnect;
    transport.send(requestEnvelope('fresh-after-failure'));
    expect(wireClientMsgIds(sockets)).toEqual(['A-id', 'fresh-after-failure']);
    expectNeverOnWire(sockets, ['B-id', 'C-id']);
  });

  it('re-entrant enqueue DURING the failure drain → the re-entrant frame is reported never-written, not lost silently', async () => {
    const { transport, sockets } = createHarness();
    const writeFailure = jest.fn();
    transport.onWriteFailure(writeFailure);

    const connectPromise = transport.connect(DEMO_URL);
    const socket = sockets[0];
    socket.dispatchOpen();
    await connectPromise;

    // The failing socket.send() triggers a re-entrant transport.send() BEFORE
    // it throws — mid-drain, while the `draining` guard is still held.
    let reentrantSendError: unknown = null;
    socket.onSend = () => {
      socket.onSend = undefined;
      try {
        transport.send({ clientMsgId: 'reentrant', payloadType: 51, payload: {} });
      } catch (error) {
        reentrantSendError = error;
      }
    };
    socket.failNextSend = true;

    transport.send(requestEnvelope('outer-frame'));

    // Truthful drain-code outcome: at re-entrancy time the generation is NOT
    // yet unhealthy, so the re-entrant send() ENQUEUED (drain guard) and did
    // NOT throw 'not-open' — the failure is reported after the throw.
    expect(reentrantSendError).toBeNull();
    // It was queued, then cleared with the unwritten queue and REPORTED — the
    // KEY certainty property: never a silent drop.
    expect(writeFailure).toHaveBeenCalledTimes(1);
    expect(writeFailure).toHaveBeenCalledWith({
      failedWriteClientMsgId: 'outer-frame',
      neverWrittenClientMsgIds: ['reentrant'],
    });
    // Only the outer frame was ever attempted; NEITHER frame reached the wire.
    expect(socket.sendAttempts).toBe(1);
    expect(socket.sentFrames).toHaveLength(0);
    expect(transport.isOpen()).toBe(false);
    expectSendRejectsNotOpen(transport, 'after-failure-send');

    // The re-entrant frame is never replayed onto a later wire.
    const reconnect = transport.connect(DEMO_URL);
    const second = sockets[1];
    second.dispatchOpen();
    await reconnect;
    transport.send(requestEnvelope('post-reconnect'));
    expect(wireClientMsgIds(sockets)).toEqual(['post-reconnect']);
    expectNeverOnWire(sockets, ['reentrant', 'outer-frame', 'after-failure-send']);
  });

  it('old socket emits message AFTER replacement → ignored', async () => {
    const { transport, sockets } = createHarness({ connectTimeoutMs: 25 });
    const onMessage = jest.fn();
    transport.onMessage(onMessage);

    const staleConnect = transport.connect(DEMO_URL); // socket1 — never opens
    const currentConnect = transport.connect(LIVE_URL); // socket2 REPLACES socket1
    const [stale, current] = sockets;
    expect(transport.transportGeneration).toBe(2); // the replacement bumped the generation

    const raw = JSON.stringify({ payloadType: 51, payload: { tick: 1 } });
    stale.dispatchMessage(raw); // fenced out — an event from the replaced socket
    expect(onMessage).not.toHaveBeenCalled();

    current.dispatchMessage(raw); // the SAME event via the ACTIVE socket
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ payloadType: 51, payload: { tick: 1 } });

    // Deterministic cleanup: both pending connects settle via their own
    // (short) connect timeouts.
    await Promise.all([
      expect(staleConnect).rejects.toThrow('connect timeout'),
      expect(currentConnect).rejects.toThrow('connect timeout'),
    ]);
  });

  it('old socket emits close AFTER replacement → ignored', async () => {
    const { transport, sockets } = createHarness({ connectTimeoutMs: 25 });
    const onClose = jest.fn();
    transport.onClose(onClose);

    const staleConnect = transport.connect(DEMO_URL); // socket1 — never opens
    const currentConnect = transport.connect(LIVE_URL); // socket2 replaces it
    const [stale, current] = sockets;
    // A frame queued on the ACTIVE (still CONNECTING) socket — its close must
    // report this id as never-written.
    transport.send(requestEnvelope('gen2-queued'));
    // The stale connect can never settle (the stale close below clears its own
    // timer before the fence) — keep a catch attached so nothing can ever
    // become an unhandled rejection.
    void staleConnect.catch(() => {});

    stale.dispatchClose(1006, 'stale-socket-close'); // fenced out
    expect(onClose).not.toHaveBeenCalled();
    // The stale close did NOT clear the active generation's queue either —
    // proven by the notification below still carrying the queued id.
    expect(current.sentFrames).toHaveLength(0);

    current.dispatchClose(1000, 'generation-2 close');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(1000, 'generation-2 close', ['gen2-queued']);

    await expect(currentConnect).rejects.toThrow('closed before open');
    // No frame from either socket ever hit a wire.
    expect(allWireFrames(sockets)).toHaveLength(0);
  });

  it('old socket emits error AFTER replacement → ignored', async () => {
    const { transport, sockets } = createHarness({ connectTimeoutMs: 25 });
    const onMessage = jest.fn();
    const onClose = jest.fn();
    const writeFailure = jest.fn();
    transport.onMessage(onMessage);
    transport.onClose(onClose);
    transport.onWriteFailure(writeFailure);

    const staleConnect = transport.connect(DEMO_URL); // socket1 — never opens
    const staleConnectState = track(staleConnect);
    void staleConnect.catch(() => {}); // no unhandled rejection, whatever happens
    const currentConnect = transport.connect(LIVE_URL); // socket2 replaces it
    const currentConnectState = track(currentConnect);
    const [stale, current] = sockets;

    current.dispatchOpen();
    await currentConnect; // settled (resolved)
    expect(currentConnectState()).toBe('resolved');

    stale.dispatchError(); // fenced out — no side effects on the active generation

    expect(currentConnectState()).toBe('resolved'); // a settled connect stays settled
    expect(staleConnectState()).toBe('pending'); // the stale error could not settle it
    expect(transport.isOpen()).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(writeFailure).not.toHaveBeenCalled();
    expect(stale.sentFrames).toHaveLength(0);
    expect(current.sentFrames).toHaveLength(0);

    // The stale connect settles ONLY via its own timeout (the fence blocks the
    // error from rejecting it).
    await expect(staleConnect).rejects.toThrow('connect timeout');
    expect(staleConnectState()).toBe('rejected');
  });

  it('old socket emits a LATE open AFTER replacement → ignored', async () => {
    const { transport, sockets } = createHarness({ connectTimeoutMs: 25 });
    const onMessage = jest.fn();
    const onClose = jest.fn();
    const writeFailure = jest.fn();
    transport.onMessage(onMessage);
    transport.onClose(onClose);
    transport.onWriteFailure(writeFailure);

    const staleConnect = transport.connect(DEMO_URL); // socket1 — left CONNECTING
    const stale = sockets[0];
    const staleConnectState = track(staleConnect);
    void staleConnect.catch(() => {});

    // Frames queued on socket1's CONNECTING state (before the replacement).
    transport.send(requestEnvelope('gen1-late-1'));
    transport.send(requestEnvelope('gen1-late-2'));
    expect(stale.sentFrames).toHaveLength(0);

    const currentConnect = transport.connect(DEMO_URL); // replacement: disposeSocket()
    const current = sockets[1];
    current.dispatchOpen();
    await currentConnect;

    stale.dispatchOpen(); // LATE open on the replaced socket

    // The late open did NOT settle anything, did NOT drain, wrote nothing.
    expect(staleConnectState()).toBe('pending');
    expect(stale.sentFrames).toHaveLength(0);
    expect(current.sentFrames).toHaveLength(0); // gen1 frames never reached the new wire
    expect(onMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Truthful code behavior: the second connect() clears the old queue
    // WITHOUT a write-failure or close notification — the frames are simply
    // gone (never written anywhere).
    expect(writeFailure).not.toHaveBeenCalled();
    expect(transport.isOpen()).toBe(true); // the active generation is unaffected
    expectNeverOnWire(sockets, ['gen1-late-1', 'gen1-late-2']);

    // The stale connect settles only via its own timeout (the fence blocked
    // its open).
    await expect(staleConnect).rejects.toThrow('connect timeout');
    expect(staleConnectState()).toBe('rejected');
  });

  it('only the ACTIVE transport generation drives state', async () => {
    const { transport, sockets } = createHarness({ connectTimeoutMs: 25 });
    const onMessage = jest.fn();
    const onClose = jest.fn();
    const writeFailure = jest.fn();
    transport.onMessage(onMessage);
    transport.onClose(onClose);
    transport.onWriteFailure(writeFailure);
    const RAW = JSON.stringify({ payloadType: 51, payload: { generation: 2 } });

    // Generation 1: socket1 (CONNECTING) with a queued frame.
    const gen1Connect = transport.connect(DEMO_URL);
    const socket1 = sockets[0];
    transport.send(requestEnvelope('gen1-stale'));
    void gen1Connect.catch(() => {}); // floats: the stale close below clears its timer

    // Generation 2: socket2 replaces socket1 (the gen1 queue is cleared
    // silently by disposeSocket()).
    const gen2Connect = transport.connect(LIVE_URL);
    const socket2 = sockets[1];
    expect(transport.transportGeneration).toBe(2);
    transport.send(requestEnvelope('gen2-flush')); // queued on the ACTIVE socket

    // STALE STORM: every event the replaced socket can emit — all ignored.
    socket1.dispatchOpen();
    socket1.dispatchMessage(RAW);
    socket1.dispatchError();
    socket1.dispatchClose(1006, 'stale-generation-1');
    expect(onMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(writeFailure).not.toHaveBeenCalled();
    expect(socket1.sentFrames).toHaveLength(0); // the stale open never drained
    expect(socket2.sentFrames).toHaveLength(0); // 'gen1-stale' never flushed onto socket2

    // ACTIVE generation: every event is processed.
    socket2.dispatchOpen(); // resolves gen2Connect and drains the queue
    await gen2Connect;
    expect(socket2.sentFrames).toHaveLength(1);
    expect(wireClientMsgIds([socket2])).toEqual(['gen2-flush']);

    socket2.dispatchMessage(RAW); // message delivered
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ payloadType: 51, payload: { generation: 2 } });

    socket2.dispatchError(); // processed (fence passes), no side effects — already settled
    expect(transport.isOpen()).toBe(true);

    socket2.dispatchClose(1001, 'gen2 peer close'); // close notified — everything was written
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(1001, 'gen2 peer close', []);

    // Generation 3: after the close, a fresh connect() — its close
    // notification carries the never-written ids (frames queued while
    // CONNECTING, cleared by the close, reported to the client).
    const gen3Connect = transport.connect(DEMO_URL);
    const socket3 = sockets[2];
    expect(transport.transportGeneration).toBe(3);
    transport.send(requestEnvelope('gen3-never-1'));
    transport.send(requestEnvelope('gen3-never-2'));

    // socket2 is stale AGAIN — its events stay ignored.
    socket2.dispatchMessage(RAW);
    socket2.dispatchClose(1011, 'now-stale-too');
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    socket3.dispatchClose(1000, 'gen3 close');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledWith(1000, 'gen3 close', ['gen3-never-1', 'gen3-never-2']);
    await expect(gen3Connect).rejects.toThrow('closed before open');
    expect(socket3.sentFrames).toHaveLength(0); // the never-written ids truly never hit a wire
    expectNeverOnWire(sockets, ['gen1-stale', 'gen3-never-1', 'gen3-never-2']);
  });

  it('transportGeneration increments per connect()', async () => {
    const { transport, sockets } = createHarness();
    expect(transport.transportGeneration).toBe(0); // fresh transport

    const firstConnect = transport.connect(DEMO_URL);
    expect(transport.transportGeneration).toBe(1); // first connect → generation 1
    sockets[0].dispatchOpen();
    await firstConnect;

    // A redundant connect() on the ALREADY-OPEN socket is a no-op — it must
    // NOT mint a new generation.
    await transport.connect(DEMO_URL);
    expect(transport.transportGeneration).toBe(1);

    sockets[0].dispatchClose(1006, 'peer close');
    const secondConnect = transport.connect(LIVE_URL);
    expect(transport.transportGeneration).toBe(2); // replacement → generation 2
    sockets[1].dispatchOpen();
    await secondConnect;
    expect(transport.transportGeneration).toBe(2); // stable while connected
  });

  it('no payloads or credential-like material in captured logs', async () => {
    const TOKEN = 'SEKRIT-TOKEN-VALUE-1234567890';
    const logged: string[] = [];
    // Spy the PROTOTYPE so every transport instance in this spec routes
    // through it — no log call can escape.
    const levels = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
    const spies = levels.map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
        );
      }),
    );

    try {
      // Scenario 1: mid-drain write failure with token-bearing frames + a
      // write-failure handler whose OWN bug message carries the token.
      const { transport, sockets } = createHarness();
      const writeFailure = jest.fn(() => {
        throw new Error(`handler bug message carrying ${TOKEN}`);
      });
      transport.onWriteFailure(writeFailure);
      transport.onClose(jest.fn());
      const connectPromise = transport.connect(DEMO_URL);
      const socket = sockets[0];
      transport.send(requestEnvelope('c10-failed', 2100, { accessToken: TOKEN }));
      transport.send(requestEnvelope('c10-queued', 2102, { accessToken: TOKEN }));
      socket.failNextSend = true; // the first write attempt throws mid-drain
      socket.dispatchOpen();
      await connectPromise;
      expect(writeFailure).toHaveBeenCalledTimes(1);
      // Deterministic not-open rejection (fixed message, no frame content).
      expect(() => transport.send(requestEnvelope('c10-after', 51, {}))).toThrow(
        CtraderTransportSendError,
      );

      // Scenario 2: a close that clears a token-bearing queued frame (ids go
      // to the CLIENT via the close notification, never to the logs).
      const second = createHarness();
      const closeHandler = jest.fn();
      second.transport.onClose(closeHandler);
      const secondConnect = second.transport.connect(DEMO_URL);
      second.transport.send(requestEnvelope('c10-close-queued', 2102, { accessToken: TOKEN }));
      second.sockets[0].dispatchClose(1006, 'peer gone');
      await expect(secondConnect).rejects.toThrow('closed before open');
      expect(closeHandler).toHaveBeenCalledWith(1006, 'peer gone', ['c10-close-queued']);

      // Scenario 3: the connect-timeout warn path.
      const slow = createHarness({ connectTimeoutMs: 5 });
      await expect(slow.transport.connect(DEMO_URL)).rejects.toThrow('connect timeout');

      // The spied surface SAW logs (write-failure warn, handler-bug warn,
      // timeout warn) — and NONE of them carry payload, token, or clientMsgId
      // content.
      expect(logged.length).toBeGreaterThanOrEqual(2);
      const everything = logged.join('\n');
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain('SEKRIT');
      expect(everything).not.toContain('accessToken');
      expect(everything).not.toContain('clientMsgId');
      expect(everything).not.toContain('c10-failed');
      expect(everything).not.toContain('c10-queued');
      expect(everything).not.toContain('c10-after');
      expect(everything).not.toContain('c10-close-queued');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
