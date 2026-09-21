/**
 * Unit tests for TradeReconciliationJob (Sprint 50 PR-4 worker).
 *
 * Both `bullmq` and `@nestjs/bullmq` are mocked at the module level so that:
 *   1. No BullMQ Worker is instantiated (no Redis TCP connection).
 *   2. bullmq does not register process-level async_hooks or event handlers
 *      that prevent the Jest worker process from exiting cleanly.
 */
jest.mock('bullmq', () => ({
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
    Processor: () => (Class: unknown) => Class,
    InjectQueue: () => (target: object, key: string) => {
      // no-op: the queue injection is not exercised in unit tests
      void target;
      void key;
    },
  };
});

import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { TradeReconciliationJob } from './trade-reconciliation.job';
import {
  ReconciliationRunOutcome,
  StateReconciliationService,
} from '../reconciliation/state-reconciliation.service';
import {
  ProtectiveOrderReconciliationService,
  ProtectiveReconciliationOutcome,
} from '../reconciliation/protective-order-reconciliation.service';
import { ReconciliationRunStatus } from '../reconciliation/reconciliation.enums';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { ExecutionService } from '../execution.service';
// Production-LIVE completion round (P13 metrics): the real in-process
// registry registered in the testing module so the job's lazy ModuleRef
// lookup resolves it (mirrors how MetricsModule provides it app-wide).
import { MetricsService } from '../../metrics/metrics.service';
import { METRIC_NAMES } from '../../metrics/metric-names';

const makeConnection = (id: string): BrokerConnection =>
  ({ id, userId: `user-${id}`, brokerId: 'paper-broker' }) as unknown as BrokerConnection;

const makeOutcome = (
  id: string,
  overrides: Partial<ReconciliationRunOutcome> = {},
): ReconciliationRunOutcome => ({
  runId: `run-${id}`,
  brokerConnectionId: id,
  status: ReconciliationRunStatus.COMPLETED,
  discrepanciesDetected: 0,
  discrepanciesNew: 0,
  discrepanciesAutoResolved: 0,
  discrepanciesOpen: 0,
  errors: 0,
  ...overrides,
});

const fakeJob = { id: 'job-1', data: {} } as never;

const makeProtectiveOutcome = (
  overrides: Partial<ProtectiveReconciliationOutcome> = {},
): ProtectiveReconciliationOutcome => ({
  checked: 0,
  protectedCount: 0,
  repairedCount: 0,
  repairFailedCount: 0,
  skippedCount: 0,
  status: 'OK',
  ...overrides,
});

