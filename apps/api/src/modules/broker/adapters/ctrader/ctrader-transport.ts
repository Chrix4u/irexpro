/**
 * cTrader Open API transport (Sprint 56 / Task 47-C2; Task 48-a outbound
 * serialization; Sprint 56 correction round 4, architect findings 3 + 4:
 * outbound write certainty + transport generation fencing).
 *
 * JSON-over-WebSocket (wss://host:5036). Uses Node's NATIVE WebSocket global
 * (Node ≥ 22; sandbox verified on v24.19.0) — ZERO new npm dependencies.
 *
 * OUTBOUND SERIALIZATION (Task 48-a): ONE ordered bounded queue per
 * connection; a SINGLE-drain loop writes ONE frame at a time (strict FIFO);
 * heartbeates enqueue like any other frame; deterministic overflow fails
 * synchronously with CtraderTransportSendError('queue-overflow').
 *
 * WRITE-CERTAINTY MODEL (correction round 4, finding 3 — an accepted frame
 * may never disappear silently while its request waits for a timeout):
 * - NOT_WRITTEN: deterministic — queue-overflow (never enqueued),
 *   not-open (socket closed/closing/intentional close BEFORE write), and
 *   every frame still QUEUED when a write failure or close clears the
 *   outbox. These are safe to retry as new operations.
 * - WRITE_ATTEMPTED_OUTCOME_UNKNOWN: the single frame whose synchronous
 *   socket.send() threw mid-drain. The frame is SHIFTED OUT of the queue and
 *   NEVER replayed — unless the transport API gives deterministic proof the
 *   frame was not accepted (the WHATWG WebSocket API does not), the request
 *   must be treated as possibly-on-the-wire.
 * - WRITTEN_AWAITING_RESPONSE: socket.send() returned normally; the response
 *   matching (clientMsgId echo) lives in ctrader-client.service.ts.
 *
 * On a synchronous write failure the transport:
 * - notifies the client IMMEDIATELY via onWriteFailure (never lets pending
 *   requests starve until the 10 s request timeout);
 * - marks THIS transport generation unhealthy (send() now fails
 *   'not-open'; the client reconnects with a NEW transport generation);
 * - clears the unwritten queue, reporting the never-written clientMsgIds so
 *   the client can fail those requests DEFINITELY_NOT_SENT;
 * - never replays the uncertain frame and never logs frame contents/tokens.
 *
 * SOCKET-IDENTITY FENCING (correction round 4, finding 4): every event
 * listener installed by connect() captures the socket it was installed FOR;
 * events from a socket that is no longer `this.socket` (replaced by a fresh
 * connect(), disposed after a timeout, or a zombie after write-failure) are
 * IGNORED — a stale socket can never clear state, satisfy pending requests,
 * or fire the close path of a newer generation. The CLIENT additionally
 * fences by monotonic transport generation (see attachTransport).
 *
 * SECURITY: message payloads are NEVER logged (they can carry tokens).
 */
import { Logger } from '@nestjs/common';
import { CtraderMessageEnvelope } from './ctrader-message-types';

/** Transport-level callback shapes (kept primitive — no DOM types in the interface). */
export type CtraderTransportMessageHandler = (rawMessage: unknown) => void;
export type CtraderTransportCloseHandler = (
  closeCode: number | undefined,
  reason: string,
  /** clientMsgIds of frames still queued (NEVER written) when the socket closed. */
  neverWrittenClientMsgIds: readonly string[],
) => void;

/**
 * Outbound write-certainty classification for a failed transport generation
 * (correction round 4, finding 3). Reported ONCE per generation when a
 * synchronous socket write fails.
 */
export interface CtraderTransportWriteFailure {
  /** The frame whose synchronous write attempt failed — outcome UNKNOWN. */
  readonly failedWriteClientMsgId: string | null;
  /**
   * clientMsgIds of frames still queued and NEVER written (deterministic
   * NOT_WRITTEN — their requests may be safely retried as new operations).
   */
  readonly neverWrittenClientMsgIds: readonly string[];
}

/** Write-failure notification handler (installed via onWriteFailure). */
export type CtraderTransportWriteFailureHandler = (failure: CtraderTransportWriteFailure) => void;

/**
 * Injectable seam over any WebSocket-like socket (production: Node's native
 * WebSocket; tests: deterministic fakes). readyState follows the WHATWG
 * numbering (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED).
 */
export interface CtraderSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Creates the socket for a URL — injectable so tests never touch the network. */
export type CtraderSocketFactory = (url: string) => CtraderSocketLike;

/** Deterministic, typed send() rejection reasons (never a silent drop). */
export type CtraderSendRejectionReason = 'queue-overflow' | 'not-open';

