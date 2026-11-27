import { closedTradeCurrencyCoverage, hasPendingClosedTradeSettlement, missingClosedTradeSettlementFields } from './closed-trade-settlement';

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

describe('missingClosedTradeSettlementFields', () => {
  it('lists only missing broker values', () => {
    expect(missingClosedTradeSettlementFields({
      ...complete,
      exitPrice: null,
      swap: null,
    })).toEqual(['exit price', 'swap']);
  });

  it('distinguishes genuine zero amounts from missing values', () => {
    expect(missingClosedTradeSettlementFields({
      ...complete,
      realisedPnl: '0',
      commission: '0',
    })).toEqual([]);
  });

  it('does not report pending settlement for an open trade', () => {
    expect(missingClosedTradeSettlementFields({
      ...complete,
      status: 'OPEN',
      exitPrice: null,
    })).toEqual([]);
  });
});

describe('closed trade currency breakdown coverage', () => {
  it('does not display zero monetary totals for an entirely incomplete currency', () => {
    expect(closedTradeCurrencyCoverage({ pnlTradeCount: 0, totalTrades: 2 }))
      .toEqual({ hasKnownTotals: false, label: '0 of 2 records with complete settlement fields' });
  });

  it('shows totals for a separate complete currency and a partial cohort', () => {
    expect(closedTradeCurrencyCoverage({ pnlTradeCount: 1, totalTrades: 1 }).hasKnownTotals).toBe(true);
    expect(closedTradeCurrencyCoverage({ pnlTradeCount: 1, totalTrades: 3 }))
      .toEqual({ hasKnownTotals: true, label: '1 of 3 records with complete settlement fields' });
  });
});
