import { BrokerMode } from '../../interfaces/broker-adapter.interface';
import { DirectMt5Adapter } from './direct-mt5.adapter';

describe('DirectMt5Adapter', () => {
  const commandService = {
    getActiveConnectorForConnection: jest.fn(),
    request: jest.fn(),
  } as any;

  beforeEach(() => jest.resetAllMocks());

  it('is DEMO-only and connects from fresh paired-terminal evidence without broker credentials', async () => {
    commandService.getActiveConnectorForConnection.mockResolvedValue({
      connectorId: 'connector-1',
      accountLogin: '12345',
      brokerServer: 'Broker-Demo',
      currency: 'USD',
      tradeAllowed: true,
    });
    const adapter = new DirectMt5Adapter(commandService, 'connection-1');
    adapter.setMode(BrokerMode.DEMO);
    await expect(adapter.connect({ accountId: '12345' })).resolves.toMatchObject({
      success: true,
      accountId: '12345',
      accountType: BrokerMode.DEMO,
    });
    expect(adapter.isConnected()).toBe(true);
    expect(() => adapter.setMode(BrokerMode.LIVE)).toThrow(/DEMO-only/i);
  });

  it('maps a MARKET order to one idempotent terminal command', async () => {
    commandService.getActiveConnectorForConnection.mockResolvedValue({
      connectorId: 'connector-1',
      accountLogin: '12345',
      brokerServer: 'Broker-Demo',
      currency: 'USD',
      tradeAllowed: true,
    });
    commandService.request.mockResolvedValue({
      success: true,
      ticket: '9001',
      filledPrice: '1.08420',
      filledAt: '2026-10-27T10:00:00.000Z',
    });
    const adapter = new DirectMt5Adapter(commandService, 'connection-1');
    adapter.setMode(BrokerMode.DEMO);
    await adapter.connect({ accountId: '12345' });
    const result = await adapter.placeOrder({
      idempotencyKey: 'intent-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.5',
      stopLoss: '1.0800',
      takeProfit: '1.0900',
      orderKind: 'MARKET',
    });
    expect(commandService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerConnectionId: 'connection-1',
        idempotencyKey: 'intent-1',
        commandType: 'PLACE_ORDER',
      }),
    );
    expect(result).toMatchObject({ success: true, externalOrderId: '9001', status: 'FILLED' });
  });
});
