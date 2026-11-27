/**
 * A position can be broker-confirmed closed before the close deal has supplied
 * a verifiable fill price, realized P&L and explicit charges.
 * Never transform absent broker economics into a zero/positive P&L.
 */
export interface ClosedTradeSettlementFields {
  status: string;
  exitPrice: string | null;
  realisedPnl: string | null;
  commission: string | null;
  swap: string | null;
  accountCurrency: string | null;
}
export function hasPendingClosedTradeSettlement(
  trade: ClosedTradeSettlementFields,
): boolean {
  return missingClosedTradeSettlementFields(trade).length > 0;
}

/** Explain pending settlement using the actual missing broker fields, not estimated amounts. */
export function missingClosedTradeSettlementFields(trade: ClosedTradeSettlementFields): string[] {
  if (trade.status !== 'CLOSED') return [];
  const fields: Array<[keyof Omit<ClosedTradeSettlementFields, 'status'>, string]> = [
    ['exitPrice', 'exit price'],
    ['realisedPnl', 'realized P&L'],
    ['commission', 'commission'],
    ['swap', 'swap'],
  ];
  const missing = fields.filter(([key]) => trade[key] === null).map(([, label]) => label);
  if (!trade.accountCurrency?.trim()) missing.push('account currency');
  return missing;
}

/** Distinguish an empty financial cohort from a genuine zero-valued settlement. */
export function closedTradeCurrencyCoverage(group: {
  pnlTradeCount: number;
  totalTrades: number;
}): { hasKnownTotals: boolean; label: string } {
  return {
    hasKnownTotals: group.pnlTradeCount > 0,
    label: group.pnlTradeCount + ' of ' + group.totalTrades + ' records with complete settlement fields',
  };
}
