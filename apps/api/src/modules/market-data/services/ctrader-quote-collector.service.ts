import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OHLCV } from '../../broker/interfaces/broker-adapter.interface';
import { BrokerService } from '../../broker/broker.service';
import { BrokerConnectionStatus } from '../../broker/interfaces/broker-adapter.interface';
import { CTRADER_FAMILY_BROKER_IDS } from '../../broker/registry/broker-catalog';
import { isFxWeeklySessionOpen } from '../utils/fx-weekly-session';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 300_000;
const DEFAULT_LIVE_QUOTE_INTERVAL_MS = 1_000;
const MIN_LIVE_QUOTE_INTERVAL_MS = 500;
const MAX_LIVE_QUOTE_INTERVAL_MS = 10_000;
const EXECUTION_SPREAD_MAX_AGE_MS = 5 * 60_000;
const MAX_PROVIDER_CLOCK_AHEAD_MS = 5_000;
const DEFAULT_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];
const M1_WARM_TARGET = 600;
const M1_REFRESH_COUNT = 60;
const CONTEXT_REFRESH_COUNT = 40;
const M1_REQUESTS_PER_CYCLE = 3;
const CONTEXT_TIMEFRAMES = ['M5', 'M15', 'H1', 'H4'] as const;

/**
 * Exact-binding cTrader market-data collector for the M1 tactical PAPER sleeve.
 *
 * Execution remains bound to the configured PAPER connection. This service is
 * read-only against the separately configured cTrader connection and writes
 * broker-native evidence under that source connection id. M1 is retained at
 * broker-native minute granularity while M5/M15/H1/H4 are also warmed directly;
 * this preserves cTrader no-tick semantics without fabricating aggregate bars.
 *
 * Historical trendbars intentionally contain NO invented bid/ask spread. Live
 * cTrader quotes must independently build the positive-spread evidence required
 * by M1 governance before PAPER execution can be admitted.
 */
