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
        },
      ]);
    const service = new DirectMt5CommandService({ query } as unknown as DataSource);

    const leased = await service.leaseNext('connector-1');

    expect(String(query.mock.calls[0]![0])).toContain("state = 'UNCERTAIN'");
    expect(String(query.mock.calls[1]![0])).toContain('FOR UPDATE OF cmd SKIP LOCKED');
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
