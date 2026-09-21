import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
 *
 * Production-LIVE completion round (Phase 11 — Redis-outage drill): a
 * scheduling failure (Redis unavailable at boot, or a transient outage) is
 * no longer a single logged error that leaves the process WITHOUT a
 * reconciliation schedule until the next restart. The producer retries with
 * bounded exponential backoff (15s → 30s → 60s, then a steady 60s liveness
 * retry), and every successful (re)schedule enqueues ONE immediate
 * idempotent recovery sweep — so a queue layer that comes back after N
 * minutes is caught up within seconds of its return (crash-left UNKNOWN
 * outcomes, pre-commitment wedges and partially filled orders do not wait
 * for manual intervention). The worker is idempotent (guarded mutations +
 * OPEN-row dedup), so a racing schedule + immediate sweep is harmless.
 */
@Injectable()
export class TradeReconciliationProducer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TradeReconciliationProducer.name);
  /** Failed schedule attempts in the current outage window. */
  private scheduleFailures = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectQueue(TRADE_RECONCILIATION_QUEUE)
    private reconciliationQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduleWithSelfHealingRetry();
  }

  onModuleDestroy(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Schedule; on failure, arm a bounded-backoff retry (never a crash, never a silent give-up). */
  private async scheduleWithSelfHealingRetry(): Promise<void> {
    const scheduled = await this.trySchedule();
    if (scheduled) {
      this.scheduleFailures = 0;
      return;
    }

    this.scheduleFailures += 1;
    const backoffMs = Math.min(
      15_000 * 2 ** Math.min(this.scheduleFailures - 1, 2),
      RECONCILIATION_INTERVAL_MS,
    );
    this.logger.error(
      `Failed to schedule reconciliation job — Redis may be unavailable ` +
        `(attempt ${this.scheduleFailures}); retrying in ${backoffMs / 1000}s. ` +
        `The repeatable schedule + an immediate recovery sweep will be (re)established ` +
        `as soon as the queue layer returns.`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.scheduleWithSelfHealingRetry();
    }, backoffMs);
    // The retry timer must never keep the event loop alive on shutdown.
    this.retryTimer.unref?.();
  }

  /** One scheduling attempt. Returns true on success; swallows+logs errors (fail-open for the process, fail-closed for the schedule). */
  private async trySchedule(): Promise<boolean> {
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
      return true;
    } catch (err) {
      this.logger.error(`Reconciliation scheduling attempt failed: ${(err as Error).message}`);
      return false;
    }
  }
}
