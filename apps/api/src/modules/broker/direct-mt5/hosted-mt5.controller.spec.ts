import { UnauthorizedException } from '@nestjs/common';
import { HostedMt5Controller, HostedMt5WorkerController } from './hosted-mt5.controller';

describe('Hosted MT5 controllers', () => {
  it('provisions only through the authenticated owner identity', async () => {
    const hosted = {
      provision: jest.fn().mockResolvedValue({
        brokerConnectionId: 'connection-1',
        connectorId: 'connector-1',
        hostMode: 'IREXPRO_HOSTED',
        state: 'PAIRING',
      }),
    } as any;
    const controller = new HostedMt5Controller(hosted);

    await expect(controller.provision('user-1', 'connection-1')).resolves.toMatchObject({
      hostMode: 'IREXPRO_HOSTED',
    });
    expect(hosted.provision).toHaveBeenCalledWith('user-1', 'connection-1');
  });

  it('requires a worker bearer token before leasing infrastructure work', async () => {
    const hosted = { leaseAssignment: jest.fn() } as any;
    const controller = new HostedMt5WorkerController(hosted);

    await expect(
      controller.lease(undefined, { workerId: 'worker-accra-1' } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(hosted.leaseAssignment).not.toHaveBeenCalled();
  });

  it('passes only the bearer token and worker id to the lease service', async () => {
    const hosted = {
      leaseAssignment: jest.fn().mockResolvedValue({
        connectorId: 'connector-1',
        tradingPassword: 'secret-infrastructure-only',
      }),
    } as any;
    const controller = new HostedMt5WorkerController(hosted);

    await expect(
      controller.lease('Bearer infrastructure-token', { workerId: 'worker-accra-1' } as any),
    ).resolves.toMatchObject({ connectorId: 'connector-1' });
    expect(hosted.leaseAssignment).toHaveBeenCalledWith('worker-accra-1', 'infrastructure-token');
  });

  it('renews the exact worker assignment with a bounded status code', async () => {
    const hosted = {
      heartbeatAssignment: jest
        .fn()
        .mockResolvedValue({ connectorId: 'connector-1', renewed: true }),
    } as any;
    const controller = new HostedMt5WorkerController(hosted);

    await expect(
      controller.heartbeat('connector-1', 'Bearer infrastructure-token', {
        workerId: 'worker-accra-1',
        errorCode: 'MT5_RECONNECTING',
      } as any),
    ).resolves.toEqual({ connectorId: 'connector-1', renewed: true });
    expect(hosted.heartbeatAssignment).toHaveBeenCalledWith(
      'connector-1',
      'worker-accra-1',
      'infrastructure-token',
      'MT5_RECONNECTING',
    );
  });

  it('accepts a non-secret worker presence heartbeat through infrastructure auth', async () => {
    const hosted = {
      heartbeatWorkerPresence: jest
        .fn()
        .mockResolvedValue({ workerId: 'mt5-win-01', accepted: true }),
    } as any;
    const controller = new HostedMt5WorkerController(hosted);

    await expect(
      controller.presence('Bearer infrastructure-token', {
        workerId: 'mt5-win-01',
        workerVersion: '0.4.0',
        runtimeReady: true,
        maxSessions: 4,
        activeSessions: 1,
      } as any),
    ).resolves.toEqual({ workerId: 'mt5-win-01', accepted: true });
    expect(hosted.heartbeatWorkerPresence).toHaveBeenCalledWith(
      'mt5-win-01',
      'infrastructure-token',
      { workerVersion: '0.4.0', runtimeReady: true, maxSessions: 4, activeSessions: 1 },
    );
  });
});
