import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ExactDecimal } from '../../common/utils/exact-decimal';
import { RiskService } from '../risk/risk.service';
import { ExecutionService } from '../execution/execution.service';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { Trade, TradeStatus } from '../execution/entities/trade.entity';
import { ProposedTrade } from '../risk/interfaces/risk.interface';
import {
  AiSignalIdentityGateService,
  SignalIdentityRegistration,
} from '../execution/orchestration/signal-identity.gate';
import { TradeIntentService, TradeIntentFacts } from '../execution/services/trade-intent.service';
import type { TradeIntent } from '../execution/entities/trade-intent.entity';
import { AllocationService } from '../execution/services/allocation.service';
import { PositionSizingService } from '../execution/services/position-sizing.service';
// Round 7.1 (P1 — sizing input freshness): the durable account-snapshot
// authority whose 30s LIVE freshness window is now enforced BEFORE sizing.
import {
  BrokerAccountSnapshotService,
  SnapshotNotFreshError,
} from '../broker/services/broker-account-snapshot.service';
import { BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { SharedControlRevisionService } from '../execution-authority/shared-control-revision.service';
// Round 7 (P1 metrics — audit R7-audit-C A6): dependency-free in-process
// counters. Resolved lazily via ModuleRef (see the getter below) — metrics
// can never affect pipeline control flow.
import { MetricsService } from '../metrics/metrics.service';
import { METRIC_NAMES } from '../metrics/metric-names';
import {
  AiSignalCandidate,
  StrategyDuplicateOfTrade,
  StrategyOutcome,
  StrategyResult,
} from './interfaces/strategy.interface';

/** Minimum confidence score required for a signal to proceed. */
const CONFIDENCE_THRESHOLD = 0.6;

/**
 * Round 6 (#302) — deterministic duplicate recovery: trade statuses whose
 * original execution is treated as SUCCEEDED when a duplicate re-delivery is
 * recovered from the existing durable trade (anything that reached or passed
 * the provider). REJECTED/CANCELLED recover as EXECUTION_FAILED.
 */
const DUPLICATE_ALIVE_TRADE_STATUSES: readonly TradeStatus[] = [
  TradeStatus.PENDING,
  TradeStatus.OPEN,
  TradeStatus.CLOSED,
  TradeStatus.RECONCILIATION_PENDING,
];

/**
 * StrategyOrchestratorService — Routes AI signal candidates through the
 * full validation pipeline before execution.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * MANDATORY PIPELINE — NEVER BYPASS:
 *   AiSignalCandidate
 *     → validate structure
 *     → confidence threshold
 *     → session active check
 *     → broker connection gate
 *     → SIGNAL IDENTITY GATE (#302, Round 5 task 50-c — BEFORE risk
 *       evaluation: persist-or-reuse AiSignalIdentity by (userId, signalId);
 *       same canonical digest (material fields + the exact generatedAt
 *       instant, Round 6) → idempotent proceed; different digest → typed
 *       conflict; stale/future generatedAt → typed rejection)
 *     → DUPLICATE RECOVERY (#302, Round 6 task 6-d: duplicate=true →
 *       recoverDuplicateOutcome() — the FIRST delivery's durable outcome is
 *       the truth; NEVER a fresh risk evaluation or provider dispatch)
 *     → RiskService.validateProposedTrade()  ← MANDATORY
 *     → ExecutionService.executeTrade()       ← only on APPROVED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Subscription/payment state is intentionally NOT part of this pipeline.
 * Users may trade without a paid plan; monetization is handled separately
 * from realised performance.
 *
 * There is NO direct path from signal to broker adapter.
 * The Risk Engine is always invoked before ExecutionService.
 */
@Injectable()
export class StrategyOrchestratorService {
  private readonly logger = new Logger(StrategyOrchestratorService.name);

  constructor(
    private readonly riskService: RiskService,
    @Inject(forwardRef(() => ExecutionService))
    private readonly executionService: ExecutionService,
    private readonly brokerService: BrokerService,
    // Round 7.1 (P1 — sizing input freshness): the LIVE fresh-snapshot
    // authority resolved BEFORE sizePosition (BrokerModule is already
    // imported by StrategyModule and exports this provider — no module
    // wiring change).
    private readonly brokerAccountSnapshotService: BrokerAccountSnapshotService,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
    private readonly signalIdentityGate: AiSignalIdentityGateService,
    // Round 6 live-execution completion (§2): the durable TradeIntent layer —
    // every NEW AI decision is normalized + persisted at intake, BEFORE risk
    // evaluation, with the authority generations CURRENT at creation.
    private readonly tradeIntentService: TradeIntentService,
    private readonly tradingAuthorityService: TradingAuthorityService,
    private readonly sharedControlRevisionService: SharedControlRevisionService,
    // Round 6 live-execution completion (§3/§4): the server-side
    // authoritative allocation engine + the deterministic fail-closed
    // position-sizing engine — every NEW decision is sized from PROVEN
    // inputs and its capital reserved BEFORE risk evaluation.
    private readonly positionSizingService: PositionSizingService,
    private readonly allocationService: AllocationService,
    /** Round 7 (P1 metrics): lazy MetricsService seam (never a constructor
     * injection — see the metrics getter for the DI decision). */
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Round 7 (P1 metrics — audit R7-audit-C A6): lazy metrics seam. Resolved
   * at CALL time via ModuleRef.get(..., { strict: false }) — the app-wide
   * lookup finds the MetricsModule singleton (registered once in AppModule).
   * Direct constructor injection was rejected: it would demand a
   * MetricsService provider in EVERY spec constructing this service
   * (incl. out-of-scope suites) plus module-file imports outside the approved
   * file scope. In isolated test contexts the lookup fails → null → the
   * `this.metrics?.increment(...)` call sites no-op (MetricsService methods
   * never throw). Never affects control flow.
   */
  private get metrics(): MetricsService | null {
    try {
      return this.moduleRef.get(MetricsService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Process an AI signal candidate through the full validation pipeline.
   *
   * Returns a StrategyResult describing what happened at each gate.
   * Any gate failure stops processing immediately (fail-closed behavior).
   */
  async processSignal(candidate: AiSignalCandidate): Promise<StrategyResult> {
    const { signalId, userId } = candidate;
    this.logger.log(
      `Processing signal ${signalId} for user=${userId} instrument=${candidate.instrument}`,
    );

    // Resolved ACTIVE session authority — the ProposedTrade binding is
    // populated FROM this session (Round 5 #295/#298: never the candidate's
    // possibly-stale connection reference, never re-discovered downstream).
    let session: TradingSession | null = null;

    // ── Gate 1: Validate signal structure ─────────────────────────────────────
    const structureError = this.validateStructure(candidate);
    if (structureError) {
      this.logger.warn(`Signal ${signalId} rejected: invalid structure — ${structureError}`);
      await this.recordIgnored(
        candidate,
        'SIGNAL_INVALID',
        'INVALID_STRUCTURE',
        'Signal structure failed validation',
      );
      return { outcome: 'SIGNAL_INVALID', signalId, reason: structureError };
    }

    const uatWorkflowProbeRequested =
      candidate.strategyCode.startsWith('uat-workflow-probe-') &&
      candidate.metadata?.uat_workflow_probe === true &&
      candidate.metadata?.production_eligible === false;

    // ── Gate 2: Confidence threshold ──────────────────────────────────────────
    // Normal AI signals remain hard-gated at 0.60. A Research PAPER UAT
    // workflow probe may defer this rejection only until the authoritative
    // PAPER_ONLY + internal-paper-broker boundary is proven below.
    if (candidate.confidenceScore < CONFIDENCE_THRESHOLD && !uatWorkflowProbeRequested) {
      const reason = `Confidence ${candidate.confidenceScore} below threshold ${CONFIDENCE_THRESHOLD}`;
      this.logger.log(`Signal ${signalId} ignored: ${reason}`);
      await this.recordIgnored(
        candidate,
        'LOW_CONFIDENCE',
        'LOW_CONFIDENCE',
        'Model confidence was below the execution threshold',
      );
      return { outcome: 'LOW_CONFIDENCE', signalId, reason };
    }

    // ── Gate 3: Trading session active ────────────────────────────────────────
    try {
      session = await this.executionService.getActiveSession(userId);
      if (!session || session.status !== TradingSessionStatus.ACTIVE) {
        const reason = 'No active trading session';
        this.logger.warn(`Signal ${signalId} rejected: ${reason}`);
        await this.recordIgnored(
          candidate,
          'SESSION_INACTIVE',
          'SESSION_INACTIVE',
          'No active trading session was available',
        );
        return { outcome: 'SESSION_INACTIVE', signalId, reason };
      }
      if (session.id !== candidate.tradingSessionId) {
        const reason = `Signal session ${candidate.tradingSessionId} does not match active session ${session.id}`;
        this.logger.warn(`Signal ${signalId} rejected: ${reason}`);
        await this.recordIgnored(
          candidate,
          'SESSION_INACTIVE',
          'SESSION_MISMATCH',
          'Signal did not match the active trading session',
        );
        return { outcome: 'SESSION_INACTIVE', signalId, reason };
      }
    } catch (err) {
      const reason = 'Failed to verify trading session';
      this.logger.error(`Signal ${signalId}: session check error`, (err as Error).message);
      await this.recordIgnored(
        candidate,
        'SESSION_INACTIVE',
        'SESSION_CHECK_FAILED',
        'Trading session could not be verified',
      );
      return { outcome: 'SESSION_INACTIVE', signalId, reason };
    }

    // ── Gate 4: Broker connection active ──────────────────────────────────────
    try {
      const hasBroker = await this.brokerService.hasActiveConnection(userId);
      if (!hasBroker) {
        const reason = 'No active broker connection';
        this.logger.warn(`Signal ${signalId} rejected: ${reason}`);
        await this.recordIgnored(
          candidate,
          'NO_BROKER_CONNECTION',
          'BROKER_UNAVAILABLE',
          'No active broker connection was available',
        );
        return { outcome: 'NO_BROKER_CONNECTION', signalId, reason };
      }
    } catch (err) {
      const reason = 'Failed to verify broker connection';
      this.logger.error(`Signal ${signalId}: broker check error`, (err as Error).message);
      await this.recordIgnored(
        candidate,
        'NO_BROKER_CONNECTION',
        'BROKER_CHECK_FAILED',
        'Broker connection could not be verified',
      );
      return { outcome: 'NO_BROKER_CONNECTION', signalId, reason };
    }

    // Type-narrowing guard: Gate 3 returned on every failure path, so the
    // session is non-null here (unreachable in practice — kept explicit so
    // the compiler enforces the binding completeness below).
    if (!session) {
      return { outcome: 'SESSION_INACTIVE', signalId, reason: 'No active trading session' };
    }

    let executionCandidate = candidate;

    if (uatWorkflowProbeRequested) {
      let boundConnection;
      try {
        boundConnection = await this.brokerService.findConnectionById(
          session.brokerConnectionId,
          userId,
        );
      } catch {
        boundConnection = null;
      }

      const safePaperBoundary =
        session.executionMode === ExecutionMode.PAPER_ONLY &&
        candidate.brokerConnectionId === session.brokerConnectionId &&
        boundConnection?.brokerId === 'paper-broker' &&
        boundConnection?.accountType === BrokerMode.DEMO;

      if (!safePaperBoundary) {
        const reason =
          'UAT workflow probe rejected: requires exact PAPER_ONLY internal paper-broker DEMO session';
        this.logger.warn(`Signal ${signalId} rejected: ${reason}`);
        await this.recordIgnored(
          candidate,
          'LOW_CONFIDENCE',
          'UAT_PROBE_BOUNDARY_REJECTED',
          reason,
        );
        return { outcome: 'LOW_CONFIDENCE', signalId, reason };
      }

      this.logger.warn(
        `Research PAPER UAT workflow probe accepted below confidence threshold: ` +
          `signal=${signalId} confidence=${candidate.confidenceScore}`,
      );

      // The historical replay and the execution simulator are intentionally
      // separate markets. A workflow probe must therefore be REBASED onto the
      // paper broker's CURRENT quote after the exact safe boundary above is
      // proven. This is not a model signal rewrite: the original replay
      // reference/protection levels remain in metadata for audit, while only
      // this production_eligible=false PAPER probe receives executable test
      // geometry. Normal model signals, provider DEMO, and LIVE never enter
      // this branch, and the final market-safety gate remains mandatory.
      try {
        executionCandidate = await this.rebaseResearchPaperWorkflowProbe(candidate, session);
      } catch (err) {
        const reason =
          `Research PAPER workflow probe could not be aligned to the paper execution market: ` +
          `${(err as Error).message}`;
        this.logger.warn(`Signal ${signalId}: ${reason}`);
        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.AI_SIGNAL_EXECUTION_FAILED,
          severity: AuditSeverity.WARNING,
          resourceType: 'AiSignal',
          resourceId: signalId,
          metadata: {
            instrument: candidate.instrument,
            direction: candidate.direction,
            failureCode: 'UAT_EXECUTION_MARKET_UNPROVABLE',
          },
        });
        this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, {
          outcome: 'EXECUTION_FAILED',
        });
        return { outcome: 'EXECUTION_FAILED', signalId, reason };
      }
    }

    // ── Gate 4.5: Signal identity (#302, Round 5 task 50-c) ──────────────
    // Persist-or-reuse the durable identity BEFORE risk evaluation: retries
    // and redeliveries never produce a second logical evaluation; a same-
    // signalId/different canonical digest (material fields OR generatedAt) is
    // a SECURITY EVENT (typed conflict, audited by the gate — never a new
    // idempotency key); stale/future generatedAt is typed-rejected.
    let registration: SignalIdentityRegistration;
    try {
      registration = await this.signalIdentityGate.registerOrReuse(userId, {
        signalId,
        generatedAt: candidate.generatedAt,
        materialFields: {
          instrument: executionCandidate.instrument,
          direction: executionCandidate.direction,
          requestedLotSize: String(executionCandidate.suggestedVolume),
          entryPrice: executionCandidate.suggestedEntryPrice,
          stopLoss: executionCandidate.suggestedStopLoss,
          takeProfit: executionCandidate.suggestedTakeProfit,
          strategyCode: executionCandidate.strategyCode,
          timeframe: executionCandidate.timeframe,
          modelVersion: executionCandidate.modelVersion,
        },
      });
    } catch (err) {
      const reason = (err as Error).message ?? 'Signal identity rejected';
      this.logger.warn(`Signal ${signalId} rejected at the identity gate: ${reason}`);
      await this.recordIgnored(
        candidate,
        'SIGNAL_INVALID',
        'SIGNAL_IDENTITY_REJECTED',
        `Signal identity gate rejected the delivery: ${reason}`,
      );
      return { outcome: 'SIGNAL_INVALID', signalId, reason };
    }

    // ── Gate 4.6: Deterministic duplicate recovery (#302, Round 6 6-d) ──
    // A duplicate delivery NEVER re-enters risk evaluation or dispatch: the
    // FIRST delivery's durable outcome is the truth for this signalId.
    if (registration.duplicate) {
      return this.recoverDuplicateOutcome(candidate, registration);
    }

    // ── Gate 4.7: Durable TradeIntent recording (Round 6 §2) ────────────
    // EVERY new AI decision is normalized into a durable TradeIntent BEFORE
    // risk evaluation: full decision provenance (source decision id +
    // ORIGINAL generatedAt, user, connection/logical account, strategy/
    // model/version, instrument, direction, entry type, requested exposure,
    // protective parameters, expiry, rationale, authority generations at
    // creation). Idempotent per (userId, signalId) — the unique intent key
    // means retries/worker restarts/queue redelivery can never mint a second
    // equivalent intent. Fail-closed: without the durable intent the decision
    // may NOT proceed to risk evaluation (executeTrade enforces the guard).
    let tradeIntent: TradeIntent;
    try {
      tradeIntent = await this.recordTradeIntent(executionCandidate, session, registration);
    } catch (err) {
      const reason = `Trade intent could not be recorded (fail-closed): ${(err as Error).message}`;
      this.logger.error(`Signal ${signalId}: intent recording failed`, (err as Error).stack);
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.AI_SIGNAL_EXECUTION_FAILED,
        severity: AuditSeverity.CRITICAL,
        resourceType: 'AiSignal',
        resourceId: signalId,
        metadata: {
          instrument: candidate.instrument,
          direction: candidate.direction,
          failureCode: 'TRADE_INTENT_RECORD_FAILED',
          message: (err as Error).message,
        },
      });
      this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, {
        outcome: 'EXECUTION_FAILED',
      });
      return { outcome: 'EXECUTION_FAILED', signalId, reason };
    }

    // ── Gate 4.8: Position sizing + capital allocation (Round 6 §3/§4) ──
    // The decision's volume is DERIVED from proven inputs (authoritative
    // equity, risk budget, stop-loss distance, PROVEN contract size and
    // instrument constraints — ExactDecimal only; missing input = typed
    // fail-closed, NEVER a guessed lot size), then the capital is reserved
    // against the account's explicit allocation budget inside the serialized
    // critical section (double allocation / strategy conflicts / multi-worker
    // races are impossible). The AI's suggested volume is provenance only —
    // the SIZED volume is what flows to the Risk Engine.
    let sized;
    try {
      // Round 7.1 (P1 — sizing input freshness): resolve the LIVE fresh-
      // snapshot authority BEFORE sizing. PositionSizingService reads equity
      // from the durable account snapshot with NO age check at sizing time,
      // and the 30s LIVE freshness window was previously enforced only LATER
      // at risk Step 2-live — which refreshes the snapshot AFTER sizing — so
      // lots could be computed from equity up to 60s+ old while risk
      // validated with fresh numbers. DEMO/PAPER connections are unchanged
      // (no sizing-time freshness gate). Any failure is the typed rejection
      // below (never a stale-equity sizing).
      await this.ensureLiveSizingSnapshotFresh(userId, session);
      sized = await this.positionSizingService.sizePosition({
        userId,
        brokerConnectionId: session.brokerConnectionId,
        instrument: executionCandidate.instrument,
        direction: executionCandidate.direction,
        entryType: executionCandidate.suggestedEntryPrice != null ? 'LIMIT' : 'MARKET',
        requestedEntryPrice:
          executionCandidate.suggestedEntryPrice != null
            ? String(executionCandidate.suggestedEntryPrice)
            : null,
        stopLoss:
          executionCandidate.suggestedStopLoss != null
            ? String(executionCandidate.suggestedStopLoss)
            : null,
      });
      await this.allocationService.resolveOrAllocate({
        intent: {
          id: tradeIntent.id,
          userId,
          brokerConnectionId: session.brokerConnectionId,
          instrument: candidate.instrument,
          direction: candidate.direction,
          strategyCode: candidate.strategyCode ?? null,
          // Round 7 (P0 allocation-scope fix): the durable intent carries the
          // connection's server-computed logical account key captured at
          // creation — the allocation engine must reserve against the REAL
          // per-account scope (the budget is seeded per (user, logical
          // account)), never a synthetic unseedable connection scope.
          logicalAccountKey: tradeIntent.logicalAccountKey,
        },
        // Round 7 (P0 allocation-scope fix): the REAL logical account scope.
        // The previous `null` made the engine substitute a synthetic
        // `conn:<connectionId>` scope whose budget can NEVER be seeded
        // (budget seeding resolves connections by their REAL
        // logical_account_key) — every entry failed
        // ALLOCATION_BUDGET_UNPROVABLE. Null is still passed through when the
        // intent genuinely carries none; the engine then fail-closes with the
        // same typed code (no silent unseedable scoping).
        logicalAccountKey: tradeIntent.logicalAccountKey,
        sized,
      });
    } catch (err) {
      // Round 7.1 (P1 — sizing input freshness): a LIVE freshness rejection
      // surfaces its TYPED SNAPSHOT_* code — never the generic default.
      const code =
        (err as { code?: string }).code ??
        (err instanceof SnapshotNotFreshError ? err.failure.code : undefined) ??
        'SIZING_ALLOCATION_FAILED';
      const reason = `Position sizing/allocation failed closed [${code}]: ${(err as Error).message}`;
      this.logger.warn(`Signal ${signalId}: ${reason}`);
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.AI_SIGNAL_EXECUTION_FAILED,
        severity: AuditSeverity.WARNING,
        resourceType: 'AiSignal',
        resourceId: signalId,
        metadata: {
          instrument: candidate.instrument,
          direction: candidate.direction,
          failureCode: code,
          message: (err as Error).message,
        },
      });
      this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, {
        outcome: 'EXECUTION_FAILED',
      });
      // Typed failure classification: AllocationError codes are all
      // ALLOCATION_-prefixed; every other typed code is a sizing failure.
      this.metrics?.increment(
        code.startsWith('ALLOCATION_')
          ? METRIC_NAMES.ALLOCATION_FAILURES
          : METRIC_NAMES.SIZING_FAILURES,
        { code },
      );
      return { outcome: 'EXECUTION_FAILED', signalId, reason };
    }

    // ── Build ProposedTrade ────────────────────────────────────────────────────────
    // (Round 5 #295/#298/#301/#302): the authority binding comes from the
    // RESOLVED ACTIVE session (Gate 3) — sessionId, sessionGeneration,
    // executionMode and the session's EXACT brokerConnectionId. The Risk
    // Engine fails closed with AUTHORITY_BINDING_REQUIRED when these are
    // missing, and rejects a stale binding (SESSION_AUTHORITY_MISMATCH)
    // instead of silently rebinding. generatedAt flows from the signal
    // producer (#302 freshness). marketRegime is normalized to the risk
    // engine's regime vocabulary — an unrecognized label stays undefined so
    // the risk layer fails closed when the profile enforces regime rules.
    const proposedTrade: ProposedTrade = {
      signalId: candidate.signalId,
      instrument: candidate.instrument,
      direction: candidate.direction,
      // Round 6 §4: the SIZED volume (risk-budget-derived, instrument-
      // normalized) — never the raw AI suggestion.
      requestedLotSize: sized.lots,
      entryPrice:
        executionCandidate.suggestedEntryPrice != null
          ? String(executionCandidate.suggestedEntryPrice)
          : '0',
      stopLoss: String(executionCandidate.suggestedStopLoss),
      takeProfit: String(executionCandidate.suggestedTakeProfit),
      idempotencyKey: `${candidate.userId}:${candidate.signalId}`,
      volatilityScore: candidate.volatilityScore,
      regime: normalizeMarketRegime(candidate.marketRegime),
      sessionId: session.id,
      sessionGeneration: session.authorityGeneration,
      executionMode: session.executionMode,
      brokerConnectionId: session.brokerConnectionId,
      generatedAt: candidate.generatedAt,
    };

    // ── Gate 5: Risk Engine ────────────────────────────────────────────────────
    let riskDecision;
    try {
      riskDecision = await this.riskService.validateProposedTrade(userId, proposedTrade);
    } catch (err) {
      const reason = 'Risk Engine error — trade rejected (fail-closed)';
      this.logger.error(`Signal ${signalId}: risk engine exception`, (err as Error).message);
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.AI_SIGNAL_RISK_REJECTED,
        severity: AuditSeverity.CRITICAL,
        resourceType: 'AiSignal',
        resourceId: signalId,
        metadata: {
          instrument: candidate.instrument,
          direction: candidate.direction,
          rejectionCode: 'RISK_ENGINE_ERROR',
          rejectionReason: reason,
        },
      });
      this.eventBus.publish(DomainEventType.RISK_SIGNAL_REJECTED, userId, {
        userId,
        instrument: candidate.instrument,
        direction: candidate.direction,
        decision: 'REJECTED',
        rejectionCode: 'RISK_ENGINE_ERROR',
        rejectionReason: reason,
      });
      this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, {
        outcome: 'RISK_REJECTED',
      });
      return { outcome: 'RISK_REJECTED', signalId, reason };
    }

    if (riskDecision.decision !== 'APPROVED') {
      const outcome: StrategyOutcome =
        riskDecision.decision === 'SUSPENDED' ? 'RISK_SUSPENDED' : 'RISK_REJECTED';
      this.logger.warn(
        `Signal ${signalId} RISK ${riskDecision.decision}: ${riskDecision.rejectionCode}`,
      );
      // §2: a risk rejection is DEFINITIVE for this decision — the intent is
      // terminally REJECTED (a replay of the same AI decision can never
      // re-enter exposure through the intent guard).
      await this.tradeIntentService
        .markRejected(tradeIntent.id)
        .catch((err) =>
          this.logger.warn(
            `Signal ${signalId}: intent ${tradeIntent.id} could not be marked REJECTED ` +
              `(${(err as Error).message}) — the duplicate-recovery path still fails closed`,
          ),
        );
      // §3: the capital reservation is released with the decision (definitive
      // non-exposure — the ledger records why).
      await this.allocationService
        .releaseAllocationForIntent(tradeIntent.id, `RISK_${riskDecision.decision}`)
        .catch((err) =>
          this.logger.warn(
            `Signal ${signalId}: allocation for intent ${tradeIntent.id} could not be ` +
              `released (${(err as Error).message}) — the aggregate self-heals from intent status`,
          ),
        );
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.AI_SIGNAL_RISK_REJECTED,
        severity: AuditSeverity.WARNING,
        resourceType: 'AiSignal',
        resourceId: signalId,
        metadata: {
          instrument: candidate.instrument,
          direction: candidate.direction,
          rejectionCode: riskDecision.rejectionCode,
          rejectionReason: riskDecision.rejectionReason,
        },
      });
      this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome });
      this.metrics?.increment(METRIC_NAMES.INTENTS_REJECTED, {
        code: riskDecision.rejectionCode,
      });
      return {
        outcome,
        signalId,
        reason: `${riskDecision.rejectionCode}: ${riskDecision.rejectionReason}`,
      };
    }

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.AI_SIGNAL_RISK_APPROVED,
      severity: AuditSeverity.INFO,
      resourceType: 'AiSignal',
      resourceId: signalId,
      metadata: {
        instrument: candidate.instrument,
        direction: candidate.direction,
      },
    });

    // ── Gate 6: Execution ──────────────────────────────────────────────────────
    // SEMI_AUTO (Round 5 task 50-c, #298): the automated pipeline may NEVER
    // dispatch NEW exposure for a SEMI_AUTO approval — the user's one-time
    // confirmation (POST /execution/confirmations/:id/confirm) is the only
    // dispatch path. The approval + its PENDING confirmation are durable;
    // this outcome is honest: nothing failed, the trade awaits the user.
    if (riskDecision.executionMode === 'SEMI_AUTO') {
      this.logger.log(
        `Signal ${signalId} approved under SEMI_AUTO — awaiting the user one-time ` +
          'confirmation (no automated dispatch).',
      );
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.AI_SIGNAL_RISK_APPROVED,
        severity: AuditSeverity.INFO,
        resourceType: 'AiSignal',
        resourceId: signalId,
        metadata: {
          instrument: candidate.instrument,
          direction: candidate.direction,
          executionMode: riskDecision.executionMode,
          grantId: riskDecision.grantId ?? null,
          awaiting: 'USER_EXECUTION_CONFIRMATION',
        },
      });
      this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, {
        outcome: 'EXECUTION_PENDING_CONFIRMATION',
      });
      return {
        outcome: 'EXECUTION_PENDING_CONFIRMATION',
        signalId,
        reason:
          'Approved under SEMI_AUTO — awaiting the user one-time confirmation ' +
          '(the automated pipeline never dispatches SEMI_AUTO new exposure).',
      };
    }

    try {
      const trade = await this.executionService.executeTrade(userId, riskDecision);
      this.logger.log(
        `Signal ${signalId} execution returned: tradeId=${trade.id} status=${trade.status}`,
      );

      // executeTrade() intentionally RETURNS durable terminal/uncertain truth
      // for several fail-closed paths instead of throwing. A non-throwing
      // call is therefore not synonymous with a successful execution.
      // Only a PENDING/OPEN/CLOSED trade proves that the entry is alive or has
      // completed. REJECTED/CANCELLED and RECONCILIATION_PENDING must never
      // inflate the scheduler's "executed" counter.
      const provenExecutionStatuses: readonly TradeStatus[] = [
        TradeStatus.PENDING,
        TradeStatus.OPEN,
        TradeStatus.CLOSED,
      ];
      if (!provenExecutionStatuses.includes(trade.status)) {
        const reason =
          trade.status === TradeStatus.RECONCILIATION_PENDING
            ? 'Execution outcome is unresolved and awaiting reconciliation'
            : `Execution ended ${trade.status} before active exposure was established`;
        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.AI_SIGNAL_EXECUTION_FAILED,
          severity:
            trade.status === TradeStatus.RECONCILIATION_PENDING
              ? AuditSeverity.CRITICAL
              : AuditSeverity.WARNING,
          resourceType: 'Trade',
          resourceId: trade.id,
          metadata: {
            signalId,
            instrument: candidate.instrument,
            direction: candidate.direction,
            strategyCode: candidate.strategyCode,
            failureCode: `EXECUTION_RETURNED_${trade.status}`,
          },
        });
        this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, {
          outcome: 'EXECUTION_FAILED',
        });
        return { outcome: 'EXECUTION_FAILED', signalId, tradeId: trade.id, reason };
      }

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.AI_SIGNAL_EXECUTED,
        severity: AuditSeverity.INFO,
        resourceType: 'Trade',
        resourceId: trade.id,
        metadata: {
          signalId,
          instrument: candidate.instrument,
          direction: candidate.direction,
          strategyCode: candidate.strategyCode,
          tradeStatus: trade.status,
        },
      });
      this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, {
        outcome: 'EXECUTION_SUCCEEDED',
      });
      return { outcome: 'EXECUTION_SUCCEEDED', signalId, tradeId: trade.id };
    } catch (err) {
      const reason = `Execution failed: ${(err as Error).message}`;
      this.logger.error(`Signal ${signalId} execution error`, (err as Error).message);
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.AI_SIGNAL_EXECUTION_FAILED,
        severity: AuditSeverity.CRITICAL,
        resourceType: 'AiSignal',
        resourceId: signalId,
        metadata: {
          instrument: candidate.instrument,
          direction: candidate.direction,
          failureCode: 'EXECUTION_ERROR',
        },
      });
      this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, {
        outcome: 'EXECUTION_FAILED',
      });
      return { outcome: 'EXECUTION_FAILED', signalId, reason };
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Rebase a production-ineligible Research PAPER workflow probe from its
   * historical replay geometry onto the CURRENT internal paper execution
   * quote. The original replay values remain in metadata for provenance.
   *
   * This helper is called only AFTER processSignal has proven:
   * PAPER_ONLY + paper-broker + DEMO + matching session/connection.
   * It never applies to a normal model signal or any real provider.
   */
  private async rebaseResearchPaperWorkflowProbe(
    candidate: AiSignalCandidate,
    session: TradingSession,
  ): Promise<AiSignalCandidate> {
    if (candidate.suggestedEntryPrice == null) {
      throw new Error('replay reference price is missing');
    }

    const quote = await this.brokerService.getCurrentPriceForConnection(
      candidate.userId,
      session.brokerConnectionId,
      candidate.instrument,
    );
    if (!quote) {
      throw new Error('current paper quote is unavailable');
    }

    const bid = ExactDecimal.tryParse(String(quote.bid));
    const ask = ExactDecimal.tryParse(String(quote.ask));
    const replayEntry = ExactDecimal.tryParse(String(candidate.suggestedEntryPrice));
    const replayStop = ExactDecimal.tryParse(String(candidate.suggestedStopLoss));
    const replayTake = ExactDecimal.tryParse(String(candidate.suggestedTakeProfit));
    if (
      !bid?.isPositive() ||
      !ask?.isPositive() ||
      ask.lt(bid) ||
      !replayEntry?.isPositive() ||
      !replayStop?.isPositive() ||
      !replayTake?.isPositive()
    ) {
      throw new Error('paper quote or replay protection geometry is invalid');
    }

    const stopDistance = replayEntry.sub(replayStop).abs();
    const takeDistance = replayTake.sub(replayEntry).abs();
    if (!stopDistance.isPositive() || !takeDistance.isPositive()) {
      throw new Error('replay stop/take distance is not positive');
    }

    const executionEntry = bid.add(ask).div(ExactDecimal.parse('2'), {
      scale: 5,
      mode: 'HALF_UP',
    });
    const executionStop =
      candidate.direction === 'BUY'
        ? executionEntry.sub(stopDistance)
        : executionEntry.add(stopDistance);
    const executionTake =
      candidate.direction === 'BUY'
        ? executionEntry.add(takeDistance)
        : executionEntry.sub(takeDistance);

    if (!executionStop.isPositive() || !executionTake.isPositive()) {
      throw new Error('rebased paper protection level is not positive');
    }

    const entryText = executionEntry.toFixed(5, 'HALF_UP');
    const stopText = executionStop.toFixed(5, 'HALF_UP');
    const takeText = executionTake.toFixed(5, 'HALF_UP');

    return {
      ...candidate,
      suggestedEntryPrice: Number(entryText),
      suggestedStopLoss: Number(stopText),
      suggestedTakeProfit: Number(takeText),
      metadata: {
        ...(candidate.metadata ?? {}),
        uat_execution_probe_rebased: true,
        uat_replay_reference_price: String(candidate.suggestedEntryPrice),
        uat_replay_stop_loss: String(candidate.suggestedStopLoss),
        uat_replay_take_profit: String(candidate.suggestedTakeProfit),
        uat_execution_reference_price: entryText,
        uat_execution_stop_loss: stopText,
        uat_execution_take_profit: takeText,
      },
    };
  }

  /**
   * Round 7.1 (P1 — sizing input freshness): resolve the LIVE fresh-snapshot
   * authority BEFORE position sizing (Gate 4.8).
   *
   * The sizing engine derives lots from the durable account snapshot's
   * equity; that read carries no age check, so the 30s LIVE freshness window
   * must be enforced HERE — before the volume is computed — instead of only
   * at risk Step 2-live, which resolves/refreshes the snapshot AFTER sizing
   * (lots computed from equity up to 60s+ old while risk validated with
   * fresh numbers).
   *
   * Resolution pattern — IDENTICAL to risk Step 2-live (risk.service.ts):
   *   1. resolveFreshSnapshotForNewExposure(connection.id);
   *   2. on SnapshotNotFreshError SNAPSHOT_STALE / SNAPSHOT_MISSING → ONE
   *      bounded synchronous provider observation
   *      (observeAccountSnapshotNow — the §1a write path) → re-resolve;
   *   3. any failure propagates (typed, fail-closed — a failed refresh never
   *      authorizes a stale snapshot, and a stale snapshot never sizes).
   *
   * DEMO/PAPER connections return immediately — no sizing-time freshness
   * gate (their behavior is unchanged).
   */
  private async ensureLiveSizingSnapshotFresh(
    userId: string,
    session: TradingSession,
  ): Promise<void> {
    // The EXACT session-bound connection (ownership enforced by
    // findConnectionById; a missing row is the caller's typed fail-closed
    // rejection — the account type can never be guessed).
    const connection = await this.brokerService.findConnectionById(
      session.brokerConnectionId,
      userId,
    );
    if (connection.accountType !== BrokerMode.LIVE) {
      return; // DEMO/PAPER: no sizing-time freshness gate.
    }
    try {
      await this.brokerAccountSnapshotService.resolveFreshSnapshotForNewExposure(connection.id);
    } catch (snapErr) {
      if (
        snapErr instanceof SnapshotNotFreshError &&
        (snapErr.failure.code === 'SNAPSHOT_STALE' || snapErr.failure.code === 'SNAPSHOT_MISSING')
      ) {
        // ONE bounded synchronous provider observation, then re-resolve —
        // LIVE sizing availability is structural, not cadence-luck.
        await this.brokerService.observeAccountSnapshotNow(userId, connection.id);
        await this.brokerAccountSnapshotService.resolveFreshSnapshotForNewExposure(connection.id);
      } else {
        throw snapErr;
      }
    }
  }

  /**
   * Round 6 live-execution completion (§2): record (or reuse) the durable
   * TradeIntent for ONE new AI decision — the normalized, provenance-complete
   * form of the decision, persisted BEFORE risk evaluation.
   *
   * Fail-closed by construction: the authority generations CURRENT at creation
   * are read from the authoritative services (never defaulted); the ORIGINAL
   * identity-gate-registered generatedAt is the decision instant (a replay can
   * never refresh it); the connection's logical-account key is read
   * best-effort (a transient read failure records NULL — the trade's own
   * immutable provenance still carries the authoritative key at reservation).
   *
   * Returns the durable intent (created or reused — a UNIQUE(user_id,
   * intent_key) race means a concurrent worker already recorded it; the
   * winner's row is the truth, never a second intent).
   */
  private async recordTradeIntent(
    candidate: AiSignalCandidate,
    session: TradingSession,
    registration: SignalIdentityRegistration,
  ) {
    const { userId, signalId } = candidate;

    // Authority/policy generations CURRENT at creation — fail-closed reads
    // (the services never default; an unreadable store throws, which the
    // caller treats as a pipeline failure, not a silent 1/0).
    const [
      authorityGeneration,
      tradingPolicyRevision,
      providerVerificationRevision,
      executionControlRevision,
    ] = await Promise.all([
      this.tradingAuthorityService.getCurrentGeneration(userId),
      this.sharedControlRevisionService.getCurrentTradingPolicyRevision(),
      this.sharedControlRevisionService.getCurrentProviderVerificationRevision(),
      this.sharedControlRevisionService.getCurrentExecutionControlRevision(),
    ]);

    // Best-effort logical-account key at intake (§2 provenance; the
    // authoritative key is re-proven at reservation from the grant binding).
    let logicalAccountKey: string | null = null;
    try {
      const connection = await this.brokerService.findConnectionById(
        session.brokerConnectionId,
        userId,
      );
      logicalAccountKey = connection?.logicalAccountKey ?? null;
    } catch {
      logicalAccountKey = null;
    }

    const facts: TradeIntentFacts = {
      userId,
      signalId,
      signalGeneratedAt: registration.generatedAt,
      brokerConnectionId: session.brokerConnectionId,
      logicalAccountKey,
      tradingSessionId: session.id,
      strategyCode: candidate.strategyCode ?? null,
      modelVersion: candidate.modelVersion ?? null,
      timeframe: candidate.timeframe ?? null,
      instrument: candidate.instrument,
      direction: candidate.direction,
      requestedLotSize: String(candidate.suggestedVolume),
      requestedEntryPrice:
        candidate.suggestedEntryPrice != null ? String(candidate.suggestedEntryPrice) : null,
      stopLoss: candidate.suggestedStopLoss != null ? String(candidate.suggestedStopLoss) : null,
      takeProfit:
        candidate.suggestedTakeProfit != null ? String(candidate.suggestedTakeProfit) : null,
      trailingStopPips: null,
      rationale: null,
      metadata: {
        confidenceScore: candidate.confidenceScore,
        marketRegime: candidate.marketRegime ?? null,
        volatilityScore: candidate.volatilityScore ?? null,
        ...(candidate.metadata ?? {}),
      },
      authorityGeneration,
      tradingPolicyRevision,
      providerVerificationRevision,
      executionControlRevision,
    };

    const registrationOutcome = await this.tradeIntentService.recordOrReuseIntent(facts);
    if (registrationOutcome.created) {
      // Round 7 (P1 metrics): only a FRESH intent row is an intent created
      // (a UNIQUE-race reuse is exactly-once identity, not a second intent).
      this.metrics?.increment(METRIC_NAMES.INTENTS_CREATED);
    }
    if (!registrationOutcome.created) {
      this.logger.log(
        `Signal ${signalId}: trade intent reused (recorded by a concurrent worker) — ` +
          'exactly-once intent identity',
      );
    }
    return registrationOutcome.intent;
  }

  /**
   * Round 6 (#302, task 6-d): recover a DUPLICATE signal delivery from the
   * FIRST delivery's durable outcome — via the EXISTING
   * executionService.findTradeBySignalId dependency (no fresh risk
   * evaluation, no new trade, no provider dispatch, ever):
   *
   *  - existing trade (ANY status) → typed duplicate outcome carrying the
   *    existing tradeId + status in StrategyResult.duplicateOfTrade
   *    (EXECUTION_SUCCEEDED for PENDING/OPEN/CLOSED/RECONCILIATION_PENDING,
   *    EXECUTION_FAILED for REJECTED/CANCELLED);
   *  - NO trade → the original evaluation produced no execution: a transport
   *    retry of a rejected signal stays rejected (RISK_REJECTED +
   *    duplicateOfTrade{tradeId:null, tradeStatus:'REJECTED_PREVIOUSLY'});
   *  - lookup failure → fail-closed SIGNAL_INVALID (the duplicate's durable
   *    outcome could not be verified — never a fresh evaluation).
   *
   * The suppressed delivery is audited via the existing
   * AuditAction.AI_SIGNAL_IGNORED (reasonCodes DUPLICATE_SIGNAL_RECOVERED /
   * DUPLICATE_PREVIOUSLY_REJECTED / DUPLICATE_STATE_UNVERIFIED) and emits the
   * AI_SIGNAL_IGNORED domain event, with metadata carrying the existing
   * trade id/status + the original generatedAt.
   */
  private async recoverDuplicateOutcome(
    candidate: AiSignalCandidate,
    registration: SignalIdentityRegistration,
  ): Promise<StrategyResult> {
    const { signalId, userId } = candidate;
    const originalGeneratedAt = registration.generatedAt.toISOString();

    let existing: Trade | null;
    try {
      existing = await this.executionService.findTradeBySignalId(signalId, userId);
    } catch (err) {
      const reason =
        'Duplicate delivery whose prior trade state could not be verified (fail-closed)';
      this.logger.error(
        `Signal ${signalId}: duplicate recovery lookup failed`,
        (err as Error).message,
      );
      await this.recordIgnored(
        candidate,
        'SIGNAL_INVALID',
        'DUPLICATE_STATE_UNVERIFIED',
        'Duplicate delivery — the prior evaluation outcome could not be verified; fail-closed',
        { existingTradeId: null, originalGeneratedAt },
      );
      return { outcome: 'SIGNAL_INVALID', signalId, reason };
    }

    if (existing) {
      const recoveredAs: StrategyOutcome = DUPLICATE_ALIVE_TRADE_STATUSES.includes(existing.status)
        ? 'EXECUTION_SUCCEEDED'
        : 'EXECUTION_FAILED';
      const duplicateOfTrade: StrategyDuplicateOfTrade = {
        tradeId: existing.id,
        tradeStatus: existing.status,
        recoveredAs,
      };
      this.logger.log(
        `Signal ${signalId} duplicate redelivery recovered from the existing ` +
          `trade ${existing.id} (status ${existing.status}) — no fresh evaluation/dispatch`,
      );
      await this.recordIgnored(
        candidate,
        recoveredAs,
        'DUPLICATE_SIGNAL_RECOVERED',
        `Duplicate redelivery recovered from the existing trade ${existing.id} (${existing.status})`,
        {
          existingTradeId: existing.id,
          existingTradeStatus: existing.status,
          originalGeneratedAt,
        },
      );
      return {
        outcome: recoveredAs,
        signalId,
        tradeId: existing.id,
        duplicateOfTrade,
      };
    }

    // No trade exists for this signalId: the FIRST evaluation completed
    // without creating one (risk-rejected, or a producer retry of a signal
    // that never passed the pipeline). A transport retry of a rejected
    // signal stays rejected — deterministically.
    this.logger.log(
      `Signal ${signalId} duplicate redelivery recovered as REJECTED_PREVIOUSLY ` +
        '(no trade was created by the original evaluation)',
    );
    await this.recordIgnored(
      candidate,
      'RISK_REJECTED',
      'DUPLICATE_PREVIOUSLY_REJECTED',
      'Duplicate redelivery of a signal whose original evaluation produced no trade — stays rejected',
      { existingTradeId: null, existingTradeStatus: 'REJECTED_PREVIOUSLY', originalGeneratedAt },
    );
    return {
      outcome: 'RISK_REJECTED',
      signalId,
      reason:
        'Duplicate delivery of a previously rejected signal — the original ' +
        'evaluation produced no trade, and a retry may never mint a fresh one.',
      duplicateOfTrade: {
        tradeId: null,
        tradeStatus: 'REJECTED_PREVIOUSLY',
        recoveredAs: 'RISK_REJECTED',
      },
    };
  }

  private validateStructure(candidate: AiSignalCandidate): string | null {
    if (!candidate.signalId) return 'Missing signalId';
    if (!candidate.userId) return 'Missing userId';
    if (!candidate.tradingSessionId) return 'Missing tradingSessionId';
    if (!candidate.brokerConnectionId) return 'Missing brokerConnectionId';
    if (!candidate.instrument) return 'Missing instrument';
    if (!['BUY', 'SELL'].includes(candidate.direction)) return 'Invalid direction';
    if (typeof candidate.confidenceScore !== 'number') return 'Invalid confidenceScore';
    if (!candidate.suggestedStopLoss) return 'Missing suggestedStopLoss';
    if (!candidate.suggestedTakeProfit) return 'Missing suggestedTakeProfit';
    if (!candidate.suggestedVolume || candidate.suggestedVolume <= 0)
      return 'Invalid suggestedVolume';
    return null;
  }

  private async recordIgnored(
    candidate: AiSignalCandidate,
    outcome: StrategyOutcome,
    reasonCode: string,
    reasonSummary: string,
    extraMetadata: Record<string, unknown> = {},
  ): Promise<void> {
    // Round 7 (P1 metrics): every ignored/duplicate-recovered signal outcome
    // funnels through here — the received-signal counter stays honest for the
    // whole gate-1..4.6 family (the remaining outcomes increment at their
    // own return sites).
    this.metrics?.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome });
    await this.auditService.log({
      actorUserId: candidate.userId,
      action: AuditAction.AI_SIGNAL_IGNORED,
      severity: AuditSeverity.INFO,
      resourceType: 'AiSignal',
      resourceId: candidate.signalId,
      metadata: {
        instrument: candidate.instrument,
        direction: candidate.direction,
        confidenceScore: candidate.confidenceScore,
        strategyCode: candidate.strategyCode,
        outcome,
        reasonCode,
        reasonSummary,
        ...extraMetadata,
      },
    });

    this.eventBus.publish(DomainEventType.AI_SIGNAL_IGNORED, candidate.userId, {
      signalId: candidate.signalId,
      instrument: candidate.instrument,
      direction: candidate.direction,
      confidenceScore: candidate.confidenceScore,
      strategyCode: candidate.strategyCode,
      ignoredReason: reasonSummary,
      ...extraMetadata,
    });
  }
}

/**
 * Normalize the AI engine's free-form market regime label to the risk
 * engine's regime vocabulary (#330). Unrecognized labels return undefined —
 * the Risk Engine then fails closed (UNKNOWN_MARKET_REGIME) when the profile
 * enforces regime rules, rather than silently treating them as acceptable.
 */
function normalizeMarketRegime(marketRegime: string | undefined): ProposedTrade['regime'] {
  if (!marketRegime || typeof marketRegime !== 'string') return undefined;
  const normalized = marketRegime.trim().toUpperCase();
  switch (normalized) {
    case 'TRENDING':
      return 'TRENDING';
    case 'RANGING':
      return 'RANGING';
    case 'LOW_LIQUIDITY':
      return 'LOW_LIQUIDITY';
    case 'HIGH_VOLATILITY':
    case 'VOLATILE':
      return 'HIGH_VOLATILITY';
    default:
      return undefined;
  }
}
