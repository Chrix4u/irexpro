import type { BrokerClosedTrade, BrokerOrderState } from '../../broker/interfaces/broker-adapter.interface';
import { compareDecimal } from './reconciliation-comparator';

/**
 * A provider position disappearing is not proof of its exit price or net P&L.
 * This independent DEMO-only proof gates late settlement for a trade already
 * marked CLOSED with all three economics columns NULL. No trading authority.
 */
export interface UnsettledDemoTradeFingerprint {
  externalOrderId: string | null;
  externalPositionId: string | null;
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string;
  fillPrice: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Only a provider-authoritative FILLED *entry* order can recover a missing
 * position identifier. cTrader orderId and positionId are not interchangeable.
 * Never infer this relation from timestamp or price correlation.
 */
export function proveCtraderEntryOrderPositionRef(
  trade: UnsettledDemoTradeFingerprint,
  providerOrder: BrokerOrderState | null,
): string | null {
  if (
    !trade.externalOrderId || !/^\d+$/.test(trade.externalOrderId) ||
    !providerOrder ||
    providerOrder.providerOrderId !== trade.externalOrderId ||
    providerOrder.status !== 'FILLED' ||
    !providerOrder.providerPositionId ||
    !/^\d+$/.test(providerOrder.providerPositionId) ||
    providerOrder.direction !== trade.direction ||
    providerOrder.instrument.replace(/[^a-z]/gi, '').toUpperCase() !==
      trade.instrument.replace(/[^a-z]/gi, '').toUpperCase()
  ) return null;
  const decimal = /^\d+(?:\.\d+)?$/;
  if (
    ![providerOrder.filledQuantity, trade.lotSize].every(
      value => typeof value === 'string' && decimal.test(value),
    ) ||
    compareDecimal(providerOrder.filledQuantity, trade.lotSize) !== 0
  ) return null;
  if (
    providerOrder.avgFillPrice !== null &&
    providerOrder.avgFillPrice !== undefined &&
    (
      !trade.fillPrice ||
      !decimal.test(providerOrder.avgFillPrice) ||
      !decimal.test(trade.fillPrice) ||
      compareDecimal(providerOrder.avgFillPrice, trade.fillPrice) !== 0
    )
  ) return null;
  return providerOrder.providerPositionId;
}

export type SettlementProof =
  | { matched: true; provider: BrokerClosedTrade }
  | { matched: false; reason: string };

export function proveUniqueCtraderDemoSettlement(
  trade: UnsettledDemoTradeFingerprint,
  candidates: readonly BrokerClosedTrade[],
  brokerId: string,
  accountType: string,
  now: Date,
): SettlementProof {
  if (!['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader'].includes(brokerId) ||
    accountType.toUpperCase() !== 'DEMO') return { matched: false, reason: 'NOT_CTRADER_DEMO' };
  const ref = trade.externalPositionId || trade.externalOrderId;
  if (!ref || !/^\d+$/.test(ref) || !trade.openedAt || !trade.closedAt ||
    !Number.isFinite(trade.openedAt.getTime()) || !Number.isFinite(trade.closedAt.getTime()) ||
    !Number.isFinite(now.getTime()) || !trade.fillPrice) {
    return { matched: false, reason: 'MISSING_POSITION_FINGERPRINT' };
  }
  const samePosition = candidates.filter(c => c.externalOrderId === ref);
  // Partial-close deals or duplicate provider events must never be booked as
  // the one complete, terminal outcome of the internal position.
  if (samePosition.length !== 1) return {
    matched: false,
    reason: samePosition.length ? 'MULTIPLE_CLOSING_DEALS_UNSAFE' : 'NO_EXACT_PROVIDER_POSITION',
  };
  const deal = samePosition[0];
  const normalize = (symbol: string) => symbol.replace(/[^a-z]/gi, '').toUpperCase();
  if (normalize(deal.instrument) !== normalize(trade.instrument) ||
    !Number.isFinite(deal.closedAt.getTime()) ||
    deal.closedAt.getTime() < trade.openedAt.getTime() ||
    deal.closedAt.getTime() > now.getTime() + 60_000 ||
    Math.abs(deal.closedAt.getTime() - trade.closedAt.getTime()) > 180_000) {
    return { matched: false, reason: 'INSTRUMENT_OR_CLOSE_TIME_MISMATCH' };
  }
  // The side on a cTrader CLOSING deal may be the opposite of the position
  // direction. We do not infer it from a close deal: exact provider position
  // ID, entry price, full volume and unique close time are mandatory instead.
  const unsignedNumber = /^\d+(?:\.\d+)?$/;
  if (
    ![deal.lotSize, trade.lotSize, deal.openPrice, trade.fillPrice].every(
      n => typeof n === 'string' && unsignedNumber.test(n),
    ) ||
    compareDecimal(deal.lotSize, trade.lotSize) !== 0 ||
    compareDecimal(deal.openPrice, trade.fillPrice) !== 0
  ) return { matched: false, reason: 'ENTRY_PRICE_OR_FULL_VOLUME_MISMATCH' };

  // Do not turn missing values into zeros. Close-side fees should be signed
  // costs (<=0). A positive fee could represent different broker semantics;
  // do not guess and corrupt historical realized account P&L.
  const money = [deal.closePrice, deal.realisedPnl, deal.commission, deal.swap];
  if (money.some(x => x === null || x === undefined || x === '' || !/^[+-]?\d+(?:\.\d+)?$/.test(x)) ||
    compareDecimal(deal.closePrice, '0') <= 0 ||
    compareDecimal(deal.commission, '0') > 0) {
    return { matched: false, reason: 'UNVERIFIED_FINANCIAL_SIGN_OR_VALUE' };
  }
  return { matched: true, provider: deal };
}
