import { BrokerClosedTrade } from '../../broker/interfaces/broker-adapter.interface';
import { TradeDirection, TradeStatus } from '../entities/trade.entity';
import { OrderKind, OrderStatus } from '../orders/order.enums';
import {
  ClosedDemoOrderFillProof,
  proveAgedCtraderDemoClosedOrderFill,
  provePepperstoneDemoClosedOrderFill,
} from './closed-demo-order-deal-proof';

import {
  AGED_DEMO_CLOSE_RECOVERY_BATCH,
  agedTradeNeedsSettlementBackfill,
  selectAgedDemoCloseRecoveryCandidates,
} from './closed-demo-order-recovery-sweep';

/** Narrow the proof union to its reason for assertion messages. */
const reasonOf = (p: ClosedDemoOrderFillProof): string =>
  p.matched ? `UNEXPECTED_MATCH:${p.positionRef}` : p.reason;

// Aged fixture: the trade closed 14 days before observation — far outside the
// live recovery six-hour fence, squarely in the stranded historical population.
const opened = new Date('2026-11-10T00:00:00Z');
const sent = new Date('2026-11-10T06:00:00Z');
const closed = new Date('2026-11-10T06:00:01Z');
const observedAt = new Date('2026-11-24T12:00:00Z');
const order: Parameters<typeof proveAgedCtraderDemoClosedOrderFill>[0]['order'] = {
  userId: 'owner',
  brokerConnectionId: 'demo-connection',
  tradeId: 'trade-1',
  status: OrderStatus.RECONCILIATION_PENDING,
  providerOrderId: null,
  orderKind: OrderKind.MARKET,
  instrument: 'USDCAD',
  direction: TradeDirection.BUY,
  requestedQuantity: '2.8000',
  filledQuantity: '0.0000',
  avgFillPrice: null,
  createdAt: new Date('2026-11-10T05:59:59Z'),
  submittedAt: sent,
};
const trade: Parameters<typeof proveAgedCtraderDemoClosedOrderFill>[0]['trade'] = {
  id: 'trade-1',
  userId: 'owner',
  brokerConnectionId: 'demo-connection',
  status: TradeStatus.CLOSED,
  instrument: 'USDCAD',
  direction: TradeDirection.SELL,
  externalPositionId: '8422910',
  externalOrderId: null,
  lotSize: '2.8000',
  openedAt: opened,
  closedAt: closed,
  exitPrice: '1.43767000',
  realisedPnl: '60.38000000',
};
const deal: BrokerClosedTrade = {
  externalOrderId: '8422910',
  instrument: 'USDCAD',
  direction: 'BUY' as const,
  lotSize: '2.8',
  openPrice: '1.43798',
  closePrice: '1.43767',
  stopLoss: '0',
  takeProfit: '0',
  realisedPnl: '60.38',
  openedAt: closed,
  closedAt: closed,
  commission: '-8.4',
  swap: '0',
  closeReason: 'UNKNOWN' as const,
};
const base = {
  brokerId: 'ctrader',
  accountType: 'DEMO',
  accountUserId: 'owner',
  accountConnectionId: 'demo-connection',
  order,
  trade,
  providerClosedDeals: [deal],
  observedAt,
};
const proveAged = (changes: Partial<typeof base> = {}) =>
  proveAgedCtraderDemoClosedOrderFill({ ...base, ...changes });

