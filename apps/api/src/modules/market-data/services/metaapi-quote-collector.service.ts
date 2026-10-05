import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';
import {
  METAAPI_PROVIDER_QUOTA_COOLDOWN_MS,
  isMetaApiQuotaError,
} from '../../broker/utils/metaapi-quota';
export { isMetaApiQuotaError } from '../../broker/utils/metaapi-quota';

interface CollectibleConnectionRow {
  id: string;
  user_id: string;
}

const DEFAULT_COLLECTION_INTERVAL_MS = 30_000;
const MIN_COLLECTION_INTERVAL_MS = 30_000;
const DEFAULT_COLLECTION_CONCURRENCY = 3;
const MAX_COLLECTION_CONCURRENCY = 6;
const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const MIN_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
export function isMetaApiQuoteCollectionWindow(now: Date): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

  // FX trades continuously through the weekday session. The previous
  // Mon-Fri<21UTC guard accidentally disabled quote collection every weekday
  // from 21:00-23:59 UTC and also missed the Sunday reopen. Keep the existing
  // conservative 21:00 UTC weekend boundary while allowing the full 24/5
  // session: Sunday >=21:00, Monday-Thursday all day, Friday <21:00.
  if (day === 0) return hour >= 21;
  if (day >= 1 && day <= 4) return true;
  if (day === 5) return hour < 21;
  return false;
}

@Injectable()
export class MetaApiQuoteCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetaApiQuoteCollectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopping = false;
  private readonly warnedAt = new Map<string, number>();
  private readonly cooldownUntilByConnection = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly brokerService: BrokerService,
    private readonly store: ProviderQuoteCandleStoreService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('METAAPI_QUOTE_COLLECTION_ENABLED', 'false') !== 'true') {
      this.logger.log('MetaApi quote collection disabled');
      return;
    }

    const intervalMs = Math.max(
      MIN_COLLECTION_INTERVAL_MS,
      Number(
        this.config.get<string>(
          'METAAPI_QUOTE_COLLECTION_INTERVAL_MS',
          String(DEFAULT_COLLECTION_INTERVAL_MS),
        ),
      ) || DEFAULT_COLLECTION_INTERVAL_MS,
    );
    this.logger.log(
      'MetaApi quote collection enabled ' +
        'interval=' +
        intervalMs +
        'ms ' +
        'instruments=' +
        this.instruments().join(',') +
        ' ' +
        'concurrency=' +
        this.collectionConcurrency() +
        ' requestTimeout=' +
        this.requestTimeoutMs() +
        'ms ' +
        'schedule=Sun>=21UTC/Mon-Thu24h/Fri<21UTC quotaCooldown=30m',
    );

    this.stopping = false;
    this.scheduleCollection(intervalMs, 2_000);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleCollection(intervalMs: number, delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(
      async () => {
        const startedAt = Date.now();
        try {
          await this.collectOnce();
        } finally {
          if (this.stopping) return;
          // Preserve the configured start-to-start cadence without overlapping
          // provider work. setInterval + the busy gate used to quantize a
          // 31-second cycle into ~60 seconds by skipping the next 30-second tick.
          const elapsedMs = Date.now() - startedAt;
          const nextDelayMs = Math.max(1_000, intervalMs - elapsedMs);
          this.scheduleCollection(intervalMs, nextDelayMs);
        }
      },
      Math.max(0, delayMs),
    );
    this.timer.unref?.();
  }

  async collectOnce(now = new Date()): Promise<void> {
    if (this.busy || !isMetaApiQuoteCollectionWindow(now)) return;
    this.busy = true;
    try {
      const connections = (await this.dataSource.query(`
        SELECT id, user_id
        FROM broker.broker_connections
        WHERE broker_id = 'metatrader5'
          AND account_type IN ('DEMO', 'LIVE')
          AND status = 'CONNECTED'
          AND authorization_status IN ('CONNECTED', 'AUTHORIZED', 'READY', 'ACTIVE')
          AND deleted_at IS NULL
      `)) as CollectibleConnectionRow[];

      const currentTime = now.getTime();
      for (const connection of connections) {
        const cooldownUntil = this.cooldownUntilByConnection.get(connection.id) ?? 0;
        if (cooldownUntil > currentTime) continue;
        if (cooldownUntil) this.cooldownUntilByConnection.delete(connection.id);

        const instruments = this.instruments();
        const concurrency = this.collectionConcurrency();
        for (let offset = 0; offset < instruments.length; offset += concurrency) {
          const batch = instruments.slice(offset, offset + concurrency);
          const results = await Promise.all(
            batch.map(async (instrument) => {
              try {
                const quote = await this.withTimeout(
                  this.brokerService.getCurrentPriceForConnection(
                    connection.user_id,
                    connection.id,
                    instrument,
                    { propagateProviderError: true },
                  ),
                  this.requestTimeoutMs(),
                  instrument,
                );
                if (quote) {
                  await this.store.upsertM1Sample(connection.id, instrument, quote);
                }
                return null;
              } catch (error) {
                if (!isMetaApiQuotaError(error)) {
                  this.warnThrottled(
                    connection.id + ':' + instrument,
                    'Quote collection failed connection=' +
                      connection.id +
                      ' instrument=' +
                      instrument +
                      ': ' +
                      (error as Error).message,
                  );
                }
                return error;
              }
            }),
          );

          const quotaError = results.find((error) => error && isMetaApiQuotaError(error));
          if (quotaError) {
            const nextAttempt = currentTime + METAAPI_PROVIDER_QUOTA_COOLDOWN_MS;
            this.cooldownUntilByConnection.set(connection.id, nextAttempt);
            this.warnThrottled(
              connection.id + ':quota',
              'MetaApi quote collection cooling down connection=' +
                connection.id +
                ' until=' +
                new Date(nextAttempt).toISOString() +
                ' reason=' +
                (quotaError as Error).message,
            );
            break;
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private requestTimeoutMs(): number {
    const configured = Number(
      this.config.get<string>(
        'METAAPI_QUOTE_REQUEST_TIMEOUT_MS',
        String(DEFAULT_REQUEST_TIMEOUT_MS),
      ),
    );
    if (!Number.isFinite(configured)) return DEFAULT_REQUEST_TIMEOUT_MS;
    return Math.min(
      MAX_REQUEST_TIMEOUT_MS,
      Math.max(MIN_REQUEST_TIMEOUT_MS, Math.floor(configured)),
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    instrument: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `MetaApi quote request timed out instrument=${instrument} after=${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private collectionConcurrency(): number {
    const configured = Number(
      this.config.get<string>(
        'METAAPI_QUOTE_COLLECTION_CONCURRENCY',
        String(DEFAULT_COLLECTION_CONCURRENCY),
      ),
    );
    if (!Number.isFinite(configured)) return DEFAULT_COLLECTION_CONCURRENCY;
    return Math.min(MAX_COLLECTION_CONCURRENCY, Math.max(1, Math.floor(configured)));
  }

  private instruments(): string[] {
    const configured = this.config.get<string>(
      'METAAPI_QUOTE_COLLECTION_INSTRUMENTS',
      'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF',
    );
    return configured
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
  }

  private warnThrottled(key: string, message: string): void {
    const now = Date.now();
    const previous = this.warnedAt.get(key) ?? 0;
    if (now - previous < 60_000) return;
    this.warnedAt.set(key, now);
    this.logger.warn(message);
  }
}
