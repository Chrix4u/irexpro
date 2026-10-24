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

  it('authenticates a connector token without comparing raw secrets in SQL', async () => {
    const query = jest.fn();
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);
    const token = 'connector-secret-token';
    query.mockResolvedValueOnce([
      {
        id: 'connector-1',
        user_id: 'user-1',
        broker_connection_id: 'connection-1',
        token_hash: service.digestToken(token),
        account_login: '113392789',
        broker_server: 'Broker-Demo',
        last_sequence: '7',
      },
    ]);

    await expect(service.authenticateConnector('connector-1', token)).resolves.toMatchObject({
      connectorId: 'connector-1',
      brokerConnectionId: 'connection-1',
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      lastSequence: 7,
    });
    expect(query.mock.calls[0]![1]).toEqual(['connector-1']);
  });

  it('rejects a wrong connector token', async () => {
    const query = jest.fn();
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);
    query.mockResolvedValueOnce([
      {
        id: 'connector-1',
        user_id: 'user-1',
        broker_connection_id: 'connection-1',
        token_hash: service.digestToken('right-token'),
        account_login: '113392789',
        broker_server: 'Broker-Demo',
        last_sequence: '0',
      },
    ]);
    await expect(service.authenticateConnector('connector-1', 'wrong-token')).rejects.toThrow(
      'authentication',
    );
  });

  it('accepts only monotonic heartbeats from the paired MT5 account', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'connector-1', last_sequence: '8' }]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);
    const binding = {
      connectorId: 'connector-1',
      userId: 'user-1',
      brokerConnectionId: 'connection-1',
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      lastSequence: 7,
    };

    await expect(
      service.recordHeartbeat(binding, {
        accountLogin: '113392789',
        brokerServer: 'Broker-Demo',
        sequence: 8,
        tradeAllowed: true,
      }),
    ).resolves.toMatchObject({ lastSequence: 8 });
  });

  it('suspends a connector when the terminal account identity changes', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);
    const binding = {
      connectorId: 'connector-1',
      userId: 'user-1',
      brokerConnectionId: 'connection-1',
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      lastSequence: 7,
    };

    await expect(
      service.recordHeartbeat(binding, {
        accountLogin: '999999',
        brokerServer: 'Other-Server',
        sequence: 8,
        tradeAllowed: true,
      }),
    ).rejects.toThrow('identity changed');
    expect(String(query.mock.calls[0]![0])).toContain("state = 'SUSPENDED'");
  });

});
