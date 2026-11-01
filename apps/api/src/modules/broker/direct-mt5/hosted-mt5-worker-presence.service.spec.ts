import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { HostedMt5WorkerPresenceService } from './hosted-mt5-worker-presence.service';

describe('HostedMt5WorkerPresenceService', () => {
  it('upserts only non-secret readiness/capacity metadata and reports spare capacity', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new HostedMt5WorkerPresenceService({ query } as unknown as DataSource);

    await service.heartbeat('mt5-win-01', {
      workerVersion: '0.4.0',
      runtimeReady: true,
      maxSessions: 4,
      activeSessions: 1,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]![0])).toContain('broker.hosted_mt5_workers');
    expect(query.mock.calls[0]![1]).toEqual(['mt5-win-01', '0.4.0', true, 4, 1]);
    expect(service.getPoolReadiness()).toMatchObject({
      ready: true,
      freshWorkers: 1,
      availableWorkers: 1,
      totalSpareSessions: 3,
    });
  });

  it('distinguishes no fresh worker from a fresh but full pool', async () => {
    const service = new HostedMt5WorkerPresenceService({ query: jest.fn().mockResolvedValue([]) } as any);

    expect(service.getPoolReadiness()).toMatchObject({ ready: false, reason: 'NO_FRESH_WORKER' });

    await service.heartbeat('mt5-win-full', {
      workerVersion: '0.4.0',
      runtimeReady: true,
      maxSessions: 2,
      activeSessions: 2,
    });
    expect(service.getPoolReadiness()).toMatchObject({
      ready: false,
      reason: 'NO_CAPACITY',
      freshWorkers: 1,
      availableWorkers: 0,
    });
  });

  it('hydrates only fresh worker rows and fails closed when the persisted worker is stale', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        worker_id: 'mt5-win-stale',
        worker_version: '0.4.0',
        runtime_ready: true,
        max_sessions: 4,
        active_sessions: 0,
        last_seen_at: new Date(Date.now() - 120_000),
      },
    ]);
    const service = new HostedMt5WorkerPresenceService({ query } as unknown as DataSource);

    await service.refreshFromDatabase();

    expect(service.getPoolReadiness()).toMatchObject({ ready: false, reason: 'NO_FRESH_WORKER' });
    expect(String(query.mock.calls[0]![0])).toContain('broker.hosted_mt5_workers');
  });

  it('rejects impossible capacity before touching the database', async () => {
    const query = jest.fn();
    const service = new HostedMt5WorkerPresenceService({ query } as unknown as DataSource);

    await expect(
      service.heartbeat('mt5-win-01', {
        workerVersion: '0.4.0',
        runtimeReady: true,
        maxSessions: 2,
        activeSessions: 3,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});
