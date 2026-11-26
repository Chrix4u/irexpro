export interface StatementConsistencyReport {
  readOnly: true;
  executionAuthority: 'NONE';
  brokerIdentityVerified: false;
  settlementProven: false;
  status: 'ARITHMETIC_CONSISTENT' | 'REVIEW_REQUIRED';
  deals: number;
  distinctEconomicKeys: number;
  checks: {
    consecutiveDealBalancesAgree: boolean;
    lastDealBalanceAgrees: boolean;
    realisedSummaryAgrees: boolean;
    equityIdentityAgrees: boolean;
    freeMarginIdentityAgrees: boolean;
    fundingSummaryAgrees: boolean;
  };
  consecutiveBalanceMismatchRows: number[];
  statementShowsZeroMarginAndUnrealised: boolean;
}
export function verifyStatementConsistency(text: string): StatementConsistencyReport;
