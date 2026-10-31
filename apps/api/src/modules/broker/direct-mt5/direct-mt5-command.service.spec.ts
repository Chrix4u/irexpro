import type { DataSource } from 'typeorm';
import { DirectMt5CommandService } from './direct-mt5-command.service';

describe('DirectMt5CommandService', () => {
  it('returns the existing command for a duplicate idempotency key', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'cmd-existing',
          connector_id: 'connector-1',
          broker_connection_id: 'connection-1',
          idempotency_key: 'intent-1',
          command_type: 'PLACE_ORDER',
          payload: { symbol: 'EURUSD' },
          state: 'PENDING',
        },
      ]);
    const service = new DirectMt5CommandService({ query } as unknown as DataSource);

    const result = await service.enqueue({
      connectorId: 'connector-1',
      brokerConnectionId: 'connection-1',
      idempotencyKey: 'intent-1',
      commandType: 'PLACE_ORDER',
      payload: { symbol: 'EURUSD' },
    });

    expect(result.id).toBe('cmd-existing');
    expect(query).toHaveBeenCalledTimes(2);
    const enqueueSql = String(query.mock.calls[0]![0]);
    expect(enqueueSql).toContain('broker.broker_connections');
    expect(enqueueSql).toContain('c.account_type = bc.account_type');
    expect(enqueueSql).toContain('c.account_login = bc.account_id');
  });

  it('rejects idempotency-key reuse with different command semantics', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'cmd-existing',
          connector_id: 'connector-1',
          broker_connection_id: 'connection-1',
          idempotency_key: 'intent-1',
          command_type: 'PLACE_ORDER',
          payload: { symbol: 'GBPUSD' },
          state: 'PENDING',
        },
      ]);
    const service = new DirectMt5CommandService({ query } as unknown as DataSource);

    await expect(
      service.enqueue({
        connectorId: 'connector-1',
        brokerConnectionId: 'connection-1',
        idempotencyKey: 'intent-1',
        commandType: 'PLACE_ORDER',
        payload: { symbol: 'EURUSD' },
      }),
    ).rejects.toThrow('idempotency');
  });

  it('marks expired leases uncertain before leasing one exact-connector command', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'cmd-1',
          connector_id: 'connector-1',
          broker_connection_id: 'connection-1',
          idempotency_key: 'intent-1',
          command_type: 'GET_PRICE',
          payload: { symbol: 'EURUSD' },
          created_at: new Date('2026-10-24T18:00:00.000Z'),
          lease_expires_at: new Date('2026-10-24T18:00:30.000Z'),
          account_login: '113392789',
          broker_server: 'Broker-Demo',
          account_type: 'DEMO',
        },
      ]);
    const service = new DirectMt5CommandService({ query } as unknown as DataSource);

    const leased = await service.leaseNext('connector-1');

    const cleanupSql = String(query.mock.calls[0]![0]);
    const leaseSql = String(query.mock.calls[1]![0]);
    expect(cleanupSql).toContain("state = 'UNCERTAIN'");
    expect(cleanupSql).toContain("command_type = 'PLACE_ORDER'");
    expect(cleanupSql).toContain("state = 'CANCELLED'");
    expect(leaseSql).toContain('FOR UPDATE OF cmd SKIP LOCKED');
    expect(leaseSql).toContain("last_heartbeat_at >= now() - interval '15 seconds'");
    expect(leaseSql).toContain("cmd.command_type <> 'PLACE_ORDER'");
    expect(leaseSql).toContain('c.trade_allowed = true');
    expect(leaseSql).toContain('broker.broker_connections');
    expect(leaseSql).toContain('c.account_type = bc.account_type');
    expect(leaseSql).toContain('c.account_login = bc.account_id');
    expect(leaseSql).toContain("bc.authorization_status = 'ACTIVE'");
    expect(leaseSql).toContain('bc.live_trading_enabled = true');
    expect(query.mock.calls[1]![1]).toEqual(['connector-1']);
    expect(leased).toMatchObject({ commandId: 'cmd-1', connectorId: 'connector-1' });
  });

  it('returns null rather than leasing another connector command', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const service = new DirectMt5CommandService({ query } as unknown as DataSource);
    await expect(service.leaseNext('connector-1')).resolves.toBeNull();
  });

  it('accepts terminal results only for the exact connector and command', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'cmd-1', state: 'SUCCEEDED' }]);
    const service = new DirectMt5CommandService({ query } as unknown as DataSource);

    await expect(
      service.recordResult('connector-1', 'cmd-1', {
        state: 'SUCCEEDED',
        result: { ticket: '1001' },
        error: null,
      }),
    ).resolves.toMatchObject({ id: 'cmd-1', state: 'SUCCEEDED' });
    expect(query.mock.calls[0]![1]?.slice(0, 2)).toEqual(['connector-1', 'cmd-1']);
  });
});


  it('returns the MT5-observed account environment only when it matches the BrokerConnection environment', async () => {
    const query = jest.fn().mockResolvedValueOnce([{
      id: 'connector-live', account_login: '12345', broker_server: 'Broker-Live', currency: 'USD',
      trade_allowed: true, account_type: 'LIVE',
    }]);
    const service = new DirectMt5CommandService({ query } as unknown as DataSource);
    await expect(service.getActiveConnectorForConnection('connection-live')).resolves.toMatchObject({
      connectorId: 'connector-live', accountType: 'LIVE', tradeAllowed: true,
    });
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('broker.broker_connections');
    expect(sql).toContain('c.account_type = bc.account_type');
    expect(sql).toContain('c.account_login = bc.account_id');
  });
