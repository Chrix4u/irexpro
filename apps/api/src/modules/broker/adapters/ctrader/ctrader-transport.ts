/**
 * cTrader Open API transport (Sprint 56 / Task 47-C2; Task 48-a outbound
 * serialization).
 *
 * JSON-over-WebSocket (wss://host:5036). Uses Node's NATIVE WebSocket global
 * (Node ≥ 22; sandbox verified on v24.19.0) — ZERO new npm dependencies.
 *
 * OUTBOUND SERIALIZATION (Task 48-a — architect finding 1: production send()
 * previously invoked WebSocket.send() directly whenever OPEN, so concurrent
 * submissions could interleave writes and CONNECTING was the only queued
 * state). Now:
 * - ONE ordered outbound queue per connection; send() enqueues and a
 *   SINGLE-drain loop writes ONE frame at a time (shift → send, strictly
 *   FIFO) — transport writes never overlap, even under synchronous bursts
 *   or re-entrant sends (a send during an active drain only enqueues; the
 *   active loop picks it up).
 * - Heartbeat frames enqueue exactly like any other message — they never
 *   jump the queue, so request ordering (incl. app-auth-first) is preserved.
 * - The queue is BOUNDED (queueCapacity, default 1000). Deterministic
 *   overflow fails synchronously with CtraderTransportSendError
 *   ('queue-overflow') — the rejected message is NOT enqueued, the queue
 *   stays intact, and NOTHING is ever silently dropped.
 * - Sending on a closed/closing/intentionally-closed transport throws
 *   CtraderTransportSendError('not-open') — never a silent drop.
 * - Frames queued while CONNECTING flush on 'open' in submission order.
 * - Unintentional disconnect and intentional close() CLEAR the queue:
 *   unwritten messages are NEVER replayed (reconnects use a NEW transport
 *   instance; connect() resets the intentional-close state).
 *
 * Inbound behavior is unchanged: JSON.parse on the way in; malformed frames
 * are dropped (never logged with content) — a malformed frame must never
 * crash the message pump and must never leak payload text into logs.
 * The transport never interprets payload semantics: request↔response
 * matching, auth, heartbeat and rate limiting all live in
 * ctrader-client.service.ts.
 *
 * SECURITY: message payloads are NEVER logged (they can carry tokens).
 */
import { Logger } from '@nestjs/common';
import { CtraderMessageEnvelope } from './ctrader-message-types';

/** Transport-level callback shapes (kept primitive — no DOM types in the interface). */
export type CtraderTransportMessageHandler = (rawMessage: unknown) => void;
export type CtraderTransportCloseHandler = (closeCode: number | undefined, reason: string) => void;

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
 * 'not-open' (no socket / CLOSING / CLOSED / intentional close). Callers
 * must handle it (ctrader-client.service.ts maps it to retryable
 * BrokerAdapterErrors).
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
  /** Registers the connection-lost callback (single handler per transport). */
  onClose(handler: CtraderTransportCloseHandler): void;
  /** Closes the connection (intentional — the CALLER tracks intent). */
  close(): void;
  /** True while the socket is open. */
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
  private messageHandler: CtraderTransportMessageHandler | null = null;
  private closeHandler: CtraderTransportCloseHandler | null = null;
  private _connectedUrl: string | undefined;

  constructor(options: NodeWebSocketCtraderTransportOptions = {}) {
    this.socketFactory = options.socketFactory ?? nativeWebSocketFactory;
    this.queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  get connectedUrl(): string | undefined {
    return this._connectedUrl;
  }

  connect(url: string): Promise<void> {
    if (!this.intentionallyClosed && this.socket && this.socket.readyState === SOCKET_OPEN) {
      return Promise.resolve();
    }
    // A fresh connect resets the intentional-close state (and any stale queue).
    this.intentionallyClosed = false;
    this.disposeSocket();
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
        clearTimeout(connectTimer);
        // Queued frames flush on open — FIFO, single-drain, in submission order.
        this.drain();
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      socket.addEventListener('error', () => {
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
        if (!settled) {
          settled = true;
          reject(new Error('cTrader WebSocket closed before open'));
        }
        // Unwritten queued messages are NEVER replayed on a later socket —
        // reconnects use a NEW transport instance; this queue is cleared.
        this.outbox.length = 0;
        const closeEvent = event as { code?: number; reason?: unknown };
        this.notifyClosed(
          typeof closeEvent.code === 'number' ? closeEvent.code : undefined,
          typeof closeEvent.reason === 'string' ? closeEvent.reason : '',
        );
      });
      socket.addEventListener('message', (event: unknown) => {
        this.handleRawFrame((event as { data?: unknown }).data);
      });
    });
  }

  send(message: CtraderMessageEnvelope): void {
    if (
      this.intentionallyClosed ||
      this.socket === null ||
      this.socket.readyState === SOCKET_CLOSING ||
      this.socket.readyState === SOCKET_CLOSED
    ) {
      // NEVER a silent drop: the caller learns the connection is gone.
      throw new CtraderTransportSendError(
        'not-open',
        'cTrader transport is not open — the message was not sent.',
      );
    }
    if (this.outbox.length >= this.queueCapacity) {
      // Deterministic backpressure: reject BEFORE enqueueing — the rejected
      // message is never enqueued and the queue stays intact (FIFO of
      // everything already accepted is preserved).
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

  close(): void {
    if (!this.socket) return;
    this.intentionallyClosed = true;
    // Queued-but-unwritten frames are dropped — never replayed after close.
    this.outbox.length = 0;
    try {
      this.socket.close(1000, 'client-initiated close');
    } catch {
      /* best-effort */
    }
  }

  isOpen(): boolean {
    return (
      !this.intentionallyClosed && this.socket !== null && this.socket.readyState === SOCKET_OPEN
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
   */
  private drain(): void {
    if (this.draining) {
      return; // the active drain loop picks the newly queued message up
    }
    this.draining = true;
    try {
      while (
        !this.intentionallyClosed &&
        this.socket !== null &&
        this.socket.readyState === SOCKET_OPEN &&
        this.outbox.length > 0
      ) {
        const message = this.outbox.shift()!;
        try {
          this.socket.send(JSON.stringify(message));
        } catch {
          // Unexpected socket write failure: pause the drain (the remaining
          // messages stay queued; the close path clears them safely).
          // Never log the frame content — payload secrecy.
          this.logger.warn('cTrader transport outbound write failed — drain paused');
          return;
        }
      }
    } finally {
      this.draining = false;
    }
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

  private notifyClosed(code: number | undefined, reason: string): void {
    if (this.closeHandler) {
      this.closeHandler(code, reason);
    }
  }

  private disposeSocket(): void {
    this.outbox.length = 0;
    this.socket = null;
  }
}
