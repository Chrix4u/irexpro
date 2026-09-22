import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReconciliationRun } from './entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from './entities/reconciliation-discrepancy.entity';
import {
  ReconciliationDiscrepancyStatus,
  ReconciliationDiscrepancyType,
  ReconciliationRunStatus,
} from './reconciliation.enums';
// NOTE: deliberately NOT imported from trade-reconciliation.job.ts — that
// would create a require cycle (job → execution.service →
// final-dispatch-boundary → this service → job) which corrupts emitted
// design:paramtypes and breaks the DI graph bootstrap. The value mirrors
// the job's RECONCILIATION_INTERVAL_MS (60s reconciliation cadence); the
// dedicated spec asserts the derived default policy so drift is caught.
const RECONCILIATION_INTERVAL_MS = 60_000;

/**
 * October UAT hardening (WS2) — typed reconciliation-health decision for the
 * LIVE new-exposure hard gate.
 *
 * The audit found reconciliation health was observable (surfaced per
 * connection in the live-account/admin views) but NOT enforced. This service
 * turns the persisted reconciliation state (runs + OPEN discrepancies) into a
 * TYPED decision that the risk pipeline AND the final dispatch boundary
 * enforce for LIVE new exposure — reconciliation truth that cannot be
 * established blocks real-money exposure (fail-closed).
 *
 * PAPER/DEMO are deliberately NOT gated here: the simulator and the broker
 * demo sandbox keep their existing execution semantics.
 */

/** Machine reason codes (stable, surfaced in risk rejections + audits). */
export enum ReconciliationHealthReasonCode {
  /** No successful run within the freshness window (or no run at all). */
  RECONCILIATION_STALE = 'RECONCILIATION_STALE',
  /** The most recent run FAILED — reconciliation truth is not established. */
  RECONCILIATION_FAILED = 'RECONCILIATION_FAILED',
  /** OPEN position-class discrepancies (unknown provider position / position
   *  closed externally). */
  UNRESOLVED_POSITION_DIVERGENCE = 'UNRESOLVED_POSITION_DIVERGENCE',
  /** OPEN order-class discrepancies (missing/unknown orders, stale order
   *  state, duplicate provider ids, unresolved execution results). */
  UNRESOLVED_ORDER_DIVERGENCE = 'UNRESOLVED_ORDER_DIVERGENCE',
  /** OPEN protective-order divergences (SL/TP not verifiable/repairable). */
  PROTECTIVE_ORDER_DIVERGENCE = 'PROTECTIVE_ORDER_DIVERGENCE',
  /** OPEN account-state mismatch — provider account truth diverges. */
  ACCOUNT_STATE_UNAVAILABLE = 'ACCOUNT_STATE_UNAVAILABLE',
}

/**
 * Explicit, typed freshness policy — NO magic values inside business logic.
 *
 * Defaults are derived from the reconciliation cadence (60s cycle):
 * - a successful run older than 5 cycles (5 minutes) is STALE — the loop
 *   should have completed well within that window;
 * - a run stalled in RUNNING/PENDING for more than 10 minutes is treated as
 *   STALE truth (the sweeper may have died mid-run — fail-closed).
 *
 * Overridable via constructor policy (specs inject deterministic clocks and
 * tightened windows; the service never reads ambient time beyond the injected
 * `now()` provider).
 */
export interface ReconciliationHealthPolicy {
  /** Max age of the most recent COMPLETED/COMPLETED_WITH_WARNINGS run. */
  maxSuccessfulRunAgeMs: number;
  /** A run stuck RUNNING/PENDING longer than this is STALE truth. */
  maxInFlightRunAgeMs: number;
}

export const DEFAULT_RECONCILIATION_HEALTH_POLICY: ReconciliationHealthPolicy = {
  maxSuccessfulRunAgeMs: 5 * RECONCILIATION_INTERVAL_MS,
  maxInFlightRunAgeMs: 10 * RECONCILIATION_INTERVAL_MS,
};

