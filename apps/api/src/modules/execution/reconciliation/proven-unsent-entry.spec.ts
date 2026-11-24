import { EntityManager } from 'typeorm';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { CapitalAllocation } from '../entities/capital-allocation.entity';
import { proveUnsentEntry, reconcileProvenUnsentEntry } from './proven-unsent-entry';

const trade = (overrides = {}) => ({
  id: 'trade', userId: 'user', brokerConnectionId: 'connection',
  signalId: 'signal', tradeIntentId: 'intent', riskGrantId: 'grant',
  status: TradeStatus.RECONCILIATION_PENDING, dispatchCertainty: 'DEFINITELY_NOT_SENT',
  instrument: 'EURUSD', direction: 'SELL', lotSize: '0.0100',
  externalOrderId: null, externalPositionId: null, openedAt: null,
  closedAt: null, fillPrice: null, exitPrice: null, realisedPnl: null, closeReason: null,
  brokerRejectionReason: 'Execution error: Dispatch error (DEFINITELY_NOT_SENT): price precision',
  ...overrides,
}) as unknown as Trade;
const order = (overrides = {}) => ({
  id: 'order', tradeId: 'trade', userId: 'user', brokerConnectionId: 'connection',
  signalId: 'signal', clientOrderId: 'sig-signal', status: OrderStatus.RECONCILIATION_PENDING,
  orderKind: 'MARKET', instrument: 'EURUSD', direction: 'SELL', requestedQuantity: '0.01',
  filledQuantity: '0.0000', avgFillPrice: null, providerOrderId: null,
  ...overrides,
}) as unknown as Order;

describe('proven unsent entry reconciliation', () => {
  it('recognizes the exact non-dispatched entry', () => expect(proveUnsentEntry(trade(), [order()])).toBe(true));
  it.each([
    { dispatchCertainty: 'MAY_HAVE_REACHED_PROVIDER' }, { externalPositionId: 'pos' },
    { fillPrice: '1.09' }, { openedAt: new Date() }, { riskGrantId: null },
    { brokerRejectionReason: 'unknown' },
  ])('preserves uncertain or previously opened trades (%p)', fields => {
    expect(proveUnsentEntry(trade(fields), [order()])).toBe(false);
  });
  it.each([
    { filledQuantity: '0.01' }, { avgFillPrice: '1.09' }, { providerOrderId: 'p' },
    { clientOrderId: 'close-trade' }, { brokerConnectionId: 'other' }, { direction: 'BUY' },
    { requestedQuantity: '0.02' },
  ])('rejects contradictory or unrelated order evidence (%p)', fields => {
    expect(proveUnsentEntry(trade(), [order(fields)])).toBe(false);
  });
  it('refuses multiple linked orders', () => expect(proveUnsentEntry(trade(), [order(), order()])).toBe(false));
  function harness() {
    const updateTrade = jest.fn().mockResolvedValue({ affected: 1 });
    const updateOrder = jest.fn().mockResolvedValue({ affected: 1 });
    const updateAllocation = jest.fn().mockResolvedValue({ affected: 1 });
    const tx = { getRepository: jest.fn((entity: unknown) => {
      if (entity === Trade) return { findOne: jest.fn().mockResolvedValue(trade()), update: updateTrade };
      if (entity === Order) return {
        createQueryBuilder: () => ({
          where: jest.fn().mockReturnThis(), setLock: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([order()]),
        }),
        update: updateOrder,
      };
      if (entity === CapitalAllocation) return { update: updateAllocation };
      throw Error('unexpected entity');
    }) };
    const manager = { transaction: (fn: (m: unknown) => unknown) => fn(tx) } as unknown as EntityManager;
    return { manager, updateTrade, updateOrder, updateAllocation };
  }
  it('converges the order, trade and allocation in one transaction', async () => {
    const h = harness();
    expect(await reconcileProvenUnsentEntry(h.manager, 'trade', 'user', 'connection', new Set())).toBe('order');
    expect(h.updateOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'REJECTED' }));
    expect(h.updateTrade).toHaveBeenCalledWith(expect.anything(), { status: 'REJECTED' });
    expect(h.updateAllocation).toHaveBeenCalledWith(expect.objectContaining({ tradeIntentId: 'intent', brokerConnectionId: 'connection' }), expect.objectContaining({ status: 'RELEASED' }));
  });
  it('does not mutate when provider reports the same client order identity', async () => {
    const h = harness();
    expect(await reconcileProvenUnsentEntry(h.manager, 'trade', 'user', 'connection', new Set(['sig-signal']))).toBeNull();
    expect(h.updateOrder).not.toHaveBeenCalled();
    expect(h.updateTrade).not.toHaveBeenCalled();
    expect(h.updateAllocation).not.toHaveBeenCalled();
  });
  it('throws on failed CAS instead of releasing the allocation', async () => {
    const h = harness();
    h.updateTrade.mockResolvedValue({ affected: 0 });
    await expect(reconcileProvenUnsentEntry(h.manager, 'trade', 'user', 'connection', new Set())).rejects.toThrow('CAS failed');
    expect(h.updateAllocation).not.toHaveBeenCalled();
  });
});
