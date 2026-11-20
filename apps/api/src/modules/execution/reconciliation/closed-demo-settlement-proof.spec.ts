import { proveUniqueCtraderDemoSettlement, proveCtraderEntryOrderPositionRef } from './closed-demo-settlement-proof';
import { BrokerClosedTrade, BrokerOrderState } from '../../broker/interfaces/broker-adapter.interface';

const now = new Date('2026-11-12T07:45:00.000Z');
const trade = {
  externalOrderId: '261975747',
  externalPositionId: null,
  instrument: 'USDCHF',
  direction: 'BUY' as const,
  lotSize: '0.2000',
  fillPrice: '0.83310000',
  openedAt: new Date('2026-11-12T05:07:33.491Z'),
  closedAt: new Date('2026-11-12T05:37:02.825Z'),
};
const deal: BrokerClosedTrade = {
  externalOrderId: '261975747',
  instrument: 'USD/CHF',
  // cTrader close DEAL side may oppose the position direction
  direction: 'SELL',
  lotSize: '0.2',
  openPrice: '0.83310',
  closePrice: '0.83298',
  stopLoss: '0',
  takeProfit: '0',
  realisedPnl: '-2.88',
  commission: '-1.20',
  swap: '0.00',
  openedAt: new Date('2026-11-12T05:37:01.000Z'),
  closedAt: new Date('2026-11-12T05:37:04.000Z'),
  closeReason: 'UNKNOWN',
};
const verify = (deals: BrokerClosedTrade[], changes = {}) =>
  proveUniqueCtraderDemoSettlement(
    { ...trade, ...changes }, deals, 'pepperstone-ctrader', 'DEMO', now,
  );

describe('closed Pepperstone DEMO broker-native settlement proof', () => {
  it('accepts exactly one complete terminal deal with same provider position, entry, volume and close-time window', () => {
    const result = verify([deal]);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.provider).toBe(deal);
  });
  it('does not match order IDs inferred by price or instrument', () => {
    expect(verify([{ ...deal, externalOrderId: 'other' }])).toEqual({
      matched: false, reason: 'NO_EXACT_PROVIDER_POSITION',
    });
    expect(verify([deal], { externalOrderId: null })).toEqual({
      matched: false, reason: 'MISSING_POSITION_FINGERPRINT',
    });
  });
  it('refuses partial-close/multiple deals on the same position', () => {
    expect(verify([deal, { ...deal, realisedPnl: '0.12' }])).toEqual({
      matched: false, reason: 'MULTIPLE_CLOSING_DEALS_UNSAFE',
    });
    expect(verify([{ ...deal, lotSize: '0.10' }])).toEqual({
      matched: false, reason: 'ENTRY_PRICE_OR_FULL_VOLUME_MISMATCH',
    });
  });
  it('rejects different broker account environment, symbol or mismatched closing time', () => {
    expect(proveUniqueCtraderDemoSettlement(trade, [deal], 'pepperstone-ctrader', 'LIVE', now)
      .matched).toBe(false);
    expect(verify([{ ...deal, instrument: 'USDJPY' }]).matched).toBe(false);
    expect(verify([{ ...deal, closedAt: new Date('2026-11-12T06:37:04Z') }]).matched).toBe(false);
    expect(verify([{ ...deal, openPrice: '0.83320' }]).matched).toBe(false);
  });
  it('will not guess P&L, fee, or broker cost sign from incomplete data', () => {
    for (const partial of [
      { realisedPnl: '' }, { realisedPnl: 'NaN' },
      { closePrice: '' }, { commission: '' }, { commission: '2.50' },
      { swap: '' }, { lotSize: '' },
    ]) {
      const result = verify([{ ...deal, ...partial }]);
      expect(result.matched).toBe(false);
    }
  });
  it('fails closed if the provider reference is available but timestamps are absent', () => {
    expect(verify([deal], { closedAt: null }).matched).toBe(false);
    expect(verify([deal], { openedAt: null }).matched).toBe(false);
  });
});

describe('verified cTrader entry-order to position-ID correlation', () => {
  const order: BrokerOrderState = {
    providerOrderId: '261975747',
    providerPositionId: '28202855',
    clientOrderId: null,
    status: 'FILLED',
    instrument: 'USD/CHF',
    direction: 'BUY',
    orderKind: 'MARKET',
    requestedQuantity: '0.2',
    filledQuantity: '0.2000',
    avgFillPrice: '0.8331',
    limitPrice: null,
    stopPrice: null,
    timeInForce: 'GTC',
    placedAt: new Date('2026-11-12T05:07:32Z'),
    updatedAt: new Date('2026-11-12T05:07:33Z'),
  };
  it('recovers different order and position IDs only from complete provider FILLED entry proof', () => {
    expect(proveCtraderEntryOrderPositionRef(trade, order)).toBe('28202855');
    expect(proveCtraderEntryOrderPositionRef(trade, null)).toBeNull();
  });
  it('never guesses broker position ID from stale/partial/opposite/ambiguous entry orders', () => {
    for (const patch of [
      { providerOrderId: 'OTHER' },
      { providerPositionId: null },
      { status: 'WORKING' },
      { direction: 'SELL' },
      { instrument: 'EURUSD' },
      { filledQuantity: '0.1000' },
      { avgFillPrice: '0.8332' },
    ]) {
      expect(proveCtraderEntryOrderPositionRef(trade, {
        ...order, ...patch,
      } as BrokerOrderState)).toBeNull();
    }
  });
});
