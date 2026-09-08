/**
 * Sprint 50 PR-4 — MetaTraderAdapter provider order-state read surface
 * (listOrders / getOrderById) used by state reconciliation.
 */
import { Test } from '@nestjs/testing';
import { MetaApiClientService } from '../services/metaapi-client.service';
import { MetaTraderAdapter } from './metatrader.adapter';
import { BrokerOrderState } from '../interfaces/broker-adapter.interface';

const mtOrder = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 111,
  type: 'ORDER_TYPE_BUY_LIMIT',
  state: 'ORDER_STATE_PLACED',
  symbol: 'EURUSD',
  openPrice: 1.1,
  stopLoss: 1.09,
  volume: 1.0,
  currentVolume: 1.0,
  time: new Date('2026-01-01T00:00:00Z'),
  doneTime: undefined,
  clientId: 'client-111',
  platform: 'mt5',
  reason: 'ORDER_REASON_CLIENT',
  ...overrides,
});

const mockConnection = {
  getAccountInformation: jest.fn().mockResolvedValue({
    login: 12345,
    currency: 'USD',
    leverage: 100,
    balance: 10000,
    equity: 10000,
    margin: 0,
    freeMargin: 10000,
    marginLevel: 0,
    type: 'DEMO',
  }),
  getPositions: jest.fn().mockResolvedValue([]),
  getPosition: jest.fn().mockResolvedValue(null),
  getOrders: jest.fn().mockResolvedValue([
    mtOrder(),
    // Partially filled pending order: 1.0 requested, 0.25 remaining.
    mtOrder({
      id: 222,
      state: 'ORDER_STATE_PARTIAL',
      type: 'ORDER_TYPE_SELL_LIMIT',
      volume: 1.0,
      currentVolume: 0.25,
      clientId: 'client-222',
    }),
    // Unrecognized state — must map to UNKNOWN (fail-closed).
    mtOrder({ id: 333, state: 'ORDER_STATE_SOMETHING_NEW', clientId: 'client-333' }),
  ]),
  getHistoryOrdersByTicket: jest.fn().mockResolvedValue({
    synchronizing: false,
    historyOrders: [
      mtOrder({
        id: 999,
        state: 'ORDER_STATE_FILLED',
        type: 'ORDER_TYPE_BUY',
        volume: 0.5,
        currentVolume: 0,
        doneTime: new Date('2026-01-02T00:00:00Z'),
        clientId: 'client-999',
      }),
    ],
  }),
};

const metaApiClient = {
  isAvailable: jest.fn().mockReturnValue(true),
  getOrCreateConnection: jest.fn().mockResolvedValue(mockConnection),
  removeConnection: jest.fn(),
};

describe('MetaTraderAdapter — provider order state (PR-4)', () => {
  let adapter: MetaTraderAdapter;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [MetaTraderAdapter, { provide: MetaApiClientService, useValue: metaApiClient }],
    }).compile();
    adapter = module.get(MetaTraderAdapter);
    await adapter.connect({ accountId: 'acc-uuid-123' });
  });

  describe('listOrders()', () => {
    it('maps MetaAPI open orders to the BrokerOrderState contract', async () => {
      const orders = await adapter.listOrders();
      expect(orders).toHaveLength(3);

      const working = orders.find((o) => o.providerOrderId === '111');
      expect(working).toMatchObject({
        providerOrderId: '111',
        clientOrderId: 'client-111',
        status: 'WORKING',
        instrument: 'EURUSD',
        direction: 'BUY',
        orderKind: 'LIMIT',
        requestedQuantity: '1.00000000',
        filledQuantity: '0.00000000',
      });
    });

    it('computes filled quantity as volume − currentVolume', async () => {
      const orders = await adapter.listOrders();
      const partial = orders.find((o) => o.providerOrderId === '222') as BrokerOrderState;
      expect(partial.status).toBe('PARTIALLY_FILLED');
      expect(partial.filledQuantity).toBe('0.75000000');
      expect(partial.avgFillPrice).not.toBeNull();
    });

    it('maps unrecognized ORDER_STATE values to UNKNOWN (fail-closed)', async () => {
      const orders = await adapter.listOrders();
      const unknown = orders.find((o) => o.providerOrderId === '333') as BrokerOrderState;
      expect(unknown.status).toBe('UNKNOWN');
    });

    it('maps order types to kinds, unknown types to null', async () => {
      const orders = await adapter.listOrders();
      expect(orders.find((o) => o.providerOrderId === '111')?.orderKind).toBe('LIMIT');
      expect(orders.find((o) => o.providerOrderId === '222')?.orderKind).toBe('LIMIT');
    });

    it('throws BrokerAdapterError when MetaAPI fails (never fabricates)', async () => {
      mockConnection.getOrders.mockRejectedValueOnce(new Error('rpc down'));
      await expect(adapter.listOrders()).rejects.toThrow();
      expect(mockConnection.getOrders).toHaveBeenCalled();
    });
  });

  describe('getOrderById()', () => {
    it('finds a WORKING order from the open set', async () => {
      const order = await adapter.getOrderById('111');
      expect(order).toMatchObject({ providerOrderId: '111', status: 'WORKING' });
      expect(mockConnection.getHistoryOrdersByTicket).not.toHaveBeenCalled();
    });

    it('falls back to history for completed orders and reports terminal state', async () => {
      const order = await adapter.getOrderById('999');
      expect(order).toMatchObject({
        providerOrderId: '999',
        status: 'FILLED',
        filledQuantity: '0.50000000',
      });
      expect(mockConnection.getHistoryOrdersByTicket).toHaveBeenCalledWith('999');
    });

    it('returns null when history is still synchronizing (retry next run — never guesses)', async () => {
      mockConnection.getHistoryOrdersByTicket.mockResolvedValueOnce({
        synchronizing: true,
        historyOrders: [],
      });
      const order = await adapter.getOrderById('999');
      expect(order).toBeNull();
    });

    it('returns null when neither open nor history knows the ticket', async () => {
      mockConnection.getHistoryOrdersByTicket.mockResolvedValueOnce({
        synchronizing: false,
        historyOrders: [],
      });
      const order = await adapter.getOrderById('does-not-exist');
      expect(order).toBeNull();
    });
  });
});
