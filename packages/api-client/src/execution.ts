import type { TradeExecutionView } from '@irexpro/types/execution';
import type { ApiClient } from './index';

export interface ExecutionApi {
  listOpenPositions(): Promise<TradeExecutionView[]>;
  listRecentExecutions(limit?: number): Promise<TradeExecutionView[]>;
  listClosedExecutions(limit?: number): Promise<TradeExecutionView[]>;
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
  return {
    listOpenPositions: () =>
      client.request<TradeExecutionView[]>('/execution/positions/open'),

    listRecentExecutions: (limit = 50) => {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      return client.request<TradeExecutionView[]>(
        `/execution/trades/recent?limit=${safeLimit}`,
      );
    },

    listClosedExecutions: (limit = 50) => {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      return client.request<TradeExecutionView[]>(
        `/execution/trades/closed?limit=${safeLimit}`,
      );
    },
  };
}
