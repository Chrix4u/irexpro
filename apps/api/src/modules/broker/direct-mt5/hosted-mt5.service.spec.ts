import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { HostedMt5Service } from './hosted-mt5.service';

const WORKER_TOKEN = 'hosted-worker-token-0123456789abcdef';

function config(options: { enabled?: boolean; workerToken?: string } = {}): ConfigService {
  const enabled = options.enabled ?? true;
  const workerToken = options.workerToken ?? WORKER_TOKEN;
  return {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'broker.hostedMt5Enabled') return enabled;
      if (key === 'broker.hostedMt5WorkerToken' || key === 'HOSTED_MT5_WORKER_TOKEN') {
        return workerToken;
      }
      return fallback;
    }),
  } as unknown as ConfigService;
}

const demoConnection = {
  id: 'connection-1',
  user_id: 'user-1',
  broker_id: 'direct-mt5',
  account_id: '113392789',
  account_type: 'DEMO',
  encrypted_credentials: 'ciphertext',
  credential_iv: 'iv',
  credential_tag: 'tag',
  encryption_key_id: 'key-1',
};

const decrypted = {
  accountId: '113392789',
  apiSecret: 'demo-trading-password',
  additionalParams: { brokerServer: 'Broker-Demo', connectionMethod: 'IREXPRO_HOSTED' },
};

