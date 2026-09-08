/**
 * Sprint 50 PR-4 — PaperBrokerAdapter honest provider-state tracking.
 *
 * The paper adapter now reflects its simulated fills in the provider read
 * surface (positions/orders/history), so reconciliation against a paper
 * connection observes truthful state instead of an always-empty universe.
 */
import { PaperBrokerAdapter } from './paper-broker.adapter';

describe('PaperBrokerAdapter — honest state tracking (PR-4)', () => {
  let adapter: PaperBrokerAdapter;

  beforeEach(async () => {
    adapter = new PaperBrokerAdapter();
    await adapter.connect({ accountId: 'paper' });
  });

  it('a market fill OPENS a simulated position the read surface reports', async () => {
    await adapter.placeOrder({
      idempotencyKey: 'k1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.5000',
      stopLoss: '1.09000',
      takeProfit: '1.15000',
      orderKind: 'MARKET',
    });

    const positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.5000',
    });

    const byId = await adapter.getPositionById(positions[0].externalOrderId);
    expect(byId).not.toBeNull();
    expect(byId?.externalOrderId).toBe(positions[0].externalOrderId);
  });

  it('a working LIMIT order RESTS in the order list (never downgraded to a fill)', async () => {
    await adapter.placeOrder({
      idempotencyKey: 'k2',
      instrument: 'EURUSD',
      direction: 'SELL',
      lotSize: '0.2500',
      stopLoss: '0',
      takeProfit: '0',
      orderKind: 'LIMIT',
      limitPrice: '1.12000',
      timeInForce: 'GTC',
      clientOrderId: 'paper-client-2',
    });

    const orders = await adapter.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      status: 'WORKING',
      orderKind: 'LIMIT',
      clientOrderId: 'paper-client-2',
      requestedQuantity: '0.2500',
      filledQuantity: '0.0000',
    });

    const byId = await adapter.getOrderById(orders[0].providerOrderId);
    expect(byId?.status).toBe('WORKING');
  });

  it('closing a position MOVES it to the closed list with economics', async () => {
    const placed = await adapter.placeOrder({
      idempotencyKey: 'k3',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '1.0000',
      stopLoss: '0',
      takeProfit: '0',
      orderKind: 'MARKET',
    });
    const positionId = placed.externalOrderId!;

    const closed = await adapter.closeOrder(positionId);
    expect(closed.success).toBe(true);

    expect(await adapter.getOpenPositions()).toHaveLength(0);
    expect(await adapter.getPositionById(positionId)).toBeNull();

    const history = await adapter.getClosedTrades(new Date(0), new Date());
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      externalOrderId: positionId,
      closePrice: '1.10005',
      realisedPnl: '0.00',
      closeReason: 'MANUAL',
    });
  });

  it('closing an UNKNOWN position fails honestly (no silent success)', async () => {
    const result = await adapter.closeOrder('paper-order-999999');
    expect(result.success).toBe(false);
    expect(result.status).toBe('REJECTED');
  });

  it('empty state reports empty (a fresh paper account is not fabricating)', async () => {
    expect(await adapter.getOpenPositions()).toEqual([]);
    expect(await adapter.listOrders()).toEqual([]);
    expect(await adapter.getClosedTrades(new Date(0), new Date())).toEqual([]);
  });
});
