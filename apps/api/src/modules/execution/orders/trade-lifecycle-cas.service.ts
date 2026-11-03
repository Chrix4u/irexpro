import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { TradeStateMachine } from './trade-state-machine';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import type { BrokerPrice } from '../../broker/interfaces/broker-adapter.interface';
import { TradeSpreadTelemetryService } from '../services/trade-spread-telemetry.service';
import {
  discardProvenExecutionQuote,
  peekProvenExecutionQuote,
} from '../services/execution-quote-registry';

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
 * Convert a proven provider quote into the raw telemetry fields that belong
 * to the PENDING → OPEN transition. The broker-supplied `spread` field is not
 * trusted for persistence: spread is re-derived from ASK - BID.
 */
export function buildEntryQuoteTelemetryPatch(
  quote: BrokerPrice | null | undefined,
): QueryDeepPartialEntity<Trade> | null {
  if (!quote) return null;
  const bid = ExactDecimal.tryParse(quote.bid);
  const ask = ExactDecimal.tryParse(quote.ask);
  const observedAtMs = new Date(quote.timestamp).getTime();
  if (
    !bid?.isPositive() ||
    !ask?.isPositive() ||
    ask.lt(bid) ||
    !Number.isFinite(observedAtMs) ||
    observedAtMs <= 0
  ) {
    return null;
  }

  return {
    entryQuoteBid: bid.toString(),
    entryQuoteAsk: ask.toString(),
    entrySpread: ask.sub(bid).toString(),
    entryQuoteObservedAt: new Date(observedAtMs),
  };
}

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
    // Optional preserves the established isolated CAS unit-test shape. In the
    // production ExecutionModule this provider is present. Telemetry is never
    // execution authority, so an unavailable estimator must degrade to null.
    @Optional()
    private readonly spreadTelemetry?: TradeSpreadTelemetryService,
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

    // The final market-safety quote is an ephemeral telemetry handoff. Only
    // OPEN transitions may consume it; terminal non-OPEN transitions discard
    // it because no entry was established.
    const executionQuote = target === TradeStatus.OPEN ? peekProvenExecutionQuote(params.tradeId) : null;
    const entryQuotePatch = buildEntryQuoteTelemetryPatch(executionQuote);
    const effectivePatch = entryQuotePatch
      ? ({ ...params.patch, ...entryQuotePatch } as QueryDeepPartialEntity<Trade>)
      : params.patch;

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
      .set(effectivePatch as never)
      .where('id = :id AND status IN (:...expected)', { id: params.tradeId, expected: legal })
      .execute();
    if (applied.affected) {
      const trade = await this.tradeRepo.findOne({ where: { id: params.tradeId } });
      if (trade) {
        this.afterTransitionTelemetry(trade, target, executionQuote, entryQuotePatch);
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
      // Idempotent: another writer already reached the target state. The raw
      // quote may not have been written by that writer, so telemetry fills it
      // best-effort without changing lifecycle truth.
      this.afterTransitionTelemetry(authoritative, target, executionQuote, entryQuotePatch, true);
      return { outcome: 'ALREADY_AT_TARGET', trade: authoritative };
    }

    if (TradeStateMachine.isTerminal(authoritative.status)) {
      // NEWER TERMINAL TRUTH — never regress it (a late UNKNOWN provider
      // response may not overwrite a reconciliation-proved CLOSED trade).
      discardProvenExecutionQuote(params.tradeId);
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
        .set(effectivePatch as never)
        .where('id = :id AND status = :status', {
          id: params.tradeId,
          status: authoritative.status,
        })
        .execute();
      if (converged.affected) {
        const trade = await this.tradeRepo.findOne({ where: { id: params.tradeId } });
        if (trade) {
          this.afterTransitionTelemetry(trade, target, executionQuote, entryQuotePatch);
          return { outcome: 'APPLIED', trade };
        }
        return { outcome: 'STATE_CONFLICT', trade: null, expected, target };
      }
      // The row moved again — reload + conflict (never loop).
      const reloaded = await this.tradeRepo.findOne({ where: { id: params.tradeId } });
      if (reloaded && TradeStateMachine.isTerminal(reloaded.status)) {
        discardProvenExecutionQuote(params.tradeId);
      }
      await this.recordDiscrepancy(params, expected, target, reloaded?.status ?? null);
      return { outcome: 'STATE_CONFLICT', trade: reloaded, expected, target };
    }

    await this.recordDiscrepancy(params, expected, target, authoritative.status);
    return { outcome: 'STATE_CONFLICT', trade: authoritative, expected, target };
  }

  /**
   * Runs only after lifecycle truth is durable. It must never be awaited by
   * the execution path: spread attribution is reporting telemetry and cannot
   * delay, block, or regress an OPEN position.
   */
  private afterTransitionTelemetry(
    trade: Trade,
    target: TradeStatus,
    quote: BrokerPrice | null,
    rawPatch: QueryDeepPartialEntity<Trade> | null,
    alreadyAtTarget = false,
  ): void {
    if (target !== TradeStatus.OPEN) {
      if (TradeStateMachine.isTerminal(target)) discardProvenExecutionQuote(trade.id);
      return;
    }

    if (!quote || !rawPatch) {
      discardProvenExecutionQuote(trade.id);
      return;
    }

    // If another writer already reached OPEN, preserve lifecycle truth and
    // fill missing raw telemetry best-effort. On the normal APPLIED path the
    // exact same fields were part of the atomic OPEN CAS above.
    if (alreadyAtTarget && !trade.entryQuoteBid) {
      void this.tradeRepo.update(trade.id, rawPatch as never).catch((err) =>
        this.logger.warn(
          `Trade ${trade.id} quote telemetry backfill failed after idempotent OPEN: ${(err as Error).message}`,
        ),
      );
    }

    discardProvenExecutionQuote(trade.id);
    void this.persistSpreadEstimateBestEffort(trade, quote);
  }

  /** Persist account-currency spread proxy after OPEN is durable. */
  private async persistSpreadEstimateBestEffort(trade: Trade, quote: BrokerPrice): Promise<void> {
    try {
      if (!this.spreadTelemetry || !trade.accountCurrency) return;
      const estimate = await this.spreadTelemetry.estimateEntrySpreadCost({
        userId: trade.userId,
        brokerConnectionId: trade.brokerConnectionId,
        instrument: trade.instrument,
        lotSize: trade.lotSize,
        accountCurrency: trade.accountCurrency,
        quote,
      });
      if (!estimate) return;

      await this.tradeRepo.update(trade.id, {
        estimatedSpreadCost: estimate.estimatedSpreadCost,
        spreadCostEstimateMethod: estimate.spreadCostEstimateMethod,
        spreadCostContractSize: estimate.spreadCostContractSize,
        spreadCostQuoteCurrency: estimate.spreadCostQuoteCurrency,
        spreadCostConversionRate: estimate.spreadCostConversionRate,
        spreadCostConversionInstrument: estimate.spreadCostConversionInstrument,
      });
    } catch (err) {
      this.logger.warn(
        `Trade ${trade.id} spread-cost estimation failed after OPEN: ${(err as Error).message}`,
      );
    }
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
