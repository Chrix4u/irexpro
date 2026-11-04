import { api } from './api';

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

export type ProfitProtectionExitQualityQuery = {
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
};

export type ProfitProtectionExitQualityItem = {
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
};

export type ProfitProtectionExitQualityReport = {
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
    smallProfitResolvedCount: number;
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
    alternativesByCurrency: Array<{
      accountCurrency: string;
      gradedTrades: number;
      runnerCandidates: number;
      runnerComparable: number;
      runnerBetter: number;
      runnerDataGaps: number;
      runnerAverageNetDelta: string | null;
      partialComparable: number;
      partialBetter: number;
      partialDataGaps: number;
      partialAverageNetDelta: string | null;
    }>;
  };
  routes: Array<{
    strategyRoute: ProfitProtectionStrategyRoute;
    total: number;
    tpFirstCount: number;
    slFirstCount: number;
    tpFirstRate: number | null;
    smallProfitCount: number;
    smallProfitResolvedCount: number;
    smallProfitComparableCount: number;
    smallProfitTpFirstCount: number;
    smallProfitSlFirstCount: number;
    smallProfitTpFirstRate: number | null;
    smallProfitAverageRDelta: number | null;
  }>;
  items: ProfitProtectionExitQualityItem[];
};

export async function loadProfitProtectionExitQuality(
  query: ProfitProtectionExitQualityQuery = {},
): Promise<ProfitProtectionExitQualityReport> {
  const params = new URLSearchParams();
  const setString = (key: string, value?: string) => {
    if (value?.trim()) params.set(key, value.trim());
  };
  const setNumber = (key: string, value?: number) => {
    if (value != null && Number.isFinite(value)) params.set(key, String(value));
  };

  setString('brokerConnectionId', query.brokerConnectionId);
  setString('from', query.from);
  setString('to', query.to);
  setString('instrument', query.instrument);
  setString('direction', query.direction);
  setString('strategyRoute', query.strategyRoute);
  setString('outcome', query.outcome);
  if (query.smallProfitOnly === true) params.set('smallProfitOnly', 'true');
  setNumber('page', query.page);
  setNumber('pageSize', query.pageSize);

  const suffix = params.toString();
  return api.request<ProfitProtectionExitQualityReport>(
    `/trading/reports/profit-protection-exit-quality${suffix ? `?${suffix}` : ''}`,
    { method: 'GET' },
  );
}
