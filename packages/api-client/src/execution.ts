import type { TradeExecutionView } from '@irexpro/types/execution';
import type { ApiClient } from './index';

export interface ExecutionApi {
  listOpenPositions(brokerConnectionId?: string): Promise<TradeExecutionView[]>;
  listRecentExecutions(limit?: number, brokerConnectionId?: string): Promise<TradeExecutionView[]>;
  listClosedExecutions(limit?: number, brokerConnectionId?: string): Promise<TradeExecutionView[]>;
}

function brokerQuery(brokerConnectionId: string | undefined, separator: '?' | '&'): string {
  return brokerConnectionId
    ? `${separator}brokerConnectionId=${encodeURIComponent(brokerConnectionId)}`
    : '';
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
    listOpenPositions: (brokerConnectionId) =>
      client.request<TradeExecutionView[]>(
        `/execution/positions/open${brokerQuery(brokerConnectionId, '?')}`,
      ),

    listRecentExecutions: (limit = 50, brokerConnectionId) => {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      return client.request<TradeExecutionView[]>(
        `/execution/trades/recent?limit=${safeLimit}${brokerQuery(brokerConnectionId, '&')}`,
      );
    },

    listClosedExecutions: (limit = 50, brokerConnectionId) => {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      return client.request<TradeExecutionView[]>(
        `/execution/trades/closed?limit=${safeLimit}${brokerQuery(brokerConnectionId, '&')}`,
      );
    },
  };
}
