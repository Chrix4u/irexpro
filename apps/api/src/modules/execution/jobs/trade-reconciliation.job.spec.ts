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
import { ReconciliationRunStatus } from '../reconciliation/reconciliation.enums';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';

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

describe('TradeReconciliationJob', () => {
  let job: TradeReconciliationJob;
  let stateReconciliation: {
    findReconcilableConnections: jest.Mock;
    runForConnection: jest.Mock;
  };

  beforeEach(async () => {
    stateReconciliation = {
      findReconcilableConnections: jest.fn().mockResolvedValue([]),
      runForConnection: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        TradeReconciliationJob,
        { provide: StateReconciliationService, useValue: stateReconciliation },
      ],
    }).compile();
    module.useLogger(false);
    job = module.get(TradeReconciliationJob);
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
});
