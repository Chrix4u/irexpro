import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BrokerPrice, OHLCV } from '../../broker/interfaces/broker-adapter.interface';

@Injectable()
export class ProviderQuoteCandleStoreService {
  constructor(private readonly dataSource: DataSource) {}

  async upsertM1Sample(
    connectionId: string,
    instrument: string,
    quote: BrokerPrice,
  ): Promise<void> {
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return;

    const midpoint = (bid + ask) / 2;
    const spread = ask - bid;
    const sampleAt = quote.timestamp instanceof Date ? quote.timestamp : new Date(quote.timestamp);
    if (Number.isNaN(sampleAt.getTime())) return;
    const bucket = new Date(sampleAt);
    bucket.setUTCSeconds(0, 0);

    await this.dataSource.query(
      `
      INSERT INTO market_data.provider_quote_candles (
        connection_id, instrument, timeframe, bucket_time,
        open, high, low, close, bid_close, ask_close, spread_close,
        sample_count, source, first_sample_at, last_sample_at
      ) VALUES ($1, $2, 'M1', $3, $4, $4, $4, $4, $5, $6, $7, 1, 'metaapi-rpc-sampled', $8, $8)
      ON CONFLICT (connection_id, instrument, timeframe, bucket_time)
      DO UPDATE SET
        high = GREATEST(market_data.provider_quote_candles.high, EXCLUDED.high),
        low = LEAST(market_data.provider_quote_candles.low, EXCLUDED.low),
        close = EXCLUDED.close,
        bid_close = EXCLUDED.bid_close,
        ask_close = EXCLUDED.ask_close,
        spread_close = EXCLUDED.spread_close,
        sample_count = market_data.provider_quote_candles.sample_count + 1,
        last_sample_at = GREATEST(
          market_data.provider_quote_candles.last_sample_at,
          EXCLUDED.last_sample_at
        ),
        updated_at = now()
      `,
      [
        connectionId,
        instrument,
        bucket.toISOString(),
        midpoint.toFixed(10),
        bid.toFixed(10),
        ask.toFixed(10),
        spread.toFixed(10),
        sampleAt.toISOString(),
      ],
    );
  }

  async getM1Candles(connectionId: string, instrument: string, count: number): Promise<OHLCV[]> {
    const rows = await this.dataSource.query(
      `
      SELECT bucket_time, open, high, low, close, sample_count, spread_close
      FROM market_data.provider_quote_candles
      WHERE connection_id = $1 AND instrument = $2 AND timeframe = 'M1'
        AND bucket_time < date_trunc('minute', now())
      ORDER BY bucket_time DESC
      LIMIT $3
      `,
      [connectionId, instrument, count],
    );

    return [...rows].reverse().map((row: any) => ({
      timestamp: new Date(row.bucket_time),
      open: String(row.open),
      high: String(row.high),
      low: String(row.low),
      close: String(row.close),
      volume: String(row.sample_count),
      tickVolume: String(row.sample_count),
    }));
  }

  async getCandles(
    connectionId: string,
    instrument: string,
    timeframe: string,
    count: number,
  ): Promise<OHLCV[]> {
    const normalized = timeframe.toUpperCase();
    if (normalized === 'M1') {
      return this.getM1Candles(connectionId, instrument, count);
    }

    const minutesByTimeframe: Record<string, number> = {
      M5: 5,
      M15: 15,
      M30: 30,
      H1: 60,
      H4: 240,
      D1: 1440,
    };
    const bucketMinutes = minutesByTimeframe[normalized];
    if (!bucketMinutes) return [];

    const m1 = await this.getM1Candles(
      connectionId,
      instrument,
      Math.max(count * bucketMinutes * 2, bucketMinutes),
    );
    const groups = new Map<number, OHLCV[]>();
    const bucketMs = bucketMinutes * 60_000;
    for (const candle of m1) {
      const ts = new Date(candle.timestamp).getTime();
      const key = Math.floor(ts / bucketMs) * bucketMs;
      const group = groups.get(key) ?? [];
      group.push(candle);
      groups.set(key, group);
    }

    const now = Date.now();
    const aggregated: OHLCV[] = [];
    for (const [bucketStart, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      if (group.length !== bucketMinutes) continue;
      if (bucketStart + bucketMs > now) continue;
      const ordered = [...group].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
      const highs = ordered.map((x) => Number(x.high));
      const lows = ordered.map((x) => Number(x.low));
      if (highs.some((x) => !Number.isFinite(x)) || lows.some((x) => !Number.isFinite(x))) {
        continue;
      }
      const volume = ordered.reduce((sum, x) => sum + Number(x.volume || 0), 0);
      aggregated.push({
        timestamp: new Date(bucketStart),
        open: ordered[0].open,
        high: Math.max(...highs).toFixed(10),
        low: Math.min(...lows).toFixed(10),
        close: ordered[ordered.length - 1].close,
        volume: String(volume),
        tickVolume: String(volume),
      });
    }

    return aggregated.slice(-count);
  }

  async countM1Candles(connectionId: string, instrument: string): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count
       FROM market_data.provider_quote_candles
       WHERE connection_id = $1 AND instrument = $2 AND timeframe = 'M1'`,
      [connectionId, instrument],
    );
    return Number(rows?.[0]?.count ?? 0);
  }
}
