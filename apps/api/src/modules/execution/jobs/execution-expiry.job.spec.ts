import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
import { ExecutionExpiryJob } from './execution-expiry.job';
import { EmergencyFlattenJob } from './emergency-flatten.job';
import type { TradeIntentService } from '../services/trade-intent.service';
import type { AllocationService } from '../services/allocation.service';
import type { RiskGrantService } from '../../risk/risk-grant.service';
import type { ExecutionService } from '../execution.service';

/**
 * Round 7 (P1) — the expiry-hygiene sweeper + the durable emergency-flatten
 * worker, exercised at the service seams:
 *
 *   - the sweeper expires stale intents, releases their capital
 *     reservations, and expires stale confirmations — a per-item release
 *     failure never breaks the sweep
 *   - the flatten worker drives the SAME idempotent close path and reports
 *     the honest closed/failed summary
 */

describe('ExecutionExpiryJob (Round 7 P1 expiry hygiene)', () => {
  let job: ExecutionExpiryJob;
  let tradeIntents: { expireStaleCreatedIntents: jest.Mock };
  let allocationService: { releaseAllocationForIntent: jest.Mock };
  let riskGrantService: { expireStalePendingConfirmations: jest.Mock };

  const fakeJob = { id: 'job-1' } as unknown as Job;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    tradeIntents = { expireStaleCreatedIntents: jest.fn().mockResolvedValue(['i1', 'i2']) };
    allocationService = { releaseAllocationForIntent: jest.fn().mockResolvedValue(undefined) };
    riskGrantService = { expireStalePendingConfirmations: jest.fn().mockResolvedValue(3) };

    job = new ExecutionExpiryJob(
      tradeIntents as unknown as TradeIntentService,
      allocationService as unknown as AllocationService,
      riskGrantService as unknown as RiskGrantService,
      // Round 7 (P1 metrics): the lazy MetricsService ModuleRef seam — the
      // stub's get() returns undefined, so every metrics call site no-ops.
      { get: jest.fn() } as unknown as ModuleRef,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('expires stale intents, releases EACH capital reservation, and expires stale confirmations', async () => {
    const result = await job.process(fakeJob);

    expect(tradeIntents.expireStaleCreatedIntents).toHaveBeenCalledTimes(1);
    expect(allocationService.releaseAllocationForIntent).toHaveBeenCalledTimes(2);
    expect(allocationService.releaseAllocationForIntent).toHaveBeenCalledWith(
      'i1',
      'INTENT_EXPIRED',
    );
    expect(allocationService.releaseAllocationForIntent).toHaveBeenCalledWith(
      'i2',
      'INTENT_EXPIRED',
    );
    expect(riskGrantService.expireStalePendingConfirmations).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ expiredIntents: 2, releasedAllocations: 2, expiredConfirmations: 3 });
  });

  it('a per-intent allocation-release failure never breaks the sweep (the aggregate self-heals)', async () => {
    allocationService.releaseAllocationForIntent
      .mockRejectedValueOnce(new Error('allocation store unavailable'))
      .mockResolvedValue(undefined);

    const result = await job.process(fakeJob);

    expect(result).toEqual({ expiredIntents: 2, releasedAllocations: 1, expiredConfirmations: 3 });
  });

  it('a no-op sweep (nothing stale) reports zeros', async () => {
    tradeIntents.expireStaleCreatedIntents.mockResolvedValue([]);
    riskGrantService.expireStalePendingConfirmations.mockResolvedValue(0);

    const result = await job.process(fakeJob);
    expect(result).toEqual({ expiredIntents: 0, releasedAllocations: 0, expiredConfirmations: 0 });
    expect(allocationService.releaseAllocationForIntent).not.toHaveBeenCalled();
  });
});

describe('EmergencyFlattenJob (Round 7 P1 durable flatten worker)', () => {
  let job: EmergencyFlattenJob;
  let executionService: { emergencyCloseAllOpenPositions: jest.Mock };

  const fakeJob = {
    id: 'flatten-job-1',
    attemptsMade: 0,
    data: { userId: 'user-1', reason: 'KILL_SWITCH_ACTIVATE' },
  } as unknown as Job<{ userId: string; reason: string }>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    executionService = {
      emergencyCloseAllOpenPositions: jest.fn().mockResolvedValue([
        { tradeId: 't1', closed: true, status: 'CLOSED' },
        { tradeId: 't2', closed: false, status: 'OPEN' },
      ]),
    };
    job = new EmergencyFlattenJob(executionService as unknown as ExecutionService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('drives the idempotent close path and reports the honest summary', async () => {
    const summary = await job.process(fakeJob);
    expect(executionService.emergencyCloseAllOpenPositions).toHaveBeenCalledWith('user-1');
    expect(summary).toEqual({ closed: 1, failed: 1, total: 2 });
  });

  it('an empty flatten (no OPEN positions) reports zeros without error', async () => {
    executionService.emergencyCloseAllOpenPositions.mockResolvedValue([]);
    const summary = await job.process(fakeJob);
    expect(summary).toEqual({ closed: 0, failed: 0, total: 0 });
  });

  it('a close-path failure propagates (BullMQ retries the durable job)', async () => {
    executionService.emergencyCloseAllOpenPositions.mockRejectedValue(
      new Error('provider unreachable'),
    );
    await expect(job.process(fakeJob)).rejects.toThrow('provider unreachable');
  });
});
