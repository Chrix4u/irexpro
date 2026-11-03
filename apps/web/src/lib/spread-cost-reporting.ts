export interface SpreadCostCurrencySummaryLike {
  accountCurrency: string;
  totalEstimatedSpreadCost?: string | null;
  spreadCostEstimatedTradeCount?: number | null;
}

export interface SpreadCostReportSummaryLike {
  totalTrades: number;
  accountCurrency: string | null;
  totalEstimatedSpreadCost?: string | null;
  spreadCostEstimatedTradeCount?: number | null;
  currencyBreakdown: SpreadCostCurrencySummaryLike[];
}

export interface SpreadCostReportingSummary {
  hasMeasurements: boolean;
  hasMixedCurrencies: boolean;
  measuredTradeCount: number;
  totalTradeCount: number;
  accountCurrency: string | null;
  totalEstimatedSpreadCost: string | null;
  coverageLabel: string;
}

/**
 * Convert the reporting-only spread telemetry into UI-safe presentation facts.
 * Money is never summed across account currencies and this helper performs no
 * realised-P&L arithmetic because spread is already embedded in execution P&L.
 */
export function summarizeSpreadCostReporting(
  summary: SpreadCostReportSummaryLike,
): SpreadCostReportingSummary {
  const totalTradeCount = Math.max(0, Math.trunc(summary.totalTrades || 0));
  const measuredTradeCount = Math.max(
    0,
    Math.trunc(summary.spreadCostEstimatedTradeCount || 0),
  );
  const hasMeasurements = measuredTradeCount > 0;
  const hasMixedCurrencies = summary.currencyBreakdown.length > 1;

  return {
    hasMeasurements,
    hasMixedCurrencies,
    measuredTradeCount,
    totalTradeCount,
    accountCurrency: hasMixedCurrencies ? null : summary.accountCurrency,
    totalEstimatedSpreadCost: hasMixedCurrencies
      ? null
      : (summary.totalEstimatedSpreadCost ?? null),
    coverageLabel: hasMeasurements
      ? `${measuredTradeCount} of ${totalTradeCount} trades measured`
      : 'No quote-at-fill measurements yet',
  };
}
