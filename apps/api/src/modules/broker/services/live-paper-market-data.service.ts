import { Injectable } from '@nestjs/common';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import type { OHLCV } from '../interfaces/broker-adapter.interface';

export interface LivePaperQuote {
  bid: string;
  ask: string;
  timestamp: Date;
  source: 'REST_M5' | 'STREAM';
}

export interface LivePaperCandleInput {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
}

interface InstrumentSpec {
  digits: number;
  spread: number;
  description: string;
}

const SPECS: Record<string, InstrumentSpec> = {
  EURUSD: { digits: 5, spread: 0.0001, description: 'Euro vs US Dollar' },
  GBPUSD: { digits: 5, spread: 0.00012, description: 'British Pound vs US Dollar' },
  USDJPY: { digits: 3, spread: 0.01, description: 'US Dollar vs Japanese Yen' },
  AUDUSD: { digits: 5, spread: 0.0001, description: 'Australian Dollar vs US Dollar' },
  USDCAD: { digits: 5, spread: 0.00012, description: 'US Dollar vs Canadian Dollar' },
  USDCHF: { digits: 5, spread: 0.00012, description: 'US Dollar vs Swiss Franc' },
};

/**
 * In-memory market cache used only by the PAPER broker when the VPS-native
 * forex evidence collector is explicitly enabled for one paper connection.
 *
 * Twelve Data's Basic time-series endpoint supplies mid OHLC rather than
 * executable bid/ask. PAPER execution therefore applies a conservative,
 * documented fixed spread per pair around the latest fully CLOSED candle.
 * This is a simulation assumption and is never represented as broker-live
 * execution evidence.
 */
@Injectable()
export class LivePaperMarketDataService {
  private readonly liveConnections = new Set<string>();
  private readonly candles = new Map<string, OHLCV[]>();
  private readonly candleQuotes = new Map<string, LivePaperQuote>();
  private readonly streamingQuotes = new Map<string, LivePaperQuote>();
  private latestObservedAt: Date | null = null;
  private latestQuoteObservedAt: Date | null = null;

  readonly instruments = Object.freeze(Object.keys(SPECS));

  registerLiveConnection(connectionId: string): void {
    if (connectionId.trim()) this.liveConnections.add(connectionId.trim());
  }

  unregisterLiveConnection(connectionId: string): void {
    this.liveConnections.delete(connectionId.trim());
  }

  isLiveConnection(connectionId?: string): boolean {
    return Boolean(connectionId && this.liveConnections.has(connectionId));
  }

