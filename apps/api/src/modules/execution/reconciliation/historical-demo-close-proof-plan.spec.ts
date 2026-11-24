import type { BrokerClosedTrade } from '../../broker/interfaces/broker-adapter.interface';
import { TradeDirection, TradeStatus } from '../entities/trade.entity';
import { OrderKind, OrderStatus } from '../orders/order.enums';
import {
  HistoricalDemoProofInput,
  proveHistoricalPepperstoneDemoClose,
  planHistoricalPepperstoneDemoCloses,
} from './historical-demo-close-proof-plan';

const opened = new Date('2026-11-20T15:00:00.000Z');
const created = new Date('2026-11-20T15:11:51.000Z');
const submitted = new Date('2026-11-20T15:11:51.800Z');
const closed = new Date('2026-11-20T15:11:53.400Z');
const observed = new Date('2026-11-24T02:34:44.000Z');

function fixture(): HistoricalDemoProofInput {
  const deal: BrokerClosedTrade = {
    externalOrderId: '8422910',
    instrument: 'USDJPY',
    direction: 'BUY',
    lotSize: '3.1800',
    openPrice: '155.200',
    closePrice: '155.250',
    stopLoss: '0',
    takeProfit: '0',
    realisedPnl: '45.20',
    openedAt: closed,
    closedAt: new Date(closed),
    commission: '-4.50',
    swap: '0',
    closeReason: 'UNKNOWN',
  };
  return {
    brokerId: 'pepperstone-ctrader',
    accountType: 'DEMO',
    accountUserId: 'owner-1',
    accountConnectionId: 'demo-one',
    brokerAccountFlat: true,
    historyPageComplete: true,
    uniquePendingCloseOrdersForTrade: 1,
    uniqueProviderClosingDealsForPosition: 1,
    order: {
      id: 'order-1',
      tradeId: 'trade-1',
      userId: 'owner-1',
      brokerConnectionId: 'demo-one',
      status: OrderStatus.RECONCILIATION_PENDING,
      providerOrderId: null,
      orderKind: OrderKind.MARKET,
      instrument: 'USDJPY',
      direction: TradeDirection.BUY,
      requestedQuantity: '3.1800',
      filledQuantity: '0.0000',
      avgFillPrice: null,
      createdAt: created,
      submittedAt: submitted,
    },
    trade: {
      id: 'trade-1',
      userId: 'owner-1',
      brokerConnectionId: 'demo-one',
      status: TradeStatus.CLOSED,
      instrument: 'USDJPY',
      direction: TradeDirection.SELL,
      externalPositionId: null,
      externalOrderId: '8422910',
      lotSize: '3.1800',
      openedAt: opened,
      closedAt: closed,
      exitPrice: '155.2500',
      realisedPnl: '45.20000000',
    },
    brokerClosingDeal: deal,
    rawBrokerClosingDeal: {
      positionId: '8422910',
      dealId: '350035648',
      orderId: '404148641',
      executionTimestamp: closed.getTime(),
    },
    observedAt: observed,
  };
}

