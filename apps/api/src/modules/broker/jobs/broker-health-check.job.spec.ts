/**
 * Unit tests for BrokerHealthCheckJob.
 *
 * Both `bullmq` and `@nestjs/bullmq` are mocked at the module level so that:
 *   1. No BullMQ Worker is instantiated (no Redis TCP connection).
 *   2. bullmq does not register process-level async_hooks or event handlers
 *      that prevent the Jest worker process from exiting cleanly after tests.
 */
jest.mock('bullmq', () => ({
  // Provide only what broker-health-check.job.ts uses: Job (type-only import)
  Job: class Job {},
  Worker: class Worker {
    close() {
      return Promise.resolve();
    }
  },
  Queue: class Queue {
    close() {
      return Promise.resolve();
    }
  },
}));

jest.mock('@nestjs/bullmq', () => {
  // Replace WorkerHost with a plain class so no Worker / Redis connection is
  // created during the test. The actual process() method lives on
  // BrokerHealthCheckJob itself — it is unaffected.
  class WorkerHost {
    worker: null = null;
    onApplicationBootstrap() {}
    onModuleDestroy() {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async process(_job: any): Promise<any> {
      return undefined;
    }
  }

  return {
    WorkerHost,
    // Processor decorator becomes a no-op class decorator
    Processor: () => (target: unknown) => target,
    InjectQueue: () => () => undefined,
    getQueueToken: (name: string) => `BullQueue_${name}`,
  };
});

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BrokerHealthCheckJob } from './broker-health-check.job';
import { BrokerService } from '../broker.service';
import { BrokerLinkOutboxService } from '../services/broker-link-outbox.service';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerConnectionStatus } from '../interfaces/broker-adapter.interface';
// Production-LIVE completion round (P13 metrics): the real in-process
// registry registered in the testing module so the job's lazy ModuleRef
// lookup resolves it (mirrors how MetricsModule provides it app-wide).
import { MetricsService } from '../../metrics/metrics.service';
import { METRIC_GAUGE_NAMES, METRIC_NAMES } from '../../metrics/metric-names';

const mockBrokerService = () => ({
  healthCheck: jest.fn(),
});

const mockConnectionRepo = () => ({
  find: jest.fn(),
});

