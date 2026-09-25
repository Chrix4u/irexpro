/**
 * Sprint 50 PR-4 — PaperBrokerAdapter honest provider-state tracking.
 *
 * The paper adapter now reflects its simulated fills in the provider read
 * surface (positions/orders/history), so reconciliation against a paper
 * connection observes truthful state instead of an always-empty universe.
 */
import { PaperBrokerAdapter } from './paper-broker.adapter';
import { PaperBrokerStateStore } from '../services/paper-broker-state.store';

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


describe('PaperBrokerAdapter — restart-durable provider state', () => {
  const durableStore = () => {
    const states = new Map<string, unknown>();
    return {
      load: jest.fn(async (connectionId: string) => states.get(connectionId) ?? null),
      loadBootstrap: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (connectionId: string, state: unknown) => {
        // Match jsonb semantics: callers can never mutate the stored object
        // after save().
        states.set(connectionId, JSON.parse(JSON.stringify(state)));
      }),
      remove: jest.fn(async (connectionId: string) => {
        states.delete(connectionId);
      }),
    } as unknown as PaperBrokerStateStore;
  };

  it('restores balance, closed history, market walk and order counter after a new adapter instance', async () => {
    const store = durableStore();
    const first = new PaperBrokerAdapter(undefined, undefined, store, 'conn-1');
    await first.connect({ accountId: 'paper' });

    const opened = await first.placeOrder({
      idempotencyKey: 'restart-k1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '1.0000',
      stopLoss: '0',
      takeProfit: '0',
      orderKind: 'MARKET',
    });
    expect(opened.externalOrderId).toBe('paper-order-000001');

    await first.getCurrentPrice('EURUSD');
    const closed = await first.closeOrder(opened.externalOrderId!);
    expect(closed.success).toBe(true);
    expect(closed.realisedPnl).toBe('20.00');
    expect((await first.getAccountBalance()).balance).toBe('10020.00');

    // Simulate a process restart: brand-new adapter object, same persisted
    // BrokerConnection identity and durable provider store.
    const restarted = new PaperBrokerAdapter(undefined, undefined, store, 'conn-1');
    await restarted.connect({ accountId: 'paper' });

    expect(await restarted.getAccountBalance()).toMatchObject({
      balance: '10020.00',
      equity: '10020.00',
    });
    const history = await restarted.getClosedTrades(new Date(0), new Date('2100-01-01'));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      externalOrderId: 'paper-order-000001',
      realisedPnl: '20.00',
      closePrice: '1.10025',
    });

    const next = await restarted.placeOrder({
      idempotencyKey: 'restart-k2',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.1000',
      stopLoss: '0',
      takeProfit: '0',
      orderKind: 'MARKET',
    });
    expect(next.externalOrderId).toBe('paper-order-000002');
    expect(next.filledPrice).toBe('1.10025');
  });

  it('restores an open position instead of fabricating an empty provider after restart', async () => {
    const store = durableStore();
    const first = new PaperBrokerAdapter(undefined, undefined, store, 'conn-open');
    await first.connect({ accountId: 'paper' });

    await first.placeOrder({
      idempotencyKey: 'open-k1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.5000',
      stopLoss: '1.09000',
      takeProfit: '1.15000',
      orderKind: 'MARKET',
    });
    await first.getCurrentPrice('EURUSD');

    const before = await first.getOpenPositions();
    expect(before).toHaveLength(1);

    const restarted = new PaperBrokerAdapter(undefined, undefined, store, 'conn-open');
    await restarted.connect({ accountId: 'paper' });
    const after = await restarted.getOpenPositions();

    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      externalOrderId: before[0].externalOrderId,
      openPrice: before[0].openPrice,
      currentPrice: before[0].currentPrice,
      unrealisedPnl: before[0].unrealisedPnl,
    });
  });

  it('bootstraps an existing flat PAPER connection from its current broker-account balance', async () => {
    const states = new Map<string, unknown>();
    const store = {
      load: jest.fn(async (connectionId: string) => states.get(connectionId) ?? null),
      loadBootstrap: jest.fn().mockResolvedValue({
        balance: '10066.50',
        activeTradeCount: 0,
        maxPaperOrderCounter: 17,
      }),
      save: jest.fn(async (connectionId: string, state: unknown) => {
        states.set(connectionId, JSON.parse(JSON.stringify(state)));
      }),
      remove: jest.fn(),
    } as unknown as PaperBrokerStateStore;

    const adapter = new PaperBrokerAdapter(undefined, undefined, store, 'legacy-flat');
    await adapter.connect({ accountId: 'paper' });

    expect(await adapter.getAccountBalance()).toMatchObject({
      balance: '10066.50',
      equity: '10066.50',
    });
    const next = await adapter.placeOrder({
      idempotencyKey: 'legacy-next',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.1000',
      stopLoss: '0',
      takeProfit: '0',
      orderKind: 'MARKET',
    });
    expect(next.externalOrderId).toBe('paper-order-000018');
  });

  it('fails closed on first bootstrap when active trades exist instead of losing provider exposure', async () => {
    const store = {
      load: jest.fn().mockResolvedValue(null),
      loadBootstrap: jest.fn().mockResolvedValue({
        balance: '10013.30',
        activeTradeCount: 1,
        maxPaperOrderCounter: 18,
      }),
      save: jest.fn(),
      remove: jest.fn(),
    } as unknown as PaperBrokerStateStore;
    const adapter = new PaperBrokerAdapter(undefined, undefined, store, 'legacy-open');

    await expect(adapter.connect({ accountId: 'paper' })).rejects.toThrow(
      /Cannot bootstrap durable PAPER state while 1 active internal trade/,
    );
    expect(store.save).not.toHaveBeenCalled();
  });

  it('fails closed when durable provider state is malformed instead of silently resetting to 10,000', async () => {
    const store = {
      load: jest.fn().mockResolvedValue({ version: 1, balance: 'NOT_A_DECIMAL' }),
      save: jest.fn(),
      remove: jest.fn(),
    } as unknown as PaperBrokerStateStore;
    const adapter = new PaperBrokerAdapter(undefined, undefined, store, 'conn-bad');

    await expect(adapter.connect({ accountId: 'paper' })).rejects.toThrow(
      /Unable to restore durable PAPER broker state/,
    );
    expect(store.save).not.toHaveBeenCalled();
  });
});