describe('historical Pepperstone DEMO close plan (read-only, not an executor)', () => {
  it('proves old exact broker close without loosening runtime recent-only guard', () => {
    expect(proveHistoricalPepperstoneDemoClose(fixture())).toEqual({
      eligible: true,
      reason: 'EXACT_BROKER_DEMO_CLOSE_PROVEN_PLAN_ONLY',
      orderId: 'order-1',
      tradeId: 'trade-1',
      positionId: '8422910',
      nativeDealId: '350035648',
      nativeOrderId: '404148641',
      quantity: '3.1800',
      price: '155.250',
    });
  });

  it('rejects a closing time before submission, including 5.209 seconds', () => {
    const x = fixture();
    x.order.submittedAt = new Date(closed.getTime() + 5209);
    expect(proveHistoricalPepperstoneDemoClose(x)).toMatchObject({
      eligible: false,
      reason: 'HISTORICAL_CLOSE_DISPATCH_OR_BROKER_TIME_UNPROVEN',
    });
  });

  it.each([
    [
      'LIVE account',
      (x: HistoricalDemoProofInput) => {
        x.accountType = 'LIVE';
      },
    ],
    [
      'generic cTrader',
      (x: HistoricalDemoProofInput) => {
        x.brokerId = 'ctrader';
      },
    ],
    [
      'other owner',
      (x: HistoricalDemoProofInput) => {
        x.order.userId = 'other';
      },
    ],
    [
      'other connection',
      (x: HistoricalDemoProofInput) => {
        x.trade.brokerConnectionId = 'other';
      },
    ],
    [
      'open trade',
      (x: HistoricalDemoProofInput) => {
        x.trade.status = TradeStatus.OPEN;
      },
    ],
    [
      'filled order',
      (x: HistoricalDemoProofInput) => {
        x.order.status = OrderStatus.FILLED;
      },
    ],
    [
      'incomplete page',
      (x: HistoricalDemoProofInput) => {
        x.historyPageComplete = false;
      },
    ],
    [
      'broker has position',
      (x: HistoricalDemoProofInput) => {
        x.brokerAccountFlat = false;
      },
    ],
    [
      'ambiguous trade order',
      (x: HistoricalDemoProofInput) => {
        x.uniquePendingCloseOrdersForTrade = 2;
      },
    ],
    [
      'ambiguous broker close',
      (x: HistoricalDemoProofInput) => {
        x.uniqueProviderClosingDealsForPosition = 2;
      },
    ],
    [
      'forged native ID',
      (x: HistoricalDemoProofInput) => {
        x.rawBrokerClosingDeal.dealId = '0';
      },
    ],
    [
      'position mismatch',
      (x: HistoricalDemoProofInput) => {
        x.rawBrokerClosingDeal.positionId = '9999';
      },
    ],
    [
      'fill already recorded',
      (x: HistoricalDemoProofInput) => {
        x.order.filledQuantity = '0.01';
      },
    ],
    [
      'wrong side',
      (x: HistoricalDemoProofInput) => {
        x.brokerClosingDeal.direction = 'SELL';
      },
    ],
    [
      'wrong size',
      (x: HistoricalDemoProofInput) => {
        x.brokerClosingDeal.lotSize = '3.17';
      },
    ],
    [
      'wrong exit',
      (x: HistoricalDemoProofInput) => {
        x.brokerClosingDeal.closePrice = '155.251';
      },
    ],
    [
      'wrong P&L',
      (x: HistoricalDemoProofInput) => {
        x.brokerClosingDeal.realisedPnl = '45.21';
      },
    ],
    [
      'forged broker time',
      (x: HistoricalDemoProofInput) => {
        x.rawBrokerClosingDeal.executionTimestamp -= 2500;
      },
    ],
    [
      'stale beyond 30 days',
      (x: HistoricalDemoProofInput) => {
        x.observedAt = new Date('2026-12-24T23:34:44.000Z');
      },
    ],
  ])('fails closed: %s', (_name, change) => {
    const x = fixture();
    change(x);
    expect(proveHistoricalPepperstoneDemoClose(x).eligible).toBe(false);
  });

  it('deduplicates native deal, trade, order and position identity across a historical plan', () => {
    const one = fixture();
    const two = fixture();
    two.order.id = 'order-2';
    two.order.tradeId = 'trade-2';
    two.trade.id = 'trade-2';
    expect(planHistoricalPepperstoneDemoCloses([one, two]).eligible).toHaveLength(0);
    expect(planHistoricalPepperstoneDemoCloses([one, two]).withheld).toHaveLength(2);
    const independent = fixture();
    independent.order.id = 'order-3';
    independent.order.tradeId = 'trade-3';
    independent.trade.id = 'trade-3';
    independent.trade.externalOrderId = '99991';
    independent.rawBrokerClosingDeal.positionId = '99991';
    independent.rawBrokerClosingDeal.dealId = '10002';
    independent.rawBrokerClosingDeal.orderId = '10003';
    independent.brokerClosingDeal.externalOrderId = '99991';
    const plan = planHistoricalPepperstoneDemoCloses([one, independent]);
    expect(plan.eligible).toHaveLength(2);
    expect(plan.withheld).toEqual([]);
  });

  it('never invokes OrderService, DB changes or broker execution', () => {
    const plan = planHistoricalPepperstoneDemoCloses([fixture()]);
    expect(plan.eligible).toHaveLength(1);
    expect(Object.keys(plan)).toEqual(['eligible', 'withheld']);
    expect('applyFill' in plan).toBe(false);
  });
});
