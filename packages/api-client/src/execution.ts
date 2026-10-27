import type { TradeExecutionView } from '@irexpro/types/execution';
import type { ApiClient } from './index';

export interface ExecutionApi {
  listOpenPositions(brokerConnectionId?: string): Promise<TradeExecutionView[]>;
  listRecentExecutions(limit?: number, brokerConnectionId?: string): Promise<TradeExecutionView[]>;
  listClosedExecutions(limit?: number, brokerConnectionId?: string): Promise<TradeExecutionView[]>;
}

/**
 * Typed execution read client layered on the shared ApiClient transport.
 *
 * This module is read-only by design. Live order placement remains server-side
 * behind the Risk Engine and execution pipeline; browser clients do not receive
 * a direct place-order method here.
 */
export function createExecutionApi(
  client: Pick<ApiClient, 'request'>,
): ExecutionApi {
  const brokerQuery = (brokerConnectionId?: string) =>
    brokerConnectionId ? `brokerConnectionId=${encodeURIComponent(brokerConnectionId)}` : '';

  return {
    listOpenPositions: (brokerConnectionId) => {
      const scope = brokerQuery(brokerConnectionId);
      return client.request<TradeExecutionView[]>(
        `/execution/positions/open${scope ? `?${scope}` : ''}`,
      );
    },

    listRecentExecutions: (limit = 50, brokerConnectionId) => {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const scope = brokerQuery(brokerConnectionId);
      return client.request<TradeExecutionView[]>(
        `/execution/trades/recent?limit=${safeLimit}${scope ? `&${scope}` : ''}`,
      );
    },

    listClosedExecutions: (limit = 50, brokerConnectionId) => {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const scope = brokerQuery(brokerConnectionId);
      return client.request<TradeExecutionView[]>(
        `/execution/trades/closed?limit=${safeLimit}${scope ? `&${scope}` : ''}`,
      );
    },
  };
}
