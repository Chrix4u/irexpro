import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { EMERGENCY_FLATTEN_JOB, EMERGENCY_FLATTEN_QUEUE } from './emergency-flatten.constants';

/**
 * EmergencyFlattenProducer (Round 7 P1 — durable kill-switch flatten) —
 * enqueues the durable emergency-flatten job.
 *
 * DURABILITY CONTRACT: the kill switch first writes the durable authority
 * (profile fact + revision + generation bump + invalidations, one
 * transaction), then enqueues THIS job, then runs the in-process fast path.
 * A crash anywhere after the enqueue redelivers the flatten via BullMQ
 * (attempts + exponential backoff) — the emergency de-risking can no longer
 * be lost to a process death between the authority write and the flatten.
 *
 * The job payload carries NO credentials and NO order data — only the user
 * id + a reason code (audit-safe).
 */
@Injectable()
export class EmergencyFlattenProducer {
  private readonly logger = new Logger(EmergencyFlattenProducer.name);

  constructor(
    @InjectQueue(EMERGENCY_FLATTEN_QUEUE)
    private flattenQueue: Queue,
  ) {}

  async enqueueDurableFlatten(userId: string, reason: string): Promise<void> {
    await this.flattenQueue.add(
      EMERGENCY_FLATTEN_JOB,
      { userId, reason: reason.slice(0, 100) },
      {
        attempts: 10,
        backoff: { type: 'exponential', delay: 3_000 },
        removeOnComplete: 100,
        removeOnFail: 1000,
      },
    );
  }
}
