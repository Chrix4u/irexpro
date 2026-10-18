import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BrokerPrice, OHLCV } from '../../broker/interfaces/broker-adapter.interface';

export type ProviderQuoteSource = 'metaapi-rpc-sampled' | 'ctrader-broker-native';

export interface ProviderQuoteCandle extends OHLCV {
  source: string;
  sampleCount: number;
  spreadClose: string | null;
  firstSampleAt: Date;
  lastSampleAt: Date;
}

const TIMEFRAME_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
};

@Injectable()
export class ProviderQuoteCandleStoreService {
  constructor(private readonly dataSource: DataSource) {}

  async upsertM1Sample(
    connectionId: string,
    instrument: string,
    quote: BrokerPrice,
    source: ProviderQuoteSource = 'metaapi-rpc-sampled',
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
      ) VALUES ($1, $2, 'M1', $3, $4, $4, $4, $4, $5, $6, $7, 1, $9, $8, $8)
      ON CONFLICT (connection_id, instrument, timeframe, bucket_time)
      DO UPDATE SET
        high = GREATEST(market_data.provider_quote_candles.high, EXCLUDED.high),
        low = LEAST(market_data.provider_quote_candles.low, EXCLUDED.low),
        close = EXCLUDED.close,
        bid_close = EXCLUDED.bid_close,
        ask_close = EXCLUDED.ask_close,
        spread_close = EXCLUDED.spread_close,
        sample_count = market_data.provider_quote_candles.sample_count + 1,
        source = EXCLUDED.source,
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
        source,
      ],
    );
  }

  /**
   * Stores provider-native historical OHLC without fabricating bid/ask spread.
   * Historical cTrader trendbars are bar evidence only. Live getCurrentPrice()
   * observations remain the sole source of execution-spread evidence.
   */
  async upsertHistoricalCandles(
    connectionId: string,
    instrument: string,
    timeframe: string,
    rows: OHLCV[],
    source: ProviderQuoteSource,
  ): Promise<void> {
    const normalizedTimeframe = timeframe.trim().toUpperCase();
    const bucketMinutes = TIMEFRAME_MINUTES[normalizedTimeframe];
    if (!bucketMinutes) return;

    const normalized = rows
      .map((row) => ({
        timestamp: new Date(row.timestamp),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.tickVolume ?? row.volume ?? 0),
      }))
      .filter(
        (row) =>
          Number.isFinite(row.timestamp.getTime()) &&
          Number.isFinite(row.open) &&
          Number.isFinite(row.high) &&
          Number.isFinite(row.low) &&
          Number.isFinite(row.close) &&
          row.open > 0 &&
          row.high > 0 &&
          row.low > 0 &&
          row.close > 0,
      )
      .map((row) => ({
        timestamp: row.timestamp.toISOString(),
        open: row.open.toFixed(10),
        high: row.high.toFixed(10),
        low: row.low.toFixed(10),
        close: row.close.toFixed(10),
        sampleCount: Math.max(1, Math.floor(Number.isFinite(row.volume) ? row.volume : 0)),
      }));
    if (normalized.length === 0) return;

    await this.dataSource.query(
      `
      INSERT INTO market_data.provider_quote_candles (
        connection_id, instrument, timeframe, bucket_time,
        open, high, low, close, bid_close, ask_close, spread_close,
        sample_count, source, first_sample_at, last_sample_at
      )
      SELECT
        $1, $2, $3, x.timestamp, x.open, x.high, x.low, x.close,
        NULL, NULL, NULL, x.sample_count, $5, x.timestamp,
        x.timestamp + ($4::int * interval '1 minute') - interval '1 second'
      FROM jsonb_to_recordset($6::jsonb) AS x(
        timestamp timestamptz,
        open numeric,
        high numeric,
        low numeric,
        close numeric,
        sample_count integer
      )
      ON CONFLICT (connection_id, instrument, timeframe, bucket_time)
      DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        sample_count = GREATEST(
          market_data.provider_quote_candles.sample_count,
          EXCLUDED.sample_count
        ),
        source = EXCLUDED.source,
        first_sample_at = LEAST(
          market_data.provider_quote_candles.first_sample_at,
          EXCLUDED.first_sample_at
        ),
        last_sample_at = GREATEST(
          market_data.provider_quote_candles.last_sample_at,
          EXCLUDED.last_sample_at
        ),
        updated_at = now()
      `,
      [
        connectionId,
        instrument,
        normalizedTimeframe,
        bucketMinutes,
        source,
        JSON.stringify(normalized),
      ],
    );
  }

  async upsertM1History(
    connectionId: string,
    instrument: string,
    rows: OHLCV[],
    source: ProviderQuoteSource,
  ): Promise<void> {
    await this.upsertHistoricalCandles(connectionId, instrument, 'M1', rows, source);
  }

  async getLatestPositiveSpreadQuote(
    connectionId: string,
    instrument: string,
    evaluatedAt = new Date(),
  ): Promise<(BrokerPrice & { positiveSampleCount: number; latestPositiveSampleAt: Date }) | null> {
    const rows = await this.dataSource.query(
      `
      WITH latest AS (
        SELECT bid_close, ask_close, spread_close, last_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1
          AND instrument = $2
          AND timeframe = 'M1'
          AND bid_close IS NOT NULL
          AND ask_close IS NOT NULL
          AND spread_close IS NOT NULL
          AND last_sample_at <= $3::timestamptz
        ORDER BY last_sample_at DESC
        LIMIT 1
      ), positive AS (
        SELECT spread_close, last_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1
          AND instrument = $2
          AND timeframe = 'M1'
          AND spread_close > 0
          AND last_sample_at > ($3::timestamptz - interval '30 minutes')
          AND last_sample_at <= $3::timestamptz
      )
      SELECT
        l.bid_close,
        l.ask_close,
        l.spread_close,
        l.last_sample_at,
        COUNT(p.*)::int AS positive_sample_count,
        percentile_cont(0.90) WITHIN GROUP (ORDER BY p.spread_close::double precision) AS p90_spread,
        MAX(p.last_sample_at) AS latest_positive_sample_at
      FROM latest l
      LEFT JOIN positive p ON true
      GROUP BY l.bid_close, l.ask_close, l.spread_close, l.last_sample_at
      `,
      [connectionId, instrument, evaluatedAt.toISOString()],
    );
    const row = rows?.[0];
    if (!row) return null;
    const rawBid = Number(row.bid_close);
    const rawAsk = Number(row.ask_close);
    const p90Spread = Number(row.p90_spread);
    const rawSpread = Math.max(0, rawAsk - rawBid);
    const spread = Math.max(rawSpread, p90Spread);
    const timestamp = new Date(row.last_sample_at);
    const latestPositiveSampleAt = new Date(row.latest_positive_sample_at);
    const positiveSampleCount = Number(row.positive_sample_count);
    if (
      !Number.isFinite(rawBid) ||
      !Number.isFinite(rawAsk) ||
      rawBid <= 0 ||
      rawAsk <= 0 ||
      rawAsk < rawBid ||
      !Number.isFinite(spread) ||
      spread <= 0 ||
      !Number.isFinite(timestamp.getTime()) ||
      !Number.isFinite(latestPositiveSampleAt.getTime()) ||
      !Number.isFinite(positiveSampleCount) ||
      positiveSampleCount <= 0
    ) {
      return null;
    }
    const mid = (rawBid + rawAsk) / 2;
    const bid = mid - spread / 2;
    const ask = mid + spread / 2;
    return {
      instrument,
      bid: bid.toFixed(10),
      ask: ask.toFixed(10),
      spread: spread.toFixed(10),
      timestamp,
      positiveSampleCount,
      latestPositiveSampleAt,
    };
  }

  async getLatestQuote(connectionId: string, instrument: string): Promise<BrokerPrice | null> {
    const rows = await this.dataSource.query(
      `
      SELECT bid_close, ask_close, spread_close, last_sample_at
      FROM market_data.provider_quote_candles
      WHERE connection_id = $1 AND instrument = $2 AND timeframe = 'M1'
        AND bid_close IS NOT NULL
        AND ask_close IS NOT NULL
      ORDER BY last_sample_at DESC
      LIMIT 1
      `,
      [connectionId, instrument],
    );
    const row = rows?.[0];
    if (!row) return null;
    const bid = Number(row.bid_close);
    const ask = Number(row.ask_close);
    const timestamp = new Date(row.last_sample_at);
    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid <= 0 ||
      ask <= 0 ||
      ask < bid ||
      !Number.isFinite(timestamp.getTime())
    ) {
      return null;
    }
    return {
      instrument,
      bid: String(row.bid_close),
      ask: String(row.ask_close),
      spread: String(row.spread_close ?? ask - bid),
      timestamp,
    };
  }

  async getStoredCandles(
    connectionId: string,
    instrument: string,
    timeframe: string,
    count: number,
    evaluatedAt = new Date(),
  ): Promise<ProviderQuoteCandle[]> {
    const normalizedTimeframe = timeframe.trim().toUpperCase();
    const bucketMinutes = TIMEFRAME_MINUTES[normalizedTimeframe];
    if (!bucketMinutes) return [];
    const rows = await this.dataSource.query(
      `
      SELECT bucket_time, open, high, low, close, sample_count, spread_close,
             source, first_sample_at, last_sample_at
      FROM market_data.provider_quote_candles
      WHERE connection_id = $1
        AND instrument = $2
        AND timeframe = $3
        AND bucket_time + ($6::int * interval '1 minute') <= $5::timestamptz
      ORDER BY bucket_time DESC
      LIMIT $4
      `,
      [
        connectionId,
        instrument,
        normalizedTimeframe,
        count,
        evaluatedAt.toISOString(),
        bucketMinutes,
      ],
    );

    return [...rows].reverse().map((row: any) => ({
      timestamp: new Date(row.bucket_time),
      open: String(row.open),
      high: String(row.high),
      low: String(row.low),
      close: String(row.close),
      volume: String(row.sample_count),
      tickVolume: String(row.sample_count),
      source: String(row.source ?? ''),
      sampleCount: Number(row.sample_count),
      spreadClose: row.spread_close == null ? null : String(row.spread_close),
      firstSampleAt: new Date(row.first_sample_at),
      lastSampleAt: new Date(row.last_sample_at),
    }));
  }

  async getM1Candles(
    connectionId: string,
    instrument: string,
    count: number,
    evaluatedAt = new Date(),
  ): Promise<ProviderQuoteCandle[]> {
    return this.getStoredCandles(connectionId, instrument, 'M1', count, evaluatedAt);
  }

  async getCandles(
    connectionId: string,
    instrument: string,
    timeframe: string,
    count: number,
    evaluatedAt = new Date(),
  ): Promise<OHLCV[]> {
    const normalized = timeframe.toUpperCase();
    if (normalized === 'M1') {
      return this.getM1Candles(connectionId, instrument, count, evaluatedAt);
    }

    const bucketMinutes = TIMEFRAME_MINUTES[normalized];
    if (!bucketMinutes) return [];

    // cTrader warms H1/H4 directly so the tactical model does not need days
    // of sampled M1 history before higher-timeframe context becomes causal.
    if (normalized === 'H1' || normalized === 'H4') {
      const direct = await this.getStoredCandles(
        connectionId,
        instrument,
        normalized,
        count,
        evaluatedAt,
      );
      if (direct.length > 0) return direct;
    }

    const m1 = await this.getM1Candles(
      connectionId,
      instrument,
      Math.max(count * bucketMinutes * 2, bucketMinutes),
      evaluatedAt,
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

    const evaluatedAtMs = evaluatedAt.getTime();
    const aggregated: OHLCV[] = [];
    for (const [bucketStart, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      if (group.length !== bucketMinutes) continue;
      if (!Number.isFinite(evaluatedAtMs) || bucketStart + bucketMs > evaluatedAtMs) continue;
      const ordered = [...group].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
      const contiguous = ordered.every(
        (candle, index) => new Date(candle.timestamp).getTime() === bucketStart + index * 60_000,
      );
      if (!contiguous) continue;
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
