import type {
  BrokerOrderResult,
  BrokerOrderState,
  IBrokerAdapter,
} from '../interfaces/broker-adapter.interface';
import {
  reconcilePendingDemoMarketOrder,
  withDemoValidationOrderReconciliation,
} from './demo-validation-order-reconciliation';

const pending: BrokerOrderResult = {
  success: true,
  externalOrderId: 'provider-order-42',
  status: 'PENDING',
};

function state(
  status: BrokerOrderState['status'],
  overrides: Partial<BrokerOrderState> = {},
): BrokerOrderState {
  return {
    providerOrderId: 'provider-order-42',
    status,
    instrument: 'EURUSD',
    direction: 'BUY',
    requestedQuantity: '0.02',
    filledQuantity: status === 'FILLED' ? '0.02' : '0',
    avgFillPrice: status === 'FILLED' ? '1.08123' : null,
    orderKind: 'MARKET',
    updatedAt: new Date('2026-10-27T12:00:00.000Z'),
    ...overrides,
  };
}

describe('DEMO validation market-order reconciliation', () => {
  it('keeps an immediate FILLED result unchanged without polling', async () => {
    const filled: BrokerOrderResult = {
      success: true,
      externalOrderId: 'provider-order-42',
      filledPrice: '1.08123',
      filledQuantity: '0.02',
      status: 'FILLED',
    };
    const getOrderById = jest.fn();

    await expect(
      reconcilePendingDemoMarketOrder(
        { getOrderById } as Pick<IBrokerAdapter, 'getOrderById'>,
        filled,
      ),
    ).resolves.toBe(filled);
    expect(getOrderById).not.toHaveBeenCalled();
  });

  it('reconciles PENDING to a provider-proven FILLED result', async () => {
    const getOrderById = jest
      .fn()
      .mockResolvedValueOnce(state('WORKING'))
      .mockResolvedValueOnce(state('FILLED'));

    const result = await reconcilePendingDemoMarketOrder(
      { getOrderById } as Pick<IBrokerAdapter, 'getOrderById'>,
      pending,
      { attempts: 3, intervalMs: 0 },
    );

    expect(result).toMatchObject({
      success: true,
      externalOrderId: 'provider-order-42',
      status: 'FILLED',
      filledPrice: '1.08123',
      filledQuantity: '0.02',
    });
    expect(getOrderById).toHaveBeenCalledTimes(2);
  });

  it('fails immediately when reconciliation reports REJECTED', async () => {
    const getOrderById = jest.fn().mockResolvedValue(state('REJECTED'));

    const result = await reconcilePendingDemoMarketOrder(
      { getOrderById } as Pick<IBrokerAdapter, 'getOrderById'>,
      pending,
      { attempts: 4, intervalMs: 0 },
    );

    expect(result.status).toBe('REJECTED');
    expect(result.success).toBe(false);
    expect(getOrderById).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the provider never proves a fill', async () => {
    const getOrderById = jest.fn().mockResolvedValue(state('WORKING'));

    const result = await reconcilePendingDemoMarketOrder(
      { getOrderById } as Pick<IBrokerAdapter, 'getOrderById'>,
      pending,
      { attempts: 3, intervalMs: 0 },
    );

    expect(result.status).toBe('FAILED');
    expect(result.success).toBe(false);
    expect(result.brokerMessage).toContain('remained PENDING');
    expect(getOrderById).toHaveBeenCalledTimes(3);
  });

  it('reconciles only MARKET validation orders and leaves pending LIMIT orders untouched', async () => {
    const placeOrder = jest.fn().mockResolvedValue(pending);
    const getOrderById = jest.fn().mockResolvedValue(state('FILLED'));
    const adapter = {
      placeOrder,
      getOrderById,
    } as unknown as IBrokerAdapter;
    const wrapped = withDemoValidationOrderReconciliation(adapter, {
      attempts: 2,
      intervalMs: 0,
    });

    const market = await wrapped.placeOrder({
      idempotencyKey: 'demo-market',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.02',
      stopLoss: '1.07000',
      takeProfit: '1.09000',
      orderKind: 'MARKET',
    });
    expect(market.status).toBe('FILLED');
    expect(getOrderById).toHaveBeenCalledTimes(1);

    getOrderById.mockClear();
    const limit = await wrapped.placeOrder({
      idempotencyKey: 'demo-limit',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '0.90000',
      takeProfit: '1.20000',
      orderKind: 'LIMIT',
      limitPrice: '0.95000',
    });
    expect(limit).toBe(pending);
    expect(getOrderById).not.toHaveBeenCalled();
  });
});
