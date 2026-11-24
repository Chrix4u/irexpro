import { ProviderDispatchCertainty } from '../broker/interfaces/provider-dispatch-certainty';
import { Trade, TradeStatus } from './entities/trade.entity';

/** Read projection only: never hide ambiguous exposure or a failed close of a filled trade. */
export function isProvenUnsentEntry(trade: Trade): boolean {
  return (
    trade.status === TradeStatus.RECONCILIATION_PENDING &&
    trade.dispatchCertainty === ProviderDispatchCertainty.DEFINITELY_NOT_SENT &&
    trade.externalOrderId == null &&
    trade.externalPositionId == null &&
    trade.fillPrice == null &&
    trade.openedAt == null &&
    trade.closedAt == null &&
    trade.exitPrice == null &&
    trade.realisedPnl == null &&
    trade.closeReason == null
  );
}