describe('HostedMt5Service', () => {
  it('fails closed before database access when hosted execution is not explicitly enabled', async () => {
    const query = jest.fn();
    const dataSource = { query, transaction: jest.fn() } as unknown as DataSource;
    const service = new HostedMt5Service(
      dataSource,
      { decrypt: jest.fn() } as any,
      { digestToken: jest.fn() } as any,
      config({ enabled: false }),
    );

    await expect(service.provision('user-1', 'connection-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.leaseAssignment('worker-1', WORKER_TOKEN)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(query).not.toHaveBeenCalled();
    expect((dataSource as any).transaction).not.toHaveBeenCalled();
  });

  it('provisions an owned DEMO Direct MT5 connection without returning or persisting plaintext secrets', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([demoConnection])
      .mockResolvedValueOnce([{ id: 'connector-1' }])
      .mockResolvedValueOnce([]);
    const encryption = { decrypt: jest.fn().mockReturnValue({ ...decrypted }) } as any;
    const pairing = { digestToken: jest.fn() } as any;
    const service = new HostedMt5Service(
      { query } as unknown as DataSource,
      encryption,
      pairing,
      config(),
    );

    const result = await service.provision('user-1', 'connection-1');

    expect(result).toEqual({
      brokerConnectionId: 'connection-1',
      connectorId: 'connector-1',
      hostMode: 'IREXPRO_HOSTED',
      state: 'PAIRING',
    });
    expect(JSON.stringify(result)).not.toContain('demo-trading-password');
    const allSqlParams = query.mock.calls.flatMap((call) =>
      Array.isArray(call[1]) ? call[1] : [],
    );
    expect(allSqlParams).not.toContain('demo-trading-password');
    expect(String(query.mock.calls[1]![0])).toContain("'IREXPRO_HOSTED'");
    expect(String(query.mock.calls[1]![0])).toContain("state = 'UNCERTAIN'");
    expect(String(query.mock.calls[2]![0])).toContain("status='CONNECTING'");
  });

  it('is idempotent when the same hosted connection already has a healthy active worker session', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        ...demoConnection,
        hosted_connector_id: 'connector-healthy',
        hosted_state: 'ACTIVE',
        hosted_healthy: true,
      },
    ]);
    const encryption = { decrypt: jest.fn() } as any;
    const service = new HostedMt5Service(
      { query } as unknown as DataSource,
      encryption,
      { digestToken: jest.fn() } as any,
      config(),
    );

    await expect(service.provision('user-1', 'connection-1')).resolves.toEqual({
      brokerConnectionId: 'connection-1',
      connectorId: 'connector-healthy',
      hostMode: 'IREXPRO_HOSTED',
      state: 'ACTIVE',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(String(query.mock.calls[0]![0])).toContain(
      "last_heartbeat_at >= now() - interval '15 seconds'",
    );
  });

  it('rejects hosted LIVE during the pilot before creating a connector', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ ...demoConnection, account_type: 'LIVE' }]);
    const encryption = { decrypt: jest.fn() } as any;
    const service = new HostedMt5Service(
      { query } as unknown as DataSource,
      encryption,
      { digestToken: jest.fn() } as any,
      config(),
    );

    await expect(service.provision('user-1', 'connection-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the encrypted hosted credentials do not contain both password and broker server', async () => {
    const query = jest.fn().mockResolvedValueOnce([demoConnection]);
    const encryption = {
      decrypt: jest
        .fn()
        .mockReturnValue({ accountId: '113392789', apiSecret: '', additionalParams: {} }),
    } as any;
    const service = new HostedMt5Service(
      { query } as unknown as DataSource,
      encryption,
      { digestToken: jest.fn() } as any,
      config(),
    );

    await expect(service.provision('user-1', 'connection-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('authenticates the infrastructure worker and atomically leases a hosted assignment with token rotation', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          {
            ...demoConnection,
            connector_id: 'connector-1',
            broker_server: 'Broker-Demo',
            connector_state: 'PAIRING',
          },
        ])
        .mockResolvedValueOnce([]),
    };
    const dataSource = {
      transaction: jest.fn(async (fn: (tx: any) => unknown) => fn(manager)),
    } as unknown as DataSource;
    const encryption = { decrypt: jest.fn().mockReturnValue({ ...decrypted }) } as any;
    const pairing = { digestToken: jest.fn().mockReturnValue('a'.repeat(64)) } as any;
    const service = new HostedMt5Service(dataSource, encryption, pairing, config());

    const assignment = await service.leaseAssignment('worker-accra-1', WORKER_TOKEN);

    expect(assignment).toMatchObject({
      connectorId: 'connector-1',
      brokerConnectionId: 'connection-1',
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      accountType: 'DEMO',
      tradingPassword: 'demo-trading-password',
    });
    expect(assignment?.connectorToken.length).toBeGreaterThan(40);
    expect(String(manager.query.mock.calls[0]![0])).toContain('FOR UPDATE OF c SKIP LOCKED');
    expect(String(manager.query.mock.calls[0]![0])).toContain('host_lease_expires_at');
    const updateParams = manager.query.mock.calls[1]![1] as unknown[];
    expect(updateParams).toContain('a'.repeat(64));
    expect(updateParams).not.toContain(assignment?.connectorToken);
    expect(updateParams).not.toContain('demo-trading-password');
  });

  it('rejects a wrong worker token before touching the database', async () => {
    const dataSource = { transaction: jest.fn() } as unknown as DataSource;
    const service = new HostedMt5Service(
      dataSource,
      { decrypt: jest.fn() } as any,
      { digestToken: jest.fn() } as any,
      config(),
    );

    await expect(service.leaseAssignment('worker-1', 'wrong-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect((dataSource as any).transaction).not.toHaveBeenCalled();
  });

  it('renews a worker lease only for the exact hosted connector owner and stores only a bounded error code', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'connector-1' }]);
    const service = new HostedMt5Service(
      { query } as unknown as DataSource,
      { decrypt: jest.fn() } as any,
      { digestToken: jest.fn() } as any,
      config(),
    );

    await expect(
      service.heartbeatAssignment('connector-1', 'worker-1', WORKER_TOKEN, 'MT5_RECONNECTING'),
    ).resolves.toEqual({ connectorId: 'connector-1', renewed: true });

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("host_mode = 'IREXPRO_HOSTED'");
    expect(sql).toContain('host_worker_id = $2');
    expect(query.mock.calls[0]![1]).toContain('MT5_RECONNECTING');

    await expect(
      service.heartbeatAssignment('connector-1', 'worker-1', WORKER_TOKEN, 'password=oops'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
