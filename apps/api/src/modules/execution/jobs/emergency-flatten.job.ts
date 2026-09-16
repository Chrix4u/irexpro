import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ExecutionService } from '../execution.service';

export const EMERGENCY_FLATTEN_QUEUE = 'emergency-flatten';
export const EMERGENCY_FLATTEN_JOB = 'emergency-flatten-user';

/**
 * EmergencyFlattenJob (Round 7 P1 — durable kill-switch flatten) — the
 * BullMQ worker that guarantees a kill-switch (or any emergency) flatten
 * SURVIVES a process crash between the durable authority write and the
 * in-process flatten.
 *
 * The job calls the SAME idempotent close path as the in-process fast path
 * (ExecutionService.emergencyCloseAllOpenPositions): every per-trade close
 * is CAS-guarded and idempotent by clientOrderId, so the durable job and
 * the fast path can never double-close a position — whichever wins, the
 * loser's CAS preserves the newer terminal truth.
 *
 * BullMQ retries (attempts + exponential backoff, configured at enqueue)
 * redeliver the job after a crash; removeOnComplete keeps a bounded audit
 * trail of completed flattens.
 */
@Injectable()
@Processor(EMERGENCY_FLATTEN_QUEUE)
export class EmergencyFlattenJob extends WorkerHost {
  private readonly logger = new Logger(EmergencyFlattenJob.name);

  constructor(private readonly executionService: ExecutionService) {
    super();
  }

  async process(
    job: Job<{ userId: string; reason: string }>,
  ): Promise<{ closed: number; failed: number; total: number }> {
    const { userId, reason } = job.data;
    this.logger.warn(
      `Durable emergency flatten for user ${userId} (attempt ${job.attemptsMade + 1}, ` +
        `reason: ${reason})`,
    );
    const results = await this.executionService.emergencyCloseAllOpenPositions(userId);
    const closed = results.filter((r) => r.closed).length;
    const summary = { closed, failed: results.length - closed, total: results.length };
    this.logger.log(
      `Durable emergency flatten for user ${userId} complete: ` +
        `${summary.closed} closed, ${summary.failed} failed of ${summary.total}`,
    );
    return summary;
  }
}
