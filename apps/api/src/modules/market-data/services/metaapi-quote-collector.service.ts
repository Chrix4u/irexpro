import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

interface CollectibleConnectionRow {
  id: string;
  user_id: string;
}

@Injectable()
export class MetaApiQuoteCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetaApiQuoteCollectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly warnedAt = new Map<string, number>();

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
      2_000,
      Number(this.config.get<string>('METAAPI_QUOTE_COLLECTION_INTERVAL_MS', '5000')) || 5000,
    );
    this.logger.log(
      `MetaApi quote collection enabled interval=${intervalMs}ms instruments=${this.instruments().join(',')}`,
    );

    const initial = setTimeout(() => void this.collectOnce(), 2_000);
    initial.unref?.();
    this.timer = setInterval(() => void this.collectOnce(), intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async collectOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const connections = (await this.dataSource.query(`
        SELECT id, user_id
        FROM broker.broker_connections
        WHERE broker_id = 'metatrader5'
          AND account_type IN ('DEMO', 'LIVE')
          AND status = 'CONNECTED'
          AND authorization_status IN ('AUTHORIZED', 'ACTIVE')
          AND deleted_at IS NULL
      `)) as CollectibleConnectionRow[];

      for (const connection of connections) {
        for (const instrument of this.instruments()) {
          try {
            const quote = await this.brokerService.getCurrentPriceForConnection(
              connection.user_id,
              connection.id,
              instrument,
            );
            if (quote) {
              await this.store.upsertM1Sample(connection.id, instrument, quote);
            }
          } catch (error) {
            this.warnThrottled(
              `${connection.id}:${instrument}`,
              `Quote collection failed connection=${connection.id} instrument=${instrument}: ${(error as Error).message}`,
            );
          }
        }
      }
    } finally {
      this.busy = false;
    }
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
