import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type ProfitProtectionExitQualityOutcome =
  | 'TP_FIRST'
  | 'SL_FIRST'
  | 'AMBIGUOUS_SAME_M1'
  | 'NEITHER_4H'
  | 'DATA_GAP';

export type ProfitProtectionStrategyRoute =
  | 'CONFIRMED_REVERSAL'
  | 'EARLY_TRANSITION'
  | 'TREND_CONTINUATION'
  | 'UNKNOWN';

export interface ProfitProtectionExitQualityQuery {
  brokerConnectionId?: string;
  from?: string;
  to?: string;
  instrument?: string;
  direction?: 'BUY' | 'SELL';
  strategyRoute?: ProfitProtectionStrategyRoute;
  outcome?: ProfitProtectionExitQualityOutcome;
  smallProfitOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ProfitProtectionExitQualityItem {
  tradeId: string;
  brokerConnectionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  strategyRoute: ProfitProtectionStrategyRoute;
  outcome: ProfitProtectionExitQualityOutcome;
  accountCurrency: string | null;
  realisedPnl: string | null;
  actualExitR: number | null;
  originalTargetR: number | null;
  counterfactualR: number | null;
  rDelta: number | null;
  minutesAfterClose: number | null;
  closedAt: string;
  eventAt: string | null;
}

export interface ProfitProtectionExitQualityReport {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: {
    total: number;
    resolvedCount: number;
    tpFirstCount: number;
    slFirstCount: number;
    tpFirstRate: number | null;
    slFirstRate: number | null;
    ambiguousCount: number;
    neitherCount: number;
    dataGapCount: number;
    smallProfitCount: number;
    smallProfitTpFirstCount: number;
    smallProfitTpFirstRate: number | null;
    accountCurrency: string | null;
    actualRealisedPnl: string | null;
    averageActualExitR: number | null;
    averageCounterfactualR: number | null;
    averageRDelta: number | null;
    currencyBreakdown: Array<{
      accountCurrency: string;
      tradeCount: number;
      actualRealisedPnl: string;
    }>;
  };
  routes: Array<{
    strategyRoute: ProfitProtectionStrategyRoute;
    total: number;
    tpFirstCount: number;
    slFirstCount: number;
    tpFirstRate: number | null;
  }>;
  items: ProfitProtectionExitQualityItem[];
}

interface NormalizedQuery {
  brokerConnectionId?: string;
  from?: string;
  to?: string;
  instrument?: string;
  direction?: 'BUY' | 'SELL';
  strategyRoute?: ProfitProtectionStrategyRoute;
  outcome?: ProfitProtectionExitQualityOutcome;
  smallProfitOnly: boolean;
  page: number;
  pageSize: number;
}

interface SqlFilterSet {
  whereSql: string;
  params: unknown[];
}

const OUTCOMES: readonly ProfitProtectionExitQualityOutcome[] = [
  'TP_FIRST',
  'SL_FIRST',
  'AMBIGUOUS_SAME_M1',
  'NEITHER_4H',
  'DATA_GAP',
];
const ROUTES: readonly ProfitProtectionStrategyRoute[] = [
  'CONFIRMED_REVERSAL',
  'EARLY_TRANSITION',
  'TREND_CONTINUATION',
  'UNKNOWN',
];
const DIRECTIONS = ['BUY', 'SELL'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTRUMENT_RE = /^[A-Z0-9._-]{3,20}$/;

const integer = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const decimal = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
};

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

@Injectable()
export class ProfitProtectionExitQualityService {
  constructor(private readonly dataSource: DataSource) {}