/**
 * Thrown SYNCHRONOUSLY by send() on deterministic outbound failures:
 * 'queue-overflow' (bounded backpressure — the message was not enqueued) or
 * 'not-open' (no socket / CLOSING / CLOSED / intentional close / unhealthy
 * transport generation). Both are DEFINITELY_NOT_SENT: the frame never
 * reached the wire. Callers must handle it (ctrader-client.service.ts maps
 * it to retryable BrokerAdapterErrors carrying dispatch certainty).
 */
export class CtraderTransportSendError extends Error {
  readonly reason: CtraderSendRejectionReason;

  constructor(reason: CtraderSendRejectionReason, message: string) {
    super(message);
    this.name = 'CtraderTransportSendError';
    this.reason = reason;
  }
}

/** Production socket factory — Node's native WebSocket global. */
const nativeWebSocketFactory: CtraderSocketFactory = (url: string) =>
  new WebSocket(url) as unknown as CtraderSocketLike;

// WHATWG WebSocket readyState numbering (WebSocket.CONNECTING/OPEN/CLOSING/CLOSED).
// A socket in CONNECTING (0) keeps the outbox queued; only OPEN (1) writes.
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;

/** Default outbound queue capacity — the bounded backpressure bound. */
const DEFAULT_QUEUE_CAPACITY = 1000;
/** Default connect timeout — mirrors the client's request timeout budget. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Constructor options (all optional; production uses the defaults). */
export interface NodeWebSocketCtraderTransportOptions {
  /** Socket factory seam — tests inject deterministic fakes. */
  socketFactory?: CtraderSocketFactory;
  /** Bounded outbound queue capacity (default 1000). */
  queueCapacity?: number;
  /** Connect timeout in ms (default 10 000). */
  connectTimeoutMs?: number;
}

/**
 * Transport abstraction over the cTrader JSON-WebSocket endpoint. Faked in
 * tests; implemented by NodeWebSocketCtraderTransport in production.
 */
export interface CtraderTransport {
  /** URL of the last successful connect() call (undefined when never connected). */
  readonly connectedUrl: string | undefined;
  /**
   * Monotonic transport-generation counter — increments on every
   * connect() (a new socket identity). Event callbacks installed for one
   * generation only ever observe their own generation's socket (internal
   * fencing); the CLIENT additionally fences cross-transport by capturing the
   * generation at attachTransport() time (correction round 4, finding 4).
   */
  readonly transportGeneration: number;
  /** Opens the WebSocket connection; rejects on failure/timeout. */
  connect(url: string): Promise<void>;
  /**
   * Sends an envelope through the bounded, strictly FIFO outbound queue
   * (single-drain — one write at a time, never overlapping). MAY throw
   * {@link CtraderTransportSendError} synchronously on deterministic
   * backpressure ('queue-overflow') or closed-connection ('not-open')
   * failures — callers must handle it; messages are never silently dropped.
   */
  send(message: CtraderMessageEnvelope): void;
  /** Registers the inbound-message callback (single handler per transport). */
  onMessage(handler: CtraderTransportMessageHandler): void;
  /**
   * Registers the connection-lost callback (single handler per transport).
   * The handler receives the never-written clientMsgIds that were cleared
   * with the queue (deterministic NOT_WRITTEN classification).
   */
  onClose(handler: CtraderTransportCloseHandler): void;
  /**
   * Registers the outbound-write-failure callback (single handler per
   * transport): fired ONCE, immediately, when a synchronous socket write
   * fails mid-drain. The generation is unhealthy from that point on.
   */
  onWriteFailure(handler: CtraderTransportWriteFailureHandler): void;
  /** Closes the connection (intentional — the CALLER tracks intent). */
  close(): void;
  /** True while the socket is open AND the generation is healthy. */
  isOpen(): boolean;
}

/**
 * Production transport on Node's native WebSocket.
 *
 * Demo/LIVE host isolation is enforced UPSTREAM (the client picks the URL from
 * the environment); the transport always connects to exactly the URL given.
 */
export class NodeWebSocketCtraderTransport implements CtraderTransport {
  private readonly logger = new Logger(NodeWebSocketCtraderTransport.name);
  private readonly socketFactory: CtraderSocketFactory;
  private readonly queueCapacity: number;
  private readonly connectTimeoutMs: number;
  private socket: CtraderSocketLike | null = null;
  /** Bounded FIFO outbound queue (one per connection/transport). */
  private readonly outbox: CtraderMessageEnvelope[] = [];
  /** Single-drain guard: at most ONE active drain loop per transport. */
  private draining = false;
  /** Set by intentional close(); reset by connect(). */
  private intentionallyClosed = false;
  /**
   * Set when a synchronous outbound write failed (finding 3): the transport
   * generation is unhealthy — send() fails 'not-open' until a fresh connect().
   */
  private writeFailureDetected = false;
  /** Monotonic fencing counter — one increment per connect() (new socket). */
  private generation = 0;
  private messageHandler: CtraderTransportMessageHandler | null = null;
  private closeHandler: CtraderTransportCloseHandler | null = null;
  private writeFailureHandler: CtraderTransportWriteFailureHandler | null = null;
  private _connectedUrl: string | undefined;