/** DI token for the (overridable) health policy — see ExecutionModule. */
export const RECONCILIATION_HEALTH_POLICY = Symbol('RECONCILIATION_HEALTH_POLICY');

/** Position-class OPEN discrepancy types. */
const POSITION_DIVERGENCE_TYPES: ReadonlySet<ReconciliationDiscrepancyType> = new Set([
  ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION,
  ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
]);

/** Order-class OPEN discrepancy types. */
const ORDER_DIVERGENCE_TYPES: ReadonlySet<ReconciliationDiscrepancyType> = new Set([
  ReconciliationDiscrepancyType.MISSING_INTERNAL_ORDER,
  ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_ORDER,
  ReconciliationDiscrepancyType.MISSING_PROVIDER_ORDER,
  ReconciliationDiscrepancyType.STALE_ORDER_STATE,
  ReconciliationDiscrepancyType.DUPLICATE_PROVIDER_ID,
  ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
]);

/** The typed health decision consumed by the LIVE gates. */
export interface ReconciliationHealthDecision {
  /** True ONLY when reconciliation truth is established and divergence-free. */
  healthy: boolean;
  /** Null when healthy; otherwise the FIRST blocking reason (deterministic
   *  precedence: FAILED > STALE > position > order > protective > account). */
  reasonCode: ReconciliationHealthReasonCode | null;
  /** Safe human-readable detail (no secrets, no raw provider payloads). */
  detail: string;
  /** Safe evidence snapshot for audits and rejection metadata. */
  evidence: {
    latestRunId: string | null;
    latestRunStatus: ReconciliationRunStatus | null;
    latestSuccessfulRunCompletedAt: string | null;
    latestSuccessfulRunAgeMs: number | null;
    openDiscrepanciesByType: Partial<Record<ReconciliationDiscrepancyType, number>>;
  };
}

@Injectable()
export class ReconciliationHealthService {
  private readonly logger = new Logger(ReconciliationHealthService.name);
  private readonly policy: ReconciliationHealthPolicy;

