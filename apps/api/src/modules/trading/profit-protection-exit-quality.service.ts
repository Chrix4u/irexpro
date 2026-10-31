import { Injectable } from '@nestjs/common';
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

@Injectable()
export class ProfitProtectionExitQualityService {
  constructor(private readonly dataSource: DataSource) {
    void this.dataSource;
  }

  async getReport(
    _userId: string,
    query: ProfitProtectionExitQualityQuery,
  ): Promise<ProfitProtectionExitQualityReport> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 25)));
    return {
      page,
      pageSize,
      total: 0,
      totalPages: 0,
      summary: {
        total: 0,
        resolvedCount: 0,
        tpFirstCount: 0,
        slFirstCount: 0,
        tpFirstRate: null,
        slFirstRate: null,
        ambiguousCount: 0,
        neitherCount: 0,
        dataGapCount: 0,
        smallProfitCount: 0,
        smallProfitTpFirstCount: 0,
        smallProfitTpFirstRate: null,
        accountCurrency: null,
        actualRealisedPnl: null,
        averageActualExitR: null,
        averageCounterfactualR: null,
        averageRDelta: null,
        currencyBreakdown: [],
      },
      routes: [],
      items: [],
    };
  }
}
