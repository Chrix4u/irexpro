import { hasPendingClosedTradeSettlement } from './closed-trade-settlement';

const complete = {
  status: 'CLOSED',
  exitPrice: '0.67390000',
  realisedPnl: '12.04',
  commission: '-10.32',
  swap: '0',
};

describe('broker-closed positions with pending financial settlement', () => {
  it('flags the real Pepperstone missing-exit and missing-financials case', () => {
    expect(hasPendingClosedTradeSettlement({
      ...complete,exitPrice:null,realisedPnl:null,commission:null,swap:null,
    })).toBe(true);
  });
  it.each(['exitPrice', 'realisedPnl', 'commission', 'swap'] as const)(
    'does not silently convert missing %s to zero', (key) => {
      expect(hasPendingClosedTradeSettlement({...complete,[key]:null})).toBe(true);
    },
  );
  it('displays settled zero and negative results without pending banner', () => {
    expect(hasPendingClosedTradeSettlement({...complete,realisedPnl:'0',commission:'0'})).toBe(false);
    expect(hasPendingClosedTradeSettlement({...complete,realisedPnl:'-120.81'})).toBe(false);
  });
  it('does not label open or reconciliation-pending trades broker settled', () => {
    for(const status of ['OPEN','RECONCILIATION_PENDING','PENDING']) {
      expect(hasPendingClosedTradeSettlement({
        ...complete,status,exitPrice:null,realisedPnl:null,commission:null,
      })).toBe(false);
    }
  });
});
