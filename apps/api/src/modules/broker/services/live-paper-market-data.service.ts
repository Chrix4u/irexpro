import { Injectable } from '@nestjs/common';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import type { OHLCV } from '../interfaces/broker-adapter.interface';

export interface LivePaperQuote {
  bid: string;
  ask: string;
  timestamp: Date;
  source: 'REST_M5' | 'STREAM' | 'PROVIDER';
}

export interface LivePaperPositionMark extends LivePaperQuote {
  /**
   * Informational freshness only. A stale mark may be shown in the UI, but it
   * must never be used by execution, risk sizing, margin authority or SL/TP.
   */
  isStale: boolean;
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

interface LivePaperMarketState {
  candles: Map<string, OHLCV[]>;
  candleQuotes: Map<string, LivePaperQuote>;
  streamingQuotes: Map<string, LivePaperQuote>;
  latestObservedAt: Date | null;
  latestQuoteObservedAt: Date | null;
}

const DEFAULT_MARKET_SCOPE = '__default__';

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
  private readonly states = new Map<string, LivePaperMarketState>();

  readonly instruments = Object.freeze(Object.keys(SPECS));

  private marketState(connectionId?: string): LivePaperMarketState {
    const key = connectionId?.trim() || DEFAULT_MARKET_SCOPE;
    let state = this.states.get(key);
    if (!state) {
      state = {
        candles: new Map<string, OHLCV[]>(),
        candleQuotes: new Map<string, LivePaperQuote>(),
        streamingQuotes: new Map<string, LivePaperQuote>(),
        latestObservedAt: null,
        latestQuoteObservedAt: null,
      };
      this.states.set(key, state);
    }
    return state;
  }

  registerLiveConnection(connectionId: string): void {
    if (connectionId.trim()) this.liveConnections.add(connectionId.trim());
  }

  unregisterLiveConnection(connectionId: string): void {
    this.liveConnections.delete(connectionId.trim());
  }

  isLiveConnection(connectionId?: string): boolean {
    return Boolean(connectionId && this.liveConnections.has(connectionId));
  }

  updateClosedCandles(
    instrument: string,
    rows: LivePaperCandleInput[],
    connectionId?: string,
  ): void {
    const state = this.marketState(connectionId);
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
    state.candles.set(symbol, normalized.slice(-500));
    state.candleQuotes.set(symbol, {
      bid: (mid - halfSpread).toFixed(spec.digits),
      ask: (mid + halfSpread).toFixed(spec.digits),
      timestamp: quoteTimestamp,
      source: 'REST_M5',
    });
    if (!state.latestObservedAt || quoteTimestamp > state.latestObservedAt) {
      state.latestObservedAt = quoteTimestamp;
    }
    if (!state.latestQuoteObservedAt || quoteTimestamp > state.latestQuoteObservedAt) {
      state.latestQuoteObservedAt = quoteTimestamp;
    }
  }

  updateStreamingMidQuote(
    instrument: string,
    price: number | string,
    observedAt: Date,
    connectionId?: string,
  ): void {
    const state = this.marketState(connectionId);
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
    const current = state.streamingQuotes.get(symbol);
    if (!current || timestamp.getTime() >= current.timestamp.getTime()) {
      state.streamingQuotes.set(symbol, quote);
    }
    if (!state.latestQuoteObservedAt || timestamp > state.latestQuoteObservedAt) {
      state.latestQuoteObservedAt = timestamp;
    }
  }