  constructor(
    @InjectRepository(ReconciliationRun)
    private readonly runRepo: Repository<ReconciliationRun>,
    @InjectRepository(ReconciliationDiscrepancy)
    private readonly discrepancyRepo: Repository<ReconciliationDiscrepancy>,
    @Optional()
    @Inject(RECONCILIATION_HEALTH_POLICY)
    policy: Partial<ReconciliationHealthPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_RECONCILIATION_HEALTH_POLICY, ...policy };
  }

  /**
   * Evaluate reconciliation health for ONE broker connection.
   *
   * DETERMINISTIC PRECEDENCE (first blocking reason wins):
   * 1. RECONCILIATION_FAILED — the latest run FAILED (truth not established).
   * 2. RECONCILIATION_STALE — no successful run within the freshness window
   *    (including: no runs at all, or a run stalled in-flight past policy).
   * 3. UNRESOLVED_POSITION_DIVERGENCE — OPEN position-class discrepancies.
   * 4. UNRESOLVED_ORDER_DIVERGENCE — OPEN order-class discrepancies.
   * 5. PROTECTIVE_ORDER_DIVERGENCE — OPEN protective-order divergences.
   * 6. ACCOUNT_STATE_UNAVAILABLE — OPEN account-state mismatch.
   *
   * Any query failure throws to the caller (which rejects fail-closed) —
   * this method never guesses healthy on unreadable state.
   */
  async evaluateReconciliationHealth(
    brokerConnectionId: string,
    now: Date = new Date(),
  ): Promise<ReconciliationHealthDecision> {
    const [latestRun, latestSuccessfulRun, openDiscrepancies] = await Promise.all([
      this.runRepo.findOne({
        where: { brokerConnectionId },
        order: { createdAt: 'DESC' },
      }),
      this.runRepo.findOne({
        where: { brokerConnectionId },
        order: { completedAt: 'DESC' },
      }),
      this.discrepancyRepo.find({
        where: {
          brokerConnectionId,
          status: ReconciliationDiscrepancyStatus.OPEN,
        },
        select: ['type'],
      }),
    ]);

    const byType: Partial<Record<ReconciliationDiscrepancyType, number>> = {};
    for (const row of openDiscrepancies) {
      byType[row.type] = (byType[row.type] ?? 0) + 1;
    }

    const evidence: ReconciliationHealthDecision['evidence'] = {
      latestRunId: latestRun?.id ?? null,
      latestRunStatus: latestRun?.status ?? null,
      latestSuccessfulRunCompletedAt: latestSuccessfulRun?.completedAt?.toISOString() ?? null,
      latestSuccessfulRunAgeMs: latestSuccessfulRun?.completedAt
        ? Math.max(0, now.getTime() - latestSuccessfulRun.completedAt.getTime())
        : null,
      openDiscrepanciesByType: byType,
    };

    // 1. Latest run FAILED — the most recent reconciliation attempt did not
    //    establish truth (typed FAILED status, never silently skipped).
    if (latestRun?.status === ReconciliationRunStatus.FAILED) {
      return this.unhealthy(
        ReconciliationHealthReasonCode.RECONCILIATION_FAILED,
        latestRun
          ? `The most recent reconciliation run failed${latestRun.errorSummary ? `: ${latestRun.errorSummary}` : ''} — provider truth could not be established.`
          : 'The most recent reconciliation run failed — provider truth could not be established.',
        evidence,
      );
    }

    // 2. Staleness: the newest run with a completion timestamp decides. A run
    //    still in flight past policy is stale truth (fail-closed — the
    //    sweeper may have died mid-run).
    const successful = this.latestCompletedSuccessful(latestRun, latestSuccessfulRun);
    const completedAt = successful?.completedAt ?? null;
    const staleTruth =
      completedAt === null ||
      now.getTime() - completedAt.getTime() > this.policy.maxSuccessfulRunAgeMs ||
      this.inFlightBeyondPolicy(latestRun, now);
    if (staleTruth) {
      const age =
        completedAt !== null ? Math.round((now.getTime() - completedAt.getTime()) / 1000) : null;
      return this.unhealthy(
        ReconciliationHealthReasonCode.RECONCILIATION_STALE,
        age !== null
          ? `The most recent successful reconciliation is ${age}s old (policy allows ${Math.round(this.policy.maxSuccessfulRunAgeMs / 1000)}s) — reconciliation truth cannot be treated as current.`
          : 'No completed reconciliation run exists for this connection — reconciliation truth cannot be established.',
        evidence,
      );
    }

    // 3–6. OPEN divergence classes (all severities block: an OPEN WARNING is
    // still unresolved divergence for real-money exposure).
    const countOf = (types: ReadonlySet<ReconciliationDiscrepancyType>): number =>
      Object.entries(byType).reduce(
        (sum, [type, count]) =>
          types.has(type as ReconciliationDiscrepancyType) ? sum + (count ?? 0) : sum,
        0,
      );

    const positionCount = countOf(POSITION_DIVERGENCE_TYPES);
    if (positionCount > 0) {
      return this.unhealthy(
        ReconciliationHealthReasonCode.UNRESOLVED_POSITION_DIVERGENCE,
        `${positionCount} open position divergence(s) remain unresolved between iRexPro and the broker.`,
        evidence,
      );
    }

    const orderCount = countOf(ORDER_DIVERGENCE_TYPES);
    if (orderCount > 0) {
      return this.unhealthy(
        ReconciliationHealthReasonCode.UNRESOLVED_ORDER_DIVERGENCE,
        `${orderCount} open order divergence(s) remain unresolved between iRexPro and the broker.`,
        evidence,
      );
    }

    const protectiveCount = byType[ReconciliationDiscrepancyType.PROTECTIVE_ORDER_DIVERGENCE] ?? 0;
    if (protectiveCount > 0) {
      return this.unhealthy(
        ReconciliationHealthReasonCode.PROTECTIVE_ORDER_DIVERGENCE,
        `${protectiveCount} open position(s) have unverified or unrestorable protective orders (SL/TP) at the broker.`,
        evidence,
      );
    }

    const accountCount = byType[ReconciliationDiscrepancyType.ACCOUNT_STATE_MISMATCH] ?? 0;
    if (accountCount > 0) {
      return this.unhealthy(
        ReconciliationHealthReasonCode.ACCOUNT_STATE_UNAVAILABLE,
        `${accountCount} open account-state mismatch(es) — the broker-reported account state diverges from the synchronized snapshot.`,
        evidence,
      );
    }

    return {
      healthy: true,
      reasonCode: null,
      detail: 'Reconciliation truth is current and divergence-free.',
      evidence,
    };
  }

  /**
   * LIVE new-exposure assertion: resolves when healthy, throws a typed error
   * carrying the reason code otherwise. Callers (risk pipeline + final
   * dispatch boundary) translate the typed error into their own rejection
   * surfaces — this method is the single decision authority.
   */
  async assertHealthyForLiveNewExposure(
    brokerConnectionId: string,
    now: Date = new Date(),
  ): Promise<ReconciliationHealthDecision> {
    const decision = await this.evaluateReconciliationHealth(brokerConnectionId, now);
    if (!decision.healthy) {
      throw new ReconciliationHealthBlockedException(decision);
    }
    return decision;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /**
   * The newest run that COMPLETED (with or without warnings) — i.e. the
   * newest run that established provider truth. `latestSuccessfulRun`
   * (ordered by completedAt DESC) covers the normal path; when the newest
   * overall run is itself COMPLETED*, it is at least as new.
   */
  private latestCompletedSuccessful(
    latestRun: ReconciliationRun | null,
    latestSuccessfulRun: ReconciliationRun | null,
  ): ReconciliationRun | null {
    const candidates = [latestSuccessfulRun];
    if (
      latestRun &&
      (latestRun.status === ReconciliationRunStatus.COMPLETED ||
        latestRun.status === ReconciliationRunStatus.COMPLETED_WITH_WARNINGS) &&
      latestRun.completedAt
    ) {
      candidates.push(latestRun);
    }
    const withCompletion = candidates.filter(
      (run): run is ReconciliationRun => run?.completedAt != null,
    );
    if (withCompletion.length === 0) return null;
    return withCompletion.reduce((newest, run) =>
      (run.completedAt as Date).getTime() > (newest.completedAt as Date).getTime() ? run : newest,
    );
  }

  /** A run stuck RUNNING/PENDING beyond policy — the sweeper may have died. */
  private inFlightBeyondPolicy(latestRun: ReconciliationRun | null, now: Date): boolean {
    if (!latestRun) return false;
    if (
      latestRun.status !== ReconciliationRunStatus.RUNNING &&
      latestRun.status !== ReconciliationRunStatus.PENDING
    ) {
      return false;
    }
    const startedAt = latestRun.startedAt ?? latestRun.createdAt;
    return now.getTime() - startedAt.getTime() > this.policy.maxInFlightRunAgeMs;
  }

  private unhealthy(
    reasonCode: ReconciliationHealthReasonCode,
    detail: string,
    evidence: ReconciliationHealthDecision['evidence'],
  ): ReconciliationHealthDecision {
    return { healthy: false, reasonCode, detail, evidence };
  }
}

/** Typed block — the LIVE gates translate this into their own surfaces. */
export class ReconciliationHealthBlockedException extends Error {
  constructor(public readonly decision: ReconciliationHealthDecision) {
    super(decision.detail);
    this.name = 'ReconciliationHealthBlockedException';
  }
}
