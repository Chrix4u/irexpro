import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Trade, TradeCloseReason, TradeDirection, TradeStatus } from './entities/trade.entity';

export type ClosedTradeOutcomeFilter = 'ALL' | 'WIN' | 'LOSS' | 'FLAT';

export interface ClosedTradeReportFilters {
  page?: number;
  pageSize?: number;
  brokerConnectionId?: string;
  from?: string;
  to?: string;
  instrument?: string;
  direction?: string;
  outcome?: string;
  closeReason?: string;
}

export interface ClosedTradeCurrencySummary {
  accountCurrency: string;
  totalTrades: number;
  pnlTradeCount: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  grossProfit: string;
  grossLoss: string;
  /** Gross realised P&L before explicit broker costs. */
  grossRealisedPnl: string;
  /** Net realised P&L after commission and signed swap/financing. */
  netRealisedPnl: string;
  averageWin: string | null;
  averageLoss: string | null;
  /** Net-after-cost expectancy per realised trade. */
  expectancyPerTrade: string | null;
  profitFactor: number | null;
  largestWin: string | null;
  largestLoss: string | null;
  totalCommission: string;
  totalSwap: string;
  /** Commission minus signed swap; positive means an explicit net cost. */
  totalExplicitCosts: string;
  averageHoldMinutes: number | null;
}

export interface ClosedTradeReportSummary {
  totalTrades: number;
  pnlTradeCount: number;
  unresolvedPnlCount: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  accountCurrency: string | null;
  grossProfit: string | null;
  grossLoss: string | null;
  grossRealisedPnl: string | null;
  netRealisedPnl: string | null;
  averageWin: string | null;
  averageLoss: string | null;
  expectancyPerTrade: string | null;
  profitFactor: number | null;
  largestWin: string | null;
  largestLoss: string | null;
  totalCommission: string | null;
  totalSwap: string | null;
  totalExplicitCosts: string | null;
  averageHoldMinutes: number | null;
  currencyBreakdown: ClosedTradeCurrencySummary[];
}

export interface ClosedTradeReport {
  trades: Trade[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: ClosedTradeReportSummary;
}

type ClosedTradeAggregateRow = {
  accountCurrency: string | null;
  totalTrades: string | number;
  pnlTradeCount: string | number;
  wins: string | number;
  losses: string | number;
  flats: string | number;
  grossProfit: string | number | null;
  grossLoss: string | number | null;
  grossRealisedPnl: string | number | null;
  netRealisedPnl: string | number | null;
  averageWin: string | number | null;
  averageLoss: string | number | null;
  expectancyPerTrade: string | number | null;
  largestWin: string | number | null;
  largestLoss: string | number | null;
  totalCommission: string | number | null;
  totalSwap: string | number | null;
  totalExplicitCosts: string | number | null;
  averageHoldMinutes: string | number | null;
};

function parseReportDate(value: string | undefined, label: 'from' | 'to'): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new BadRequestException(`${label} must be a valid date/time`);
  }
  return parsed;
}