  updateProviderQuote(
    instrument: string,
    bid: number | string,
    ask: number | string,
    observedAt: Date,
    connectionId?: string,
  ): void {
    const state = this.marketState(connectionId);
    const symbol = this.requireSupported(instrument);
    const spec = SPECS[symbol]!;
    const bidNumber = Number(bid);
    const askNumber = Number(ask);
    const timestamp = new Date(observedAt);
    if (
      !Number.isFinite(bidNumber) ||
      !Number.isFinite(askNumber) ||
      bidNumber <= 0 ||
      askNumber <= 0 ||
      askNumber < bidNumber ||
      !Number.isFinite(timestamp.getTime())
    ) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_PRICE,
        `Invalid provider PAPER quote for ${symbol}.`,
      );
    }
    const quote: LivePaperQuote = {
      bid: bidNumber.toFixed(spec.digits),
      ask: askNumber.toFixed(spec.digits),
      timestamp,
      source: 'PROVIDER',
    };
    const current = state.streamingQuotes.get(symbol);
    if (!current || timestamp.getTime() >= current.timestamp.getTime()) {
      state.streamingQuotes.set(symbol, quote);
    }
    if (!state.latestQuoteObservedAt || timestamp > state.latestQuoteObservedAt) {
      state.latestQuoteObservedAt = timestamp;
    }
  }

  /**
   * Execution/evidence quote: ALWAYS the latest fully closed M5 REST candle.
   * Streaming ticks must never alter v5 fills, margin/risk, or SL/TP evidence.
   */
  getQuote(instrument: string, maxAgeMs = 20 * 60_000, connectionId?: string): LivePaperQuote {
    const state = this.marketState(connectionId);
    const symbol = this.requireSupported(instrument);
    const quote = state.candleQuotes.get(symbol);
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
   * Fast position/protection mark: prefer a genuinely fresh streaming tick,
   * otherwise fall back to the same closed-M5 execution quote. The PAPER broker
   * may use fresh STREAM/PROVIDER marks to trigger SL/TP on already-open positions;
   * entry fills, risk sizing, margin authority and model evidence remain M5-based.
   */
  getMarkQuote(
    instrument: string,
    streamMaxAgeMs = 60_000,
    fallbackMaxAgeMs = 20 * 60_000,
    connectionId?: string,
  ): LivePaperQuote {
    const state = this.marketState(connectionId);
    const symbol = this.requireSupported(instrument);
    const stream = state.streamingQuotes.get(symbol);
    if (stream) {
      const age = Date.now() - stream.timestamp.getTime();
      if (Number.isFinite(age) && age >= -5_000 && age <= streamMaxAgeMs) {
        return { ...stream, timestamp: new Date(stream.timestamp) };
      }
    }
    return this.getQuote(symbol, fallbackMaxAgeMs, connectionId);
  }

  /**
   * Position valuation/protection mark.
   *
   * Unlike getQuote()/getMarkQuote(), this method may return the newest cached
   * quote even when it is stale. That is intentional: the Live Account UI can
   * keep displaying the last known market valuation with an explicit STALE
   * marker during provider gaps/rollover, while every trading decision remains
   * fail-closed on the freshness-enforcing methods above.
   */
  getPositionMarkQuote(
    instrument: string,
    streamMaxAgeMs = 60_000,
    fallbackMaxAgeMs = 20 * 60_000,
    connectionId?: string,
  ): LivePaperPositionMark {
    const state = this.marketState(connectionId);
    const symbol = this.requireSupported(instrument);
    const now = Date.now();
    const stream = state.streamingQuotes.get(symbol);
    const candle = state.candleQuotes.get(symbol);

    if (stream) {
      const age = now - stream.timestamp.getTime();
      if (Number.isFinite(age) && age >= -5_000 && age <= streamMaxAgeMs) {
        return { ...stream, timestamp: new Date(stream.timestamp), isStale: false };
      }
    }

    if (candle) {
      const age = now - candle.timestamp.getTime();
      if (Number.isFinite(age) && age >= -5_000 && age <= fallbackMaxAgeMs) {
        return { ...candle, timestamp: new Date(candle.timestamp), isStale: false };
      }
    }

    const candidates = [stream, candle].filter((quote): quote is LivePaperQuote => Boolean(quote));
    const latest = candidates.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
    if (!latest) {
      throw new BrokerAdapterError(
        BrokerErrorCode.PROVIDER_UNAVAILABLE,
        `No live PAPER position mark is cached yet for ${symbol}.`,
        undefined,
        true,
      );
    }
    return { ...latest, timestamp: new Date(latest.timestamp), isStale: true };
  }

  getOHLCV(instrument: string, timeframe: string, count: number, connectionId?: string): OHLCV[] {
    const state = this.marketState(connectionId);
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
    const rows = state.candles.get(symbol) ?? [];
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
    const latestClosedAt = state.latestObservedAt?.getTime() ?? 0;
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

  now(connectionId?: string): Date {
    // PAPER execution clocks are anchored to each connection's own evidence stream.
    const state = this.marketState(connectionId);
    return state.latestObservedAt ? new Date(state.latestObservedAt) : new Date();
  }

  status(connectionId?: string) {
    const state = this.marketState(connectionId);
    const cached = new Set([...state.candleQuotes.keys(), ...state.streamingQuotes.keys()]);
    const now = Date.now();
    const streamingInstruments = [...state.streamingQuotes.entries()]
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
      latestObservedAt: state.latestObservedAt ? new Date(state.latestObservedAt) : null,
      latestQuoteObservedAt: state.latestQuoteObservedAt
        ? new Date(state.latestQuoteObservedAt)
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
