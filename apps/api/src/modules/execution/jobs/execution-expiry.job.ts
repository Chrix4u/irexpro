import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
import { TradeIntentService } from '../services/trade-intent.service';
import { AllocationService } from '../services/allocation.service';
import { RiskGrantService } from '../../risk/risk-grant.service';
// Round 7 (P1 metrics — audit R7-audit-C A6): dependency-free in-process
// counters (lazy ModuleRef seam — see the metrics getter below).
import { MetricsService } from '../../metrics/metrics.service';
import { METRIC_NAMES } from '../../metrics/metric-names';

export const EXECUTION_EXPIRY_QUEUE = 'execution-expiry';
export const EXECUTION_EXPIRY_JOB = 'sweep-execution-expiry';
export const EXECUTION_EXPIRY_INTERVAL_MS = 60_000;

/**
 * ExecutionExpiryJob (Round 7 P1 — expiry hygiene sweeper) — the scheduled
 * worker that makes execution-authority expiry PROACTIVE instead of purely
 * lazy:
 *
 *   1. EXPIRE stale CREATED TradeIntents (validity window passed). Lazy
 *      resolution already fails closed per-intent, but an abandoned
 *      SEMI_AUTO decision (intent CREATED, no trade, no rejection) would
 *      otherwise count as in-flight capital FOREVER in the §3 aggregate —
 *      a per-signal capital-budget self-DoS.
 *   2. RELEASE each expired intent's ACTIVE capital allocation (definite
 *      non-exposure — the ledger records why; the aggregate self-heals
 *      regardless).
 *   3. EXPIRE stale PENDING confirmations (window passed). The boundary
 *      already refuses them; this keeps the user-facing pending list
 *      honest instead of listing dead proposals forever.
 *
 * Idempotent by construction: every mutation is a guarded CAS (status =
 * PENDING/CREATED only); a concurrently consumed/revoked/expired row is
 * never rewritten. Per-item failures never break the sweep.
 */
@Injectable()
@Processor(EXECUTION_EXPIRY_QUEUE)
export class ExecutionExpiryJob extends WorkerHost {
  private readonly logger = new Logger(ExecutionExpiryJob.name);

  constructor(
    private readonly tradeIntents: TradeIntentService,
    private readonly allocationService: AllocationService,
    private readonly riskGrantService: RiskGrantService,
    /** Round 7 (P1 metrics): lazy MetricsService seam (never a constructor
     * injection — see the metrics getter for the DI decision). */
    private readonly moduleRef: ModuleRef,
  ) {
    super();
  }

  /**
   * Round 7 (P1 metrics — audit R7-audit-C A6): lazy metrics seam. Resolved
   * at CALL time via ModuleRef.get(..., { strict: false }) — the app-wide
   * lookup finds the MetricsModule singleton (registered once in AppModule).
   * Direct constructor injection was rejected: it would demand a
   * MetricsService provider in EVERY spec constructing this job (incl.
   * out-of-scope suites) plus module-file imports outside the approved file
   * scope. In isolated test contexts the lookup fails → null → the
   * `this.metrics?.increment(...)` call sites no-op. Never affects control
   * flow (MetricsService methods never throw).
   */
  private get metrics(): MetricsService | null {
    try {
      return this.moduleRef.get(MetricsService, { strict: false });
    } catch {
      return null;
    }
  }

  async process(job: Job): Promise<{
    expiredIntents: number;
    releasedAllocations: number;
    expiredConfirmations: number;
  }> {
    this.logger.debug(`Running execution-expiry sweep ${job.id}`);

    // 1. Expire stale CREATED intents (guarded per-id CAS).
    const expiredIntentIds = await this.tradeIntents.expireStaleCreatedIntents();

    // 2. Release their capital reservations (definite non-exposure).
    let releasedAllocations = 0;
    for (const intentId of expiredIntentIds) {
      try {
        await this.allocationService.releaseAllocationForIntent(intentId, 'INTENT_EXPIRED');
        releasedAllocations += 1;
      } catch (err) {
        this.logger.warn(
          `Allocation release for expired intent ${intentId} failed ` +
            `(${(err as Error).message}) — the aggregate self-heals from the intent status`,
        );
      }
    }

    // 3. Expire stale PENDING confirmations (guarded per-id CAS).
    const expiredConfirmations = await this.riskGrantService.expireStalePendingConfirmations();

    if (expiredIntentIds.length > 0 || expiredConfirmations > 0) {
      this.logger.log(
        `Execution-expiry sweep: ${expiredIntentIds.length} intent(s) expired, ` +
          `${releasedAllocations} allocation(s) released, ${expiredConfirmations} ` +
          'confirmation(s) expired',
      );
    }

    // Round 7 (P1 metrics): sweep-count increments (value = count; a zero
    // sweep still materializes the series at 0 for scrape stability).
    this.metrics?.increment(METRIC_NAMES.INTENTS_EXPIRED, undefined, expiredIntentIds.length);
    this.metrics?.increment(METRIC_NAMES.ALLOCATIONS_RELEASED, undefined, releasedAllocations);
    this.metrics?.increment(METRIC_NAMES.CONFIRMATIONS_EXPIRED, undefined, expiredConfirmations);

    return {
      expiredIntents: expiredIntentIds.length,
      releasedAllocations,
      expiredConfirmations,
    };
  }
}