  constructor(options: NodeWebSocketCtraderTransportOptions = {}) {
    this.socketFactory = options.socketFactory ?? nativeWebSocketFactory;
    this.queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  get connectedUrl(): string | undefined {
    return this._connectedUrl;
  }

  get transportGeneration(): number {
    return this.generation;
  }

  connect(url: string): Promise<void> {
    if (
      !this.intentionallyClosed &&
      !this.writeFailureDetected &&
      this.socket &&
      this.socket.readyState === SOCKET_OPEN
    ) {
      return Promise.resolve();
    }
    // A fresh connect resets the intentional-close and write-failure state
    // (and any stale queue) — each connect() is a NEW socket generation.
    this.intentionallyClosed = false;
    this.writeFailureDetected = false;
    this.disposeSocket();
    this.generation += 1;
    const generation = this.generation;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = this.socketFactory(url);
      this.socket = socket;
      this._connectedUrl = url;

      const connectTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.logger.warn(`cTrader WebSocket connect timed out after ${this.connectTimeoutMs}ms`);
          try {
            socket.close();
          } catch {
            /* best-effort cleanup */
          }
          reject(new Error('cTrader WebSocket connect timeout'));
        }
      }, this.connectTimeoutMs);

      socket.addEventListener('open', () => {
        // SOCKET-IDENTITY FENCE (finding 4): a late 'open' from a socket that
        // is no longer current (timeout disposal / replacement) is ignored.
        if (this.socket !== socket || this.generation !== generation) {
          return;
        }
        clearTimeout(connectTimer);
        // Queued frames flush on open — FIFO, single-drain, in submission order.
        this.drain();
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      socket.addEventListener('error', () => {
        if (this.socket !== socket || this.generation !== generation) {
          return; // stale socket event — never affects the current generation
        }
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          // Never include the URL query or payloads — the URL contains only
          // the host, which is safe, but keep the log minimal on principle.
          this.logger.warn('cTrader WebSocket connection error');
          reject(new Error('cTrader WebSocket connection failed'));
        }
      });
      socket.addEventListener('close', (event: unknown) => {
        clearTimeout(connectTimer);
        // SOCKET-IDENTITY FENCE (finding 4): events from a replaced/disposed
        // socket never clear the queue or fire the close path of a newer
        // generation.
        if (this.socket !== socket || this.generation !== generation) {
          return;
        }
        if (!settled) {
          settled = true;
          reject(new Error('cTrader WebSocket closed before open'));
        }
        // Unwritten queued messages are NEVER replayed on a later socket —
        // reconnects use a NEW transport instance; this queue is cleared and
        // the never-written ids are REPORTED so the client can fail those
        // requests DEFINITELY_NOT_SENT (finding 3 certainty contract).
        const neverWritten = this.clearOutbox();
        const closeEvent = event as { code?: number; reason?: unknown };
        this.notifyClosed(
          typeof closeEvent.code === 'number' ? closeEvent.code : undefined,
          typeof closeEvent.reason === 'string' ? closeEvent.reason : '',
          neverWritten,
        );
      });
      socket.addEventListener('message', (event: unknown) => {
        if (this.socket !== socket || this.generation !== generation) {
          return; // stale socket event — never satisfies a newer generation
        }
        this.handleRawFrame((event as { data?: unknown }).data);
      });
    });
  }

  send(message: CtraderMessageEnvelope): void {
    if (
      this.intentionallyClosed ||
      this.writeFailureDetected ||
      this.socket === null ||
      this.socket.readyState === SOCKET_CLOSING ||
      this.socket.readyState === SOCKET_CLOSED
    ) {
      // NEVER a silent drop: the caller learns the generation is gone. The
      // frame was NEVER written — deterministic NOT_WRITTEN.
      throw new CtraderTransportSendError(
        'not-open',
        'cTrader transport is not open — the message was not sent.',
      );
    }
    if (this.outbox.length >= this.queueCapacity) {
      // Deterministic backpressure: reject BEFORE enqueueing — the rejected
      // message is never enqueued and the queue stays intact (FIFO of
      // everything already accepted is preserved). NOT_WRITTEN.
      throw new CtraderTransportSendError(
        'queue-overflow',
        `cTrader outbound queue is at capacity (${this.queueCapacity}) — the message was not enqueued.`,
      );
    }
    this.outbox.push(message);
    this.drain();
  }

  onMessage(handler: CtraderTransportMessageHandler): void {
    this.messageHandler = handler;
  }

  onClose(handler: CtraderTransportCloseHandler): void {
    this.closeHandler = handler;
  }

  onWriteFailure(handler: CtraderTransportWriteFailureHandler): void {
    this.writeFailureHandler = handler;
  }

  close(): void {
    if (!this.socket) return;
    this.intentionallyClosed = true;
    // Queued-but-unwritten frames are dropped — never replayed after close.
    // (Intentional close: the CLIENT already failed these pending requests
    // through closeEnvironmentConnection — no notification needed here.)
    this.outbox.length = 0;
    try {
      this.socket.close(1000, 'client-initiated close');
    } catch {
      /* best-effort */
    }
  }

  isOpen(): boolean {
    return (
      !this.intentionallyClosed &&
      !this.writeFailureDetected &&
      this.socket !== null &&
      this.socket.readyState === SOCKET_OPEN
    );
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Single-drain outbound loop: at most ONE active drain per transport. A
   * re-entrant send() during the drain only ENQUEUES — the active loop picks
   * the newly queued message up, so transport writes never overlap and the
   * wire order is always the submission order. One frame at a time
   * (shift → send), strictly FIFO. CONNECTING sockets leave the queue
   * untouched (the 'open' listener drains).
   *
   * WRITE-CERTAINTY (finding 3): a frame is shifted out BEFORE the write
   * attempt. If socket.send() throws synchronously, that frame's outcome is
   * UNKNOWN (WRITE_ATTEMPTED_OUTCOME_UNKNOWN) — it is never re-queued, never
   * replayed; the remaining queue is cleared (NOT_WRITTEN, reported); the
   * generation is marked unhealthy; and the client is notified IMMEDIATELY.
   */
  private drain(): void {
    if (this.draining) {
      return; // the active drain loop picks the newly queued message up
    }
    this.draining = true;
    try {
      while (
        !this.intentionallyClosed &&
        !this.writeFailureDetected &&
        this.socket !== null &&
        this.socket.readyState === SOCKET_OPEN &&
        this.outbox.length > 0
      ) {
        const message = this.outbox.shift()!;
        try {
          this.socket.send(JSON.stringify(message));
          // WRITTEN_AWAITING_RESPONSE — the clientMsgId echo matching lives
          // in the client service.
        } catch {
          // SYNCHRONOUS WRITE FAILURE (finding 3): the shifted frame's
          // outcome is UNKNOWN. Never log the frame content — payload
          // secrecy. Never replay. Fail the generation immediately.
          this.handleOutboundWriteFailure(message);
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Terminal write-failure handling (finding 3): mark the generation
   * unhealthy, clear + report the unwritten queue, close the broken socket
   * best-effort, and notify the client ONCE — pending requests must NEVER
   * starve until the request timeout.
   */
  private handleOutboundWriteFailure(failedMessage: CtraderMessageEnvelope): void {
    this.writeFailureDetected = true;
    const neverWritten = this.clearOutbox();
    const failure: CtraderTransportWriteFailure = {
      failedWriteClientMsgId: failedMessage.clientMsgId ?? null,
      neverWrittenClientMsgIds: neverWritten,
    };
    const socket = this.socket;
    this.socket = null; // the generation is dead — no further writes/events
    try {
      socket?.close();
    } catch {
      /* best-effort */
    }
    this.logger.warn(
      'cTrader transport outbound write failed — transport generation marked ' +
        'unhealthy (uncertain frame not replayed; unwritten queue cleared and reported)',
    );
    if (this.writeFailureHandler) {
      try {
        this.writeFailureHandler(failure);
      } catch (err) {
        // A handler bug must never take the transport down — logged without
        // any frame/token content.
        this.logger.warn(
          `cTrader transport write-failure handler threw: ${(err as Error).constructor.name}`,
        );
      }
    }
  }

  /** Removes every queued (never-written) frame, returning their clientMsgIds. */
  private clearOutbox(): string[] {
    const ids: string[] = [];
    while (this.outbox.length > 0) {
      const message = this.outbox.shift()!;
      if (message.clientMsgId) {
        ids.push(message.clientMsgId);
      }
    }
    return ids;
  }

  private handleRawFrame(data: unknown): void {
    if (typeof data !== 'string') {
      // cTrader JSON frames are text frames; anything else is dropped.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Malformed frame — dropped without logging content (payload secrecy).
      return;
    }
    if (this.messageHandler) {
      this.messageHandler(parsed);
    }
  }

  private notifyClosed(
    code: number | undefined,
    reason: string,
    neverWrittenClientMsgIds: readonly string[],
  ): void {
    if (this.closeHandler) {
      this.closeHandler(code, reason, neverWrittenClientMsgIds);
    }
  }

  private disposeSocket(): void {
    this.outbox.length = 0;
    this.socket = null;
  }
}
