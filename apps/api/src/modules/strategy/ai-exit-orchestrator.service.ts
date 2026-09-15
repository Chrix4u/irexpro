import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionReadService } from '../execution/execution-read.service';
import {
  AiSignalIdentityGateService,
  SignalIdentityRegistration,
} from '../execution/orchestration/signal-identity.gate';
import { TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { TradeCloseReason, TradeStatus } from '../execution/entities/trade.entity';
import {
  AiExitResult,
  AiExitSignal,
  AiExitTradeResult,
  AiExitOutcome,
} from './interfaces/ai-exit-signal.interface';

/** Same confidence threshold as entry signals (symmetric decision quality). */
export const EXIT_CONFIDENCE_THRESHOLD = 0.6;

/**
 * AiExitOrchestratorService (Round 6 live-execution completion §10) — the
 * SERIALIZED AI exit pipeline.
 *
 * PIPELINE (every gate fail-closed, every step audited)
 * ─────────────────────────────────────────────────────────────────────────
 *   AiExitSignal
 *     → validate structure (typed EXIT_INVALID)
 *     → confidence threshold (LOW_CONFIDENCE)
 *     → session gate (ACTIVE session; tradingSessionId must match — a stale
 *       session reference is a stale decision)
 *     → SIGNAL IDENTITY GATE (#302 discipline applied to exits: persist-or-
 *       reuse by (userId, signalId); same digest → idempotent duplicate —
 *       the FIRST delivery's durable outcome is the truth, NEVER a re-close
 *       attempt; different digest → typed conflict audited by the gate)
 *     → §10 SERIALIZATION: per-user processing — target resolution and every
 *       closeTrade call for one user run strictly one-at-a-time (in-process
 *       promise-chain mutex). Cross-process safety is inherited from
 *       closeTrade's idempotent close-attempt sequence + CAS discipline.
 *     → resolve targets: tradeId → that exact trade; otherwise EVERY open
 *       position on the instrument for the user
 *     → ExecutionService.closeTrade(tradeId, userId, AI_CLOSE_SIGNAL) per
 *       target — risk-REDUCING: control-plane-exempt, market-safety-exempt,
 *       zero NEW-exposure surface (no grant, no sizing, no allocation)
 *     → aggregate outcome (EXIT_SUCCEEDED / EXIT_PARTIAL / EXIT_FAILED)
 *
 * NEVER a direct adapter call. NEVER a bypass of closeTrade's guards.
 */
@Injectable()
export class AiExitOrchestratorService {
  private readonly logger = new Logger(AiExitOrchestratorService.name);

  /**
   * §10 serialization: per-user in-process mutex (promise chain). Exits for
   * one user are strictly ordered; different users proceed concurrently.
   * The chain never rejects (the tail always resolves) so one failed exit
   * can never wedge later ones.
   */
  private readonly userExitChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly auditService: AuditService,
    @Inject(forwardRef(() => ExecutionService))
    private readonly executionService: ExecutionService,
    private readonly executionReadService: ExecutionReadService,
    private readonly signalIdentityGate: AiSignalIdentityGateService,
  ) {}

  /** Process one AI exit decision through the serialized pipeline. */
  async processExitSignal(signal: AiExitSignal): Promise<AiExitResult> {
    const { signalId, userId } = signal;
    this.logger.log(
      `Processing exit signal ${signalId} for user=${userId} instrument=${signal.instrument}` +
        (signal.tradeId ? ` trade=${signal.tradeId}` : ' (flatten instrument)'),
    );

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.AI_EXIT_SIGNAL_RECEIVED,
      severity: AuditSeverity.INFO,
      resourceType: 'AiSignal',
      resourceId: signalId,
      metadata: {
        kind: 'EXIT',
        instrument: signal.instrument,
        tradeId: signal.tradeId ?? null,
        confidenceScore: signal.confidenceScore,
        strategyCode: signal.strategyCode ?? null,
        modelVersion: signal.modelVersion ?? null,
      },
    });

    // ── Gate 1: structure ────────────────────────────────────────────────
    const structureError = this.validateStructure(signal);
    if (structureError) {
      return this.ignoreExit(signal, 'EXIT_INVALID', structureError);
    }

    // ── Gate 2: confidence (symmetric with the entry threshold) ──────────
    if (
      typeof signal.confidenceScore !== 'number' ||
      signal.confidenceScore < 0 ||
      signal.confidenceScore > 1
    ) {
      return this.ignoreExit(signal, 'EXIT_INVALID', 'confidenceScore must be 0–1');
    }
    if (signal.confidenceScore < EXIT_CONFIDENCE_THRESHOLD) {
      return this.ignoreExit(
        signal,
        'LOW_CONFIDENCE',
        `Confidence ${signal.confidenceScore} below threshold ${EXIT_CONFIDENCE_THRESHOLD}`,
      );
    }

    // ── Gate 3: session binding (a stale session reference is a stale
    // decision — same discipline as entry Gate 3) ─────────────────────────
    const session = await this.executionService.getActiveSession(userId);
    if (!session || session.status !== TradingSessionStatus.ACTIVE) {
      return this.ignoreExit(signal, 'SESSION_INACTIVE', 'No active trading session');
    }
    if (session.id !== signal.tradingSessionId) {
      return this.ignoreExit(
        signal,
        'SESSION_INACTIVE',
        `Exit session ${signal.tradingSessionId} does not match active session ${session.id}`,
      );
    }

    // ── Gate 4: signal identity (#302 discipline, exit material fields) ──
    let registration: SignalIdentityRegistration;
    try {
      registration = await this.signalIdentityGate.registerOrReuse(userId, {
        signalId,
        generatedAt: signal.generatedAt,
        materialFields: {
          kind: 'EXIT',
          instrument: signal.instrument,
          tradeId: signal.tradeId ?? null,
          strategyCode: signal.strategyCode ?? null,
          modelVersion: signal.modelVersion ?? null,
        },
      });
    } catch (err) {
      const reason = (err as Error).message ?? 'Signal identity rejected';
      return this.ignoreExit(signal, 'SIGNAL_IDENTITY_REJECTED', reason);
    }

    // ── §10 SERIALIZATION: everything from here on is per-user ordered ──
    return this.serializeForUser(userId, () =>
      this.processRegisteredExit(signal, registration),
    );
  }

  // ─── Serialized core ─────────────────────────────────────────────────────

  private async processRegisteredExit(
    signal: AiExitSignal,
    registration: SignalIdentityRegistration,
  ): Promise<AiExitResult> {
    // ── Gate 5: deterministic duplicate recovery ─────────────────────────
    // A duplicate delivery NEVER re-enters target resolution or closeTrade:
    // the FIRST delivery's durable outcome is the truth. The durable state
    // IS the trade status — all targeted trades CLOSED → the exit already
    // happened (idempotent success); targets still OPEN → the first attempt
    // did not close them (recovered failure). The AI engine mints a NEW
    // signalId for a fresh exit decision.
    if (registration.duplicate) {
      const targets = await this.resolveTargets(signal);
      const trades = targets.found.map((t) => ({
        tradeId: t.id,
        closed: t.status === TradeStatus.CLOSED,
        reason:
          t.status === TradeStatus.CLOSED
            ? undefined
            : `still ${t.status} after the first delivery`,
      }));
      const outcome: AiExitOutcome =
        trades.length === 0
          ? 'NO_OPEN_POSITION'
          : trades.every((t) => t.closed)
            ? 'EXIT_SUCCEEDED'
            : trades.some((t) => t.closed)
              ? 'EXIT_PARTIAL'
              : 'EXIT_FAILED';
      const result: AiExitResult = {
        outcome: 'DUPLICATE_RECOVERED',
        signalId: signal.signalId,
        trades,
        recoveredAs: outcome,
        reason: `Duplicate delivery — recovered from the first delivery's durable outcome (${outcome})`,
      };
      this.logger.log(`Exit signal ${signal.signalId}: duplicate recovered as ${outcome}`);
      return result;
    }

    // ── Gate 6: target resolution ────────────────────────────────────────
    const targets = await this.resolveTargets(signal);

    if (signal.tradeId && targets.found.length === 0) {
      // The referenced trade does not exist for this user at all.
      const result: AiExitResult = {
        outcome: 'EXIT_TARGET_NOT_FOUND',
        signalId: signal.signalId,
        trades: [],
        reason: `Trade ${signal.tradeId} not found for user`,
      };
      await this.auditService.log({
        actorUserId: signal.userId,
        action: AuditAction.AI_EXIT_SIGNAL_IGNORED,
        severity: AuditSeverity.WARNING,
        resourceType: 'AiSignal',
        resourceId: signal.signalId,
        metadata: {
          kind: 'EXIT',
          failureCode: 'EXIT_TARGET_NOT_FOUND',
          tradeId: signal.tradeId,
          message: result.reason,
        },
      });
      return result;
    }

    const openTargets = targets.found.filter((t) => t.status === TradeStatus.OPEN);
    if (openTargets.length === 0) {
      // Nothing to close — the position(s) already reached a terminal state
      // (closed/rejected/reconciled elsewhere). Idempotent, not an error.
      const result: AiExitResult = {
        outcome: 'NO_OPEN_POSITION',
        signalId: signal.signalId,
        trades: targets.found.map((t) => ({
          tradeId: t.id,
          closed: false,
          reason: `position already ${t.status}`,
        })),
        reason: `No OPEN position to exit (${signal.instrument})`,
      };
      await this.auditService.log({
        actorUserId: signal.userId,
        action: AuditAction.AI_EXIT_SIGNAL_IGNORED,
        severity: AuditSeverity.INFO,
        resourceType: 'AiSignal',
        resourceId: signal.signalId,
        metadata: {
          kind: 'EXIT',
          failureCode: 'NO_OPEN_POSITION',
          instrument: signal.instrument,
          message: result.reason,
        },
      });
      return result;
    }

    // ── Gate 7: serialized closes (risk-reducing — control/market-safety
    // exempt by operation class; every close is CAS-guarded + idempotent) ─
    const trades: AiExitTradeResult[] = [];
    let failedCloses = 0;
    for (const target of openTargets) {
      try {
        const closed = await this.executionService.closeTrade(
          target.id,
          signal.userId,
          TradeCloseReason.AI_CLOSE_SIGNAL,
        );
        trades.push({
          tradeId: target.id,
          closed: closed.status === TradeStatus.CLOSED,
          reason:
            closed.status === TradeStatus.CLOSED
              ? undefined
              : `close dispatched — trade now ${closed.status}`,
        });
      } catch (err) {
        // closeTrade is fail-closed per trade: a refused/unknown close
        // leaves the trade OPEN or RECONCILIATION_PENDING — never a silent
        // drop. One failed target must not abort the remaining de-risking.
        failedCloses++;
        const reason = (err as Error).message;
        trades.push({ tradeId: target.id, closed: false, reason });
        this.logger.warn(
          `Exit signal ${signal.signalId}: close of trade ${target.id} failed — ${reason}`,
        );
      }
    }

    const closedCount = trades.filter((t) => t.closed).length;
    // Progress = a close that did NOT throw: either confirmed CLOSED or
    // DISPATCHED-but-uncertain (RECONCILIATION_PENDING — reconciliation owns
    // the convergence). EXIT_FAILED is reserved for zero progress (every
    // attempt refused); a dispatched close is honest PARTIAL, never FAILED.
    const outcome: AiExitOutcome =
      closedCount === trades.length
        ? 'EXIT_SUCCEEDED'
        : failedCloses === trades.length
          ? 'EXIT_FAILED'
          : 'EXIT_PARTIAL';

    await this.auditService.log({
      actorUserId: signal.userId,
      action:
        outcome === 'EXIT_FAILED'
          ? AuditAction.AI_EXIT_SIGNAL_FAILED
          : AuditAction.AI_EXIT_SIGNAL_EXECUTED,
      severity: outcome === 'EXIT_FAILED' ? AuditSeverity.WARNING : AuditSeverity.INFO,
      resourceType: 'AiSignal',
      resourceId: signal.signalId,
      metadata: {
        kind: 'EXIT',
        instrument: signal.instrument,
        outcome,
        closedCount,
        targetCount: trades.length,
        trades: trades.map((t) => ({ tradeId: t.tradeId, closed: t.closed })),
      },
    });

    if (outcome === 'EXIT_FAILED') {
      return {
        outcome,
        signalId: signal.signalId,
        trades,
        reason: 'Every close attempt failed (see per-trade reasons)',
      };
    }
    return { outcome, signalId: signal.signalId, trades };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Structure validation — typed, fail-closed, no defaults invented. */
  private validateStructure(signal: AiExitSignal): string | null {
    if (!signal.signalId) return 'Missing signalId';
    if (!signal.userId) return 'Missing userId';
    if (!signal.tradingSessionId) return 'Missing tradingSessionId';
    if (!signal.instrument || signal.instrument.length < 3) return 'Invalid instrument';
    if (!signal.generatedAt) return 'Missing generatedAt';
    return null;
  }

  /**
   * Resolve close targets: the exact tradeId when provided (tenant-scoped),
   * otherwise EVERY open position on the instrument for the user.
   */
  private async resolveTargets(signal: AiExitSignal): Promise<{
    found: Array<{ id: string; status: TradeStatus }>;
  }> {
    const open = await this.executionReadService.listOpenPositions(signal.userId);
    if (signal.tradeId) {
      // Tenant-scoped existence check across ALL trades is not needed for a
      // close decision: only OPEN positions are closeable. A tradeId that is
      // not an open position of this user resolves to nothing (typed outcome
      // by the caller).
      const match = open.find((t) => t.id === signal.tradeId);
      return { found: match ? [{ id: match.id, status: match.status }] : [] };
    }
    return {
      found: open
        .filter((t) => t.instrument === signal.instrument)
        .map((t) => ({ id: t.id, status: t.status })),
    };
  }

  /** Audit + return a typed ignore outcome (pre-target failures). */
  private async ignoreExit(
    signal: AiExitSignal,
    outcome: AiExitOutcome,
    reason: string,
  ): Promise<AiExitResult> {
    this.logger.warn(`Exit signal ${signal.signalId} ${outcome}: ${reason}`);
    await this.auditService.log({
      actorUserId: signal.userId,
      action: AuditAction.AI_EXIT_SIGNAL_IGNORED,
      severity: AuditSeverity.INFO,
      resourceType: 'AiSignal',
      resourceId: signal.signalId,
      metadata: {
        kind: 'EXIT',
        failureCode: outcome,
        instrument: signal.instrument,
        message: reason,
      },
    });
    return { outcome, signalId: signal.signalId, trades: [], reason };
  }

  /**
   * §10 per-user serialization. The chain tail always resolves; failures
   * inside `work` are the CALLER's result values (never rejections that
   * could wedge the chain — processRegisteredExit catches per-trade errors
   * and returns typed outcomes).
   */
  private serializeForUser<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.userExitChains.get(userId) ?? Promise.resolve();
    // `previous` never rejects (the stored tail is always caught), so this
    // is pure ordering; a rejection inside `work` propagates to THIS
    // caller only — the stored tail stays clean for the next exit.
    const next = previous.then(work);
    this.userExitChains.set(userId, next.catch(() => undefined));
    return next;
  }
}
