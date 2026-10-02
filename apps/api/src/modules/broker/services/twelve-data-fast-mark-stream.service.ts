import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LivePaperMarketDataService } from './live-paper-market-data.service';
import { PaperBrokerStateService } from './paper-broker-state.service';

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
const PROVIDER_BY_INSTRUMENT = new Map(
  [...SYMBOL_MAP.entries()].map(([provider, instrument]) => [instrument, provider]),
);

@Injectable()
export class TwelveDataFastMarkStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TwelveDataFastMarkStreamService.name);
  private socket: NativeWebSocketLike | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private preferenceTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 5_000;
  private destroyed = false;
  private preferredProviderSymbol = PROVIDER_SYMBOLS[0]!;

  constructor(
    private readonly config: ConfigService,
    private readonly market: LivePaperMarketDataService,
    private readonly paperState: PaperBrokerStateService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || !this.enabled()) return;
    await this.refreshPreferredSymbol(false);
    this.connect();
    this.preferenceTimer = setInterval(() => {
      void this.refreshPreferredSymbol(true);
    }, 30_000);
    this.preferenceTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.preferenceTimer) clearInterval(this.preferenceTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.preferenceTimer = null;
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
      // Twelve Data Basic currently accepts only one forex WebSocket symbol.
      // Request the selected exposure-aware symbol explicitly; sending all six
      // lets the provider choose a different symbol (observed: EUR/USD), which
      // defeats the fast-mark preference logic.
      socket.send(
        JSON.stringify({
          action: 'subscribe',
          params: { symbols: this.preferredProviderSymbol },
        }),
      );
      this.startHeartbeat();
      this.logger.log(
        `Twelve Data fast-mark WebSocket connected; primary=${this.preferredProviderSymbol} subscription requested`,
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
      if (
        success.length === 0 &&
        fails.includes(this.preferredProviderSymbol) &&
        this.preferredProviderSymbol !== 'EUR/USD' &&
        this.socket?.readyState === 1
      ) {
        this.logger.warn(
          `Fast-mark entitlement rejected ${this.preferredProviderSymbol}; falling back to EUR/USD`,
        );
        this.socket.send(
          JSON.stringify({ action: 'subscribe', params: { symbols: 'EUR/USD' } }),
        );
      }
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
      const connectionId = this.config
        .get<string>('vpsForexScanner.brokerConnectionId', '')
        .trim();
      this.market.updateStreamingMidQuote(
        instrument,
        price,
        observedAt,
        connectionId || undefined,
      );
    } catch (error) {
      this.logger.warn(`Rejected fast mark for ${instrument}: ${(error as Error).message}`);
      return;
    }
    // Mark-only by design: position reads consume this fresher quote and
    // recalculate unrealized P&L. v5 PAPER SL/TP remains governed by the
    // closed-M5 evidence path; tick-level exits require a separately
    // versioned execution model once a six-pair broker-grade stream exists.
  }

  private async refreshPreferredSymbol(reconnectOnChange: boolean): Promise<void> {
    const connectionId = this.config.get<string>('vpsForexScanner.brokerConnectionId', '').trim();
    if (!connectionId) return;
    let state: Record<string, unknown> | null = null;
    try {
      state = await this.paperState.load(connectionId);
    } catch (error) {
      this.logger.debug(`Fast-mark preference lookup deferred: ${(error as Error).message}`);
      return;
    }
    const positions = Array.isArray(state?.positions) ? state.positions : [];
    const score = new Map<string, { count: number; latest: number }>();
    for (const raw of positions) {
      if (!raw || typeof raw !== 'object') continue;
      const position = raw as { instrument?: unknown; openedAt?: unknown };
      const instrument =
        typeof position.instrument === 'string' ? position.instrument.trim().toUpperCase() : '';
      const provider = PROVIDER_BY_INSTRUMENT.get(instrument);
      if (!provider) continue;
      const openedAt = new Date(String(position.openedAt ?? '')).getTime();
      const current = score.get(provider) ?? { count: 0, latest: 0 };
      current.count += 1;
      if (Number.isFinite(openedAt)) current.latest = Math.max(current.latest, openedAt);
      score.set(provider, current);
    }
    const preferred =
      [...score.entries()]
        .sort((a, b) => b[1].count - a[1].count || b[1].latest - a[1].latest)
        .map(([provider]) => provider)[0] ?? PROVIDER_SYMBOLS[0]!;
    if (preferred === this.preferredProviderSymbol) return;
    const previous = this.preferredProviderSymbol;
    this.preferredProviderSymbol = preferred;
    this.logger.log(
      `Fast-mark primary changed ${previous} -> ${preferred} based on open PAPER exposure`,
    );
    if (reconnectOnChange && this.socket) {
      try {
        this.socket.close();
      } catch {
        // close/reconnect handler owns recovery
      }
    }
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
