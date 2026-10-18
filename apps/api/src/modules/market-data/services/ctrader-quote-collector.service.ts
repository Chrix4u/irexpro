import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrokerService } from '../../broker/broker.service';
import { BrokerConnectionStatus } from '../../broker/interfaces/broker-adapter.interface';
import { CTRADER_FAMILY_BROKER_IDS } from '../../broker/registry/broker-catalog';
import { isFxWeeklySessionOpen } from '../utils/fx-weekly-session';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 300_000;
const DEFAULT_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];
const WARM_TARGET_M1_CANDLES = 12_000;
const WARM_PAGE_SIZE = 2_000;
const MAX_HISTORY_PAGES_PER_CYCLE = 4;

/**
 * Exact-binding cTrader market-data collector for the M1 tactical PAPER sleeve.
 *
 * Execution remains bound to the configured PAPER connection. This service is
 * read-only against the separately configured cTrader connection and writes
 * broker-native M1 evidence under that source connection id. The scheduler
 * reads from the same source id while persisting/executing decisions against
 * the PAPER binding.
 *
 * Historical trendbars intentionally contain NO invented bid/ask spread. A
 * fresh live cTrader quote stream must build the positive-spread evidence used
 * by M1 governance before any PAPER order can be admitted.
 */
@Injectable()
export class CTraderQuoteCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CTraderQuoteCollectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private readonly warnedAt = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly brokerService: BrokerService,
    private readonly store: ProviderQuoteCandleStoreService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.enabled()) return;
    const intervalMs = this.intervalMs();
    this.stopping = false;
    this.logger.log(
      `cTrader broker-native M1 collection enabled interval=${intervalMs}ms ` +
        `source=${this.sourceConnectionId()} instruments=${this.instruments().join(',')}`,
    );
    this.schedule(intervalMs, 3_000);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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

      await this.warmHistory(userId, connectionId, now);
      await Promise.all(
        this.instruments().map(async (instrument) => {
          try {
            const quote = await this.brokerService.getCurrentPriceForConnection(
              userId,
              connectionId,
              instrument,
              { propagateProviderError: true },
            );
            if (quote) {
              await this.store.upsertM1Sample(
                connectionId,
                instrument,
                quote,
                'ctrader-broker-native',
              );
            }
          } catch (error) {
            this.warnThrottled(
              `${connectionId}:${instrument}:quote`,
              `cTrader quote collection failed connection=${connectionId} instrument=${instrument}: ${(error as Error).message}`,
            );
          }
        }),
      );
    } catch (error) {
      this.warnThrottled(
        `${connectionId}:binding`,
        `cTrader M1 source binding is unavailable: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async warmHistory(userId: string, connectionId: string, now: Date): Promise<void> {
    let pages = 0;
    for (const instrument of this.instruments()) {
      if (pages >= MAX_HISTORY_PAGES_PER_CYCLE) break;
      try {
        const count = await this.store.countM1Candles(connectionId, instrument);
        if (count >= WARM_TARGET_M1_CANDLES) continue;

        const oldest = await this.store.getOldestM1OpenTime(connectionId, instrument);
        const before = oldest
          ? new Date(oldest.getTime() - 60_000)
          : new Date(Math.floor(now.getTime() / 60_000) * 60_000);
        const remaining = Math.max(1, WARM_TARGET_M1_CANDLES - count);
        const requestCount = Math.min(WARM_PAGE_SIZE, remaining);
        const rows = await this.brokerService.getOhlcvForConnection(
          userId,
          connectionId,
          instrument,
          'M1',
          requestCount,
          before,
        );
        pages += 1;

        const decisionMs = now.getTime();
        const closedRows = rows.filter((row) => {
          const openMs = new Date(row.timestamp).getTime();
          return Number.isFinite(openMs) && openMs + 60_000 <= decisionMs;
        });
        if (closedRows.length > 0) {
          await this.store.upsertM1History(
            connectionId,
            instrument,
            closedRows,
            'ctrader-broker-native',
          );
        }
      } catch (error) {
        this.warnThrottled(
          `${connectionId}:${instrument}:history`,
          `cTrader M1 warm-start deferred connection=${connectionId} instrument=${instrument}: ${(error as Error).message}`,
        );
      }
    }
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
    this.timer = setTimeout(async () => {
      const startedAt = Date.now();
      try {
        await this.collectOnce();
      } finally {
        if (!this.stopping) {
          this.schedule(intervalMs, Math.max(1_000, intervalMs - (Date.now() - startedAt)));
        }
      }
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private warnThrottled(key: string, message: string): void {
    const now = Date.now();
    const previous = this.warnedAt.get(key) ?? 0;
    if (now - previous < 60_000) return;
    this.warnedAt.set(key, now);
    this.logger.warn(message);
  }
}