@Injectable()
export class CTraderQuoteCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CTraderQuoteCollectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private liveQuoteTimer: NodeJS.Timeout | null = null;
  private running = false;
  private liveQuoteRunning = false;
  private stopping = false;
  private m1RotationOffset = 0;
  private contextRotationOffset = 0;
  private readonly warnedAt = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly brokerService: BrokerService,
    private readonly store: ProviderQuoteCandleStoreService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.enabled()) return;
    const intervalMs = this.intervalMs();
    const liveQuoteIntervalMs = this.liveQuoteIntervalMs();
    this.stopping = false;
    this.logger.log(
      `cTrader broker-native M1 collection enabled historyInterval=${intervalMs}ms ` +
        `liveQuoteInterval=${liveQuoteIntervalMs}ms source=${this.sourceConnectionId()} ` +
        `instruments=${this.instruments().join(',')}`,
    );
    this.schedule(intervalMs, 3_000);
    this.scheduleLiveQuotes(liveQuoteIntervalMs, 250);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.liveQuoteTimer) clearTimeout(this.liveQuoteTimer);
    this.timer = null;
    this.liveQuoteTimer = null;
  }

  async collectOnce(now = new Date()): Promise<void> {
    if (this.running || !this.enabled() || !isFxWeeklySessionOpen(now)) return;
    const userId = this.userId();
    const connectionId = this.sourceConnectionId();
    if (!userId || !connectionId) return;

    this.running = true;
    try {
      const connection = await this.brokerService.findConnectionById(connectionId, userId);
      if (!CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId)) {
        this.warnThrottled(
          `${connectionId}:wrong-provider`,
          `Configured M1 source ${connectionId} is ${connection.brokerId}, not a cTrader-family broker; collection is fail-closed.`,
        );
        return;
      }
      if (connection.status !== BrokerConnectionStatus.CONNECTED) {
        this.warnThrottled(
          `${connectionId}:not-connected`,
          `Configured cTrader M1 source ${connectionId} is ${connection.status}; collection is paused.`,
        );
        return;
      }

      // Execution-grade bid/ask evidence has priority over historical backfill.
      // A slow/rate-limited OHLCV request must never starve fresh quote samples
      // used by M1 readiness, cross-currency sizing and final risk validation.
      await this.sampleLiveSpreads(userId, connectionId, now);
      await this.refreshHistoricalSlice(userId, connectionId, now);
    } catch (error) {
      this.warnThrottled(
        `${connectionId}:binding`,
        `cTrader M1 source binding is unavailable: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  async collectLiveQuotesOnce(now = new Date()): Promise<void> {
    if (this.liveQuoteRunning || !this.enabled() || !isFxWeeklySessionOpen(now)) return;
    const userId = this.userId();
    const connectionId = this.sourceConnectionId();
    if (!userId || !connectionId) return;

    this.liveQuoteRunning = true;
    try {
      const connection = await this.brokerService.findConnectionById(connectionId, userId);
      if (!CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId)) return;
      if (connection.status !== BrokerConnectionStatus.CONNECTED) return;
      await this.sampleLiveSpreads(userId, connectionId, now);
    } catch (error) {
      this.warnThrottled(
        `${connectionId}:live-quote`,
        `cTrader live quote sampling deferred connection=${connectionId}: ${(error as Error).message}`,
      );
    } finally {
      this.liveQuoteRunning = false;
    }
  }

  private async refreshHistoricalSlice(
    userId: string,
    connectionId: string,
    now: Date,
  ): Promise<void> {
    const instruments = this.instruments();
    if (instruments.length === 0) return;

    const m1Batch = Array.from(
      { length: Math.min(M1_REQUESTS_PER_CYCLE, instruments.length) },
      (_, index) => instruments[(this.m1RotationOffset + index) % instruments.length]!,
    );
    this.m1RotationOffset =
      (this.m1RotationOffset + Math.min(M1_REQUESTS_PER_CYCLE, instruments.length)) %
      instruments.length;

    // Keep the cTrader historical request burst at four or fewer per cycle.
    // The provider documents a 5 requests/second historical limit per connection.
    for (const instrument of m1Batch) {
      await this.refreshM1(userId, connectionId, instrument, now);
    }

    // Warm the faster context across every pair before rotating into H1/H4.
    // Native cTrader M5/M15 is authoritative for no-tick intervals and avoids
    // rebuilding those timeframes from a sparse one-minute trendbar grid.
    const contextTasks = CONTEXT_TIMEFRAMES.flatMap((timeframe) =>
      instruments.map((instrument) => ({ instrument, timeframe })),
    );
    if (contextTasks.length === 0) return;
    const context = contextTasks[this.contextRotationOffset % contextTasks.length]!;
    this.contextRotationOffset = (this.contextRotationOffset + 1) % contextTasks.length;
    await this.refreshContext(userId, connectionId, context.instrument, context.timeframe, now);
  }

  private async refreshM1(
    userId: string,
    connectionId: string,
    instrument: string,
    now: Date,
  ): Promise<void> {
    try {
      const existing = await this.store.countM1Candles(connectionId, instrument);
      const requestCount = existing < M1_WARM_TARGET ? M1_WARM_TARGET : M1_REFRESH_COUNT;
      const rows = await this.brokerService.getOhlcvForConnection(
        userId,
        connectionId,
        instrument,
        'M1',
        requestCount,
      );
      const closed = this.closedRows(rows, 1, now);
      if (closed.length > 0) {
        await this.store.upsertHistoricalCandles(
          connectionId,
          instrument,
          'M1',
          closed,
          'ctrader-broker-native',
        );
      }
    } catch (error) {
      this.warnThrottled(
        `${connectionId}:${instrument}:M1`,
        `cTrader M1 refresh deferred connection=${connectionId} instrument=${instrument}: ${(error as Error).message}`,
      );
    }
  }

  private async refreshContext(
    userId: string,
    connectionId: string,
    instrument: string,
    timeframe: (typeof CONTEXT_TIMEFRAMES)[number],
    now: Date,
  ): Promise<void> {
    const minutes =
      timeframe === 'M5' ? 5 : timeframe === 'M15' ? 15 : timeframe === 'H1' ? 60 : 240;
    try {
      const rows = await this.brokerService.getOhlcvForConnection(
        userId,
        connectionId,
        instrument,
        timeframe,
        CONTEXT_REFRESH_COUNT,
      );
      const closed = this.closedRows(rows, minutes, now);
      if (closed.length > 0) {
        await this.store.upsertHistoricalCandles(
          connectionId,
          instrument,
          timeframe,
          closed,
          'ctrader-broker-native',
        );
      }
    } catch (error) {
      this.warnThrottled(
        `${connectionId}:${instrument}:${timeframe}`,
        `cTrader ${timeframe} refresh deferred connection=${connectionId} instrument=${instrument}: ${(error as Error).message}`,
      );
    }
  }

  private closedRows(rows: OHLCV[], minutes: number, now: Date): OHLCV[] {
    const decisionMs = now.getTime();
    const durationMs = minutes * 60_000;
    return rows.filter((row) => {
      const openMs = new Date(row.timestamp).getTime();
      return Number.isFinite(openMs) && openMs + durationMs <= decisionMs;
    });
  }

  private async sampleLiveSpreads(
    userId: string,
    connectionId: string,
    now: Date,
  ): Promise<void> {
    const collectorNowMs = now.getTime();
    await Promise.all(
      this.instruments().map(async (instrument) => {
        try {
          const quote = await this.brokerService.getCurrentPriceForConnection(
            userId,
            connectionId,
            instrument,
            { propagateProviderError: true },
          );
          if (!quote) return;

          const providerTimestampMs = new Date(quote.timestamp).getTime();
          const ageMs = collectorNowMs - providerTimestampMs;
          if (
            !Number.isFinite(providerTimestampMs) ||
            !Number.isFinite(collectorNowMs) ||
            ageMs > EXECUTION_SPREAD_MAX_AGE_MS ||
            ageMs < -MAX_PROVIDER_CLOCK_AHEAD_MS
          ) {
            const ageSeconds = Number.isFinite(ageMs) ? Math.round(ageMs / 1_000) : null;
            this.warnThrottled(
              `${connectionId}:${instrument}:stale-quote`,
              `cTrader live quote rejected connection=${connectionId} instrument=${instrument} ` +
                `providerTimestamp=${new Date(quote.timestamp).toISOString()} ` +
                `ageSeconds=${ageSeconds ?? 'INVALID'}; execution spread remains fail-closed.`,
            );
            return;
          }

          await this.store.upsertM1Sample(
            connectionId,
            instrument,
            quote,
            'ctrader-broker-native',
          );
        } catch (error) {
          this.warnThrottled(
            `${connectionId}:${instrument}:quote`,
            `cTrader quote collection failed connection=${connectionId} instrument=${instrument}: ${(error as Error).message}`,
          );
        }
      }),
    );
  }

  private enabled(): boolean {
    return (
      this.config.get<boolean>('vpsForexScanner.enabled', false) === true &&
      this.config.get<boolean>('vpsForexScanner.m1CtraderCollectionEnabled', false) === true &&
      Boolean(this.userId()) &&
      Boolean(this.sourceConnectionId())
    );
  }

  private userId(): string {
    return this.config.get<string>('vpsForexScanner.userId', '').trim();
  }

  private sourceConnectionId(): string {
    return this.config.get<string>('vpsForexScanner.m1MarketDataConnectionId', '').trim();
  }

  private intervalMs(): number {
    const raw = Number(
      this.config.get<number | string>(
        'vpsForexScanner.m1CtraderCollectionIntervalMs',
        DEFAULT_INTERVAL_MS,
      ),
    );
    if (!Number.isFinite(raw)) return DEFAULT_INTERVAL_MS;
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.floor(raw)));
  }

  private liveQuoteIntervalMs(): number {
    const raw = Number(
      this.config.get<number | string>(
        'vpsForexScanner.m1CtraderLiveQuoteIntervalMs',
        DEFAULT_LIVE_QUOTE_INTERVAL_MS,
      ),
    );
    if (!Number.isFinite(raw)) return DEFAULT_LIVE_QUOTE_INTERVAL_MS;
    return Math.min(
      MAX_LIVE_QUOTE_INTERVAL_MS,
      Math.max(MIN_LIVE_QUOTE_INTERVAL_MS, Math.floor(raw)),
    );
  }

  private instruments(): string[] {
    const raw = this.config.get<string>(
      'vpsForexScanner.m1CtraderCollectionInstruments',
      DEFAULT_INSTRUMENTS.join(','),
    );
    const values = raw
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    return values.length > 0 ? [...new Set(values)] : [...DEFAULT_INSTRUMENTS];
  }

  private schedule(intervalMs: number, delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(
      async () => {
        const startedAt = Date.now();
        try {
          await this.collectOnce();
        } finally {
          if (!this.stopping) {
            this.schedule(intervalMs, Math.max(1_000, intervalMs - (Date.now() - startedAt)));
          }
        }
      },
      Math.max(0, delayMs),
    );
    this.timer.unref?.();
  }

  private scheduleLiveQuotes(intervalMs: number, delayMs: number): void {
    if (this.stopping) return;
    this.liveQuoteTimer = setTimeout(
      async () => {
        const startedAt = Date.now();
        try {
          await this.collectLiveQuotesOnce();
        } finally {
          if (!this.stopping) {
            this.scheduleLiveQuotes(
              intervalMs,
              Math.max(100, intervalMs - (Date.now() - startedAt)),
            );
          }
        }
      },
      Math.max(0, delayMs),
    );
    this.liveQuoteTimer.unref?.();
  }

  private warnThrottled(key: string, message: string): void {
    const now = Date.now();
    const previous = this.warnedAt.get(key) ?? 0;
    if (now - previous < 60_000) return;
    this.warnedAt.set(key, now);
    this.logger.warn(message);
  }
}
