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
}
export function hasPendingClosedTradeSettlement(
  trade: ClosedTradeSettlementFields,
): boolean {
  return trade.status === 'CLOSED' && (
    trade.exitPrice === null ||
    trade.realisedPnl === null ||
    trade.commission === null ||
    trade.swap === null
  );
}
