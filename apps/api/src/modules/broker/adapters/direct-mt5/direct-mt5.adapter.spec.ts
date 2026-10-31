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
});
