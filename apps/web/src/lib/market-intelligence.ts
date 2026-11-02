import { createMarketIntelligenceApi } from '@irexpro/api-client/market-intelligence';
import type {
  MarketCandleView,
  MarketIntelligenceRequest,
  MarketIntelligenceView,
  MarketQuoteView,
} from '@irexpro/types/market-intelligence';
import { api } from '@/lib/api';
import { reconcileLiveCandles } from '@/lib/ai-live-visuals';

const marketApi = createMarketIntelligenceApi(api);
const FRESHNESS = new Set(['FRESH', 'STALE']);
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const liveCandleCache = new Map<string, MarketCandleView[]>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value) && Number.isFinite(Number(value));
}

function isQuote(value: unknown): value is MarketQuoteView {
  if (!isRecord(value) || !hasExactKeys(value, ['bid', 'ask', 'spread', 'timestamp', 'freshness'])) {
    return false;
  }
  return (
    isDecimal(value.bid) &&
    isDecimal(value.ask) &&
    isDecimal(value.spread) &&
    isIsoDate(value.timestamp) &&
    typeof value.freshness === 'string' &&
    FRESHNESS.has(value.freshness)
  );
}

function isCandle(value: unknown): value is MarketCandleView {
  if (!isRecord(value) || !hasExactKeys(value, ['timestamp', 'open', 'high', 'low', 'close', 'volume'])) {
    return false;
  }
  return (
    isIsoDate(value.timestamp) &&
    isDecimal(value.open) &&
    isDecimal(value.high) &&
    isDecimal(value.low) &&
    isDecimal(value.close) &&
    isDecimal(value.volume) &&
    Number(value.high) >= Math.max(Number(value.open), Number(value.close), Number(value.low)) &&
    Number(value.low) <= Math.min(Number(value.open), Number(value.close), Number(value.high))
  );
}

export function isMarketIntelligenceView(value: unknown): value is MarketIntelligenceView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'instrument',
      'timeframe',
      'source',
      'status',
      'retrievedAt',
      'latestCandleAt',
      'quote',
      'candles',
    ])
  ) {
    return false;
  }

  return (
    typeof value.instrument === 'string' &&
    /^[A-Z0-9._-]{3,24}$/.test(value.instrument) &&
    typeof value.timeframe === 'string' &&
    value.source === 'BROKER' &&
    typeof value.status === 'string' &&
    FRESHNESS.has(value.status) &&
    isIsoDate(value.retrievedAt) &&
    (value.latestCandleAt === null || isIsoDate(value.latestCandleAt)) &&
    isQuote(value.quote) &&
    Array.isArray(value.candles) &&
    value.candles.length > 0 &&
    value.candles.length <= 300 &&
    value.candles.every(isCandle)
  );
}

function cacheKey(request: MarketIntelligenceRequest): string {
  return [request.brokerConnectionId ?? 'AUTO', request.instrument, request.timeframe].join('|');
}

export async function loadMarketIntelligence(
  request: MarketIntelligenceRequest,
): Promise<MarketIntelligenceView> {
  const snapshot = await marketApi.getSnapshot(request);
  if (!isMarketIntelligenceView(snapshot)) {
    throw new Error('Market Intelligence contract mismatch');
  }

  const key = cacheKey(request);
  const previous = liveCandleCache.get(key) ?? [];
  const candles = reconcileLiveCandles(
    previous,
    snapshot.candles,
    snapshot.quote,
    snapshot.timeframe,
  ) as MarketCandleView[];
  liveCandleCache.set(key, candles);

  return {
    ...snapshot,
    candles,
  };
}


/**
 * Fetch only the newest broker quote projection. The API still returns one
 * completed candle for contract compatibility, but this path deliberately does
 * not touch the 90-bar live-candle cache used by the chart history refresh.
 */
export async function loadLiveMarketQuote(
  request: Omit<MarketIntelligenceRequest, 'limit'>,
): Promise<MarketQuoteView> {
  const snapshot = await marketApi.getSnapshot({ ...request, limit: 1 });
  if (!isRecord(snapshot) || !isQuote(snapshot.quote)) {
    throw new Error('Live market quote contract mismatch');
  }
  return snapshot.quote;
}
