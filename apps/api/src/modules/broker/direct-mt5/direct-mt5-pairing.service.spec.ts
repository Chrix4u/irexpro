import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { DirectMt5PairingService } from './direct-mt5-pairing.service';

describe('DirectMt5PairingService', () => {
  const config = {
    get: jest.fn().mockReturnValue('0123456789abcdef0123456789abcdef'),
  } as unknown as ConfigService;

  it('creates a single-use pairing code without persisting the raw code', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'connection-1', broker_id: 'metatrader5-native', account_type: 'DEMO' },
      ])
      .mockResolvedValueOnce([]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);

    const result = await service.createPairing('user-1', 'connection-1');

    expect(result.pairingCode).toMatch(/^[A-Z2-9]{10}$/);
    expect(result.connectorId).toMatch(/^[0-9a-f-]{36}$/);
    const pairingSql = String(query.mock.calls[1]![0]);
    const insertParams = query.mock.calls[1]![1] as unknown[];
    expect(insertParams).not.toContain(result.pairingCode);
    expect(String(insertParams[3])).toMatch(/^[0-9a-f]{64}$/);
    expect(pairingSql).toContain("state = 'CANCELLED'");
    expect(pairingSql).toContain("state = 'UNCERTAIN'");
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

  it('refuses to attach the native connector to a legacy MetaApi-backed MT5 connection', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'connection-cloud', broker_id: 'metatrader5', account_type: 'DEMO' },
      ]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);

    await expect(service.createPairing('user-1', 'connection-cloud')).rejects.toThrow(
      'Native Bridge',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects Direct MT5 pairing for a LIVE BrokerConnection', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'connection-live', broker_id: 'metatrader5-native', account_type: 'LIVE' },
      ]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);

    await expect(service.createPairing('user-1', 'connection-live')).rejects.toThrow('DEMO');
    expect(query).toHaveBeenCalledTimes(1);
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
      company: 'Broker Ltd',
      environment: 'DEMO',
      currency: 'USD',
      leverage: 100,
      marginMode: 'HEDGING',
      terminalConnected: true,
      terminalTradeAllowed: true,
      accountTradeAllowed: true,
      eaTradingAllowed: true,
      tradeAllowed: true,
    });

    expect(result.connectorToken.length).toBeGreaterThan(40);
    expect(result.connectorId).toBe('connector-1');
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params).not.toContain(result.connectorToken);
    expect(String(params[1])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not activate a pairing when the terminal login differs from the BrokerConnection account', async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      // Current implementation updates the connector without consulting the
      // BrokerConnection. The corrected implementation must join/fence the
      // expected account id, which makes this mismatched terminal return no row.
      if (sql.includes('broker.broker_connections')) return [];
      return [
        {
          id: 'connector-1',
          broker_connection_id: 'connection-1',
          user_id: 'user-1',
        },
      ];
    });
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);

    await expect(
      service.redeemPairing('ABCDEFGH23', {
        accountLogin: '999999999',
        brokerServer: 'Broker-Demo',
        company: 'Broker Ltd',
        environment: 'DEMO',
        currency: 'USD',
        leverage: 100,
        marginMode: 'HEDGING',
        terminalConnected: true,
        terminalTradeAllowed: true,
        accountTradeAllowed: true,
        eaTradingAllowed: true,
        tradeAllowed: true,
      }),
    ).rejects.toThrow('account');

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('broker.broker_connections');
    expect(sql).toContain('bc.account_id = $3');
  });

  it('rejects a LIVE terminal identity before issuing a native connector token', async () => {
    const service = new DirectMt5PairingService(
      { query: jest.fn() } as unknown as DataSource,
      config,
    );

    await expect(
      service.redeemPairing('ABCDEFGH23', {
        accountLogin: '113392789',
        brokerServer: 'Broker-Live',
        company: 'Broker Ltd',
        environment: 'LIVE',
        currency: 'USD',
        leverage: 100,
        marginMode: 'HEDGING',
        terminalConnected: true,
        terminalTradeAllowed: true,
        accountTradeAllowed: true,
        eaTradingAllowed: true,
        tradeAllowed: true,
      }),
    ).rejects.toThrow('DEMO');
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
        company: 'Broker Ltd',
        environment: 'DEMO',
        currency: 'USD',
        leverage: 100,
        marginMode: 'HEDGING',
        terminalConnected: true,
        terminalTradeAllowed: true,
        accountTradeAllowed: true,
        eaTradingAllowed: true,
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

  it('fails closed when an ACTIVE connector heartbeat is stale', async () => {
    const now = new Date('2026-10-24T19:00:00.000Z');
    const query = jest.fn().mockResolvedValueOnce([
      {
        id: 'connector-1',
        state: 'ACTIVE',
        account_login: '113392789',
        broker_server: 'Broker-Demo',
        trade_allowed: true,
        last_heartbeat_at: new Date(now.getTime() - 16_000),
      },
    ]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);

    await expect(service.getConnectionHealth('user-1', 'connection-1', now)).resolves.toMatchObject(
      {
        connectorId: 'connector-1',
        state: 'ACTIVE',
        connected: false,
        executionReady: false,
        reason: 'HEARTBEAT_STALE',
      },
    );
  });

  it('reports a fresh trading-enabled connector as execution ready', async () => {
    const now = new Date('2026-10-24T19:00:00.000Z');
    const query = jest.fn().mockResolvedValueOnce([
      {
        id: 'connector-1',
        state: 'ACTIVE',
        account_login: '113392789',
        broker_server: 'Broker-Demo',
        trade_allowed: true,
        last_heartbeat_at: new Date(now.getTime() - 2_000),
      },
    ]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);

    await expect(service.getConnectionHealth('user-1', 'connection-1', now)).resolves.toMatchObject(
      {
        connected: true,
        executionReady: true,
        reason: 'READY',
      },
    );
  });

  it('revokes the connector token and neutralizes pending or leased commands', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'connector-1' }]);
    const service = new DirectMt5PairingService({ query } as unknown as DataSource, config);

    await expect(service.revokeConnector('user-1', 'connection-1')).resolves.toEqual({
      connectorId: 'connector-1',
      revoked: true,
    });

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("state = 'REVOKED'");
    expect(sql).toContain('token_hash = NULL');
    expect(sql).toContain("state = 'CANCELLED'");
    expect(sql).toContain("state = 'UNCERTAIN'");
    expect(query.mock.calls[0]![1]).toEqual(['user-1', 'connection-1']);
  });
});
