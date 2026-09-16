import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  RECONCILIATION_INTERVAL_MS,
  TRADE_RECONCILIATION_JOB,
  TRADE_RECONCILIATION_QUEUE,
} from './trade-reconciliation.job';

/**
 * TradeReconciliationProducer — Schedules the repeatable reconciliation job.
 *
 * Ensures exactly one reconciliation job runs every 60 seconds.
 * Stale/duplicate repeatable jobs are cleaned up on startup.
 */
@Injectable()
export class TradeReconciliationProducer implements OnModuleInit {
  private readonly logger = new Logger(TradeReconciliationProducer.name);

  constructor(
    @InjectQueue(TRADE_RECONCILIATION_QUEUE)
    private reconciliationQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Remove any stale repeatable jobs from previous deployments
      const existing = await this.reconciliationQueue.getRepeatableJobs();
      await Promise.all(
        existing.map((job) => this.reconciliationQueue.removeRepeatableByKey(job.key)),
      );

      await this.reconciliationQueue.add(
        TRADE_RECONCILIATION_JOB,
        {},
        { repeat: { every: RECONCILIATION_INTERVAL_MS } },
      );

      // Round 7.1 (P0-5 — boot-time recovery convergence): after a process
      // restart, in-flight states left behind by the crash (UNKNOWN provider
      // outcomes, pre-commitment wedges, partially filled orders) otherwise
      // wait up to a FULL interval (60s+) before the first sweep converges
      // them. Enqueue ONE immediate, idempotent run so restart recovery
      // starts in seconds. The worker is idempotent (guarded mutations +
      // OPEN-row dedup) — a race with the repeatable schedule is harmless.
      await this.reconciliationQueue.add(TRADE_RECONCILIATION_JOB, { immediateRecovery: true });

      this.logger.log(
        `Trade reconciliation job scheduled (every ${RECONCILIATION_INTERVAL_MS / 1000}s) ` +
          '+ one immediate boot-time recovery sweep enqueued',
      );
    } catch (err) {
      this.logger.error(
        `Failed to schedule reconciliation job — Redis may be unavailable: ` +
          `${(err as Error).message}`,
      );
    }
  }
}
