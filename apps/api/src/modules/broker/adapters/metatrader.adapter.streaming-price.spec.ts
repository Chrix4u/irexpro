jest.mock('metaapi.cloud-sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    metatraderAccountApi: { getAccount: jest.fn() },
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { MetaTraderAdapter } from './metatrader.adapter';
import { MetaApiClientService } from '../services/metaapi-client.service';

function createRpcConnection() {
  return {
    getAccountInformation: jest.fn().mockResolvedValue({
      login: '123456',
      type: 'ACCOUNT_TRADE_MODE_DEMO',
      currency: 'USD',
    }),
    isSynchronized: jest.fn().mockReturnValue(true),
    subscribeToMarketData: jest.fn().mockResolvedValue(undefined),
    getSymbolPrice: jest.fn().mockResolvedValue({
      bid: 1.0864,
      ask: 1.0865,
      time: new Date('2026-10-12T14:00:00.000Z'),
    }),
  };
}

describe('MetaTraderAdapter streaming price path', () => {
  let module: TestingModule;
  let adapter: MetaTraderAdapter;
  let client: {
    getOrCreateConnection: jest.Mock;
    hasConnection: jest.Mock;
    removeConnection: jest.Mock;
    getOrCreateStreamingConnection: jest.Mock;
    removeStreamingConnection: jest.Mock;
  };
  let rpc: ReturnType<typeof createRpcConnection>;
  let streaming: {
    subscribeToMarketData: jest.Mock;
    terminalState: { price: jest.Mock };
  };

  beforeEach(async () => {
    rpc = createRpcConnection();
    streaming = {
      subscribeToMarketData: jest.fn().mockResolvedValue(undefined),
      terminalState: {
        price: jest.fn().mockReturnValue({
          bid: 1.087,
          ask: 1.0871,
          time: new Date('2026-10-12T14:00:01.000Z'),
        }),
      },
    };
    client = {
      getOrCreateConnection: jest.fn().mockResolvedValue(rpc),
      hasConnection: jest.fn().mockReturnValue(true),
      removeConnection: jest.fn().mockResolvedValue(undefined),
      getOrCreateStreamingConnection: jest.fn().mockResolvedValue(streaming),
      removeStreamingConnection: jest.fn().mockResolvedValue(undefined),
    };

    module = await Test.createTestingModule({
      providers: [
        MetaTraderAdapter,
        { provide: MetaApiClientService, useValue: client },
      ],
    }).compile();
    adapter = module.get(MetaTraderAdapter);
    await adapter.connect({ accountId: 'acc-stream-1' });
  });

  afterEach(async () => {
    await module.close();
  });

  it('reads a subscribed streaming terminal quote before making any RPC quote request', async () => {
    const quote = await adapter.getCurrentPrice('EURUSD');

    expect(client.getOrCreateStreamingConnection).toHaveBeenCalledWith('acc-stream-1');
    expect(streaming.subscribeToMarketData).toHaveBeenCalledWith('EURUSD');
    expect(streaming.terminalState.price).toHaveBeenCalledWith('EURUSD');
    expect(rpc.getSymbolPrice).not.toHaveBeenCalled();
    expect(quote).toMatchObject({
      instrument: 'EURUSD',
      bid: '1.08700000',
      ask: '1.08710000',
      spread: '0.00010000',
    });
  });

  it('subscribes the RPC fallback before reading a price when streaming is unavailable', async () => {
    client.getOrCreateStreamingConnection.mockRejectedValueOnce(new Error('stream unavailable'));

    const quote = await adapter.getCurrentPrice('EURUSD');

    expect(rpc.subscribeToMarketData).toHaveBeenCalledWith('EURUSD');
    expect(rpc.getSymbolPrice).toHaveBeenCalledWith('EURUSD');
    expect(quote.bid).toBe('1.08640000');
  });

  it('reuses the same successful streaming symbol subscription across quote reads', async () => {
    await adapter.getCurrentPrice('EURUSD');
    await adapter.getCurrentPrice('EURUSD');

    expect(streaming.subscribeToMarketData).toHaveBeenCalledTimes(1);
    expect(streaming.terminalState.price).toHaveBeenCalledTimes(2);
    expect(rpc.getSymbolPrice).not.toHaveBeenCalled();
  });

  it('closes both pooled RPC and streaming sessions on adapter disconnect', async () => {
    await adapter.disconnect();

    expect(client.removeConnection).toHaveBeenCalledWith('acc-stream-1');
    expect(client.removeStreamingConnection).toHaveBeenCalledWith('acc-stream-1');
  });
});
