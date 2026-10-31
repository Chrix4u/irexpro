import { BrokerMode } from '../../interfaces/broker-adapter.interface';
import { DirectMt5Adapter } from './direct-mt5.adapter';

describe('DirectMt5Adapter', () => {
  const commandService = {
    getActiveConnectorForConnection: jest.fn(),
    request: jest.fn(),
  } as any;

  beforeEach(() => jest.resetAllMocks());

  it('supports DEMO and LIVE only when the paired terminal environment matches the requested mode', async () => {
    commandService.getActiveConnectorForConnection.mockResolvedValue({
      connectorId: 'connector-1', accountLogin: '12345', brokerServer: 'Broker-Demo', currency: 'USD', tradeAllowed: true, accountType: BrokerMode.DEMO,
    });
    const adapter = new DirectMt5Adapter(commandService, 'connection-1');
    adapter.setMode(BrokerMode.DEMO);
    await expect(adapter.connect({ accountId: '12345' })).resolves.toMatchObject({ success: true, accountId: '12345', accountType: BrokerMode.DEMO });
    expect(adapter.isConnected()).toBe(true);

    commandService.getActiveConnectorForConnection.mockResolvedValue({ connectorId: 'connector-live', accountLogin: '54321', brokerServer: 'Broker-Live', currency: 'USD', tradeAllowed: true, accountType: BrokerMode.LIVE });
    const live = new DirectMt5Adapter(commandService, 'connection-live');
    live.setMode(BrokerMode.LIVE);
    await expect(live.connect({ accountId: '54321' })).resolves.toMatchObject({ success: true, accountId: '54321', accountType: BrokerMode.LIVE });

    commandService.getActiveConnectorForConnection.mockResolvedValue({ connectorId: 'connector-wrong', accountLogin: '54321', brokerServer: 'Broker-Live', currency: 'USD', tradeAllowed: true, accountType: BrokerMode.DEMO });
    const fenced = new DirectMt5Adapter(commandService, 'connection-live');
    fenced.setMode(BrokerMode.LIVE);
    await expect(fenced.connect({ accountId: '54321' })).rejects.toThrow(/environment/i);
  });

  it('maps a MARKET order to one idempotent terminal command', async () => {
    commandService.getActiveConnectorForConnection.mockResolvedValue({ connectorId: 'connector-1', accountLogin: '12345', brokerServer: 'Broker-Demo', currency: 'USD', tradeAllowed: true, accountType: BrokerMode.DEMO });
    commandService.request.mockResolvedValue({ success: true, ticket: '9001', filledPrice: '1.08420', filledAt: '2026-10-27T10:00:00.000Z' });
    const adapter = new DirectMt5Adapter(commandService, 'connection-1');
    adapter.setMode(BrokerMode.DEMO);
    await adapter.connect({ accountId: '12345' });
    const result = await adapter.placeOrder({ idempotencyKey: 'intent-1', instrument: 'EURUSD', direction: 'BUY', lotSize: '0.5', stopLoss: '1.0800', takeProfit: '1.0900', orderKind: 'MARKET' });
    expect(commandService.request).toHaveBeenCalledWith(expect.objectContaining({ brokerConnectionId: 'connection-1', idempotencyKey: 'intent-1', commandType: 'PLACE_ORDER' }));
    expect(result).toMatchObject({ success: true, externalOrderId: '9001', status: 'FILLED' });
  });

  it('normalizes connector ISO timestamps into broker interface Date values', async () => {
    commandService.getActiveConnectorForConnection.mockResolvedValue({
      connectorId: 'connector-1', accountLogin: '12345', brokerServer: 'Broker-Demo', currency: 'USD',
      tradeAllowed: true, accountType: BrokerMode.DEMO,
    });
    commandService.request.mockImplementation(async ({ commandType }: any) => {
      if (commandType === 'GET_PRICE') return { instrument: 'EURUSD', bid: '1.0842', ask: '1.0843', spread: '0.0001', timestamp: '2026-10-31T10:00:00.000Z' };
      if (commandType === 'GET_OHLCV') return { bars: [{ timestamp: '2026-10-31T09:55:00.000Z', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' }] };
      if (commandType === 'LIST_POSITIONS') return { positions: [{ externalOrderId: '9001', instrument: 'EURUSD', direction: 'BUY', lotSize: '0.2', openPrice: '1', currentPrice: '1.1', stopLoss: '0.9', takeProfit: '1.2', unrealisedPnl: '20', openedAt: '2026-10-31T09:00:00.000Z', commission: '0', swap: '0' }] };
      if (commandType === 'GET_HISTORY') return { trades: [{ externalOrderId: '9001', instrument: 'EURUSD', direction: 'BUY', lotSize: '0.2', openPrice: '1', closePrice: '1.1', stopLoss: '0.9', takeProfit: '1.2', realisedPnl: '20', openedAt: '2026-10-31T09:00:00.000Z', closedAt: '2026-10-31T10:00:00.000Z', commission: '0', swap: '0', closeReason: 'TP' }] };
      if (commandType === 'LIST_ORDERS') return { orders: [{ providerOrderId: '8001', status: 'WORKING', instrument: 'EURUSD', direction: 'BUY', requestedQuantity: '0.2', filledQuantity: '0', placedAt: '2026-10-31T09:30:00.000Z', updatedAt: '2026-10-31T09:31:00.000Z' }] };
      if (commandType === 'GET_ORDER') return { order: { providerOrderId: '8001', status: 'FILLED', instrument: 'EURUSD', direction: 'BUY', requestedQuantity: '0.2', filledQuantity: '0.2', placedAt: '2026-10-31T09:30:00.000Z', updatedAt: '2026-10-31T09:32:00.000Z' } };
      throw new Error(`unexpected command ${commandType}`);
    });
    const adapter = new DirectMt5Adapter(commandService, 'connection-1');
    adapter.setMode(BrokerMode.DEMO);
    await adapter.connect({ accountId: '12345' });

    expect((await adapter.getCurrentPrice('EURUSD')).timestamp).toBeInstanceOf(Date);
    expect((await adapter.getOHLCV('EURUSD', 'M5', 1))[0]!.timestamp).toBeInstanceOf(Date);
    expect((await adapter.getOpenPositions())[0]!.openedAt).toBeInstanceOf(Date);
    const trade = (await adapter.getClosedTrades(new Date('2026-10-31T00:00:00Z'), new Date('2026-11-01T00:00:00Z')))[0]!;
    expect(trade.openedAt).toBeInstanceOf(Date);
    expect(trade.closedAt).toBeInstanceOf(Date);
    const order = (await adapter.listOrders())[0]!;
    expect(order.placedAt).toBeInstanceOf(Date);
    expect(order.updatedAt).toBeInstanceOf(Date);
    const one = await adapter.getOrderById('8001');
    expect(one?.placedAt).toBeInstanceOf(Date);
    expect(one?.updatedAt).toBeInstanceOf(Date);
  });

});