describe('aged cTrader-family DEMO closed-order proof (no freshness fence)', () => {
  it('matches 14-day-old evidence on the generic ctrader DEMO account', () => {
    expect(proveAged()).toEqual({
      matched: true,
      quantity: '2.8000',
      price: '1.43767',
      positionRef: '8422910',
    });
  });

  it('matches the same aged evidence for pepperstone and icmarkets DEMO', () => {
    expect(proveAged({ brokerId: 'pepperstone-ctrader' }).matched).toBe(true);
    expect(proveAged({ brokerId: 'icmarkets-ctrader' }).matched).toBe(true);
  });

  it('still rejects LIVE and non-family brokers', () => {
    expect(proveAged({ accountType: 'LIVE' }).matched).toBe(false);
    expect(proveAged({ brokerId: 'metaapi' }).matched).toBe(false);
  });

  it('removes the freshness fence only — every exact-decimal guard stays', () => {
    // The live Pepperstone proof rejects this aged evidence (6h fence),
    // proving the two scopes differ exactly by the freshness policy.
    expect(
      reasonOf(
        provePepperstoneDemoClosedOrderFill({
          ...base,
          brokerId: 'pepperstone-ctrader',
        }),
      ),
    ).toBe('CLOSE_DISPATCH_TIME_UNPROVEN');
    // ...while the same evidence still fails closed on economics mismatch:
    expect(reasonOf(proveAged({ providerClosedDeals: [{ ...deal, closePrice: '1.43768' }] }))).toBe(
      'EXACT_BROKER_CLOSE_DEAL_ECONOMICS_MISMATCH',
    );
    expect(reasonOf(proveAged({ providerClosedDeals: [{ ...deal, lotSize: '1.4' }] }))).toBe(
      'EXACT_BROKER_CLOSE_DEAL_ECONOMICS_MISMATCH',
    );
    expect(reasonOf(proveAged({ providerClosedDeals: [] }))).toBe('PROVIDER_DEAL_ABSENT');
    expect(
      reasonOf(proveAged({ providerClosedDeals: [deal, { ...deal, externalOrderId: '8422910' }] })),
    ).toBe('PROVIDER_DEAL_MULTIPLE');
  });

  it('rejects future close timestamps and malformed provenance like the live path', () => {
    expect(reasonOf(proveAged({ observedAt: new Date('2026-11-09T12:00:00Z') }))).toBe(
      'CLOSE_DISPATCH_TIME_UNPROVEN',
    );
    expect(reasonOf(proveAged({ trade: { ...trade, closedAt: null as never } }))).toBe(
      'TIME_PROVENANCE_UNVERIFIED',
    );
    expect(reasonOf(proveAged({ trade: { ...trade, externalPositionId: 'NOT-NUMERIC' } }))).toBe(
      'PROVIDER_POSITION_ID_UNPROVEN',
    );
  });
});