function numericString(value: string | number | null | undefined, fallback = '0'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function nullableNumericString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function finiteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ratio(grossProfit: string, grossLoss: string): number | null {
  const profit = Number(grossProfit);
  const loss = Number(grossLoss);
  if (!Number.isFinite(profit) || !Number.isFinite(loss) || loss <= 0) return null;
  return profit / loss;
}

function currencySummary(row: ClosedTradeAggregateRow): ClosedTradeCurrencySummary | null {
  if (!row.accountCurrency) return null;
  const totalTrades = Number(row.totalTrades) || 0;
  const pnlTradeCount = Number(row.pnlTradeCount) || 0;
  const wins = Number(row.wins) || 0;
  const losses = Number(row.losses) || 0;
  const flats = Number(row.flats) || 0;
  const grossProfit = numericString(row.grossProfit);
  const grossLoss = numericString(row.grossLoss);
  const outcomeCount = wins + losses + flats;

  return {
    accountCurrency: row.accountCurrency,
    totalTrades,
    pnlTradeCount,
    wins,
    losses,
    flats,
    winRate: outcomeCount > 0 ? wins / outcomeCount : null,
    grossProfit,
    grossLoss,
    grossRealisedPnl: numericString(row.grossRealisedPnl),
    netRealisedPnl: numericString(row.netRealisedPnl),
    averageWin: nullableNumericString(row.averageWin),
    averageLoss: nullableNumericString(row.averageLoss),
    expectancyPerTrade: nullableNumericString(row.expectancyPerTrade),
    profitFactor: ratio(grossProfit, grossLoss),
    largestWin: nullableNumericString(row.largestWin),
    largestLoss: nullableNumericString(row.largestLoss),
    totalCommission: numericString(row.totalCommission),
    totalSwap: numericString(row.totalSwap),
    totalExplicitCosts: numericString(row.totalExplicitCosts),
    averageHoldMinutes: finiteNumber(row.averageHoldMinutes),
  };
}

/**
 * Read-only execution projection service for user-facing terminal clients.
 *
 * Keeping read queries separate from ExecutionService prevents browser-facing
 * concerns from expanding the live order-placement engine. Every query is
 * explicitly scoped by userId before DTO mapping occurs in the controller.
 */
@Injectable()
export class ExecutionReadService {
  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
  ) {}

  async listOpenPositions(userId: string, brokerConnectionId?: string): Promise<Trade[]> {
    return this.tradeRepo.find({
      where: {
        userId,
        ...(brokerConnectionId ? { brokerConnectionId } : {}),
        status: TradeStatus.OPEN,
      },
      order: { openedAt: 'DESC', createdAt: 'DESC' },
      take: 100,
    });
  }

  async listRecentExecutions(
    userId: string,
    limit = 50,
    brokerConnectionId?: string,
  ): Promise<Trade[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.tradeRepo.find({
      where: { userId, ...(brokerConnectionId ? { brokerConnectionId } : {}) },
      order: { createdAt: 'DESC' },
      take: safeLimit,
    });
  }

  async listClosedExecutions(
    userId: string,
    limit = 50,
    brokerConnectionId?: string,
  ): Promise<Trade[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.tradeRepo.find({
      where: {
        userId,
        ...(brokerConnectionId ? { brokerConnectionId } : {}),
        status: TradeStatus.CLOSED,
      },
      order: { closedAt: 'DESC', createdAt: 'DESC' },
      take: safeLimit,
    });
  }

  async listClosedTradeReport(
    userId: string,
    filters: ClosedTradeReportFilters = {},
  ): Promise<ClosedTradeReport> {
    const page = Math.max(1, Math.trunc(filters.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(filters.pageSize ?? 25)));
    const from = parseReportDate(filters.from, 'from');
    const to = parseReportDate(filters.to, 'to');
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be on or before to');
    }

    const direction = filters.direction?.trim().toUpperCase();
    if (direction && !Object.values(TradeDirection).includes(direction as TradeDirection)) {
      throw new BadRequestException('direction must be BUY or SELL');
    }
    const outcome = (filters.outcome?.trim().toUpperCase() || 'ALL') as ClosedTradeOutcomeFilter;
    if (!['ALL', 'WIN', 'LOSS', 'FLAT'].includes(outcome)) {
      throw new BadRequestException('outcome must be ALL, WIN, LOSS, or FLAT');
    }
    const closeReason = filters.closeReason?.trim().toUpperCase();
    if (closeReason && !Object.values(TradeCloseReason).includes(closeReason as TradeCloseReason)) {
      throw new BadRequestException('closeReason is not a supported close reason');
    }

    const instrument = filters.instrument?.trim().toUpperCase();
    if (instrument && instrument.length > 50) {
      throw new BadRequestException('instrument is too long');
    }

    const baseQuery = this.tradeRepo.createQueryBuilder('trade');
    baseQuery.where('trade.userId = :userId', { userId });
    baseQuery.andWhere('trade.status = :status', { status: TradeStatus.CLOSED });
    if (filters.brokerConnectionId) {
      baseQuery.andWhere('trade.brokerConnectionId = :brokerConnectionId', {
        brokerConnectionId: filters.brokerConnectionId,
      });
    }
    if (from) baseQuery.andWhere('trade.closedAt >= :from', { from });
    if (to) baseQuery.andWhere('trade.closedAt <= :to', { to });
    if (instrument) baseQuery.andWhere('trade.instrument = :instrument', { instrument });
    if (direction) baseQuery.andWhere('trade.direction = :direction', { direction });
    if (outcome === 'WIN') baseQuery.andWhere('trade.realisedPnl > 0');
    if (outcome === 'LOSS') baseQuery.andWhere('trade.realisedPnl < 0');
    if (outcome === 'FLAT') baseQuery.andWhere('trade.realisedPnl = 0');
    if (closeReason) baseQuery.andWhere('trade.closeReason = :closeReason', { closeReason });

    const pageQuery = baseQuery.clone();
    const [trades, total] = await pageQuery
      .orderBy('trade.closedAt', 'DESC')
      .addOrderBy('trade.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    // Keep all closed records in the report, but use one consistent cohort
    // for monetary totals and outcome metrics. Missing fees are not zero.
    // Completeness of stored fields is not independent broker provenance.
    const complete = [
      '"trade"."realised_pnl" IS NOT NULL',
      '"trade"."commission" IS NOT NULL',
      '"trade"."swap" IS NOT NULL',
      '"trade"."exit_price" IS NOT NULL',
      '"trade"."account_currency" IS NOT NULL',
      `BTRIM("trade"."account_currency") <> ''`,
    ].join(' AND ');
    const settledOnly = (aggregate: string) => `${aggregate} FILTER (WHERE ${complete})`;
    const sum = (expression: string) => `COALESCE(${settledOnly(`SUM(${expression})`)}, 0)`;
    const count = settledOnly('COUNT(*)');
    const net = `${sum('"trade"."realised_pnl"')} - ${sum('ABS("trade"."commission")')} + ${sum('"trade"."swap"')}`;
    const summaryQuery = baseQuery.clone();
    const rawRows = (await summaryQuery
      .select('"trade"."account_currency"', 'accountCurrency')
      .addSelect('COUNT(*)', 'totalTrades')
      .addSelect(count, 'pnlTradeCount')
      .addSelect(settledOnly('COUNT(CASE WHEN "trade"."realised_pnl" > 0 THEN 1 END)'), 'wins')
      .addSelect(settledOnly('COUNT(CASE WHEN "trade"."realised_pnl" < 0 THEN 1 END)'), 'losses')
      .addSelect(settledOnly('COUNT(CASE WHEN "trade"."realised_pnl" = 0 THEN 1 END)'), 'flats')
      .addSelect(
        sum('CASE WHEN "trade"."realised_pnl" > 0 THEN "trade"."realised_pnl" ELSE 0 END'),
        'grossProfit',
      )
      .addSelect(
        sum('CASE WHEN "trade"."realised_pnl" < 0 THEN -"trade"."realised_pnl" ELSE 0 END'),
        'grossLoss',
      )
      .addSelect(sum('"trade"."realised_pnl"'), 'grossRealisedPnl')
      .addSelect(sum('ABS("trade"."commission")'), 'totalCommission')
      .addSelect(sum('"trade"."swap"'), 'totalSwap')
      .addSelect(net, 'netRealisedPnl')
      .addSelect(`${sum('ABS("trade"."commission")')} - ${sum('"trade"."swap"')}`, 'totalExplicitCosts')
      .addSelect(
        settledOnly('AVG(CASE WHEN "trade"."realised_pnl" > 0 THEN "trade"."realised_pnl" END)'),
        'averageWin',
      )
      .addSelect(
        settledOnly('AVG(CASE WHEN "trade"."realised_pnl" < 0 THEN -"trade"."realised_pnl" END)'),
        'averageLoss',
      )
      .addSelect(`(${net}) / NULLIF(${count}, 0)`, 'expectancyPerTrade')
      .addSelect(
        settledOnly('MAX(CASE WHEN "trade"."realised_pnl" > 0 THEN "trade"."realised_pnl" END)'),
        'largestWin',
      )
      .addSelect(
        settledOnly('MIN(CASE WHEN "trade"."realised_pnl" < 0 THEN "trade"."realised_pnl" END)'),
        'largestLoss',
      )
      .addSelect(
        settledOnly('AVG(EXTRACT(EPOCH FROM ("trade"."closed_at" - "trade"."opened_at")) / 60.0)'),
        'averageHoldMinutes',
      )
      .groupBy('trade.accountCurrency')
      .orderBy('trade.accountCurrency', 'ASC')
      .getRawMany()) as ClosedTradeAggregateRow[];

    const currencyBreakdown = rawRows
      .map((row) => currencySummary(row))
      .filter((row): row is ClosedTradeCurrencySummary => row !== null);
    const pnlTradeCount = currencyBreakdown.reduce((sum, row) => sum + row.pnlTradeCount, 0);
    const wins = rawRows.reduce((sum, row) => sum + (Number(row.wins) || 0), 0);
    const losses = rawRows.reduce((sum, row) => sum + (Number(row.losses) || 0), 0);
    const flats = rawRows.reduce((sum, row) => sum + (Number(row.flats) || 0), 0);
    const outcomeCount = wins + losses + flats;
    const singleCurrency = currencyBreakdown.length === 1 ? currencyBreakdown[0] : null;
    const knownCurrency =
      singleCurrency && singleCurrency.pnlTradeCount > 0 ? singleCurrency : null;

    return {
      trades,
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      summary: {
        totalTrades: total,
        pnlTradeCount,
        unresolvedPnlCount: Math.max(0, total - pnlTradeCount),
        wins,
        losses,
        flats,
        winRate: outcomeCount > 0 ? wins / outcomeCount : null,
        accountCurrency: singleCurrency?.accountCurrency ?? null,
        grossProfit: knownCurrency?.grossProfit ?? null,
        grossLoss: knownCurrency?.grossLoss ?? null,
        grossRealisedPnl: knownCurrency?.grossRealisedPnl ?? null,
        netRealisedPnl: knownCurrency?.netRealisedPnl ?? null,
        averageWin: knownCurrency?.averageWin ?? null,
        averageLoss: knownCurrency?.averageLoss ?? null,
        expectancyPerTrade: knownCurrency?.expectancyPerTrade ?? null,
        profitFactor: knownCurrency?.profitFactor ?? null,
        largestWin: knownCurrency?.largestWin ?? null,
        largestLoss: knownCurrency?.largestLoss ?? null,
        totalCommission: knownCurrency?.totalCommission ?? null,
        totalSwap: knownCurrency?.totalSwap ?? null,
        totalExplicitCosts: knownCurrency?.totalExplicitCosts ?? null,
        averageHoldMinutes: knownCurrency?.averageHoldMinutes ?? null,
        currencyBreakdown,
      },
    };
  }

  /**
   * Resolve execution records for a previously user-scoped set of AI signals.
   *
   * The userId predicate is mandatory even though signal IDs are UUIDs. This
   * prevents decision lineage from becoming a cross-tenant lookup primitive.
   */
  async listBySignalIds(userId: string, signalIds: string[]): Promise<Trade[]> {
    if (signalIds.length === 0) return [];

    return this.tradeRepo.find({
      where: { userId, signalId: In(signalIds) },
      order: { createdAt: 'ASC' },
      take: 100,
    });
  }
}
