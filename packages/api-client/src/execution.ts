import type {
  ClosedTradeReportQuery,
  ClosedTradeReportView,
  TradeExecutionView,
} from '@irexpro/types/execution';
import type { ApiClient } from './index';

export interface ExecutionApi {
  listOpenPositions(brokerConnectionId?: string): Promise<TradeExecutionView[]>;
  listRecentExecutions(limit?: number, brokerConnectionId?: string): Promise<TradeExecutionView[]>;
  listClosedExecutions(limit?: number, brokerConnectionId?: string): Promise<TradeExecutionView[]>;
  getClosedTradeReport(query?: ClosedTradeReportQuery): Promise<ClosedTradeReportView>;
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

    getClosedTradeReport: (query = {}) => {
      const page = Math.max(1, Math.trunc(query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 25)));
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (query.brokerConnectionId) params.set('brokerConnectionId', query.brokerConnectionId);
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      if (query.instrument) params.set('instrument', query.instrument.trim().toUpperCase());
      if (query.direction) params.set('direction', query.direction);
      if (query.outcome && query.outcome !== 'ALL') params.set('outcome', query.outcome);
      if (query.closeReason) params.set('closeReason', query.closeReason);
      return client.request<ClosedTradeReportView>(
        `/execution/trades/closed/report?${params.toString()}`,
      );
    },
  };
}
