import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { DirectMt5PairingService } from './direct-mt5-pairing.service';

describe('DirectMt5PairingService', () => {
  const config = { get: jest.fn().mockReturnValue('0123456789abcdef0123456789abcdef') } as unknown as ConfigService;

  it('creates a single-use pairing code without persisting the raw code', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'connection-1', broker_id: 'metatrader5' }])
      .mockResolvedValueOnce([]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);

    const result = await service.createPairing('user-1', 'connection-1');

    expect(result.pairingCode).toMatch(/^[A-Z2-9]{10}$/);
    expect(result.connectorId).toMatch(/^[0-9a-f-]{36}$/);
    const insertParams = query.mock.calls[1]![1] as unknown[];
    expect(insertParams).not.toContain(result.pairingCode);
    expect(String(insertParams[3])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects pairing a connection owned by another user or a non-MT5 provider', async () => {
    const missing = new DirectMt5PairingService(
      { query: jest.fn().mockResolvedValue([]) } as unknown as DataSource,
      config,
    );
    await expect(missing.createPairing('user-1', 'connection-x')).rejects.toThrow('not found');

    const wrongProvider = new DirectMt5PairingService(
      {
        query: jest.fn().mockResolvedValue([{ id: 'connection-1', broker_id: 'ctrader' }]),
      } as unknown as DataSource,
      config,
    );
    await expect(wrongProvider.createPairing('user-1', 'connection-1')).rejects.toThrow(
      'MetaTrader 5',
    );
  });

  it('redeems a pairing code once and persists only a connector-token digest', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        id: 'connector-1',
        broker_connection_id: 'connection-1',
        user_id: 'user-1',
      },
    ]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);

    const result = await service.redeemPairing('ABCDEFGH23', {
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      currency: 'USD',
      tradeAllowed: true,
    });

    expect(result.connectorToken.length).toBeGreaterThan(40);
    expect(result.connectorId).toBe('connector-1');
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params).not.toContain(result.connectorToken);
    expect(String(params[1])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when a pairing code is expired, consumed, or unknown', async () => {
    const service = new DirectMt5PairingService(
      { query: jest.fn().mockResolvedValue([]) } as unknown as DataSource,
      config,
    );
    await expect(
      service.redeemPairing('ABCDEFGH23', {
        accountLogin: '1',
        brokerServer: 'Demo',
        currency: 'USD',
        tradeAllowed: true,
      }),
    ).rejects.toThrow('invalid or expired');
  });
});
