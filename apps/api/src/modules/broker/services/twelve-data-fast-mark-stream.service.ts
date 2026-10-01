import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LivePaperMarketDataService } from './live-paper-market-data.service';

type WsEvent = { data?: unknown; code?: number };
type NativeWebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: WsEvent) => void,
  ): void;
};
type NativeWebSocketCtor = new (url: string) => NativeWebSocketLike;

const PROVIDER_SYMBOLS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF'];
const SYMBOL_MAP = new Map(PROVIDER_SYMBOLS.map((symbol) => [symbol, symbol.replace('/', '')]));

@Injectable()
export class TwelveDataFastMarkStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TwelveDataFastMarkStreamService.name);
  private socket: NativeWebSocketLike | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 5_000;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly market: LivePaperMarketDataService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.enabled()) return;
    this.connect();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    try {
      this.socket?.close();
    } catch {
      // no-op during shutdown
    }
    this.socket = null;
  }

  private enabled(): boolean {
    if (this.config.get<boolean>('vpsForexScanner.enabled', false) !== true) return false;
    if (this.config.get<boolean>('vpsForexScanner.fastMarkStreamEnabled', true) === false)
      return false;
    const key = this.config.get<string>('vpsForexScanner.apiKey', '').trim();
    return Boolean(key && key.toLowerCase() !== 'demo');
  }

  private connect(): void {
    if (this.destroyed || !this.enabled() || this.socket) return;
    const Ctor = (globalThis as unknown as { WebSocket?: NativeWebSocketCtor }).WebSocket;
    if (!Ctor) {
      this.logger.warn('Node WebSocket client unavailable; fast PAPER marks disabled');
      return;
    }
    const key = this.config.get<string>('vpsForexScanner.apiKey', '').trim();
    const socket = new Ctor(
      `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(key)}`,
    );
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectDelayMs = 5_000;
      socket.send(
        JSON.stringify({ action: 'subscribe', params: { symbols: PROVIDER_SYMBOLS.join(',') } }),
      );
      this.startHeartbeat();
      this.logger.log(
        'Twelve Data fast-mark WebSocket connected; subscription requested for 6 pairs',
      );
    });
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('error', () => {
      this.logger.warn('Twelve Data fast-mark WebSocket reported an error');
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.scheduleReconnect();
    });
  }

  private onMessage(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.event === 'subscribe-status') {
      const success = Array.isArray(message.success)
        ? message.success
            .map((entry) =>
              typeof entry === 'object' && entry !== null
                ? String((entry as { symbol?: unknown }).symbol ?? '')
                : '',
            )
            .filter(Boolean)
        : [];
      const fails = Array.isArray(message.fails)
        ? message.fails
            .map((entry) =>
              typeof entry === 'object' && entry !== null
                ? String((entry as { symbol?: unknown }).symbol ?? '')
                : '',
            )
            .filter(Boolean)
        : [];
      this.logger.log(
        `Twelve Data fast-mark subscription accepted=${success.join(',') || 'none'} fallback=${fails.join(',') || 'none'}`,
      );
      return;
    }

    const providerSymbol = typeof message.symbol === 'string' ? message.symbol : '';
    const instrument = SYMBOL_MAP.get(providerSymbol);
    const price = Number(message.price);
    if (!instrument || !Number.isFinite(price) || price <= 0) return;
    const epochSeconds = Number(message.timestamp);
    const observedAt =
      Number.isFinite(epochSeconds) && epochSeconds > 0
        ? new Date(epochSeconds * 1000)
        : new Date();
    try {
      this.market.updateStreamingMidQuote(instrument, price, observedAt);
    } catch (error) {
      this.logger.warn(`Rejected fast mark for ${instrument}: ${(error as Error).message}`);
      return;
    }
    // Mark-only by design: position reads consume this fresher quote and
    // recalculate unrealized P&L. v5 PAPER SL/TP remains governed by the
    // closed-M5 evidence path; tick-level exits require a separately
    // versioned execution model once a six-pair broker-grade stream exists.
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === 1) {
        try {
          this.socket.send(JSON.stringify({ action: 'heartbeat' }));
        } catch {
          // close/reconnect handler owns recovery
        }
      }
    }, 10_000);
    this.heartbeatTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || !this.enabled() || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(60_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
