import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { TradeStateMachine } from './trade-state-machine';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';

/**
 * The CAS outcome of one provider-bound Trade lifecycle transition
 * (Sprint 56 correction round 5, task 50-c, architect issue #315).
 */
export type TradeCasOutcome =
  | { outcome: 'APPLIED'; trade: Trade }
  /** The authoritative reload already shows the target state — idempotent return. */
  | { outcome: 'ALREADY_AT_TARGET'; trade: Trade }
  /**
   * The reload shows a NEWER TERMINAL truth (CLOSED / REJECTED / CANCELLED) —
   * it is PRESERVED, never regressed: a late UNKNOWN provider response may
   * not overwrite a reconciliation-proved terminal state.
   */
  | { outcome: 'PRESERVED_NEWER_TRUTH'; trade: Trade }
  /**
   * The authoritative state diverged in a way this transition cannot legally
   * converge onto — a discrepancy record is written; the caller must reload
   * and decide (never a blind retry).
   */
  | {
      outcome: 'STATE_CONFLICT';
      trade: Trade | null;
      expected: TradeStatus[];
      target: TradeStatus;
    };

/**
 * TradeLifecycleCasService — EVERY provider-bound Trade state transition is a
 * compare-and-swap (issue #315).
 *
 * The pattern (mirrors the round-4/round-3 discipline on orders + authority
 * rows):
 *   1. validate the transition against the TradeStateMachine (fail-loud on an
 *      illegal transition);
 *   2. conditional UPDATE ... WHERE id AND status IN (expected) with an
 *      affected-rows check (single writer wins);
 *   3. on 0 affected rows → RELOAD the authoritative row:
 *        - already at the target state → idempotent return;
 *        - terminal truth (CLOSED/REJECTED/CANCELLED) → PRESERVED, never
 *          regressed (a late UNKNOWN response cannot overwrite it);
 *        - a state from which the target is legally reachable → converge
 *          with ONE more guarded CAS (e.g. a FILLED response arriving after
 *          the trade moved RECONCILIATION_PENDING);
 *        - otherwise → STATE_CONFLICT + a persisted discrepancy record
 *          (reconciliation-discrepancy pattern: safe comparison facts only —
 *          expected vs observed statuses, never credentials or raw payloads).
 *
 * The PLACE-path reservation (atomicallyReserveTradeSlot) is already
 * single-winner by construction (user+day advisory lock + idempotency-key
 * unique constraint) — the same fencing guarantees, unchanged.
 */
@Injectable()
export class TradeLifecycleCasService {
  private readonly logger = new Logger(TradeLifecycleCasService.name);

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Apply ONE guarded lifecycle transition. Never throws on a lost race —
   * the outcome union tells the caller exactly what happened.
   */
  async applyCasTransition(params: {
    tradeId: string;
    expectedFrom: TradeStatus | readonly TradeStatus[];
    target: TradeStatus;
    patch: QueryDeepPartialEntity<Trade>;
    context: {
      userId: string;
      /** Audit lineage (e.g. 'executeTrade:FILLED', 'closeTrade:UNKNOWN'). */
      source: string;
      reason?: string;
    };
  }): Promise<TradeCasOutcome> {
    const expected = Array.isArray(params.expectedFrom)
      ? (params.expectedFrom as TradeStatus[])
      : [params.expectedFrom as TradeStatus];
    const target = params.target;

    // ── 1. State-machine validation (fail-loud on illegal transitions) ────
    const legal = expected.filter((from) => TradeStateMachine.canTransition(from, target));
    if (legal.length === 0) {
      // Preserve the original fail-loud behavior: an impossible transition is
      // a programming error, not a race.
      TradeStateMachine.assertTransition(expected[0], target);
    }

    // ── 2. CAS: conditional UPDATE with an affected-rows check ────────────
    const applied = await this.tradeRepo
      .createQueryBuilder()
      .update()
      .set(params.patch as never)
      .where('id = :id AND status IN (:...expected)', { id: params.tradeId, expected: legal })
      .execute();
    if (applied.affected) {
      const trade = await this.tradeRepo.findOne({ where: { id: params.tradeId } });
      if (trade) {
        return { outcome: 'APPLIED', trade };
      }
      // Applied but unreadable — treat as conflict (fail closed).
      return { outcome: 'STATE_CONFLICT', trade: null, expected, target };
    }

    // ── 3. Lost the CAS — reload the AUTHORITATIVE row and decide ─────────
    const authoritative = await this.tradeRepo.findOne({ where: { id: params.tradeId } });
    if (!authoritative) {
      return { outcome: 'STATE_CONFLICT', trade: null, expected, target };
    }

    if (authoritative.status === target) {
      // Idempotent: another writer already reached the target state.
      return { outcome: 'ALREADY_AT_TARGET', trade: authoritative };
    }

    if (TradeStateMachine.isTerminal(authoritative.status)) {
      // NEWER TERMINAL TRUTH — never regress it (a late UNKNOWN provider
      // response may not overwrite a reconciliation-proved CLOSED trade).
      await this.recordDiscrepancy(params, expected, target, authoritative.status);
      return { outcome: 'PRESERVED_NEWER_TRUTH', trade: authoritative };
    }

    if (TradeStateMachine.canTransition(authoritative.status, target)) {
      // The authoritative state can still legally reach the target — ONE more
      // guarded CAS converges it (e.g. RECONCILIATION_PENDING → OPEN when the
      // fill response arrives after an ambiguity flag).
      const converged = await this.tradeRepo
        .createQueryBuilder()
        .update()
        .set(params.patch as never)
        .where('id = :id AND status = :status', {
          id: params.tradeId,
          status: authoritative.status,
        })
        .execute();
      if (converged.affected) {
        const trade = await this.tradeRepo.findOne({ where: { id: params.tradeId } });
        return trade
          ? { outcome: 'APPLIED', trade }
          : { outcome: 'STATE_CONFLICT', trade: null, expected, target };
      }
      // The row moved again — reload + conflict (never loop).
      const reloaded = await this.tradeRepo.findOne({ where: { id: params.tradeId } });
      await this.recordDiscrepancy(params, expected, target, reloaded?.status ?? null);
      return { outcome: 'STATE_CONFLICT', trade: reloaded, expected, target };
    }

    await this.recordDiscrepancy(params, expected, target, authoritative.status);
    return { outcome: 'STATE_CONFLICT', trade: authoritative, expected, target };
  }

  /**
   * Persist a trade-lifecycle discrepancy record (the reconciliation-
   * discrepancy pattern: safe comparison facts only — expected vs observed
   * statuses, source lineage, sanitized reason; never credentials or raw
   * provider payloads). Audit failures never break the CAS outcome.
   */
  private async recordDiscrepancy(
    params: {
      tradeId: string;
      target: TradeStatus;
      context: { userId: string; source: string; reason?: string };
    },
    expected: TradeStatus[],
    target: TradeStatus,
    observed: TradeStatus | null,
  ): Promise<void> {
    try {
      await this.auditService.log({
        actorUserId: params.context.userId,
        action: AuditAction.RECONCILIATION_DISCREPANCY_DETECTED,
        resourceType: 'Trade',
        resourceId: params.tradeId,
        severity: AuditSeverity.WARNING,
        metadata: {
          domain: 'TRADE_LIFECYCLE_CAS',
          source: params.context.source,
          expectedStatuses: expected,
          targetStatus: target,
          observedStatus: observed ?? 'UNKNOWN',
          reason: params.context.reason?.slice(0, 200) ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Trade CAS discrepancy audit failed for trade ${params.tradeId}: ${(err as Error).message}`,
      );
    }
  }
}
