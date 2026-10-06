export type MarketDataFreshness = 'FRESH' | 'STALE';

export interface MarketQuoteView {
  bid: string;
  ask: string;
  spread: string;
  timestamp: string;
  freshness: MarketDataFreshness;
}

export interface MarketCandleView {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface MarketIntelligenceView {
  instrument: string;
  timeframe: string;
  source: 'BROKER';
  status: MarketDataFreshness;
  retrievedAt: string;
  latestCandleAt: string | null;
  quote: MarketQuoteView;
  candles: MarketCandleView[];
}

export interface MarketIntelligenceRequest {
  instrument: string;
  timeframe: 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';
  limit?: number;
  /** Optional exact broker connection selected by the trading workspace. */
  brokerConnectionId?: string;
}
