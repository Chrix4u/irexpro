import type {
  ManualPositionCloseResponseView,
  TradeExecutionView,
} from '@irexpro/types/execution';
import type { ApiClient } from './index';

export interface ExecutionApi {
  listOpenPositions(): Promise<TradeExecutionView[]>;
  listRecentExecutions(limit?: number): Promise<TradeExecutionView[]>;
  /**
   * Close ONE open position by its execution record id. Returns the typed,
   * honest outcome — the client never fabricates a close result.
   */
  closePosition(tradeId: string): Promise<ManualPositionCloseResponseView>;
}

/**
 * Typed execution read client layered on the shared ApiClient transport.
 *
 * Order placement remains server-side behind the Risk Engine and execution
 * pipeline; browser clients do not receive a direct place-order method here.
 * The single-position manual close IS exposed: it routes through the same
 * server-side execution domain (risk-reducing, ownership-checked, audited) —
 * never a direct provider call from the client.
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

    closePosition: (tradeId) =>
      client.request<ManualPositionCloseResponseView>(
        `/execution/positions/${encodeURIComponent(tradeId)}/close`,
        { method: 'POST' },
      ),
  };
}
