import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import {
  CtraderDeal,
  CtraderDealStatus,
  CtraderPosition,
  CtraderPositionStatus,
  moneyToDecimalString,
  volumeCentsToLotString,
} from './ctrader-message-types';

/**
 * Read-only cTrader DEMO evidence. The broker deals history + latest position
 * cannot prove the BEFORE volume of a close; reconstructing it from the
 * current volume would be an unsafe guess if another action intervened.
 *
 * Values are raw cTrader account-currency amounts. Commission/swap sign
 * conventions are not yet independently normalized. NEVER pass this output
 * directly to the partial-close CONFIRMED ledger transition.
 */
export interface CtraderDemoPartialBrokerRead {
  readonly source: 'DEAL_LIST_AND_RECONCILE';
  readonly accountId: string;
  readonly accountCurrency: string;
  readonly brokerPositionId: string;
  readonly providerDealId: string;
  readonly providerOrderId: string;
  readonly dealExecutedAt: string;
  readonly brokerFilledLots: string;
  readonly brokerLotsAfter: string | null;
  readonly brokerLotsBefore: null;
  readonly grossRealisedPnlRaw: string | null;
  readonly commissionRaw: string | null;
  readonly swapRaw: string | null;
  readonly moneyDigits: number | null;
  readonly feesSignVerified: false;
  readonly canConfirm: false;
  readonly canDispatchOrder: false;
}

function money(value: unknown, digits: number | null): string | null {
  if (digits === null || typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return null;
  }
  return moneyToDecimalString(value, digits);
}

function safeDigits(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 8
    ? value
    : null;
}

export function mapCtraderDemoPartialBrokerRead(params: {
  accountId: string;
  accountCurrency: string;
  expectedPositionId: number;
  expectedDealId: number;
  deal: CtraderDeal;
  openPosition: CtraderPosition | null;
  symbolLotSizeCents: number;
}): CtraderDemoPartialBrokerRead {
  const { deal, expectedPositionId, expectedDealId, openPosition, symbolLotSizeCents } = params;
  const close = deal.closePositionDetail;
  if (
    !/^[A-Z]{3}$/.test(params.accountCurrency) ||
    !Number.isSafeInteger(symbolLotSizeCents) ||
    symbolLotSizeCents <= 0 ||
    !Number.isSafeInteger(deal.positionId) ||
    deal.positionId !== expectedPositionId ||
    !Number.isSafeInteger(deal.dealId) ||
    deal.dealId !== expectedDealId ||
    !Number.isSafeInteger(deal.orderId) ||
    deal.orderId <= 0 ||
    deal.dealStatus !== CtraderDealStatus.FILLED ||
    !Number.isSafeInteger(deal.executionTimestamp) ||
    deal.executionTimestamp <= 0 ||
    !close ||
    !Number.isSafeInteger(deal.filledVolume) ||
    deal.filledVolume <= 0 ||
    !Number.isSafeInteger(close.closedVolume) ||
    close.closedVolume !== deal.filledVolume
  ) {
    throw new BrokerAdapterError(
      BrokerErrorCode.BROKER_SERVER_ERROR,
      'cTrader partial-close deal has incomplete or inconsistent provider identity/volume.',
    );
  }
  let brokerLotsAfter: string | null = null;
  if (openPosition) {
    if (
      openPosition.positionId !== expectedPositionId ||
      openPosition.positionStatus !== CtraderPositionStatus.POSITION_STATUS_OPEN ||
      openPosition.tradeData.symbolId !== deal.symbolId ||
      !Number.isSafeInteger(openPosition.tradeData.volume) ||
      openPosition.tradeData.volume <= 0
    ) {
      throw new BrokerAdapterError(
        BrokerErrorCode.BROKER_SERVER_ERROR,
        'cTrader partial-close residual position is inconsistent with provider deal.',
      );
    }
    brokerLotsAfter = volumeCentsToLotString(openPosition.tradeData.volume, symbolLotSizeCents);
  }

  const moneyDigits = safeDigits(close.moneyDigits);
  return {
    source: 'DEAL_LIST_AND_RECONCILE',
    accountId: params.accountId,
    accountCurrency: params.accountCurrency,
    brokerPositionId: String(deal.positionId),
    providerDealId: String(deal.dealId),
    providerOrderId: String(deal.orderId),
    dealExecutedAt: new Date(deal.executionTimestamp).toISOString(),
    brokerFilledLots: volumeCentsToLotString(deal.filledVolume, symbolLotSizeCents),
    brokerLotsAfter,
    brokerLotsBefore: null,
    grossRealisedPnlRaw: money(close.grossProfit, moneyDigits),
    commissionRaw: money(close.commission, moneyDigits),
    swapRaw: money(close.swap, moneyDigits),
    moneyDigits,
    feesSignVerified: false,
    canConfirm: false,
    canDispatchOrder: false,
  };
}
