import type { BrokerPrice } from '../../broker/interfaces/broker-adapter.interface';
import { BrokerService } from '../../broker/broker.service';
import { AuditService } from '../../audit/audit.service';
import { OrderService } from '../orders/order.service';
import { OrderKind, OrderTimeInForce } from '../orders/order.enums';
import type { ExecutionIntent } from './execution-intent.interface';
import { MarketSafetyGateService } from './market-safety-gate.service';

const quote: BrokerPrice = {
  instrument: 'EURUSD',
  bid: '1.08490',
  ask: '1.08510',
  spread: '0.00020',
  timestamp: new Date('2026-11-03T10:00:00.000Z'),
};

const intent: ExecutionIntent = {
  userId: '11111111-1111-4111-8111-111111111111',
  brokerConnectionId: '22222222-2222-4222-8222-222222222222',
  clientOrderId: 'sig-spread-quote',
  orderKind: OrderKind.MARKET,
  timeInForce: OrderTimeInForce.GTC,
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedQuantity: '0.20',
  requestedPrice: null,
  stopPrice: null,
  stopLoss: '1.07500',
  takeProfit: '1.09500',
  referencePrice: '1.08500',
  providerAction: 'PLACE',
};

describe('MarketSafetyGateService quote provenance', () => {
  it('returns the exact fresh quote that passed the final market-safety checks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-03T10:00:05.000Z'));
    const brokerService = {
      getCurrentPriceForConnection: jest.fn().mockResolvedValue(quote),
    };
    const orderService = { rejectOrder: jest.fn() };
    const auditService = { log: jest.fn() };
    const service = new MarketSafetyGateService(
      brokerService as unknown as BrokerService,
      orderService as unknown as OrderService,
      auditService as unknown as AuditService,
    );

    await expect(
      service.assertMarketSafeForDispatch(
        intent,
        { brokerId: 'ctrader' } as never,
        'order-spread-quote',
      ),
    ).resolves.toEqual(quote);

    expect(brokerService.getCurrentPriceForConnection).toHaveBeenCalledTimes(1);
    expect(orderService.rejectOrder).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
