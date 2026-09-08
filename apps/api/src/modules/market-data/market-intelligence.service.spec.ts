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
  };
  const marketDataReader = {
    getCurrentPrice: jest.fn(),
    getOHLCV: jest.fn(),
  };
  const encryptionService = { decrypt: jest.fn() };
  const auditService = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
    brokerService.findActiveConnectionForUser.mockResolvedValue(connection);
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

  it('rejects paper/synthetic market adapters before decrypting credentials', async () => {
    brokerService.findActiveConnectionForUser.mockResolvedValue({
      ...connection,
      brokerId: 'paper-broker',
    });

    await expect(
      createService().getSnapshot(userId, { instrument: 'EURUSD', timeframe: 'H1', limit: 120 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MARKET_DATA_UNAVAILABLE' }),
    });
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(marketDataReader.getOHLCV).not.toHaveBeenCalled();
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
