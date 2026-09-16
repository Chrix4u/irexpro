import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  EXECUTION_EXPIRY_INTERVAL_MS,
  EXECUTION_EXPIRY_JOB,
  EXECUTION_EXPIRY_QUEUE,
} from './execution-expiry.job';

/**
 * ExecutionExpiryProducer — schedules the repeatable execution-expiry sweep
 * (exactly one run per interval; stale repeatables from previous deployments
 * are stripped on boot — the TradeReconciliationProducer pattern).
 */
@Injectable()
export class ExecutionExpiryProducer implements OnModuleInit {
  private readonly logger = new Logger(ExecutionExpiryProducer.name);

  constructor(
    @InjectQueue(EXECUTION_EXPIRY_QUEUE)
    private expiryQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.expiryQueue.getRepeatableJobs();
      await Promise.all(existing.map((job) => this.expiryQueue.removeRepeatableByKey(job.key)));

      await this.expiryQueue.add(
        EXECUTION_EXPIRY_JOB,
        {},
        {
          repeat: { every: EXECUTION_EXPIRY_INTERVAL_MS },
        },
      );

      this.logger.log(
        `Execution-expiry sweep scheduled (every ${EXECUTION_EXPIRY_INTERVAL_MS / 1000}s)`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to schedule the execution-expiry sweep — Redis may be unavailable: ` +
          `${(err as Error).message}`,
      );
    }
  }
}