  updateClosedCandles(instrument: string, rows: LivePaperCandleInput[]): void {
    const symbol = this.requireSupported(instrument);
    if (rows.length < 2) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `Live paper market data requires at least two closed candles for ${symbol}.`,
      );
    }
    const spec = SPECS[symbol]!;
    const normalized = rows
      .map((row) => ({
        timestamp: new Date(row.timestamp),
        open: this.decimal(row.open, spec.digits),
        high: this.decimal(row.high, spec.digits),
        low: this.decimal(row.low, spec.digits),
        close: this.decimal(row.close, spec.digits),
        volume: '0',
        tickVolume: '0',
        priceDigits: spec.digits,
        brokerTime: new Date(row.timestamp).toISOString(),
      }))
      .filter((row) => Number.isFinite(row.timestamp.getTime()))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (normalized.length < 2) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `Live paper market data contains insufficient valid timestamps for ${symbol}.`,
      );
    }

    const latest = normalized[normalized.length - 1]!;
    const mid = Number(latest.close);
    if (!Number.isFinite(mid) || mid <= 0) {
      throw new BrokerAdapterError(BrokerErrorCode.INVALID_PRICE, `Invalid ${symbol} close price.`);
    }
    const halfSpread = spec.spread / 2;
    const quoteTimestamp = new Date(latest.timestamp.getTime() + 5 * 60_000);
    this.candles.set(symbol, normalized.slice(-500));
    this.candleQuotes.set(symbol, {
      bid: (mid - halfSpread).toFixed(spec.digits),
      ask: (mid + halfSpread).toFixed(spec.digits),
      timestamp: quoteTimestamp,
      source: 'REST_M5',
    });
    if (!this.latestObservedAt || quoteTimestamp > this.latestObservedAt) {
      this.latestObservedAt = quoteTimestamp;
    }
    if (!this.latestQuoteObservedAt || quoteTimestamp > this.latestQuoteObservedAt) {
      this.latestQuoteObservedAt = quoteTimestamp;
    }
  }

  updateStreamingMidQuote(instrument: string, price: number | string, observedAt: Date): void {
    const symbol = this.requireSupported(instrument);
    const spec = SPECS[symbol]!;
    const mid = Number(price);
    const timestamp = new Date(observedAt);
    if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(timestamp.getTime())) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_PRICE,
        `Invalid streaming PAPER quote for ${symbol}.`,
      );
    }
    const halfSpread = spec.spread / 2;
    const quote: LivePaperQuote = {
      bid: (mid - halfSpread).toFixed(spec.digits),
      ask: (mid + halfSpread).toFixed(spec.digits),
      timestamp,
      source: 'STREAM',
    };
    const current = this.streamingQuotes.get(symbol);
    if (!current || timestamp.getTime() >= current.timestamp.getTime()) {
      this.streamingQuotes.set(symbol, quote);
    }
    if (!this.latestQuoteObservedAt || timestamp > this.latestQuoteObservedAt) {
      this.latestQuoteObservedAt = timestamp;
    }
  }

  /**
   * Execution/evidence quote: ALWAYS the latest fully closed M5 REST candle.
   * Streaming ticks must never alter v5 fills, margin/risk, or SL/TP evidence.
   */
  getQuote(instrument: string, maxAgeMs = 20 * 60_000): LivePaperQuote {
    const symbol = this.requireSupported(instrument);
    const quote = this.candleQuotes.get(symbol);
    if (!quote) {
      throw new BrokerAdapterError(
        BrokerErrorCode.PROVIDER_UNAVAILABLE,
        `No live PAPER execution quote is cached yet for ${symbol}.`,
        undefined,
        true,
      );
    }
    const age = Date.now() - quote.timestamp.getTime();
    if (!Number.isFinite(age) || age > maxAgeMs) {
      throw new BrokerAdapterError(
        BrokerErrorCode.PROVIDER_UNAVAILABLE,
        `Live PAPER execution quote for ${symbol} is stale (${Math.max(0, Math.round(age / 1000))}s old).`,
        undefined,
        true,
      );
    }
    return { ...quote, timestamp: new Date(quote.timestamp) };
  }

  /**
   * Read-only position mark: prefer a genuinely fresh streaming tick, otherwise
   * fall back to the same closed-M5 execution quote. This path is intentionally
   * excluded from order fills, risk sizing, margin authority and protection
   * evaluation so v5 evidence semantics remain unchanged.
   */
  getMarkQuote(
    instrument: string,
    streamMaxAgeMs = 60_000,
    fallbackMaxAgeMs = 20 * 60_000,
  ): LivePaperQuote {
    const symbol = this.requireSupported(instrument);
    const stream = this.streamingQuotes.get(symbol);
    if (stream) {
      const age = Date.now() - stream.timestamp.getTime();
      if (Number.isFinite(age) && age >= -5_000 && age <= streamMaxAgeMs) {
        return { ...stream, timestamp: new Date(stream.timestamp) };
      }
    }
    return this.getQuote(symbol, fallbackMaxAgeMs);
  }

  getOHLCV(instrument: string, timeframe: string, count: number): OHLCV[] {
    const symbol = this.requireSupported(instrument);
    const tf = timeframe.trim().toUpperCase();
    const timeframeMinutes: Record<string, number> = {
      M5: 5,
      M15: 15,
      M30: 30,
      H1: 60,
      H4: 240,
      D1: 1440,
    };
    const minutes = timeframeMinutes[tf];
    if (!minutes) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `VPS live PAPER market data supports M5/M15/M30/H1/H4/D1 (requested ${timeframe}).`,
      );
    }
    const rows = this.candles.get(symbol) ?? [];
    if (!rows.length) {
      throw new BrokerAdapterError(
        BrokerErrorCode.PROVIDER_UNAVAILABLE,
        `No live PAPER candles are cached yet for ${symbol}.`,
        undefined,
        true,
      );
    }
    if (tf === 'M5') {
      return rows
        .slice(-Math.max(1, count))
        .map((row) => ({ ...row, timestamp: new Date(row.timestamp) }));
    }

    const bucketMs = minutes * 60_000;
    const latestClosedAt = this.latestObservedAt?.getTime() ?? 0;
    const buckets = new Map<number, OHLCV[]>();
    for (const row of rows) {
      const ts = row.timestamp.getTime();
      const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
      // Higher-timeframe candles are exposed only after the entire bucket is
      // closed. This avoids presenting a partial H1/H4 bar as final evidence.
      if (bucketStart + bucketMs > latestClosedAt) continue;
      const bucket = buckets.get(bucketStart) ?? [];
      bucket.push(row);
      buckets.set(bucketStart, bucket);
    }

    const aggregated = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucketStart, bucket]) => {
        const first = bucket[0]!;
        const last = bucket[bucket.length - 1]!;
        const high = Math.max(...bucket.map((row) => Number(row.high)));
        const low = Math.min(...bucket.map((row) => Number(row.low)));
        const volume = bucket.reduce((sum, row) => sum + Number(row.volume || '0'), 0);
        const tickVolume = bucket.reduce((sum, row) => sum + Number(row.tickVolume || '0'), 0);
        return {
          ...first,
          timestamp: new Date(bucketStart),
          open: first.open,
          high: high.toFixed(first.priceDigits ?? this.spec(symbol).digits),
          low: low.toFixed(first.priceDigits ?? this.spec(symbol).digits),
          close: last.close,
          volume: String(volume),
          tickVolume: String(tickVolume),
          brokerTime: new Date(bucketStart).toISOString(),
        };
      });

    return aggregated.slice(-Math.max(1, count));
  }

  now(): Date {
    // v5 execution clock is anchored to the closed-candle evidence stream.
    return this.latestObservedAt ? new Date(this.latestObservedAt) : new Date();
  }

  status() {
    const cached = new Set([...this.candleQuotes.keys(), ...this.streamingQuotes.keys()]);
    const now = Date.now();
    const streamingInstruments = [...this.streamingQuotes.entries()]
      .filter(([, quote]) => {
        const age = now - quote.timestamp.getTime();
        return Number.isFinite(age) && age >= -5_000 && age <= 60_000;
      })
      .map(([symbol]) => symbol)
      .sort();
    return {
      cachedInstruments: [...cached].sort(),
      cachedInstrumentCount: cached.size,
      streamingInstruments,
      streamingInstrumentCount: streamingInstruments.length,
      latestObservedAt: this.latestObservedAt ? new Date(this.latestObservedAt) : null,
      latestQuoteObservedAt: this.latestQuoteObservedAt
        ? new Date(this.latestQuoteObservedAt)
        : null,
    };
  }

  spec(instrument: string): InstrumentSpec {
    return SPECS[this.requireSupported(instrument)]!;
  }

  private requireSupported(instrument: string): string {
    const symbol = instrument.trim().toUpperCase();
    if (!SPECS[symbol]) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        `Live PAPER market data supports ${Object.keys(SPECS).join(', ')} (received "${instrument}").`,
      );
    }
    return symbol;
  }

  private decimal(value: string, digits: number): string {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_PRICE,
        `Invalid live PAPER price: ${value}`,
      );
    }
    return n.toFixed(digits);
  }
}
