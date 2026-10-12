import { MetaTraderMarketDataReaderService } from './meta-trader-market-data-reader.service';

function createConnection(bid: number, ask: number) {
  return {
    subscribeToMarketData: jest.fn().mockResolvedValue(undefined),
    getSymbolPrice: jest.fn().mockResolvedValue({
      bid,
      ask,
      time: new Date('2026-08-30T20:00:15.000Z'),
    }),
  };
}

function createAccount(close: number) {
  return {
    getHistoricalCandles: jest.fn().mockResolvedValue([
      {
        time: new Date('2026-08-30T20:00:00.000Z'),
        open: close - 0.0002,
        high: close + 0.0002,
        low: close - 0.0003,
        close,
        tickVolume: 1200,
      },
    ]),
  };
}

describe('MetaTraderMarketDataReaderService', () => {
  const accountA = 'meta-account-a';
  const accountB = 'meta-account-b';
  const connectionA = createConnection(1.17, 1.1701);
  const connectionB = createConnection(1.28, 1.2802);
  const historicalA = createAccount(1.17005);
  const historicalB = createAccount(1.28015);
  const streamingConnectionA = {
    subscribeToMarketData: jest.fn().mockResolvedValue(undefined),
    terminalState: {
      price: jest.fn().mockReturnValue({
        bid: 1.171,
        ask: 1.1711,
        time: new Date('2026-08-30T20:00:16.000Z'),
      }),
    },
  };
  const metaApiClient = {
    getOrCreateConnection: jest.fn(async (accountId: string) => {
      if (accountId === accountA) return connectionA;
      if (accountId === accountB) return connectionB;
      throw new Error('unknown account');
    }),
    getOrCreateStreamingConnection: jest.fn(),
    removeConnection: jest.fn().mockResolvedValue(undefined),
    removeStreamingConnection: jest.fn().mockResolvedValue(undefined),
    connectionPool: new Map([
      [accountA, { account: historicalA }],
      [accountB, { account: historicalB }],
    ]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    metaApiClient.getOrCreateStreamingConnection.mockRejectedValue(
      new Error('streaming unavailable'),
    );
    connectionA.subscribeToMarketData.mockResolvedValue(undefined);
    connectionB.subscribeToMarketData.mockResolvedValue(undefined);
    streamingConnectionA.subscribeToMarketData.mockResolvedValue(undefined);
    streamingConnectionA.terminalState.price.mockReturnValue({
      bid: 1.171,
      ask: 1.1711,
      time: new Date('2026-08-30T20:00:16.000Z'),
    });
  });

  it('prefers the synchronized streaming terminal quote and avoids the RPC quote call', async () => {
    metaApiClient.getOrCreateStreamingConnection.mockResolvedValueOnce(streamingConnectionA);
    const reader = new MetaTraderMarketDataReaderService(metaApiClient as never);

    const quote = await reader.getCurrentPrice(accountA, 'EURUSD');

    expect(quote.bid).toBe('1.17100000');
    expect(quote.ask).toBe('1.17110000');
    expect(metaApiClient.getOrCreateStreamingConnection).toHaveBeenCalledWith(accountA);
    expect(streamingConnectionA.subscribeToMarketData).toHaveBeenCalledWith('EURUSD');
    expect(streamingConnectionA.terminalState.price).toHaveBeenCalledWith('EURUSD');
    expect(connectionA.getSymbolPrice).not.toHaveBeenCalled();
  });

  it('keeps a successful symbol subscription for repeated streaming reads', async () => {
    metaApiClient.getOrCreateStreamingConnection.mockResolvedValue(streamingConnectionA);
    const reader = new MetaTraderMarketDataReaderService(metaApiClient as never);

    await reader.getCurrentPrice(accountA, 'EURUSD');
    await reader.getCurrentPrice(accountA, 'EURUSD');

    expect(streamingConnectionA.subscribeToMarketData).toHaveBeenCalledTimes(1);
    expect(streamingConnectionA.terminalState.price).toHaveBeenCalledTimes(2);
    expect(connectionA.getSymbolPrice).not.toHaveBeenCalled();
  });

  it('falls back to subscribed account-scoped RPC quotes when streaming is unavailable', async () => {
    const reader = new MetaTraderMarketDataReaderService(metaApiClient as never);

    const [quoteA, quoteB] = await Promise.all([
      reader.getCurrentPrice(accountA, 'EURUSD'),
      reader.getCurrentPrice(accountB, 'EURUSD'),
    ]);

    expect(quoteA.bid).toBe('1.17000000');
    expect(quoteA.ask).toBe('1.17010000');
    expect(quoteB.bid).toBe('1.28000000');
    expect(quoteB.ask).toBe('1.28020000');
    expect(metaApiClient.getOrCreateConnection).toHaveBeenCalledWith(accountA, {
      requireSynchronization: true,
    });
    expect(metaApiClient.getOrCreateConnection).toHaveBeenCalledWith(accountB, {
      requireSynchronization: true,
    });
    expect(connectionA.subscribeToMarketData).toHaveBeenCalledWith('EURUSD');
    expect(connectionB.subscribeToMarketData).toHaveBeenCalledWith('EURUSD');
    expect(connectionA.getSymbolPrice).toHaveBeenCalledWith('EURUSD');
    expect(connectionB.getSymbolPrice).toHaveBeenCalledWith('EURUSD');
  });

  it('keeps a successful RPC symbol subscription across fallback reads', async () => {
    const reader = new MetaTraderMarketDataReaderService(metaApiClient as never);

    await reader.getCurrentPrice(accountA, 'EURUSD');
    await reader.getCurrentPrice(accountA, 'EURUSD');

    expect(connectionA.subscribeToMarketData).toHaveBeenCalledTimes(1);
    expect(connectionA.getSymbolPrice).toHaveBeenCalledTimes(2);
  });

  it('falls back to RPC when streaming terminal state has no valid price yet', async () => {
    metaApiClient.getOrCreateStreamingConnection.mockResolvedValueOnce(streamingConnectionA);
    streamingConnectionA.terminalState.price.mockReturnValueOnce(undefined);
    const reader = new MetaTraderMarketDataReaderService(metaApiClient as never);

    const quote = await reader.getCurrentPrice(accountA, 'EURUSD');

    expect(quote.bid).toBe('1.17000000');
    expect(connectionA.subscribeToMarketData).toHaveBeenCalledWith('EURUSD');
    expect(connectionA.getSymbolPrice).toHaveBeenCalledWith('EURUSD');
    expect(metaApiClient.removeStreamingConnection).not.toHaveBeenCalled();
  });

  it('evicts a broken streaming connection before falling back to RPC', async () => {
    metaApiClient.getOrCreateStreamingConnection.mockResolvedValueOnce(streamingConnectionA);
    streamingConnectionA.subscribeToMarketData.mockRejectedValueOnce(new Error('stream broken'));
    const reader = new MetaTraderMarketDataReaderService(metaApiClient as never);

    const quote = await reader.getCurrentPrice(accountA, 'EURUSD');

    expect(quote.bid).toBe('1.17000000');
    expect(metaApiClient.removeStreamingConnection).toHaveBeenCalledWith(
      accountA,
      streamingConnectionA,
    );
    expect(connectionA.subscribeToMarketData).toHaveBeenCalledWith('EURUSD');
    expect(connectionA.getSymbolPrice).toHaveBeenCalledWith('EURUSD');
  });

  it('routes historical candles by explicit account reference, never another pooled account', async () => {
    const reader = new MetaTraderMarketDataReaderService(metaApiClient as never);

    const [candlesA, candlesB] = await Promise.all([
      reader.getOHLCV(accountA, 'EURUSD', 'H1', 80),
      reader.getOHLCV(accountB, 'EURUSD', 'H1', 80),
    ]);

    expect(candlesA[0].close).toBe('1.17005000');
    expect(candlesB[0].close).toBe('1.28015000');
    expect(historicalA.getHistoricalCandles).toHaveBeenCalledWith(
      'EURUSD',
      '1h',
      expect.any(Date),
      80,
    );
    expect(historicalB.getHistoricalCandles).toHaveBeenCalledWith(
      'EURUSD',
      '1h',
      expect.any(Date),
      80,
    );
  });

  it('invalidates the pooled RPC connection when a fallback quote read fails', async () => {
    const reader = new MetaTraderMarketDataReaderService(metaApiClient as never);
    connectionA.getSymbolPrice.mockRejectedValueOnce(new Error('quote timeout'));

    await expect(reader.getCurrentPrice(accountA, 'EURUSD')).rejects.toThrow('quote timeout');

    expect(metaApiClient.removeConnection).toHaveBeenCalledWith(accountA, connectionA);
  });

  it('does not invalidate an unrelated RPC pool entry when fallback acquisition itself fails', async () => {
    const reader = new MetaTraderMarketDataReaderService(metaApiClient as never);
    metaApiClient.getOrCreateConnection.mockRejectedValueOnce(new Error('connect timeout'));

    await expect(reader.getCurrentPrice(accountA, 'EURUSD')).rejects.toThrow('connect timeout');

    expect(metaApiClient.removeConnection).not.toHaveBeenCalled();
  });
});