describe('BrokerHealthCheckJob', () => {
  let module: TestingModule;
  let job: BrokerHealthCheckJob;
  let brokerService: ReturnType<typeof mockBrokerService>;
  let connectionRepo: ReturnType<typeof mockConnectionRepo>;
  let metrics: MetricsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    module = await Test.createTestingModule({
      providers: [
        BrokerHealthCheckJob,
        { provide: BrokerService, useFactory: mockBrokerService },
        {
          provide: getRepositoryToken(BrokerConnection),
          useFactory: mockConnectionRepo,
        },
        {
          provide: BrokerLinkOutboxService,
          useValue: {
            sweep: jest.fn().mockResolvedValue({ delivered: 0, failed: 0, deferred: 0 }),
          },
        },
        // P13 metrics: registered so the job's lazy ModuleRef seam resolves a
        // REAL registry (exactly what MetricsModule does app-wide).
        { provide: MetricsService, useValue: new MetricsService() },
      ],
    }).compile();

    job = module.get<BrokerHealthCheckJob>(BrokerHealthCheckJob);
    brokerService = module.get(BrokerService);
    connectionRepo = module.get(getRepositoryToken(BrokerConnection));
    metrics = module.get(MetricsService);
    metrics.reset();
  });

  afterEach(async () => {
    await module.close();
  });

  it('returns zero counts when no active connections exist', async () => {
    connectionRepo.find.mockResolvedValue([]);
    const result = await job.process({ id: 'job-1' } as any);
    expect(result).toEqual({ checked: 0, failed: 0 });
    expect(brokerService.healthCheck).not.toHaveBeenCalled();
  });

  it('health checks all CONNECTED connections and reports successes', async () => {
    connectionRepo.find.mockResolvedValue([
      { id: 'conn-1', brokerId: 'metatrader5', accountId: 'acc-1' },
      { id: 'conn-2', brokerId: 'metatrader5', accountId: 'acc-2' },
    ]);
    (brokerService.healthCheck as jest.Mock).mockResolvedValue(true);

    const result = await job.process({ id: 'job-2' } as any);
    expect(result.checked).toBe(2);
    expect(result.failed).toBe(0);
    expect(brokerService.healthCheck).toHaveBeenCalledTimes(2);
  });

  it('counts failed health checks correctly', async () => {
    connectionRepo.find.mockResolvedValue([
      { id: 'conn-1', brokerId: 'metatrader5', accountId: 'acc-1' },
      { id: 'conn-2', brokerId: 'metatrader5', accountId: 'acc-2' },
      { id: 'conn-3', brokerId: 'metatrader5', accountId: 'acc-3' },
    ]);
    (brokerService.healthCheck as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await job.process({ id: 'job-3' } as any);
    // checked = number of healthy connections; failed = number of unhealthy
    expect(result.checked).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('counts thrown errors as failures without crashing the job', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    connectionRepo.find.mockResolvedValue([
      { id: 'conn-1', brokerId: 'metatrader5', accountId: 'acc-1' },
    ]);
    (brokerService.healthCheck as jest.Mock).mockRejectedValue(new Error('MetaAPI error'));

    const result = await job.process({ id: 'job-4' } as any);
    expect(result.failed).toBe(1);
    expect(result.checked).toBe(0);
    jest.restoreAllMocks();
  });

  it('queries only CONNECTED status connections', async () => {
    connectionRepo.find.mockResolvedValue([]);
    await job.process({ id: 'job-5' } as any);

    expect(connectionRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: BrokerConnectionStatus.CONNECTED },
      }),
    );
  });

  // ─── P13 metrics: provider connectivity instrumentation ──────────────────

  it('P13: counts per-provider health-check outcomes (HEALTHY/UNHEALTHY/ERROR)', async () => {
    connectionRepo.find.mockResolvedValue([
      { id: 'conn-1', brokerId: 'metatrader5', accountId: 'acc-1' },
      { id: 'conn-2', brokerId: 'oanda', accountId: 'acc-2' },
      { id: 'conn-3', brokerId: 'oanda', accountId: 'acc-3' },
    ]);
    (brokerService.healthCheck as jest.Mock)
      .mockResolvedValueOnce(true) // conn-1 metatrader5 → HEALTHY
      .mockResolvedValueOnce(false) // conn-2 oanda → UNHEALTHY
      .mockRejectedValueOnce(new Error('MetaAPI error')); // conn-3 oanda → ERROR
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    await job.process({ id: 'job-metrics-1' } as any);

    const counter = (labels: Record<string, string>) =>
      metrics
        .snapshot()
        .counters.find(
          (series) =>
            series.name === METRIC_NAMES.BROKER_HEALTH_CHECKS &&
            Object.entries(labels).every(([key, value]) => series.labels[key] === value),
        )?.value;

    expect(counter({ brokerId: 'metatrader5', outcome: 'HEALTHY' })).toBe(1);
    expect(counter({ brokerId: 'oanda', outcome: 'UNHEALTHY' })).toBe(1);
    expect(counter({ brokerId: 'oanda', outcome: 'ERROR' })).toBe(1);
    expect(counter({ brokerId: 'metatrader5', outcome: 'UNHEALTHY' })).toBeUndefined();
    jest.restoreAllMocks();
  });

  it('P13: sets the last-success epoch gauge per provider only on HEALTHY checks', async () => {
    const before = Math.floor(Date.now() / 1000);
    connectionRepo.find.mockResolvedValue([
      { id: 'conn-1', brokerId: 'metatrader5', accountId: 'acc-1' },
      { id: 'conn-2', brokerId: 'oanda', accountId: 'acc-2' },
    ]);
    (brokerService.healthCheck as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    await job.process({ id: 'job-metrics-2' } as any);

    const gauges = metrics
      .snapshot()
      .gauges.filter(
        (series) => series.name === METRIC_GAUGE_NAMES.BROKER_HEALTH_LAST_SUCCESS_EPOCH_SECONDS,
      );
    expect(gauges).toHaveLength(1); // only the HEALTHY provider carries it
    expect(gauges[0].labels).toEqual({ brokerId: 'metatrader5' });
    expect(gauges[0].value).toBeGreaterThanOrEqual(before);
    jest.restoreAllMocks();
  });

  it('P13: a failed gauge/counter lookup (no MetricsService) never breaks the loop', async () => {
    // Direct construction WITHOUT the optional moduleRef — the lazy seam
    // returns null and every metrics call site no-ops.
    const bareJob = new BrokerHealthCheckJob(
      brokerService as unknown as BrokerService,
      connectionRepo as never,
      module.get(BrokerLinkOutboxService),
    );
    connectionRepo.find.mockResolvedValue([
      { id: 'conn-1', brokerId: 'metatrader5', accountId: 'acc-1' },
    ]);
    (brokerService.healthCheck as jest.Mock).mockResolvedValue(true);

    const result = await bareJob.process({ id: 'job-metrics-3' } as any);
    expect(result).toEqual({ checked: 1, failed: 0 });
    expect(metrics.snapshot().counters).toEqual([]); // nothing recorded, nothing thrown
  });
});
