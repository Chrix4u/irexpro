import type {
  LiveAccountActivityPage,
  LiveAccountOrdersPage,
  LiveAccountOverviewView,
  LiveAccountPositionsView,
  LiveOrderStatusFilter,
} from '@irexpro/types/live-account';
import type { ApiClient } from './index';

export interface LiveAccountApi {
  getOverview(): Promise<LiveAccountOverviewView>;
  getOrders(
    status?: LiveOrderStatusFilter,
    limit?: number,
    offset?: number,
  ): Promise<LiveAccountOrdersPage>;
  getPositions(): Promise<LiveAccountPositionsView>;
  getActivity(limit?: number, offset?: number): Promise<LiveAccountActivityPage>;
}

/**
 * Typed read-only Live Account client layered on the shared ApiClient
 * transport (Sprint 50 PR-5 — Directive PHASE J/K).
 *
 * This module is read-only by design: alerts, health, and the environment
 * banner are all server-derived (Directive §38) and the client never
 * re-computes them. Query pagination is clamped client-side (limit 1..100,
 * offset ≥ 0) as defense in depth — the backend re-clamps fail-closed.
 */
export function createLiveAccountApi(
  client: Pick<ApiClient, 'request'>,
): LiveAccountApi {
  return {
    getOverview: () => client.request<LiveAccountOverviewView>('/live-account/overview'),

    getOrders: (status: LiveOrderStatusFilter = 'ALL', limit = 50, offset = 0) => {
      const safeStatus: LiveOrderStatusFilter =
        status === 'WORKING' || status === 'HISTORY' ? status : 'ALL';
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const safeOffset = Math.max(Math.trunc(offset), 0);
      return client.request<LiveAccountOrdersPage>(
        `/live-account/orders?status=${safeStatus}&limit=${safeLimit}&offset=${safeOffset}`,
      );
    },

    getPositions: () => client.request<LiveAccountPositionsView>('/live-account/positions'),

    getActivity: (limit = 50, offset = 0) => {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const safeOffset = Math.max(Math.trunc(offset), 0);
      return client.request<LiveAccountActivityPage>(
        `/live-account/activity?limit=${safeLimit}&offset=${safeOffset}`,
      );
    },
  };
}