  async getReport(
    userId: string,
    query: ProfitProtectionExitQualityQuery,
  ): Promise<ProfitProtectionExitQualityReport> {
    if (!userId?.trim()) throw new BadRequestException('Invalid user');
    const normalized = this.normalizeQuery(query);
    const filters = this.buildFilters(userId, normalized);
    const cte = this.baseCte(filters.whereSql);

    const summaryRows = (await this.dataSource.query(
      `${cte}
       SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE f.outcome IN ('TP_FIRST','SL_FIRST'))::text AS resolved_count,
         COUNT(*) FILTER (WHERE f.outcome = 'TP_FIRST')::text AS tp_first_count,
         COUNT(*) FILTER (WHERE f.outcome = 'SL_FIRST')::text AS sl_first_count,
         COUNT(*) FILTER (WHERE f.outcome = 'AMBIGUOUS_SAME_M1')::text AS ambiguous_count,
         COUNT(*) FILTER (WHERE f.outcome = 'NEITHER_4H')::text AS neither_count,
         COUNT(*) FILTER (WHERE f.outcome = 'DATA_GAP')::text AS data_gap_count,
         COUNT(*) FILTER (WHERE f.realised_pnl > 0 AND f.realised_pnl <= 6)::text AS small_profit_count,
         COUNT(*) FILTER (WHERE f.realised_pnl > 0 AND f.realised_pnl <= 6 AND f.outcome = 'TP_FIRST')::text AS small_profit_tp_first_count,
         CASE
           WHEN COUNT(DISTINCT f.account_currency) FILTER (WHERE f.realised_pnl IS NOT NULL) = 1
             AND COUNT(*) FILTER (WHERE f.realised_pnl IS NOT NULL AND f.account_currency IS NULL) = 0
           THEN MIN(f.account_currency) FILTER (WHERE f.realised_pnl IS NOT NULL)
           ELSE NULL
         END AS account_currency,
         CASE
           WHEN COUNT(DISTINCT f.account_currency) FILTER (WHERE f.realised_pnl IS NOT NULL) = 1
             AND COUNT(*) FILTER (WHERE f.realised_pnl IS NOT NULL AND f.account_currency IS NULL) = 0
           THEN SUM(f.realised_pnl)::text
           ELSE NULL
         END AS actual_realised_pnl,
         AVG(f.actual_exit_r)::text AS avg_actual_exit_r,
         AVG(f.counterfactual_r)::text AS avg_counterfactual_r,
         AVG(f.r_delta)::text AS avg_r_delta
       FROM final_rows f`,
      filters.params,
    )) as Array<Record<string, unknown>> | undefined;

    const currencyRows = (await this.dataSource.query(
      `${cte}
       SELECT
         f.account_currency,
         COUNT(*)::text AS trade_count,
         SUM(f.realised_pnl)::text AS actual_realised_pnl
       FROM final_rows f
       WHERE f.account_currency IS NOT NULL AND f.realised_pnl IS NOT NULL
       GROUP BY f.account_currency
       ORDER BY f.account_currency`,
      filters.params,
    )) as Array<Record<string, unknown>> | undefined;

    const routeRows = (await this.dataSource.query(
      `${cte}
       SELECT
         f.strategy_route,
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE f.outcome = 'TP_FIRST')::text AS tp_first_count,
         COUNT(*) FILTER (WHERE f.outcome = 'SL_FIRST')::text AS sl_first_count
       FROM final_rows f
       GROUP BY f.strategy_route
       ORDER BY COUNT(*) DESC, f.strategy_route ASC`,
      filters.params,
    )) as Array<Record<string, unknown>> | undefined;

    const limitPosition = filters.params.length + 1;
    const offsetPosition = filters.params.length + 2;
    const itemRows = (await this.dataSource.query(
      `${cte}
       SELECT
         f.trade_id,
         f.broker_connection_id,
         f.instrument,
         f.direction,
         f.strategy_route,
         f.outcome,
         f.account_currency,
         f.realised_pnl,
         f.actual_exit_r,
         f.original_target_r,
         f.counterfactual_r,
         f.r_delta,
         f.minutes_after_close,
         f.closed_at,
         f.event_at,
         COUNT(*) OVER()::text AS total_count
       FROM final_rows f
       ORDER BY f.closed_at DESC, f.trade_id DESC
       LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
      [...filters.params, normalized.pageSize, (normalized.page - 1) * normalized.pageSize],
    )) as Array<Record<string, unknown>> | undefined;

    const summaryRow = summaryRows?.[0] ?? {};
    const total = integer(summaryRow.total);
    const resolvedCount = integer(summaryRow.resolved_count);
    const tpFirstCount = integer(summaryRow.tp_first_count);
    const slFirstCount = integer(summaryRow.sl_first_count);
    const smallProfitCount = integer(summaryRow.small_profit_count);
    const smallProfitTpFirstCount = integer(summaryRow.small_profit_tp_first_count);

    return {
      page: normalized.page,
      pageSize: normalized.pageSize,
      total,
      totalPages: total > 0 ? Math.ceil(total / normalized.pageSize) : 0,
      summary: {
        total,
        resolvedCount,
        tpFirstCount,
        slFirstCount,
        tpFirstRate: resolvedCount > 0 ? tpFirstCount / resolvedCount : null,
        slFirstRate: resolvedCount > 0 ? slFirstCount / resolvedCount : null,
        ambiguousCount: integer(summaryRow.ambiguous_count),
        neitherCount: integer(summaryRow.neither_count),
        dataGapCount: integer(summaryRow.data_gap_count),
        smallProfitCount,
        smallProfitTpFirstCount,
        smallProfitTpFirstRate:
          smallProfitCount > 0 ? smallProfitTpFirstCount / smallProfitCount : null,
        accountCurrency:
          typeof summaryRow.account_currency === 'string' ? summaryRow.account_currency : null,
        actualRealisedPnl: decimal(summaryRow.actual_realised_pnl),
        averageActualExitR: numeric(summaryRow.avg_actual_exit_r),
        averageCounterfactualR: numeric(summaryRow.avg_counterfactual_r),
        averageRDelta: numeric(summaryRow.avg_r_delta),
        currencyBreakdown: (currencyRows ?? []).map((row) => ({
          accountCurrency: String(row.account_currency),
          tradeCount: integer(row.trade_count),
          actualRealisedPnl: decimal(row.actual_realised_pnl) ?? '0',
        })),
      },
      routes: (routeRows ?? []).map((row) => {
        const routeTotal = integer(row.total);
        const routeTp = integer(row.tp_first_count);
        const routeSl = integer(row.sl_first_count);
        const routeResolved = routeTp + routeSl;
        return {
          strategyRoute: this.coerceRoute(row.strategy_route),
          total: routeTotal,
          tpFirstCount: routeTp,
          slFirstCount: routeSl,
          tpFirstRate: routeResolved > 0 ? routeTp / routeResolved : null,
        };
      }),
      items: (itemRows ?? []).map((row) => ({
        tradeId: String(row.trade_id),
        brokerConnectionId: String(row.broker_connection_id),
        instrument: String(row.instrument),
        direction: row.direction === 'SELL' ? 'SELL' : 'BUY',
        strategyRoute: this.coerceRoute(row.strategy_route),
        outcome: this.coerceOutcome(row.outcome),
        accountCurrency: typeof row.account_currency === 'string' ? row.account_currency : null,
        realisedPnl: decimal(row.realised_pnl),
        actualExitR: numeric(row.actual_exit_r),
        originalTargetR: numeric(row.original_target_r),
        counterfactualR: numeric(row.counterfactual_r),
        rDelta: numeric(row.r_delta),
        minutesAfterClose: numeric(row.minutes_after_close),
        closedAt: iso(row.closed_at) ?? String(row.closed_at ?? ''),
        eventAt: iso(row.event_at),
      })),
    };
  }

  private normalizeQuery(query: ProfitProtectionExitQualityQuery): NormalizedQuery {
    const page = Number.isFinite(Number(query.page))
      ? Math.max(1, Math.floor(Number(query.page)))
      : 1;
    const pageSize = Number.isFinite(Number(query.pageSize))
      ? Math.min(100, Math.max(1, Math.floor(Number(query.pageSize))))
      : 25;

    let from: string | undefined;
    let to: string | undefined;
    if (query.from) {
      const parsed = new Date(query.from);
      if (Number.isNaN(parsed.getTime())) throw new BadRequestException('Invalid from');
      from = parsed.toISOString();
    }
    if (query.to) {
      const parsed = new Date(query.to);
      if (Number.isNaN(parsed.getTime())) throw new BadRequestException('Invalid to');
      to = parsed.toISOString();
    }
    if (from && to && Date.parse(from) > Date.parse(to)) {
      throw new BadRequestException('Invalid date range');
    }

    const direction = query.direction?.toUpperCase() as 'BUY' | 'SELL' | undefined;
    if (direction && !DIRECTIONS.includes(direction)) {
      throw new BadRequestException('Invalid direction');
    }
    const strategyRoute = query.strategyRoute?.toUpperCase() as
      | ProfitProtectionStrategyRoute
      | undefined;
    if (strategyRoute && !ROUTES.includes(strategyRoute)) {
      throw new BadRequestException('Invalid strategyRoute');
    }
    const outcome = query.outcome?.toUpperCase() as ProfitProtectionExitQualityOutcome | undefined;
    if (outcome && !OUTCOMES.includes(outcome)) {
      throw new BadRequestException('Invalid outcome');
    }

    const instrument = query.instrument?.trim().toUpperCase();
    if (instrument && !INSTRUMENT_RE.test(instrument)) {
      throw new BadRequestException('Invalid instrument');
    }
    const brokerConnectionId = query.brokerConnectionId?.trim();
    if (brokerConnectionId && !UUID_RE.test(brokerConnectionId)) {
      throw new BadRequestException('Invalid brokerConnectionId');
    }

    return {
      brokerConnectionId,
      from,
      to,
      instrument,
      direction,
      strategyRoute,
      outcome,
      smallProfitOnly: query.smallProfitOnly === true,
      page,
      pageSize,
    };
  }

  private buildFilters(userId: string, query: NormalizedQuery): SqlFilterSet {
    const params: unknown[] = [userId];
    const clauses = [
      't.user_id = $1',
      "t.status = 'CLOSED'",
      "t.close_reason = 'PROFIT_PROTECTION'",
      "o.artifact = 'profit-protection-counterfactual-v1'",
      'o.checkpoint_minutes = 240',
      "o.execution_authority = 'NONE'",
      'o.modifies_execution = false',
    ];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.brokerConnectionId)
      clauses.push(`t.broker_connection_id = ${add(query.brokerConnectionId)}::uuid`);
    if (query.from) clauses.push(`t.closed_at >= ${add(query.from)}::timestamptz`);
    if (query.to) clauses.push(`t.closed_at <= ${add(query.to)}::timestamptz`);
    if (query.instrument) clauses.push(`UPPER(t.instrument) = ${add(query.instrument)}`);
    if (query.direction) clauses.push(`t.direction::text = ${add(query.direction)}`);
    if (query.strategyRoute) {
      clauses.push(
        `COALESCE(NULLIF(UPPER(o.response->>'strategy_route'), ''), 'UNKNOWN') = ${add(query.strategyRoute)}`,
      );
    }
    if (query.outcome) clauses.push(`o.state = ${add(query.outcome)}`);
    if (query.smallProfitOnly) clauses.push('t.realised_pnl > 0 AND t.realised_pnl <= 6');

    return { whereSql: clauses.join('\n          AND '), params };
  }

  private baseCte(whereSql: string): string {
    return `
      WITH raw_rows AS (
        SELECT
          t.id AS trade_id,
          t.broker_connection_id,
          t.instrument,
          t.direction::text AS direction,
          t.account_currency,
          t.realised_pnl,
          t.closed_at,
          o.state AS outcome,
          COALESCE(NULLIF(UPPER(o.response->>'strategy_route'), ''), 'UNKNOWN') AS strategy_route,
          NULLIF(o.response->>'actual_exit_r', '')::numeric AS actual_exit_r,
          NULLIF(o.response->>'minutes_after_close', '')::numeric AS minutes_after_close,
          NULLIF(o.response->>'event_at', '')::timestamptz AS event_at,
          COALESCE(t.fill_price, t.requested_entry_price) AS entry_price,
          t.stop_loss,
          t.take_profit
        FROM trading.trades t
        INNER JOIN trading.post_entry_shadow_observations o ON o.trade_id = t.id
        WHERE ${whereSql}
      ),
      barrier_r AS (
        SELECT
          r.*,
          CASE
            WHEN r.entry_price IS NULL OR r.stop_loss IS NULL OR r.take_profit IS NULL THEN NULL
            WHEN ABS(r.entry_price - r.stop_loss) = 0 THEN NULL
            ELSE ABS(r.take_profit - r.entry_price) / ABS(r.entry_price - r.stop_loss)
          END AS original_target_r
        FROM raw_rows r
      ),
      scored AS (
        SELECT
          b.*,
          CASE
            WHEN b.outcome = 'SL_FIRST' THEN -1::numeric
            WHEN b.outcome = 'TP_FIRST' THEN b.original_target_r
            ELSE NULL
          END AS counterfactual_r
        FROM barrier_r b
      ),
      final_rows AS (
        SELECT
          s.*,
          CASE
            WHEN s.counterfactual_r IS NULL OR s.actual_exit_r IS NULL THEN NULL
            ELSE s.counterfactual_r - s.actual_exit_r
          END AS r_delta
        FROM scored s
      )`;
  }

  private coerceRoute(value: unknown): ProfitProtectionStrategyRoute {
    const route = String(value ?? 'UNKNOWN').toUpperCase() as ProfitProtectionStrategyRoute;
    return ROUTES.includes(route) ? route : 'UNKNOWN';
  }

  private coerceOutcome(value: unknown): ProfitProtectionExitQualityOutcome {
    const outcome = String(value ?? 'DATA_GAP').toUpperCase() as ProfitProtectionExitQualityOutcome;
    return OUTCOMES.includes(outcome) ? outcome : 'DATA_GAP';
  }
}
