/**
 * Historical broker-realized route economics, segregated by the selected
 * connected DEMO account. All results are observational only.
 */
export const DEMO_ROUTE_NET_PERFORMANCE_WINDOW_DAYS = 10 as const;

export interface DemoRouteNetPerformanceRow {
  broker_id: string;
  account_currency: string | null;
  authority_path: string | null;
  strategy_route: string | null;
  closed_trades: number | string | null;
  verified_trades: number | string | null;
  net_wins: number | string | null;
  net_losses: number | string | null;
  gross_pnl: string | null;
  commission: string | null;
  swap: string | null;
  net_pnl: string | null;
}

export interface DemoRouteNetPerformance {
  mode: 'RESEARCH_ONLY';
  windowDays: typeof DEMO_ROUTE_NET_PERFORMANCE_WINDOW_DAYS;
  scope: 'LATEST_CONNECTED_CTRADER_DEMO' | 'NO_CONNECTED_CTRADER_DEMO';
  broker: string | null;
  accountCurrency: string | null;
  routes: Array<{
    authorityPath: string;
    strategyRoute: string;
    closedTrades: number;
    verifiedTrades: number;
    netWins: number;
    netLosses: number;
    grossPnl: string | null;
    commission: string | null;
    swap: string | null;
    netPnl: string | null;
  }>;
  modifiesExecution: false;
}

function count(raw: number | string | null): number {
  const numeric = Number(raw);
  return raw !== null && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function money(raw: string | null): string | null {
  return typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw) ? raw : null;
}

export function toDemoRouteNetPerformance(
  rows: DemoRouteNetPerformanceRow[],
): DemoRouteNetPerformance {
  const broker = rows[0]?.broker_id ?? null;
  const currency = rows[0]?.account_currency ?? null;
  return {
    mode: 'RESEARCH_ONLY',
    windowDays: DEMO_ROUTE_NET_PERFORMANCE_WINDOW_DAYS,
    scope: broker ? 'LATEST_CONNECTED_CTRADER_DEMO' : 'NO_CONNECTED_CTRADER_DEMO',
    broker,
    accountCurrency: currency,
    routes: rows
      .filter((row) => row.authority_path != null && row.strategy_route != null)
      .map((row) => ({
        authorityPath: row.authority_path!,
        strategyRoute: row.strategy_route!,
        closedTrades: count(row.closed_trades),
        verifiedTrades: count(row.verified_trades),
        netWins: count(row.net_wins),
        netLosses: count(row.net_losses),
        grossPnl: money(row.gross_pnl),
        commission: money(row.commission),
        swap: money(row.swap),
        netPnl: money(row.net_pnl),
      })),
    modifiesExecution: false,
  };
}