describe('TradeReconciliationJob', () => {
  let job: TradeReconciliationJob;
  let stateReconciliation: {
    findReconcilableConnections: jest.Mock;
    runForConnection: jest.Mock;
  };
  let protectiveOrderReconciliation: { reconcileProtectiveOrders: jest.Mock };
  let executionService: { closeStopRequestedAiPositions: jest.Mock };
  let metrics: MetricsService;

  beforeEach(async () => {
    stateReconciliation = {
      findReconcilableConnections: jest.fn().mockResolvedValue([]),
      runForConnection: jest.fn(),
    };
    protectiveOrderReconciliation = {
      reconcileProtectiveOrders: jest.fn().mockResolvedValue(makeProtectiveOutcome()),
    };
    executionService = {
      closeStopRequestedAiPositions: jest.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [
        TradeReconciliationJob,
        { provide: StateReconciliationService, useValue: stateReconciliation },
        {
          provide: ProtectiveOrderReconciliationService,
          useValue: protectiveOrderReconciliation,
        },
        { provide: ExecutionService, useValue: executionService },
        // P13 metrics: registered so the job's lazy ModuleRef seam resolves a
        // REAL registry (exactly what MetricsModule does app-wide).
        { provide: MetricsService, useValue: new MetricsService() },
      ],
    }).compile();
    module.useLogger(false);
    job = module.get(TradeReconciliationJob);
    metrics = module.get(MetricsService);
    metrics.reset();
    Logger.overrideLogger(false);
  });

  it('returns zero aggregates when no connections need reconciliation', async () => {
    const result = await job.process(fakeJob);
    expect(result).toEqual({
      connectionsReconciled: 0,
      discrepanciesDetected: 0,
      discrepanciesNew: 0,
      discrepanciesAutoResolved: 0,
      discrepanciesOpen: 0,
      failedConnections: 0,
      protectiveOrdersChecked: 0,
      protectiveOrdersRepaired: 0,
      protectiveRepairsFailed: 0,
    });
    expect(stateReconciliation.runForConnection).not.toHaveBeenCalled();
  });

  it('runs ONE full state reconciliation per discovered connection', async () => {
    stateReconciliation.findReconcilableConnections.mockResolvedValue([
      makeConnection('conn-1'),
      makeConnection('conn-2'),
    ]);
    stateReconciliation.runForConnection
      .mockResolvedValueOnce(
        makeOutcome('conn-1', {
          discrepanciesDetected: 2,
          discrepanciesNew: 1,
          discrepanciesOpen: 1,
        }),
      )
      .mockResolvedValueOnce(makeOutcome('conn-2', { discrepanciesAutoResolved: 3 }));

    const result = await job.process(fakeJob);

    expect(stateReconciliation.runForConnection).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      connectionsReconciled: 2,
      discrepanciesDetected: 2,
      discrepanciesNew: 1,
      discrepanciesAutoResolved: 3,
      discrepanciesOpen: 1,
      failedConnections: 0,
    });
  });

  it('counts FAILED runs without breaking the cycle', async () => {
    stateReconciliation.findReconcilableConnections.mockResolvedValue([
      makeConnection('conn-1'),
      makeConnection('conn-2'),
    ]);
    stateReconciliation.runForConnection
      .mockResolvedValueOnce(
        makeOutcome('conn-1', { status: ReconciliationRunStatus.FAILED, errors: 1 }),
      )
      .mockResolvedValueOnce(makeOutcome('conn-2'));

    const result = await job.process(fakeJob);
    expect(result.failedConnections).toBe(1);
  });

  it('survives a run that throws (the loop never breaks)', async () => {
    stateReconciliation.findReconcilableConnections.mockResolvedValue([
      makeConnection('conn-1'),
      makeConnection('conn-2'),
    ]);
    stateReconciliation.runForConnection
      .mockRejectedValueOnce(new Error('unexpected explosion'))
      .mockResolvedValueOnce(makeOutcome('conn-2'));

    const result = await job.process(fakeJob);
    expect(result.failedConnections).toBe(1);
    expect(stateReconciliation.runForConnection).toHaveBeenCalledTimes(2);
  });

  it('processes connections SEQUENTIALLY (stateful adapter model)', async () => {
    const order: string[] = [];
    stateReconciliation.findReconcilableConnections.mockResolvedValue([
      makeConnection('conn-1'),
      makeConnection('conn-2'),
    ]);
    stateReconciliation.runForConnection.mockImplementation(async (conn: BrokerConnection) => {
      order.push(`start:${conn.id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${conn.id}`);
      return makeOutcome(conn.id);
    });

    await job.process(fakeJob);
    expect(order).toEqual(['start:conn-1', 'end:conn-1', 'start:conn-2', 'end:conn-2']);
  });

  // ─── Round 6 §8: the protective-order loop ─────────────────────────────

  it('runs the protective-order loop AFTER each connection state sweep', async () => {
    const order: string[] = [];
    stateReconciliation.findReconcilableConnections.mockResolvedValue([makeConnection('conn-1')]);
    stateReconciliation.runForConnection.mockImplementation(async () => {
      order.push('state-sweep');
      return makeOutcome('conn-1');
    });
    protectiveOrderReconciliation.reconcileProtectiveOrders.mockImplementation(async () => {
      order.push('protective-loop');
      return makeProtectiveOutcome();
    });

    await job.process(fakeJob);
    expect(order).toEqual(['state-sweep', 'protective-loop']);
    expect(executionService.closeStopRequestedAiPositions).toHaveBeenCalledWith(
      'user-conn-1',
      'conn-1',
    );
    expect(protectiveOrderReconciliation.reconcileProtectiveOrders).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1' }),
    );
  });

  it('continues a durable user-stop flatten after the provider state sweep', async () => {
    const order: string[] = [];
    stateReconciliation.findReconcilableConnections.mockResolvedValue([makeConnection('conn-1')]);
    stateReconciliation.runForConnection.mockImplementation(async () => {
      order.push('state-sweep');
      return makeOutcome('conn-1');
    });
    executionService.closeStopRequestedAiPositions.mockImplementation(async () => {
      order.push('stop-flatten');
      return [];
    });
    protectiveOrderReconciliation.reconcileProtectiveOrders.mockImplementation(async () => {
      order.push('protective-loop');
      return makeProtectiveOutcome();
    });

    await job.process(fakeJob);

    expect(order).toEqual(['state-sweep', 'stop-flatten', 'protective-loop']);
  });

  it('aggregates protective-order counts across connections', async () => {
    stateReconciliation.findReconcilableConnections.mockResolvedValue([
      makeConnection('conn-1'),
      makeConnection('conn-2'),
    ]);
    protectiveOrderReconciliation.reconcileProtectiveOrders
      .mockResolvedValueOnce(
        makeProtectiveOutcome({ checked: 3, repairedCount: 1, repairFailedCount: 1 }),
      )
      .mockResolvedValueOnce(makeProtectiveOutcome({ checked: 2, repairedCount: 2 }));

    const result = await job.process(fakeJob);
    expect(result).toMatchObject({
      protectiveOrdersChecked: 5,
      protectiveOrdersRepaired: 3,
      protectiveRepairsFailed: 1,
    });
  });

  it('survives a protective-loop throw (the cycle never breaks)', async () => {
    stateReconciliation.findReconcilableConnections.mockResolvedValue([
      makeConnection('conn-1'),
      makeConnection('conn-2'),
    ]);
    protectiveOrderReconciliation.reconcileProtectiveOrders
      .mockRejectedValueOnce(new Error('protective explosion'))
      .mockResolvedValueOnce(makeProtectiveOutcome({ checked: 1 }));

    const result = await job.process(fakeJob);
    expect(result.protectiveOrdersChecked).toBe(1);
    expect(protectiveOrderReconciliation.reconcileProtectiveOrders).toHaveBeenCalledTimes(2);
  });

  // ─── P13 metrics: reconciliation cycle instrumentation ────────────────────

  it('P13: counts ONE reconciliation_cycles increment per completed cycle (with connections)', async () => {
    stateReconciliation.findReconcilableConnections.mockResolvedValue([
      makeConnection('conn-1'),
      makeConnection('conn-2'),
    ]);
    stateReconciliation.runForConnection.mockResolvedValue(makeOutcome('conn-1'));

    await job.process(fakeJob);

    const cycles = metrics
      .snapshot()
      .counters.find((series) => series.name === METRIC_NAMES.RECONCILIATION_CYCLES);
    expect(cycles?.value).toBe(1);
    expect(cycles?.labels).toEqual({});
  });

  it('P13: a no-connections tick is still a completed cycle (sweep liveness)', async () => {
    stateReconciliation.findReconcilableConnections.mockResolvedValue([]);

    await job.process(fakeJob);

    const cycles = metrics
      .snapshot()
      .counters.find((series) => series.name === METRIC_NAMES.RECONCILIATION_CYCLES);
    expect(cycles?.value).toBe(1);
  });

  it('P13: cycles accumulate across successive jobs and per-run discrepancies are NOT double-counted here', async () => {
    stateReconciliation.findReconcilableConnections.mockResolvedValue([makeConnection('conn-1')]);
    stateReconciliation.runForConnection.mockResolvedValue(
      makeOutcome('conn-1', { discrepanciesDetected: 2, discrepanciesNew: 1 }),
    );

    await job.process(fakeJob);
    await job.process(fakeJob);

    const cycles = metrics
      .snapshot()
      .counters.find((series) => series.name === METRIC_NAMES.RECONCILIATION_CYCLES);
    expect(cycles?.value).toBe(2);
    // The job never increments the discrepancy counter — the per-run
    // instrumentation lives in StateReconciliationService itself.
    expect(
      metrics
        .snapshot()
        .counters.find((series) => series.name === METRIC_NAMES.RECONCILIATION_DISCREPANCIES),
    ).toBeUndefined();
  });
});
