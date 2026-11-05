import { CtraderDeal, CtraderPosition } from './ctrader-message-types';
import { mapCtraderDemoPartialBrokerRead } from './ctrader-demo-partial-evidence';

const deal: CtraderDeal = {
  dealId: 120,
  orderId: 118,
  positionId: 101,
  volume: 100_000,
  filledVolume: 100_000,
  symbolId: 1,
  createTimestamp: 1_800_000_000_000,
  executionTimestamp: 1_800_000_000_500,
  executionPrice: 1.12,
  tradeSide: 2,
  dealStatus: 2,
  closePositionDetail: {
    entryPrice: 1.1,
    grossProfit: 800,
    commission: 30,
    swap: -10,
    balance: 9999,
    closedVolume: 100_000,
    moneyDigits: 2,
  },
};
const position: CtraderPosition = {
  positionId: 101,
  tradeData: { symbolId: 1, tradeSide: 1, volume: 100_000 },
  positionStatus: 1,
  swap: -10,
};

const input = {
  accountId: '777',
  accountCurrency: 'EUR',
  expectedPositionId: 101,
  expectedDealId: 120,
  deal,
  openPosition: position,
  symbolLotSizeCents: 10_000_000,
};

describe('read-only cTrader DEMO partial-exit evidence mapper', () => {
  it('exposes provider deal and current snapshot but NEVER infers before size or fee sign', () => {
    expect(mapCtraderDemoPartialBrokerRead(input)).toMatchObject({
      source: 'DEAL_LIST_AND_RECONCILE',
      accountId: '777',
      accountCurrency: 'EUR',
      brokerPositionId: '101',
      providerDealId: '120',
      providerOrderId: '118',
      brokerFilledLots: '0.01',
      brokerLotsAfter: '0.01',
      brokerLotsBefore: null,
      grossRealisedPnlRaw: '8.00',
      commissionRaw: '0.30',
      swapRaw: '-0.10',
      moneyDigits: 2,
      feesSignVerified: false,
      canConfirm: false,
      canDispatchOrder: false,
    });
  });

  it('retains unknown residual position as null rather than inventing zero', () => {
    expect(mapCtraderDemoPartialBrokerRead({ ...input, openPosition: null })).toMatchObject({
      brokerLotsAfter: null,
      brokerLotsBefore: null,
      canConfirm: false,
    });
  });

  it('retains incomplete moneyDigits/commission as unknown, not zero', () => {
    const result = mapCtraderDemoPartialBrokerRead({
      ...input,
      deal: {
        ...deal,
        closePositionDetail: {
          ...deal.closePositionDetail!,
          moneyDigits: undefined,
          commission: undefined as unknown as number,
        },
      },
    });
    expect(result).toMatchObject({
      grossRealisedPnlRaw: null,
      commissionRaw: null,
      swapRaw: null,
      moneyDigits: null,
      canConfirm: false,
    });
  });

  it.each([
    ['wrong deal id', { deal: { ...deal, dealId: 121 } }],
    ['wrong position', { deal: { ...deal, positionId: 102 } }],
    ['unfilled deal', { deal: { ...deal, dealStatus: 3 } }],
    [
      'missing closed volume',
      {
        deal: {
          ...deal,
          closePositionDetail: { ...deal.closePositionDetail!, closedVolume: undefined },
        },
      },
    ],
    [
      'inconsistent closed volume',
      {
        deal: {
          ...deal,
          closePositionDetail: { ...deal.closePositionDetail!, closedVolume: 50_000 },
        },
      },
    ],
    ['wrong residual position', { openPosition: { ...position, positionId: 102 } }],
    [
      'wrong residual symbol',
      { openPosition: { ...position, tradeData: { ...position.tradeData, symbolId: 2 } } },
    ],
    ['closed residual', { openPosition: { ...position, positionStatus: 2 } }],
    ['invalid currency', { accountCurrency: 'EU' }],
  ])('rejects %s without reporting provider confirmation', (_reason, patch) => {
    expect(() => mapCtraderDemoPartialBrokerRead({ ...input, ...patch })).toThrow();
  });
});