describe('selectAgedDemoCloseRecoveryCandidates', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const stranded = (id: string, tradeId: string, submittedAt: Date) =>
    ({
      id,
      tradeId,
      status: OrderStatus.RECONCILIATION_PENDING,
      orderKind: OrderKind.MARKET,
      providerOrderId: null,
      filledQuantity: '0.0000',
      avgFillPrice: null,
      submittedAt,
      createdAt: submittedAt,
    }) as Parameters<typeof selectAgedDemoCloseRecoveryCandidates>[0][number];

  it('selects the stranded shape regardless of age (14 days old passes)', () => {
    const aged = stranded('o1', 't1', new Date('2026-11-10T06:00:00Z'));
    expect(selectAgedDemoCloseRecoveryCandidates([aged], now, undefined)).toEqual([aged]);
  });

  it('excludes orders with a provider id, a fill, another kind, or terminal status', () => {
    expect(
      selectAgedDemoCloseRecoveryCandidates(
        [
          {
            ...stranded('with-id', 't1', new Date('2026-11-10T06:00:00Z')),
            providerOrderId: '991',
          },
          { ...stranded('filled', 't2', new Date('2026-11-10T06:00:00Z')), filledQuantity: '1' },
          {
            ...stranded('limit', 't3', new Date('2026-11-10T06:00:00Z')),
            orderKind: OrderKind.LIMIT,
          },
          {
            ...stranded('terminal', 't4', new Date('2026-11-10T06:00:00Z')),
            status: OrderStatus.FILLED,
          },
        ],
        now,
        undefined,
      ),
    ).toEqual([]);
  });

  it('excludes ambiguous trades with more than one pending MARKET order', () => {
    const a = stranded('a', 't1', new Date('2026-11-10T06:00:00Z'));
    const b = stranded('b', 't1', new Date('2026-11-10T06:30:00Z'));
    const c = stranded('c', 't2', new Date('2026-11-10T07:00:00Z'));
    expect(selectAgedDemoCloseRecoveryCandidates([a, b, c], now, undefined)).toEqual([c]);
  });

  it('rotates fairly so unresolved rows cannot starve the rest of the backlog', () => {
    const ids = Array.from({ length: 5 }, (_, i) => `o${String(i).padStart(2, '0')}`);
    const orders = ids.map((id) => stranded(id, `t-${id}`, new Date('2026-11-10T06:00:00Z')));
    const first = selectAgedDemoCloseRecoveryCandidates(orders, now, undefined).map((o) => o.id);
    const second = selectAgedDemoCloseRecoveryCandidates(orders, now, first[first.length - 1]).map(
      (o) => o.id,
    );
    const third = selectAgedDemoCloseRecoveryCandidates(orders, now, second[second.length - 1]).map(
      (o) => o.id,
    );
    expect(first).toEqual(ids.slice(0, 2));
    expect(second).toEqual(ids.slice(2, 4));
    // The final unvisited row is reached before wrapping to the head.
    expect(third).toEqual([...ids.slice(4), ...ids.slice(0, 1)]);
  });

  it('does not let recent attempts exhaust the historical recovery budget', () => {
    const orders = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      stranded(id, `t-${id}`, new Date('2026-11-10T06:00:00Z')),
    );
    const attempted = new Set(['a', 'b']);
    expect(
      selectAgedDemoCloseRecoveryCandidates(orders, now, undefined, attempted).map((o) => o.id),
    ).toEqual(['c', 'd']);
    expect(
      selectAgedDemoCloseRecoveryCandidates(orders, now, 'd', attempted).map((o) => o.id),
    ).toEqual(['e', 'c']);
  });

  it('preserves ambiguity checks even when one competing order was attempted', () => {
    const a = stranded('a', 't1', new Date('2026-11-10T06:00:00Z'));
    const b = stranded('b', 't1', new Date('2026-11-10T06:30:00Z'));
    const c = stranded('c', 't2', new Date('2026-11-10T07:00:00Z'));
    expect(
      selectAgedDemoCloseRecoveryCandidates([a, b, c], now, undefined, new Set(['a'])),
    ).toEqual([c]);
  });

  it('bounds the batch to the documented budget', () => {
    expect(AGED_DEMO_CLOSE_RECOVERY_BATCH).toBe(2);
    const many = Array.from({ length: 60 }, (_, i) =>
      stranded(`o${String(i).padStart(3, '0')}`, `t${i}`, new Date('2026-11-10T06:00:00Z')),
    );
    expect(selectAgedDemoCloseRecoveryCandidates(many, now, undefined)).toHaveLength(2);
  });

  it('requires submittedAt/createdAt provenance and a finite asOf', () => {
    const noSubmitted = { ...stranded('x', 't1', new Date('2026-11-10T06:00:00Z')) };
    delete (noSubmitted as { submittedAt?: Date }).submittedAt;
    expect(selectAgedDemoCloseRecoveryCandidates([noSubmitted], now, undefined)).toEqual([]);
    expect(
      selectAgedDemoCloseRecoveryCandidates([stranded('y', 't2', now)], new Date('nan'), undefined),
    ).toEqual([]);
  });
});

describe('agedTradeNeedsSettlementBackfill', () => {
  it('flags CLOSED trades whose three close economics are all NULL', () => {
    expect(
      agedTradeNeedsSettlementBackfill({
        status: TradeStatus.CLOSED,
        realisedPnl: null,
        commission: null,
        exitPrice: null,
      }),
    ).toBe(true);
    expect(
      agedTradeNeedsSettlementBackfill({
        status: TradeStatus.CLOSED,
        realisedPnl: '60.38',
        commission: '-8.4',
        exitPrice: '1.43767',
      }),
    ).toBe(false);
    expect(
      agedTradeNeedsSettlementBackfill({
        status: TradeStatus.OPEN,
        realisedPnl: null,
        commission: null,
        exitPrice: null,
      }),
    ).toBe(false);
    // Partial economics (some set, some null) are NOT the backfill shape —
    // the unique-deal settlement proof writes all three together or nothing.
    expect(
      agedTradeNeedsSettlementBackfill({
        status: TradeStatus.CLOSED,
        realisedPnl: '60.38',
        commission: null,
        exitPrice: null,
      }),
    ).toBe(false);
  });
});
