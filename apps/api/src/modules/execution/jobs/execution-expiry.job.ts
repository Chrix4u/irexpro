import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { TradeIntentService } from '../services/trade-intent.service';
import { AllocationService } from '../services/allocation.service';
import { RiskGrantService } from '../../risk/risk-grant.service';

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
  ) {
    super();
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

    return {
      expiredIntents: expiredIntentIds.length,
      releasedAllocations,
      expiredConfirmations,
    };
  }
}
