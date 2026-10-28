import { ServiceUnavailableException } from '@nestjs/common';
import { MarketIntelligenceService } from './market-intelligence.service';

describe('MarketIntelligenceService', () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const credentials = { accountId: 'provider-account', apiKey: 'secret' };
  const connection = {
    id: '00000000-0000-0000-0000-000000000002',
    brokerId: 'metatrader5',
    accountType: 'DEMO',
    // A3: usable credential state — the lifecycle gate must pass
    credentialStatus: 'VERIFIED',
    encryptedCredentials: 'ciphertext',
    credentialIv: 'iv',
    credentialTag: 'tag',
    encryptionKeyId: 'env-key-v1',
  };

  const brokerService = {
    findActiveConnectionForUser: jest.fn(),
    findConnectionById: jest.fn(),
    getCurrentPriceForConnection: jest.fn(),
    getOhlcvForConnection: jest.fn(),
  };
  const marketDataReader = {
    getCurrentPrice: jest.fn(),
    getOHLCV: jest.fn(),
  };
  const encryptionService = { decrypt: jest.fn() };
  const auditService = { log: jest.fn().mockResolvedValue(undefined) };
  const livePaperMarket = {
    isLiveConnection: jest.fn().mockReturnValue(false),
    getPositionMarkQuote: jest.fn(),
    getReadOnlyOHLCV: jest.fn(),
  };
  const providerQuoteStore = {
    getLatestQuote: jest.fn(),
    getCandles: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    brokerService.findActiveConnectionForUser.mockResolvedValue(connection);
    livePaperMarket.isLiveConnection.mockReturnValue(false);
    encryptionService.decrypt.mockReturnValue({ ...credentials });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createService(): MarketIntelligenceService {
    return new MarketIntelligenceService(
      brokerService as never,
      marketDataReader as never,
      encryptionService as never,
      auditService as never,
      livePaperMarket as never,
      providerQuoteStore as never,
    );
  }

  it('returns a sanitized fresh broker quote and ordered account-scoped candles', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-30T12:00:30.000Z').getTime());
    marketDataReader.getCurrentPrice.mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.17001',
      ask: '1.17013',
      spread: '0.00012',
      timestamp: new Date('2026-08-30T12:00:15.000Z'),
    });
    marketDataReader.getOHLCV.mockResolvedValue([
      {
        timestamp: new Date('2026-08-30T12:00:00.000Z'),
        open: '1.16980',
        high: '1.17020',
        low: '1.16970',
        close: '1.17005',
        volume: '1200',
      },
      {
        timestamp: new Date('2026-08-30T11:00:00.000Z'),
        open: '1.16920',
        high: '1.16990',
        low: '1.16910',
        close: '1.16980',
        volume: '980',
      },
    ]);

    const result = await createService().getSnapshot(userId, {
      instrument: 'eurusd',
      timeframe: 'H1',
      limit: 120,
    });

    expect(marketDataReader.getCurrentPrice).toHaveBeenCalledWith('provider-account', 'EURUSD');
    expect(marketDataReader.getOHLCV).toHaveBeenCalledWith('provider-account', 'EURUSD', 'H1', 120);
    expect(result.status).toBe('FRESH');
    expect(result.instrument).toBe('EURUSD');
    expect(result.quote).toEqual({
      bid: '1.17001',
      ask: '1.17013',
      spread: '0.00012',
      timestamp: '2026-08-30T12:00:15.000Z',
      freshness: 'FRESH',
    });
    expect(result.candles.map((candle) => candle.timestamp)).toEqual([
      '2026-08-30T11:00:00.000Z',
      '2026-08-30T12:00:00.000Z',
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(connection.id);
    expect(serialized).not.toContain('provider-account');
    expect(serialized).not.toContain('secret');
  });

  it('binds market intelligence to the exact broker selected by the trading workspace', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-06T17:00:30.000Z').getTime());
    const paperConnection = {
      ...connection,
      id: '00000000-0000-0000-0000-000000000099',
      brokerId: 'paper-broker',
      accountType: 'DEMO',
      status: 'CONNECTED',
      encryptedCredentials: null,
      credentialIv: null,
      credentialTag: null,
    };
    brokerService.findConnectionById.mockResolvedValue(paperConnection);
    brokerService.getCurrentPriceForConnection.mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.17001',
      ask: '1.17013',
      spread: '0.00012',
      timestamp: new Date('2026-10-06T17:00:15.000Z'),
    });
    brokerService.getOhlcvForConnection.mockResolvedValue([
      {
        timestamp: new Date('2026-10-06T17:00:00.000Z'),
        open: '1.16980',
        high: '1.17020',
        low: '1.16970',
        close: '1.17005',
        volume: '1200',
      },
    ]);

    const result = await createService().getSnapshot(userId, {
      instrument: 'EURUSD',
      timeframe: 'M1',
      limit: 20,
      brokerConnectionId: paperConnection.id,
    });

    expect(brokerService.findConnectionById).toHaveBeenCalledWith(paperConnection.id, userId);
    expect(brokerService.findActiveConnectionForUser).not.toHaveBeenCalled();
    expect(brokerService.getCurrentPriceForConnection).toHaveBeenCalledWith(
      userId,
      paperConnection.id,
      'EURUSD',
    );
    expect(marketDataReader.getCurrentPrice).not.toHaveBeenCalled();
    expect(result.instrument).toBe('EURUSD');
  });

  it('serves scanner-owned PAPER market intelligence from the read-only live cache without touching execution quotes', async () => {
    const now = new Date('2026-10-19T18:10:30.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const paperConnection = {
      ...connection,
      id: '00000000-0000-0000-0000-000000000099',
      brokerId: 'paper-broker',
      accountType: 'DEMO',
      status: 'CONNECTED',
    };
    brokerService.findConnectionById.mockResolvedValue(paperConnection);
    livePaperMarket.isLiveConnection.mockReturnValue(true);
    livePaperMarket.getPositionMarkQuote.mockReturnValue({
      bid: '152.301',
      ask: '152.311',
      timestamp: new Date('2026-10-19T18:10:20.000Z'),
      source: 'STREAM',
      streamProvider: 'DERIV',
      isStale: false,
    });
    livePaperMarket.getReadOnlyOHLCV.mockReturnValue([
      {
        timestamp: new Date('2026-10-19T18:05:00.000Z'),
        open: '152.250',
        high: '152.340',
        low: '152.240',
        close: '152.300',
        volume: '0',
      },
    ]);

    const result = await createService().getSnapshot(userId, {
      instrument: 'USDJPY',
      timeframe: 'M5',
      limit: 90,
      brokerConnectionId: paperConnection.id,
    });

    expect(livePaperMarket.getPositionMarkQuote).toHaveBeenCalledWith(
      'USDJPY',
      60_000,
      20 * 60_000,
      paperConnection.id,
    );
    expect(livePaperMarket.getReadOnlyOHLCV).toHaveBeenCalledWith(
      'USDJPY',
      'M5',
      90,
      paperConnection.id,
    );
    expect(brokerService.getCurrentPriceForConnection).not.toHaveBeenCalled();
    expect(brokerService.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(result.quote).toMatchObject({
      bid: '152.301',
      ask: '152.311',
      spread: '0.010',
      freshness: 'FRESH',
    });
    expect(result.candles).toHaveLength(1);
  });

  it('fails closed when an explicitly selected broker is not CONNECTED', async () => {
    brokerService.findConnectionById.mockResolvedValue({
      ...connection,
      status: 'DISCONNECTED',
    });

    await expect(
      createService().getSnapshot(userId, {
        instrument: 'EURUSD',
        timeframe: 'M5',
        limit: 20,
        brokerConnectionId: connection.id,
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(brokerService.findActiveConnectionForUser).not.toHaveBeenCalled();
    expect(marketDataReader.getCurrentPrice).not.toHaveBeenCalled();
  });

  it('normalizes malformed OHLC envelopes for browser-safe chart projection', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-28T23:00:30.000Z').getTime());
    brokerService.findActiveConnectionForUser.mockResolvedValue({
      ...connection,
      brokerId: 'paper-broker',
      accountType: 'DEMO',
    });
    brokerService.getCurrentPriceForConnection.mockResolvedValue({
      instrument: 'USDJPY',
      bid: '157.398',
      ask: '157.404',
      spread: '0.006',
      timestamp: new Date('2026-09-28T22:59:30.000Z'),
    });
    brokerService.getOhlcvForConnection.mockResolvedValue([
      {
        timestamp: new Date('2026-09-28T22:54:00.000Z'),
        open: '157.4345',
        high: '157.435',
        low: '157.434',
        close: '157.4355',
        volume: '20',
      },
      {
        timestamp: new Date('2026-09-28T22:55:00.000Z'),
        open: '157.4345',
        high: '157.437',
        low: '157.434',
        close: '157.4335',
        volume: '17',
      },
    ]);

    const result = await createService().getSnapshot(userId, {
      instrument: 'USDJPY',
      timeframe: 'M1',
      limit: 60,
    });

    expect(result.candles[0]).toEqual(
      expect.objectContaining({
        open: '157.4345',
        high: '157.4355',
        low: '157.434',
        close: '157.4355',
      }),
    );
    expect(result.candles[1]).toEqual(
      expect.objectContaining({
        open: '157.4345',
        high: '157.437',
        low: '157.4335',
        close: '157.4335',
      }),
    );
  });

  it('marks old broker evidence stale instead of presenting it as live', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-30T14:30:00.000Z').getTime());
    marketDataReader.getCurrentPrice.mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.17001',
      ask: '1.17013',
      spread: '0.00012',
      timestamp: new Date('2026-08-30T14:20:00.000Z'),
    });
    marketDataReader.getOHLCV.mockResolvedValue([
      {
        timestamp: new Date('2026-08-30T10:00:00.000Z'),
        open: '1.1',
        high: '1.2',
        low: '1.0',
        close: '1.1',
        volume: '100',
      },
    ]);

    const result = await createService().getSnapshot(userId, {
      instrument: 'EURUSD',
      timeframe: 'H1',
      limit: 120,
    });

    expect(result.status).toBe('STALE');
    expect(result.quote.freshness).toBe('STALE');
  });

  it('fails closed when there is no active broker connection', async () => {
    brokerService.findActiveConnectionForUser.mockResolvedValue(null);

    await expect(
      createService().getSnapshot(userId, { instrument: 'EURUSD', timeframe: 'H1', limit: 120 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(marketDataReader.getCurrentPrice).not.toHaveBeenCalled();
    expect(brokerService.getCurrentPriceForConnection).not.toHaveBeenCalled();
  });

  it('A3: fails closed BEFORE decrypt when the credential lifecycle state is unusable', async () => {
    brokerService.findActiveConnectionForUser.mockResolvedValue({
      ...connection,
      credentialStatus: 'REVOKED',
    });

    await expect(
      createService().getSnapshot(userId, { instrument: 'EURUSD', timeframe: 'H1', limit: 120 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MARKET_DATA_UNAVAILABLE' }),
    });
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(marketDataReader.getCurrentPrice).not.toHaveBeenCalled();
    expect(marketDataReader.getOHLCV).not.toHaveBeenCalled();
  });

  it('serves exact paper-broker DEMO evidence through the connection-scoped adapter seams', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-17T15:00:30.000Z').getTime());
    brokerService.findActiveConnectionForUser.mockResolvedValue({
      ...connection,
      brokerId: 'paper-broker',
      accountType: 'DEMO',
    });
    brokerService.getCurrentPriceForConnection.mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.10020',
      ask: '1.10030',
      spread: '0.00010',
      timestamp: new Date('2026-09-17T15:00:15.000Z'),
    });
    brokerService.getOhlcvForConnection.mockResolvedValue([
      {
        timestamp: new Date('2026-09-17T14:00:00.000Z'),
        open: '1.09980',
        high: '1.10040',
        low: '1.09960',
        close: '1.10020',
        volume: '1000',
      },
      {
        timestamp: new Date('2026-09-17T15:00:00.000Z'),
        open: '1.10020',
        high: '1.10050',
        low: '1.10000',
        close: '1.10030',
        volume: '1000',
      },
    ]);

    const result = await createService().getSnapshot(userId, {
      instrument: 'eurusd',
      timeframe: 'H1',
      limit: 60,
    });

    expect(brokerService.getCurrentPriceForConnection).toHaveBeenCalledWith(
      userId,
      connection.id,
      'EURUSD',
    );
    expect(brokerService.getOhlcvForConnection).toHaveBeenCalledWith(
      userId,
      connection.id,
      'EURUSD',
      'H1',
      60,
    );
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(marketDataReader.getCurrentPrice).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        instrument: 'EURUSD',
        timeframe: 'H1',
        source: 'BROKER',
        status: 'FRESH',
        quote: expect.objectContaining({
          bid: '1.10020',
          ask: '1.10030',
          spread: '0.00010',
          freshness: 'FRESH',
        }),
      }),
    );
  });

  it('does not widen paper market intelligence to a LIVE paper-broker row', async () => {
    brokerService.findActiveConnectionForUser.mockResolvedValue({
      ...connection,
      brokerId: 'paper-broker',
      accountType: 'LIVE',
    });

    await expect(
      createService().getSnapshot(userId, { instrument: 'EURUSD', timeframe: 'H1', limit: 60 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MARKET_DATA_UNAVAILABLE' }),
    });
    expect(brokerService.getCurrentPriceForConnection).not.toHaveBeenCalled();
    expect(brokerService.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
  });

  it('serves cTrader DEMO market intelligence from the exact persisted broker-native store without bursting provider reads', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-27T20:00:30.000Z').getTime());
    const ctraderConnection = {
      ...connection,
      id: '00000000-0000-0000-0000-000000000077',
      brokerId: 'ctrader',
      accountType: 'DEMO',
      status: 'CONNECTED',
    };
    brokerService.findConnectionById.mockResolvedValue(ctraderConnection);
    providerQuoteStore.getLatestQuote.mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.11350',
      ask: '1.11353',
      spread: '0.00003',
      timestamp: new Date('2026-10-27T20:00:25.000Z'),
    });
    providerQuoteStore.getCandles.mockResolvedValue([
      {
        timestamp: new Date('2026-10-27T19:59:00.000Z'),
        open: '1.11340',
        high: '1.11360',
        low: '1.11330',
        close: '1.11350',
        volume: '42',
      },
    ]);

    const result = await createService().getSnapshot(userId, {
      instrument: 'EURUSD',
      timeframe: 'M1',
      limit: 90,
      brokerConnectionId: ctraderConnection.id,
    });

    expect(providerQuoteStore.getLatestQuote).toHaveBeenCalledWith(ctraderConnection.id, 'EURUSD');
    expect(providerQuoteStore.getCandles).toHaveBeenCalledWith(
      ctraderConnection.id,
      'EURUSD',
      'M1',
      90,
    );
    expect(brokerService.getCurrentPriceForConnection).not.toHaveBeenCalled();
    expect(brokerService.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(marketDataReader.getOHLCV).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        instrument: 'EURUSD',
        timeframe: 'M1',
        source: 'BROKER',
        quote: expect.objectContaining({ bid: '1.11350', ask: '1.11353' }),
      }),
    );
    expect(result.candles).toHaveLength(1);
  });

  it('keeps cTrader workspace reads fail-closed when the persisted broker-native store is unavailable instead of bursting the provider', async () => {
    const ctraderConnection = {
      ...connection,
      id: '00000000-0000-0000-0000-000000000077',
      brokerId: 'ctrader',
      accountType: 'DEMO',
      status: 'CONNECTED',
    };
    brokerService.findConnectionById.mockResolvedValue(ctraderConnection);
    providerQuoteStore.getLatestQuote.mockResolvedValue(null);
    providerQuoteStore.getCandles.mockResolvedValue([]);

    await expect(
      createService().getSnapshot(userId, {
        instrument: 'USDJPY',
        timeframe: 'M1',
        limit: 90,
        brokerConnectionId: ctraderConnection.id,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MARKET_DATA_UNAVAILABLE' }),
    });

    expect(providerQuoteStore.getLatestQuote).toHaveBeenCalledWith(ctraderConnection.id, 'USDJPY');
    expect(brokerService.getCurrentPriceForConnection).not.toHaveBeenCalled();
    expect(brokerService.getOhlcvForConnection).not.toHaveBeenCalled();
  });

  it('keeps unsupported real brokers fail-closed before decrypting credentials', async () => {
    brokerService.findActiveConnectionForUser.mockResolvedValue({
      ...connection,
      brokerId: 'oanda',
    });

    await expect(
      createService().getSnapshot(userId, { instrument: 'EURUSD', timeframe: 'H1', limit: 120 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MARKET_DATA_UNAVAILABLE' }),
    });
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(marketDataReader.getOHLCV).not.toHaveBeenCalled();
    expect(brokerService.getOhlcvForConnection).not.toHaveBeenCalled();
  });

  it('sanitizes paper simulator failures and does not fall through to provider credentials', async () => {
    brokerService.findActiveConnectionForUser.mockResolvedValue({
      ...connection,
      brokerId: 'paper-broker',
      accountType: 'DEMO',
    });
    brokerService.getCurrentPriceForConnection.mockResolvedValue(null);

    await expect(
      createService().getSnapshot(userId, { instrument: 'EURUSD', timeframe: 'H1', limit: 60 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MARKET_DATA_UNAVAILABLE' }),
    });

    expect(brokerService.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'simulator-unavailable' }),
      }),
    );
  });

  it('sanitizes provider failures and clears decrypted credentials', async () => {
    const mutableCredentials = { ...credentials };
    encryptionService.decrypt.mockReturnValue(mutableCredentials);
    marketDataReader.getCurrentPrice.mockRejectedValue(
      new Error('provider account 123 secret diagnostic'),
    );
    marketDataReader.getOHLCV.mockResolvedValue([]);

    await expect(
      createService().getSnapshot(userId, { instrument: 'EURUSD', timeframe: 'H1', limit: 120 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MARKET_DATA_UNAVAILABLE' }),
    });

    expect(mutableCredentials.accountId).toBeNull();
    expect(mutableCredentials.apiKey).toBeNull();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'provider-unavailable' }),
      }),
    );
  });
});
