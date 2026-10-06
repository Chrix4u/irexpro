import type {
  MarketIntelligenceRequest,
  MarketIntelligenceView,
} from '@irexpro/types/market-intelligence';
import type { ApiClient } from './index';

export interface MarketIntelligenceApi {
  getSnapshot(request: MarketIntelligenceRequest): Promise<MarketIntelligenceView>;
}

/** Read-only market data client. No order-placement or broker mutation methods. */
export function createMarketIntelligenceApi(
  client: Pick<ApiClient, 'request'>,
): MarketIntelligenceApi {
  return {
    getSnapshot: ({ instrument, timeframe, limit = 120, brokerConnectionId }) => {
      const params = new URLSearchParams({
        instrument,
        timeframe,
        limit: String(limit),
      });
      if (brokerConnectionId) params.set('brokerConnectionId', brokerConnectionId);
      return client.request<MarketIntelligenceView>(`/market-data/intelligence?${params.toString()}`);
    },
  };
}
