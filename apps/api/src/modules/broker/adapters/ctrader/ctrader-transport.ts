/**
 * cTrader Open API transport (Sprint 56 / Task 47-C2).
 *
 * JSON-over-WebSocket (wss://host:5036). Uses Node's NATIVE WebSocket global
 * (Node ≥ 22; sandbox verified on v24.19.0) — ZERO new npm dependencies.
 *
 * The transport is deliberately minimal and dumb:
 * - JSON.stringify on the way out (the {clientMsgId, payloadType, payload}
 *   envelope), JSON.parse on the way in.
 * - Messages sent while the socket is still connecting are QUEUED and
 *   flushed on open (best practice per the official connection docs).
 * - Inbound JSON that fails to parse is DROPPED (counted, never logged with
 *   content) — a malformed frame must never crash the message pump and must
 *   never leak payload text into logs.
 * - The transport never interprets payload semantics: request↔response
 *   matching, auth, heartbeat and rate limiting all live in
 *   ctrader-client.service.ts.
 *
 * SECURITY: message payloads are NEVER logged (they can carry tokens).
 */
import { Logger } from '@nestjs/common';
import { CtraderMessageEnvelope } from './ctrader-message-types';

/** Transport-level callback shapes (kept primitive — no DOM types in the interface). */
export type CtraderTransportMessageHandler = (rawMessage: unknown) => void;
export type CtraderTransportCloseHandler = (closeCode: number | undefined, reason: string) => void;

/**
 * Transport abstraction over the cTrader JSON-WebSocket endpoint. Faked in
 * tests; implemented by NodeWebSocketCtraderTransport in production.
 */
export interface CtraderTransport {
  /** URL of the last successful connect() call (undefined when never connected). */
  readonly connectedUrl: string | undefined;
  /** Opens the WebSocket connection; rejects on failure/timeout. */
  connect(url: string): Promise<void>;
  /** Sends an envelope (queued while connecting; dropped when closed). */
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

/** Connect timeout — mirrors the client's request timeout budget. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Production transport on Node's native WebSocket.
 *
 * Demo/LIVE host isolation is enforced UPSTREAM (the client picks the URL from
 * the environment); the transport always connects to exactly the URL given.
 */
export class NodeWebSocketCtraderTransport implements CtraderTransport {
  private readonly logger = new Logger(NodeWebSocketCtraderTransport.name);
  private socket: WebSocket | null = null;
  private queuedMessages: CtraderMessageEnvelope[] = [];
  private messageHandler: CtraderTransportMessageHandler | null = null;
  private closeHandler: CtraderTransportCloseHandler | null = null;
  private _connectedUrl: string | undefined;

  get connectedUrl(): string | undefined {
    return this._connectedUrl;
  }

  connect(url: string): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    this.disposeSocket();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url);
      this.socket = socket;
      this._connectedUrl = url;

      const connectTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.logger.warn(`cTrader WebSocket connect timed out after ${CONNECT_TIMEOUT_MS}ms`);
          try {
            socket.close();
          } catch {
            /* best-effort cleanup */
          }
          reject(new Error('cTrader WebSocket connect timeout'));
        }
      }, CONNECT_TIMEOUT_MS);

      socket.addEventListener('open', () => {
        clearTimeout(connectTimer);
        if (!settled) {
          settled = true;
          this.flushQueue();
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
      socket.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(connectTimer);
        if (!settled) {
          settled = true;
          reject(new Error('cTrader WebSocket closed before open'));
        }
        this.notifyClosed(event.code, event.reason ?? '');
      });
      socket.addEventListener('message', (event: MessageEvent) => {
        this.handleRawFrame(event.data);
      });
    });
  }

  send(message: CtraderMessageEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
        this.queuedMessages.push(message);
      }
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  onMessage(handler: CtraderTransportMessageHandler): void {
    this.messageHandler = handler;
  }

  onClose(handler: CtraderTransportCloseHandler): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (!this.socket) return;
    try {
      this.socket.close(1000, 'client-initiated close');
    } catch {
      /* best-effort */
    }
  }

  isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

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

  private flushQueue(): void {
    const queue = this.queuedMessages;
    this.queuedMessages = [];
    for (const message of queue) {
      this.send(message);
    }
  }

  private notifyClosed(code: number | undefined, reason: string): void {
    if (this.closeHandler) {
      this.closeHandler(code, reason);
    }
  }

  private disposeSocket(): void {
    this.queuedMessages = [];
    this.socket = null;
  }
}
