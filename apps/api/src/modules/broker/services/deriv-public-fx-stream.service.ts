import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isFxWeeklySessionOpen } from '../../market-data/utils/fx-weekly-session';
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

const DERIV_PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const DERIV_SYMBOLS = Object.freeze([
  ['frxEURUSD', 'EURUSD'],
  ['frxGBPUSD', 'GBPUSD'],
  ['frxUSDJPY', 'USDJPY'],
  ['frxAUDUSD', 'AUDUSD'],
  ['frxUSDCAD', 'USDCAD'],
  ['frxUSDCHF', 'USDCHF'],
] as const);
const INSTRUMENT_BY_DERIV_SYMBOL = new Map<string, string>(DERIV_SYMBOLS);
const REQUIRED_M1_CONTINUITY_BARS = 60;

@Injectable()
export class DerivPublicFxStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DerivPublicFxStreamService.name);
  private socket: NativeWebSocketLike | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 5_000;
  private destroyed = false;
  private marketSessionPaused = false;
  private readonly seenInstruments = new Set<string>();
  private sixPairReadyLogged = false;

  constructor(
    private readonly config: ConfigService,
    private readonly market: LivePaperMarketDataService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.enabled()) return;
    this.reconcileMarketSession();
    this.sessionTimer = setInterval(() => this.reconcileMarketSession(), 30_000);
    this.sessionTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.sessionTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Best-effort shutdown only.
      }
    }
  }

  private enabled(): boolean {
    if (this.config.get<boolean>('vpsForexScanner.enabled', false) !== true) return false;
    if (this.config.get<boolean>('vpsForexScanner.fastMarkStreamEnabled', true) === false)
      return false;
    const provider = this.config
      .get<string>('vpsForexScanner.fastMarkProvider', 'TWELVE_DATA')
      .trim()
      .toUpperCase();
    return provider === 'DERIV';
  }

  private connectionId(): string | undefined {
    const value = this.config.get<string>('vpsForexScanner.brokerConnectionId', '').trim();
    return value || undefined;
  }

  private reconcileMarketSession(): void {
    if (this.destroyed || !this.enabled()) return;
    if (!isFxWeeklySessionOpen(new Date())) {
      if (!this.marketSessionPaused) {
        this.marketSessionPaused = true;
        this.logger.log('Deriv public FX stream paused while the FX weekly session is closed');
      }
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.reconnectTimer = null;
      this.heartbeatTimer = null;
      const socket = this.socket;
      this.socket = null;
      if (socket) {
        try {
          socket.close();
        } catch {
          // Session-close owns the disconnect.
        }
      }
      return;
    }

    if (this.marketSessionPaused) {
      this.marketSessionPaused = false;
      this.logger.log('Deriv public FX stream resuming for the open FX weekly session');
    }
    this.connect();
  }

  private connect(): void {
    if (this.destroyed || !this.enabled() || this.socket || !isFxWeeklySessionOpen(new Date()))
      return;
    const Ctor = (globalThis as unknown as { WebSocket?: NativeWebSocketCtor }).WebSocket;
    if (!Ctor) {
      this.logger.warn('Node WebSocket client unavailable; Deriv fast PAPER marks disabled');
      return;
    }

    const socket = new Ctor(DERIV_PUBLIC_WS);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.reconnectDelayMs = 5_000;
      this.seenInstruments.clear();
      this.sixPairReadyLogged = false;
      socket.send(
        JSON.stringify({
          ticks: DERIV_SYMBOLS.map(([symbol]) => symbol),
          subscribe: 1,
          req_id: 1,
        }),
      );
      DERIV_SYMBOLS.forEach(([symbol], index) => {
        socket.send(
          JSON.stringify({
            ticks_history: symbol,
            count: 100,
            end: 'latest',
            style: 'candles',
            granularity: 60,
            req_id: 100 + index,
          }),
        );
      });
      this.startHeartbeat();
      this.logger.log('Deriv public FX WebSocket connected; six-pair stream requested');
    });
    socket.addEventListener('message', (event) => void this.onMessage(event.data));
    socket.addEventListener('error', () => {
      this.logger.warn('Deriv public FX WebSocket reported an error');
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.scheduleReconnect();
    });
  }

  private async onMessage(raw: unknown): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.error && typeof message.error === 'object') {
      const error = message.error as { code?: unknown; message?: unknown };
      this.logger.warn(
        `Deriv public FX API error code=${String(error.code ?? 'UNKNOWN')} message=${String(error.message ?? 'unknown')}`,
      );
      return;
    }

    if (message.msg_type === 'tick') {
      this.acceptTick(message.tick);
      return;
    }
    if (message.msg_type === 'candles') {
      this.acceptM1History(message);
    }
  }

  private acceptTick(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const tick = raw as { symbol?: unknown; quote?: unknown; epoch?: unknown };
    const providerSymbol = typeof tick.symbol === 'string' ? tick.symbol : '';
    const instrument = INSTRUMENT_BY_DERIV_SYMBOL.get(providerSymbol);
    const price = Number(tick.quote);
    const epochSeconds = Number(tick.epoch);
    if (
      !instrument ||
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(epochSeconds) ||
      epochSeconds <= 0
    ) {
      return;
    }
    const observedAt = new Date(epochSeconds * 1000);
    try {
      // Deriv exposes a single public FX quote rather than executable broker
      // Bid/Ask. Keep it in the generic STREAM lane so it can improve marks
      // and M1 telemetry without ever gaining PAPER execution authority.
      this.market.updateStreamingMidQuote(instrument, price, observedAt, this.connectionId());
    } catch (error) {
      this.logger.warn(`Rejected Deriv fast mark for ${instrument}: ${(error as Error).message}`);
      return;
    }

    this.seenInstruments.add(instrument);
    if (!this.sixPairReadyLogged && this.seenInstruments.size === DERIV_SYMBOLS.length) {
      this.sixPairReadyLogged = true;
      this.logger.log('Deriv public FX stream live instruments=6/6');
    }
  }

  private acceptM1History(message: Record<string, unknown>): void {
    const echo =
      message.echo_req && typeof message.echo_req === 'object'
        ? (message.echo_req as { ticks_history?: unknown })
        : null;
    const providerSymbol = typeof echo?.ticks_history === 'string' ? echo.ticks_history : '';
    const instrument = INSTRUMENT_BY_DERIV_SYMBOL.get(providerSymbol);
    const rawCandles = Array.isArray(message.candles) ? message.candles : [];
    if (!instrument || rawCandles.length === 0) return;

    const currentMinuteStart = Math.floor(Date.now() / 60_000) * 60_000;
    const rows = rawCandles
      .map((raw) => {
        if (!raw || typeof raw !== 'object') return null;
        const candle = raw as {
          epoch?: unknown;
          open?: unknown;
          high?: unknown;
          low?: unknown;
          close?: unknown;
        };
        const timestamp = new Date(Number(candle.epoch) * 1000);
        const prices = [candle.open, candle.high, candle.low, candle.close].map(Number);
        if (
          !Number.isFinite(timestamp.getTime()) ||
          timestamp.getTime() >= currentMinuteStart ||
          prices.some((price) => !Number.isFinite(price) || price <= 0)
        ) {
          return null;
        }
        return {
          timestamp,
          open: String(candle.open),
          high: String(candle.high),
          low: String(candle.low),
          close: String(candle.close),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

    if (rows.length < REQUIRED_M1_CONTINUITY_BARS) {
      this.logger.warn(
        `Deriv M1 bootstrap deferred instrument=${instrument} completedCandles=${rows.length}`,
      );
      return;
    }

    const connectionId = this.connectionId();
    try {
      this.market.updateClosedM1Candles(instrument, rows.slice(-100), connectionId);
      const latestOpen = rows.at(-1)!.timestamp;
      const contiguous = this.market.hasContiguousM1History(
        instrument,
        REQUIRED_M1_CONTINUITY_BARS,
        latestOpen,
        connectionId,
      );
      this.logger.log(
        `Deriv M1 PAPER history bootstrapped instrument=${instrument} candles=${Math.min(rows.length, 100)} contiguous60=${contiguous}`,
      );
    } catch (error) {
      this.logger.warn(
        `Rejected Deriv M1 bootstrap for ${instrument}: ${(error as Error).message}`,
      );
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === 1) {
        try {
          this.socket.send(JSON.stringify({ ping: 1 }));
        } catch {
          // Close/reconnect owns recovery.
        }
      }
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (
      this.destroyed ||
      !this.enabled() ||
      this.reconnectTimer ||
      !isFxWeeklySessionOpen(new Date())
    ) {
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(60_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
