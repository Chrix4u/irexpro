import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ExactDecimal } from '../../common/utils/exact-decimal';
import { RiskProfile } from './entities/risk-profile.entity';
import { RiskViolation } from './entities/risk-violation.entity';
import { TradingSession } from '../execution/entities/trading-session.entity';
import { TradingAuthorityGeneration } from '../users/entities/trading-authority-generation.entity';
import {
  ProposedTrade,
  RiskApprovalResult,
  RiskContextSnapshot,
  RiskDecision,
  RiskRejectionCode,
  RiskRejectionResult,
  ValidatedOrder,
} from './interfaces/risk.interface';
import { BrokerService } from '../broker/broker.service';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerConnectionStatus, BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { UpdateRiskProfileDto } from './dto/update-risk-profile.dto';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import {
  ActiveSessionAuthority,
  ExecutionSessionResolutionService,
  SessionAuthorityNotActiveException,
} from '../execution/execution-session.resolution';
import {
  AuthoritativeOrderPayload,
  ExecutionMode,
  digestCanonicalPayload,
  normalizeDecimalStringForDigest,
} from '../execution/interfaces/execution-authority';
import { RiskGrantService } from './risk-grant.service';
import { RiskOrderGeometryService } from './risk-order-geometry.service';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';
import { ModuleRef } from '@nestjs/core';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import type { AuthorityBumpReason } from '../execution-authority/trading-authority.service';
import { SharedControlRevisionService } from '../execution-authority/shared-control-revision.service';
import { GrantInvalidationService } from '../execution-authority/grant-invalidation.service';
import { DailyRiskPeriodService } from '../execution/services/daily-risk-period.service';
import { BrokerAccountSnapshotService } from '../broker/services/broker-account-snapshot.service';

/** Default pip size for standard 5-digit pairs (EURUSD, GBPUSD, etc.) */
const DEFAULT_PIP_SIZE = '0.0001';
/** Default pip size for JPY pairs (USDJPY, GBPJPY, etc.) */
const JPY_PIP_SIZE = '0.01';

/** Exact-decimal division scale for PERCENT risk ratios (conservative divUp). */
const RISK_PERCENT_SCALE = 8;
/** Exact-decimal division scale for drawdown ratios (conservative divUp). */
const DRAWDOWN_SCALE = 8;
/** Exact-decimal division scale for effective-leverage ratios (divUp). */
const LEVERAGE_SCALE = 8;

/**
 * RiskService — The mandatory, non-bypassable pre-trade validation gateway.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CORE INVARIANT — NEVER VIOLATE:
 *   1. validateProposedTrade() MUST be called before ANY broker order
 *   2. Only APPROVED decisions allow execution to proceed
 *   3. The pipeline is FAIL CLOSED — any internal error = REJECTED
 *   4. APPROVED decisions cannot be fabricated — they must come from this service
 *   5. Round 5 (#296): NO rule is ever SKIPPED on a failed state query —
 *      safety queries that cannot be answered REJECT (sanitized
 *      RISK_ENGINE_QUERY_FAILED), never substitute zero/empty/default
 *   6. Round 5 (#313): ALL safety-critical arithmetic uses ExactDecimal —
 *      no parseFloat, no Number(), no epsilon comparisons. Boundary
 *      semantics are EXACT: loss >= limit rejects at equality;
 *      requiredMargin > freeMargin rejects only when strictly greater
 *      (equality passes); drawdown/risk percent use conservative divUp.
 *   7. Round 5 (#295/#298): the authority target is the EXACT ACTIVE
 *      TradingSession (resolved through the execution-module seam) — this
 *      service never rediscovers "the latest active BrokerConnection".
 *   8. Round 5 (#301): every APPROVED decision carries a durable RiskGrant
 *      issued by RiskGrantService — approval without a persisted grant is
 *      impossible (issuance failure fails closed).
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Validation pipeline:
 *   Step 0: Authority binding (ProposedTrade session fields — REQUIRED)
 *   Step 1: Pre-conditions (control plane, kill switch, session + exact
 *           connection, LIVE authorization)
 *   Step 2: Load broker account state (fail-closed, typed)
 *   Step 3: Account-level checks (daily loss vs session opening balance,
 *           drawdown vs monotonic session peak, margin)
 *   Step 4: Position-level checks (concurrent trades, daily trades,
 *           position size, instrument)
 *   Step 5: Order integrity (mandatory SL/TP, SL distance, TP direction)
 *   Step 6: Volatility, market regime, per-trade risk % and effective leverage
 *   Step 7: Duplicate prevention (idempotency)
 *   Step 8: APPROVED — durable RiskGrant issuance (+ SEMI_AUTO confirmation)
 *
 * See: docs/architecture/11-risk-engine-architecture.md
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    @InjectRepository(RiskProfile)
    private profileRepo: Repository<RiskProfile>,
    @InjectRepository(RiskViolation)
    private violationRepo: Repository<RiskViolation>,
    @InjectRepository(TradingSession)
    private readonly sessionRepo: Repository<TradingSession>,
    @InjectRepository(TradingAuthorityGeneration)
    private readonly authorityGenerationRepo: Repository<TradingAuthorityGeneration>,
    private brokerService: BrokerService,
    private auditService: AuditService,
    @Inject(forwardRef(() => ExecutionService))
    private executionService: ExecutionService,
    private readonly executionControlService: ExecutionControlService,
    private readonly eventBus: DomainEventBus,
    @Inject(forwardRef(() => ExecutionSessionResolutionService))
    private readonly sessionResolution: ExecutionSessionResolutionService,
    private readonly riskGrantService: RiskGrantService,
    private readonly orderGeometry: RiskOrderGeometryService,
    // ── Round 6: unified execution-authority seams ──────────────────────────
    // All PLAIN (leaf) dependencies — ExecutionAuthorityModule and
    // DailyRiskPeriodModule are acyclic, so NO provider-level forwardRef is
    // added here (the Round-5 RiskModule↔ExecutionModule forwardRef cycle
    // stays exactly as committed; stacking provider-level forwardRef onto it
    // is what crashed full-graph DI compilation in the lost tree).
    private readonly tradingAuthorityService: TradingAuthorityService,
    private readonly sharedControlRevisionService: SharedControlRevisionService,
    private readonly dailyRiskPeriod: DailyRiskPeriodService,
    private readonly grantInvalidation: GrantInvalidationService,
    private readonly brokerAccountSnapshotService: BrokerAccountSnapshotService,
    /** Reserved lazy-resolution seam for cycle-prone execution-side
     * collaborators (resolved at CALL time, never in the constructor). */
    private readonly moduleRef: ModuleRef,
  ) {}

  // ─── Main validation entry point ──────────────────────────────────────────

  /**
   * Validate a proposed trade signal through the complete risk pipeline.
   *
   * This is the ONLY entry point for trade validation. It must be called
   * before every order, without exception.
   *
   * Returns:
   *   APPROVED   — trade may proceed to ExecutionService (carries a durable
   *                RiskGrant handle the execution side MUST verify + consume)
   *   REJECTED   — trade is blocked; reason logged in RiskViolation
   *   SUSPENDED  — trading session suspended; requires manual review
   */
  async validateProposedTrade(userId: string, trade: ProposedTrade): Promise<RiskDecision> {
    const evaluatedAt = new Date();

    // FAIL CLOSED wrapper — any uncaught error = REJECTED
    try {
      return await this.runValidationPipeline(userId, trade, evaluatedAt);
    } catch (err) {
      this.logger.error(
        `Risk Engine error for user ${userId}, signal ${trade.signalId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      // Never approve on system error — always reject
      return this.buildRejection(
        trade.signalId,
        RiskRejectionCode.RISK_ENGINE_ERROR,
        `Risk Engine internal error: ${(err as Error).message}`,
        evaluatedAt,
      );
    }
  }

  // ─── Pipeline ──────────────────────────────────────────────────────────────

  private async runValidationPipeline(
    userId: string,
    trade: ProposedTrade,
    evaluatedAt: Date,
  ): Promise<RiskDecision> {
    const appliedRules: string[] = [];
    const contextSnapshot: Partial<RiskContextSnapshot> = {
      userId,
      signalId: trade.signalId,
      proposedLotSize: trade.requestedLotSize,
      proposedInstrument: trade.instrument,
      checkedAt: evaluatedAt,
      // Round 5 (#295/#298): record the authority binding the evaluation saw.
      sessionId: trade.sessionId,
      sessionGeneration: trade.sessionGeneration,
      executionMode: trade.executionMode,
      brokerConnectionId: trade.brokerConnectionId,
    };

    // ── Step 0: Authority binding (REQUIRED before ANY other check) ────────
    // Round 5 (#295/#298/#301): NEW-exposure validation is bound to the EXACT
    // session authority. A ProposedTrade without the binding is unroutable —
    // there is no honest default, so it fails closed BEFORE any other rule
    // (kill switch, controls, broker checks — none may run first).
    const bindingError = this.requireAuthorityBinding(trade);
    if (bindingError) {
      appliedRules.push('AUTHORITY_BINDING:MISSING');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.AUTHORITY_BINDING_REQUIRED,
        bindingError,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('AUTHORITY_BINDING:OK');

    // ── Step 1: Pre-condition checks (fail fast) ────────────────────────────

    // 1a-pre. Emergency control plane (Sprint 50, Directive §28) — checked
    // FIRST so GLOBAL/USER-level disable affects newly submitted work
    // immediately, before any broker/connection discovery. Fail-closed: an
    // unreadable control store blocks execution.
    //
    // Architect correction A1: this EARLY check covers the GLOBAL and USER
    // scopes only (no connection context is known yet). After the
    // authoritative session-bound connection is loaded (1c), the pipeline
    // re-evaluates the control plane with the COMPLETE context — user +
    // provider + broker connection — so all four scopes are genuinely
    // enforced at the risk boundary.
    const earlyControlRejection = await this.evaluateControlGate(
      { userId },
      userId,
      trade,
      contextSnapshot,
      evaluatedAt,
    );
    if (earlyControlRejection) return earlyControlRejection;
    appliedRules.push('EXECUTION_CONTROL:OK');

    // 1a. Kill switch (checked before session resolution — fastest rejection)
    const profile = await this.getOrCreateProfile(userId);
    contextSnapshot.killSwitchActive = profile.killSwitchActive;

    if (profile.killSwitchActive) {
      appliedRules.push('KILL_SWITCH');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.KILL_SWITCH_ACTIVE,
        'Kill switch is active — all trading suspended',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('KILL_SWITCH:OK');

    // 1b. Resolve the ACTIVE TradingSession authority (issue #295) — the
    // session is THE authoritative execution target; this pipeline NEVER
    // calls findActiveConnectionForUser() to rediscover a connection.
    let authority: ActiveSessionAuthority;
    try {
      authority = await this.sessionResolution.resolveActiveSessionAuthority(userId);
    } catch (err) {
      if (err instanceof SessionAuthorityNotActiveException) {
        appliedRules.push('SESSION_AUTHORITY');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.SESSION_NOT_ACTIVE,
          'No ACTIVE trading session — start an explicit session before requesting new exposure',
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }
      throw err; // unexpected resolution failure → wrapper fail-closed
    }

    const session = await this.sessionRepo.findOne({
      where: { id: authority.sessionId, userId },
    });
    if (!session) {
      appliedRules.push('SESSION_AUTHORITY:VANISHED');
      return this.buildRejection(
        trade.signalId,
        RiskRejectionCode.RISK_ENGINE_ERROR,
        'Resolved trading session could not be loaded — authority state is inconsistent',
        evaluatedAt,
      );
    }
    contextSnapshot.sessionId = session.id;
    contextSnapshot.sessionGeneration = session.authorityGeneration;
    contextSnapshot.executionMode = session.executionMode;
    contextSnapshot.brokerConnectionId = session.brokerConnectionId;

    // 1b-continued. The signal's binding must match the CURRENT authority —
    // a stale generation/connection/mode binding means the signal was built
    // against a superseded authority state; it is rejected (never silently
    // rebound) and the producer must re-build it from the fresh session.
    const authorityMismatch = this.describeAuthorityMismatch(trade, session, authority);
    if (authorityMismatch) {
      appliedRules.push('SESSION_AUTHORITY:MISMATCH');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.SESSION_AUTHORITY_MISMATCH,
        authorityMismatch,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('SESSION_AUTHORITY:OK');

    // 1c. Load the EXACT session-bound broker connection (ownership enforced
    // by findConnectionById; no discovery fallback).
    let connection: BrokerConnection;
    try {
      connection = await this.brokerService.findConnectionById(session.brokerConnectionId, userId);
    } catch {
      appliedRules.push('BROKER_CONNECTION');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.BROKER_DISCONNECTED,
        `Session-bound broker connection ${session.brokerConnectionId} is not available to this user — cannot place orders`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      appliedRules.push('BROKER_CONNECTION');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.BROKER_DISCONNECTED,
        `Session-bound broker connection ${connection.id} is ${connection.status}, not CONNECTED — cannot place orders`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    contextSnapshot.brokerConnected = true;
    appliedRules.push('BROKER_CONNECTION:OK');

    // 1c-pre. Emergency control plane — COMPLETE four-scope context
    // (architect correction A1): now that the session-bound connection is
    // known, re-evaluate the control plane against user + provider + broker
    // connection. This is the gate that genuinely enforces PROVIDER and
    // BROKER_CONNECTION scopes in the risk pipeline.
    const fullControlRejection = await this.evaluateControlGate(
      {
        userId,
        brokerId: connection.brokerId,
        brokerConnectionId: connection.id,
      },
      userId,
      trade,
      contextSnapshot,
      evaluatedAt,
    );
    if (fullControlRejection) return fullControlRejection;
    appliedRules.push('EXECUTION_CONTROL_FULL_CONTEXT:OK');

    // 1d. LIVE authorization gate (Sprint 50, Directive §16): when the
    // session-bound connection is a LIVE account, its authorization state
    // machine must be ACTIVE (the only executable state). DEMO/PAPER
    // connections keep the existing behavior — LIVE isolation fails closed
    // here, never falls back to a lower-friction path.
    if (
      connection.accountType === BrokerMode.LIVE &&
      !this.brokerService.isConnectionExecutable(connection)
    ) {
      appliedRules.push('LIVE_AUTHORIZATION');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.LIVE_AUTHORIZATION_REQUIRED,
        `LIVE connection ${connection.id} authorization status is ` +
          `${connection.authorizationStatus} — live execution requires ACTIVE`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('LIVE_AUTHORIZATION:OK');

    // ── Step 2: Load broker account state (fail-closed, typed) ─────────────
    // Round 5 (#296/#313): a failed/absent/unparseable account read REJECTS —
    // it is never silently skipped toward APPROVED.
    let accountState: {
      balance: string;
      equity: string;
      freeMargin: string;
      currency?: string | null;
    } | null = null;
    try {
      accountState = await this.brokerService.getBrokerAccountState(connection.id);
    } catch (err) {
      this.logger.error(
        `Broker account state query failed for connection ${connection.id}: ${(err as Error).message}`,
      );
      appliedRules.push('ACCOUNT_STATE:QUERY_FAILED');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.RISK_ENGINE_QUERY_FAILED,
        'Risk Engine could not read the broker account state — rejecting (fail-closed)',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    if (!accountState) {
      appliedRules.push('ACCOUNT_STATE:UNAVAILABLE');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.ACCOUNT_STATE_UNAVAILABLE,
        'Broker account state unavailable — cannot verify account-level limits (fail-closed)',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    contextSnapshot.brokerBalance = accountState.balance;
    contextSnapshot.brokerEquity = accountState.equity;

    const currentEquity = this.parseBrokerDecimal(accountState.equity, 'equity');
    if (!currentEquity) {
      appliedRules.push('ACCOUNT_STATE:MALFORMED');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.ACCOUNT_STATE_UNAVAILABLE,
        `Broker equity is ${
          accountState.equity === null ||
          accountState.equity === undefined ||
          accountState.equity === ''
            ? 'unavailable'
            : `malformed ("${accountState.equity}")`
        } — cannot verify account-level limits (fail-closed)`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    // ── Step 2-live (Round 6 #297/#312/#362): LIVE NEW-exposure derives its
    // financial truth from the DURABLE accepted account snapshot (exact
    // connection, fresh observation, non-null currency) and resolves the
    // per-account DAILY-RISK PERIOD (exact baseline + UTC day budget that a
    // session restart can never reset). PAPER/DEMO keeps the projected
    // current view — nothing is ever synthesized for LIVE.
    let liveSnapshotBinding: {
      id: string;
      generation: number;
      observedAt: Date;
      currency: string;
      logicalAccountKey: string;
    } | null = null;
    let liveRiskPeriodId: string | null = null;
    let liveLossTotal: string | null = null;
    let liveLossComplete = false;
    if (connection.accountType === BrokerMode.LIVE) {
      try {
        const snapshot = await this.brokerAccountSnapshotService.resolveFreshSnapshotForNewExposure(
          connection.id,
        );
        const logicalAccountKey = connection.logicalAccountKey ?? null;
        if (!logicalAccountKey) {
          throw new Error(
            'LIVE connection carries no logical account key — cannot scope the daily-risk period',
          );
        }
        // Fail-closed: the snapshot's financial identity fields must be
        // present (resolveFreshSnapshotForNewExposure already validated
        // parseability — a null field still refuses to bind authority).
        const snapshotCurrency = snapshot.currency;
        const snapshotBalance = snapshot.balance;
        const snapshotEquity = snapshot.equity;
        if (!snapshotCurrency || !snapshotBalance || !snapshotEquity) {
          throw new Error(
            'LIVE snapshot is missing currency/balance/equity — cannot bind authority (fail-closed)',
          );
        }
        liveSnapshotBinding = {
          id: snapshot.id,
          generation: snapshot.generation,
          observedAt: snapshot.providerObservedAt ?? snapshot.acceptedAt,
          currency: snapshotCurrency,
          logicalAccountKey,
        };
        const period = await this.dailyRiskPeriod.resolveDailyRiskPeriod({
          userId,
          brokerConnectionId: connection.id,
          logicalAccountKey,
          accountCurrency: snapshotCurrency,
          snapshot: { id: snapshot.id, balance: snapshotBalance, equity: snapshotEquity },
          riskProfile: { id: profile.id, revision: profile.revision ?? 0 },
        });
        liveRiskPeriodId = period.id;
        const exact = await this.dailyRiskPeriod.getTodayRealisedLossExact({
          userId,
          logicalAccountKey,
          accountCurrency: snapshotCurrency,
        });
        liveLossTotal = exact.total;
        liveLossComplete = exact.complete;
      } catch (err) {
        this.logger.error(
          `LIVE snapshot/daily-risk-period authority failed for connection ${connection.id}: ${(err as Error).message}`,
        );
        appliedRules.push('ACCOUNT_STATE:LIVE_SNAPSHOT_UNAVAILABLE');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.ACCOUNT_STATE_UNAVAILABLE,
          `LIVE account snapshot authority unavailable for connection ${connection.id} — ` +
            `${(err as Error).message} (fail-closed)`,
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }
    }

    // ── Step 3: Account-level checks ───────────────────────────────────────

    // 3a. Daily loss limit — Round 5 (#317): the denominator is the SESSION
    // OPENING BALANCE (the day baseline captured at session start), NOT the
    // current broker balance (which already includes the loss being limited).
    // Missing/unusable baseline → typed fail-closed rejection, never a skip.
    const openingBalance = this.parseSessionDecimal(session.openingBalance);
    contextSnapshot.sessionOpeningBalance =
      session.openingBalance === null || session.openingBalance === undefined
        ? undefined
        : String(session.openingBalance);
    if (!openingBalance || !openingBalance.isPositive()) {
      appliedRules.push('DAILY_LOSS_LIMIT:BASELINE_UNAVAILABLE');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.SESSION_BASELINE_UNAVAILABLE,
        `Trading session ${session.id} has no usable opening balance ` +
          `(${session.openingBalance === null ? 'null' : String(session.openingBalance)}) — ` +
          'cannot evaluate the daily loss limit (fail-closed)',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    let todayLoss: ExactDecimal | null = null;
    try {
      if (liveLossTotal !== null) {
        // LIVE (#313/#362): the EXACT string total from the per-account
        // daily-risk-period query — no IEEE-754 boundary anywhere. Incomplete
        // history (legacy rows without provenance) fails CLOSED, never guessed.
        if (!liveLossComplete) {
          appliedRules.push('DAILY_LOSS_LIMIT:INCOMPLETE_PROVENANCE');
          return this.rejectAndRecord(
            userId,
            trade,
            RiskRejectionCode.RISK_ENGINE_QUERY_FAILED,
            "Today's realised loss cannot be proven complete for this account " +
              '(legacy rows without account/currency provenance) — rejecting (fail-closed)',
            contextSnapshot as RiskContextSnapshot,
            evaluatedAt,
          );
        }
        todayLoss = ExactDecimal.tryParse(liveLossTotal);
      } else {
        // PAPER/DEMO: ExecutionService boundary (number → the exact decimal
        // of its shortest round-trip string). Malformed (NaN/Infinity) fails
        // closed below.
        todayLoss = this.parseNumberAsDecimal(
          await this.executionService.getTodayRealisedLoss(userId),
        );
      }
    } catch (err) {
      this.logger.error(
        `Daily realised-loss query failed for user ${userId}: ${(err as Error).message}`,
      );
      appliedRules.push('DAILY_LOSS_LIMIT:QUERY_FAILED');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.RISK_ENGINE_QUERY_FAILED,
        "Risk Engine could not verify today's realised loss — rejecting (fail-closed)",
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    if (!todayLoss) {
      appliedRules.push('DAILY_LOSS_LIMIT:MALFORMED');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.RISK_ENGINE_QUERY_FAILED,
        "Today's realised loss is malformed — cannot evaluate the daily loss limit (fail-closed)",
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    if (todayLoss.isNegative()) {
      // EXACT boundary: |loss| >= limit rejects at equality (#313).
      const lossAmount = todayLoss.abs();
      const maxLossAmount = ExactDecimal.percentOf(
        profile.maxDailyLossPercent,
        openingBalance.toString(),
      );
      contextSnapshot.dailyRealisedPnl = lossAmount.toString();
      if (lossAmount.gte(maxLossAmount)) {
        appliedRules.push('DAILY_LOSS_LIMIT');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.DAILY_LOSS_LIMIT_REACHED,
          `Daily loss ${lossAmount.toFixed(2)} has reached limit ` +
            `(${profile.maxDailyLossPercent}% = ${maxLossAmount.toFixed(2)} of the session ` +
            `opening balance ${openingBalance.toFixed(2)})`,
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }
    }
    appliedRules.push('DAILY_LOSS_LIMIT:OK');

    // 3b. Max drawdown — Round 5 (#317): peak equity is maintained
    // MONOTONICALLY on the TradingSession via a guarded CAS write; drawdown
    // is (peak − current) / peak with EXACT decimals and a conservative
    // divUp quantization, compared exactly against maxDrawdownPercent.
    const peakEquity = await this.maintainMonotonicPeak(session.id, currentEquity);
    contextSnapshot.sessionPeakEquity = peakEquity.toString();
    if (!peakEquity.isPositive()) {
      appliedRules.push('MAX_DRAWDOWN:BASELINE_UNAVAILABLE');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.SESSION_BASELINE_UNAVAILABLE,
        `Trading session ${session.id} has no positive peak equity — cannot evaluate drawdown (fail-closed)`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    const drawdownAmount = peakEquity.sub(currentEquity);
    // peak >= current by construction (monotonic) — drawdown >= 0. EXACT
    // boundary: drawdownPercent >= maxDrawdownPercent rejects at equality.
    const drawdownPercent = drawdownAmount.divUp(peakEquity, DRAWDOWN_SCALE).mulByPowerOfTen(2);
    const maxDrawdown = this.parseProfileDecimal(profile.maxDrawdownPercent, 'maxDrawdownPercent');
    if (drawdownPercent.gte(maxDrawdown)) {
      appliedRules.push('MAX_DRAWDOWN');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.MAX_DRAWDOWN_REACHED,
        `Drawdown ${drawdownPercent.toFixed(2)}% (peak ${peakEquity.toFixed(2)}, equity ` +
          `${currentEquity.toFixed(2)}) has reached limit ${maxDrawdown.toString()}%`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('MAX_DRAWDOWN:OK');

    // 3c. Margin / account capacity check
    // Sprint 32 Gate 2: capability-aware margin validation through the broker
    // abstraction. The Risk Engine does NOT contain broker-specific margin
    // formulas — it delegates to BrokerService.getRequiredMargin() which uses
    // the adapter's getRequiredMargin() (broker-specific rules).
    //
    // For LIVE execution: compares requiredMargin vs available freeMargin.
    // EXACT boundary (#313): requiredMargin > freeMargin rejects ONLY when
    // strictly greater — equality passes (the account has exactly enough).
    // If requiredMargin cannot be established (null) → fail closed.
    // If account state is missing/malformed → fail closed.
    //
    // No arbitrary safety multipliers (e.g. 0.95) are used.
    const freeMarginUnavailable =
      accountState.freeMargin === null ||
      accountState.freeMargin === undefined ||
      accountState.freeMargin === '';
    const freeMargin = this.parseBrokerDecimal(accountState.freeMargin, 'freeMargin');
    if (!freeMargin) {
      appliedRules.push(freeMarginUnavailable ? 'MARGIN_CHECK:UNAVAILABLE' : 'MARGIN_CHECK:ERROR');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.INSUFFICIENT_MARGIN,
        freeMarginUnavailable
          ? 'Broker free margin is unavailable — cannot verify account capacity (fail-closed)'
          : `Broker free margin is malformed ("${accountState.freeMargin}") — cannot verify account capacity`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    let requiredMargin: string | null = null;
    try {
      requiredMargin = await this.brokerService.getRequiredMargin(connection.id, {
        instrument: trade.instrument,
        lotSize: trade.requestedLotSize,
        direction: trade.direction,
      });
    } catch {
      // Adapter error — fail closed
      appliedRules.push('MARGIN_CHECK:ADAPTER_ERROR');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.INSUFFICIENT_MARGIN,
        'Broker adapter error — cannot calculate required margin (fail-closed)',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    if (requiredMargin === null) {
      // Adapter cannot calculate required margin — fail closed for safety
      appliedRules.push('MARGIN_CHECK:CAPABILITY_UNAVAILABLE');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.INSUFFICIENT_MARGIN,
        'Broker cannot calculate required margin for this order — capacity verification unavailable (fail-closed)',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    const reqMargin = this.parseBrokerDecimal(requiredMargin, 'requiredMargin');
    if (!reqMargin) {
      appliedRules.push('MARGIN_CHECK:MALFORMED');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.INSUFFICIENT_MARGIN,
        `Required margin is malformed ("${requiredMargin}") — cannot verify capacity (fail-closed)`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    if (reqMargin.gt(freeMargin)) {
      appliedRules.push('MARGIN_CHECK');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.INSUFFICIENT_MARGIN,
        `Required margin (${reqMargin.toFixed(2)}) exceeds available free margin (${freeMargin.toFixed(2)})`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('MARGIN_CHECK:OK');

    // ── Step 4: Position-level checks ──────────────────────────────────────

    // 4a. Max concurrent trades — Round 5 (#296): a failed count query
    // REJECTS (sanitized); the rule is never SKIPPED.
    let openCount: number;
    try {
      openCount = await this.executionService.countOpenTrades(userId);
    } catch (err) {
      this.logger.error(
        `Open-trades count query failed for user ${userId}: ${(err as Error).message}`,
      );
      appliedRules.push('CONCURRENT_TRADES:QUERY_FAILED');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.RISK_ENGINE_QUERY_FAILED,
        'Risk Engine could not verify the open-trade count — rejecting (fail-closed)',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    contextSnapshot.openTradesCount = openCount;
    if (openCount >= profile.maxOpenTrades) {
      appliedRules.push('CONCURRENT_TRADES');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.MAX_CONCURRENT_TRADES,
        `Open trades (${openCount}) has reached maxOpenTrades limit (${profile.maxOpenTrades})`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('CONCURRENT_TRADES:OK');

    // 4b. Max daily trades
    // Sprint 32: enforce the daily trade limit. Counts trades actually Opened
    // today (UTC day boundary), excluding PENDING and REJECTED. Concurrency-
    // safe via the DB unique constraint on idempotency_key.
    let todayTrades: number;
    try {
      todayTrades = await this.executionService.countTodayTrades(userId);
    } catch {
      // Fail closed: if we cannot count today's trades, we cannot safely
      // enforce the limit. Reject rather than risk exceeding the daily cap.
      appliedRules.push('DAILY_TRADES:ERROR');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.RISK_ENGINE_ERROR,
        'Risk Engine error: could not verify daily trade count',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    contextSnapshot.dailyTradesCount = todayTrades;
    if (todayTrades >= profile.maxDailyTrades) {
      appliedRules.push('DAILY_TRADES');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.MAX_DAILY_TRADES,
        `Daily trades (${todayTrades}) has reached maxDailyTrades limit (${profile.maxDailyTrades})`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('DAILY_TRADES:OK');

    // 4c. Position size check — EXACT decimal comparison (#313).
    const requestedLots = this.parseOrderDecimal(trade.requestedLotSize, 'requestedLotSize');
    const maxLots = this.parseProfileDecimal(profile.maxPositionSizeLot, 'maxPositionSizeLot');
    let effectiveLotSize = trade.requestedLotSize;

    if (requestedLots.gt(maxLots)) {
      // Soft reduction: cap to max, don't reject outright
      effectiveLotSize = profile.maxPositionSizeLot;
      this.logger.log(
        `Signal ${trade.signalId}: lot size reduced from ${requestedLots.toString()} to ` +
          `${maxLots.toString()} (maxPositionSizeLot)`,
      );
      appliedRules.push(
        `POSITION_SIZE:REDUCED_${requestedLots.toString()}_TO_${maxLots.toString()}`,
      );

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.RISK_POSITION_SIZE_REDUCED,
        metadata: {
          signalId: trade.signalId,
          requestedLots: requestedLots.toString(),
          cappedLots: maxLots.toString(),
          instrument: trade.instrument,
        },
      });
    } else {
      appliedRules.push('POSITION_SIZE:OK');
    }
    const effectiveQuantity = this.parseOrderDecimal(effectiveLotSize, 'effectiveLotSize');

    // 4d. Instrument whitelist check
    if (profile.allowedInstruments && profile.allowedInstruments.length > 0) {
      if (!profile.allowedInstruments.includes(trade.instrument)) {
        appliedRules.push('INSTRUMENT_WHITELIST');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.INSTRUMENT_NOT_ALLOWED,
          `Instrument ${trade.instrument} is not in the allowed list`,
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }
    }
    appliedRules.push('INSTRUMENT_WHITELIST:OK');

    // ── Step 5: Order integrity checks ─────────────────────────────────────

    // 5a. Mandatory stop-loss
    if (!trade.stopLoss || trade.stopLoss === '0') {
      appliedRules.push('MANDATORY_SL');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.MISSING_STOP_LOSS,
        'Stop-loss is mandatory — all orders must have a valid stop-loss',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('MANDATORY_SL:OK');

    // 5b. Mandatory take-profit
    if (!trade.takeProfit || trade.takeProfit === '0') {
      appliedRules.push('MANDATORY_TP');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.MISSING_TAKE_PROFIT,
        'Take-profit is mandatory — all orders must have a valid take-profit',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('MANDATORY_TP:OK');

    // 5c. Stop-loss distance check (minimum pips from entry) — EXACT (#313).
    const slDistanceCheck = this.checkStopLossDistance(trade, profile);
    if (slDistanceCheck) {
      appliedRules.push('SL_DISTANCE');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.INVALID_SL_DISTANCE,
        slDistanceCheck,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('SL_DISTANCE:OK');

    // 5d. Take-profit direction validity — EXACT (#313).
    const tpDirectionCheck = this.checkTakeProfitDirection(trade);
    if (tpDirectionCheck) {
      appliedRules.push('TP_DIRECTION');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.INVALID_TP_DIRECTION,
        tpDirectionCheck,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('TP_DIRECTION:OK');

    // ── Step 6: Volatility, regime and per-trade control checks ────────────

    // 6a. Volatility score (informational model score 0–1 — parsed to the
    // exact decimal of its shortest round-trip string; strictly-greater
    // rejects, as documented since Sprint 32).
    if (trade.volatilityScore !== undefined) {
      const maxVol = this.parseProfileDecimal(profile.maxVolatilityScore, 'maxVolatilityScore');
      const score = this.parseNumberAsDecimal(trade.volatilityScore);
      if (!score) {
        appliedRules.push('VOLATILITY:MALFORMED');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.RISK_ENGINE_ERROR,
          'Volatility score is malformed — cannot evaluate the volatility threshold',
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }
      if (score.gt(maxVol)) {
        appliedRules.push('VOLATILITY');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.HIGH_VOLATILITY,
          `Volatility score ${score.toString()} exceeds threshold ${maxVol.toString()}`,
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }
      appliedRules.push('VOLATILITY:OK');
    }

    // 6b. Market regime (#330): the regime classification from the signal
    // MUST reach the risk checks. LOW_LIQUIDITY + rejectLowLiquidity →
    // reject. When the profile enforces regime rules (rejectLowLiquidity
    // true), a MISSING or UNKNOWN regime may NOT silently pass — the
    // control cannot be verified, so NEW exposure fails closed.
    if (trade.regime === 'LOW_LIQUIDITY' && profile.rejectLowLiquidity) {
      appliedRules.push('REGIME');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.LOW_LIQUIDITY_REGIME,
        'Trade rejected: LOW_LIQUIDITY market regime detected',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    if (profile.rejectLowLiquidity && !isKnownMarketRegime(trade.regime)) {
      appliedRules.push('REGIME:UNKNOWN');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.UNKNOWN_MARKET_REGIME,
        `Market regime is ${trade.regime === undefined ? 'missing' : `unknown ("${trade.regime}")`} ` +
          'and the profile enforces regime rules — cannot verify the regime control (fail-closed)',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('REGIME:OK');

    // 6c. Per-trade controls (#316) — maxTradeRiskPercent + maxLeverageAllowed.
    // See enforcePerTradeControls for the exact semantics. The result also
    // carries the quote reference observed for MARKET geometry (bound into
    // the issued grant).
    const { rejection: perTradeRejection, quoteRef: geometryQuoteRef } =
      await this.enforcePerTradeControls(
        userId,
        trade,
        profile,
        session,
        connection,
        currentEquity,
        effectiveQuantity,
        appliedRules,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    if (perTradeRejection) return perTradeRejection;

    // ── Step 7: Duplicate prevention (risk layer) ─────────────────────────
    // Sprint 32: the Execution layer has an atomic DB unique-constraint check
    // on idempotency_key. The Risk layer additionally checks for an EXISTING
    // trade with this signalId — a duplicate is rejected early with
    // DUPLICATE_SIGNAL (defense in depth before the DB constraint).
    let existingTrade: { id: string; status: string } | null = null;
    try {
      existingTrade = await this.executionService.findTradeBySignalId(trade.signalId, userId);
    } catch {
      // Fail closed: if we cannot check for duplicates, reject rather than
      // risk double-execution.
      appliedRules.push('IDEMPOTENCY:ERROR');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.RISK_ENGINE_ERROR,
        'Risk Engine error: could not verify signal idempotency',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    if (existingTrade) {
      appliedRules.push('IDEMPOTENCY:DUPLICATE');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.DUPLICATE_SIGNAL,
        `Signal ${trade.signalId} has already been processed (trade ${existingTrade.id}, status ${existingTrade.status})`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('IDEMPOTENCY:OK');

    // ── Step 8: APPROVED — durable RiskGrant issuance (#301) ───────────────

    const validatedOrder: ValidatedOrder = {
      instrument: trade.instrument,
      direction: trade.direction,
      lotSize: effectiveLotSize,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss!,
      takeProfit: trade.takeProfit!,
      trailingStopPips: trade.trailingStopPips,
      idempotencyKey: trade.idempotencyKey,
    };

    // Approval is impossible without a durable grant: any issuance failure
    // rejects (fail-closed) — a caller-constructed approval object can never
    // satisfy the dispatch boundary.
    let grantId: string;
    try {
      grantId = await this.issueAuthorityGrant(
        userId,
        trade,
        profile,
        session,
        connection,
        evaluatedAt,
        validatedOrder,
        geometryQuoteRef,
        liveSnapshotBinding,
      );
    } catch (err) {
      this.logger.error(
        `RiskGrant issuance failed for signal ${trade.signalId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      appliedRules.push('GRANT_ISSUANCE:FAILED');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.RISK_ENGINE_ERROR,
        'Risk Engine could not issue the durable risk grant — approval is impossible without it (fail-closed)',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    const result: RiskApprovalResult = {
      decision: 'APPROVED',
      signalId: trade.signalId,
      validatedOrder,
      appliedRules,
      riskScore: this.computeRiskScore(trade, profile),
      evaluatedAt,
      // Sprint 32 Gate 2: pass maxDailyTrades to ExecutionService for the
      // final atomic advisory-lock daily-trade-slot reservation.
      maxDailyTrades: profile.maxDailyTrades,
      // Round 5 (#301/#295/#298): the durable authority this approval binds.
      grantId,
      sessionId: session.id,
      sessionGeneration: session.authorityGeneration,
      executionMode: session.executionMode,
      brokerConnectionId: session.brokerConnectionId,
      // Round 6 (#362): immutable per-trade provenance → the durable Trade
      // row (logical account, currency, daily-risk period). LIVE decisions
      // carry the snapshot-bound values; PAPER carries the projected view's
      // currency when the source provides one (never fabricated).
      logicalAccountKey: liveSnapshotBinding?.logicalAccountKey,
      accountCurrency: liveSnapshotBinding?.currency ?? accountState.currency ?? undefined,
      riskPeriodId: liveRiskPeriodId ?? undefined,
    };

    this.logger.log(
      `Signal ${trade.signalId} APPROVED for user ${userId} ` +
        `(instrument=${trade.instrument}, lots=${effectiveLotSize}, rules=${appliedRules.length}, ` +
        `grant=${grantId}, session=${session.id}@${session.authorityGeneration}, mode=${session.executionMode})`,
    );

    this.eventBus.publish(DomainEventType.RISK_SIGNAL_APPROVED, userId, {
      userId,
      instrument: trade.instrument,
      direction: trade.direction,
      decision: 'APPROVED',
    });

    return result;
  }

  // ─── Step 0 / 1b helpers ───────────────────────────────────────────────────

  /**
   * Round 5 (#295/#298): NEW-exposure validation requires the COMPLETE
   * authority binding on the ProposedTrade — sessionId, sessionGeneration,
   * executionMode AND brokerConnectionId, with a recognized execution mode.
   * Anything missing/malformed fails closed BEFORE any other check.
   */
  private requireAuthorityBinding(trade: ProposedTrade): string | null {
    if (!trade.sessionId) return 'ProposedTrade is missing the sessionId authority binding';
    if (trade.sessionGeneration === undefined || trade.sessionGeneration === null) {
      return 'ProposedTrade is missing the sessionGeneration authority binding';
    }
    if (!trade.brokerConnectionId) {
      return 'ProposedTrade is missing the brokerConnectionId authority binding';
    }
    if (
      !trade.executionMode ||
      !Object.values(ExecutionMode).includes(trade.executionMode as ExecutionMode)
    ) {
      return `ProposedTrade carries an invalid executionMode binding ("${trade.executionMode}")`;
    }
    return null;
  }

  /**
   * Human-readable (sanitized) description of a binding/authority mismatch,
   * or null when the signal binding matches the CURRENT session authority.
   * Also guards the resolution→load window: if the session's generation
   * advanced between the seam resolution and the row load, the evaluation
   * is stale and fails closed.
   */
  private describeAuthorityMismatch(
    trade: ProposedTrade,
    session: TradingSession,
    authority: ActiveSessionAuthority,
  ): string | null {
    if (authority.sessionGeneration !== session.authorityGeneration) {
      return (
        `The session authority changed during evaluation (resolved generation ` +
        `${authority.sessionGeneration}, persisted ${session.authorityGeneration}) — reload and retry`
      );
    }
    if (trade.sessionId !== session.id) {
      return `Signal session binding ${trade.sessionId} does not match the ACTIVE session ${session.id}`;
    }
    if (trade.sessionGeneration !== session.authorityGeneration) {
      return (
        `Signal session generation ${trade.sessionGeneration} does not match the current ` +
        `authority generation ${session.authorityGeneration} — the binding is stale`
      );
    }
    if (trade.brokerConnectionId !== session.brokerConnectionId) {
      return (
        `Signal connection binding ${trade.brokerConnectionId} does not match the session-bound ` +
        `connection ${session.brokerConnectionId}`
      );
    }
    if (trade.executionMode !== session.executionMode) {
      return (
        `Signal execution mode ${trade.executionMode} does not match the session mode ` +
        `${session.executionMode}`
      );
    }
    return null;
  }

  // ─── Step 6c: per-trade controls (#316) ────────────────────────────────────

  /**
   * Enforce the configured per-trade controls with EXACT decimals (#313/#316):
   *
   *  maxTradeRiskPercent — monetary risk at stop:
   *      riskAtStop = |entry − stop| × quantity × contractSize
   *      reject when riskAtStop / equity × 100 >= maxTradeRiskPercent
   *      (divUp at scale 8; EXACT equality rejects).
   *      MARKET entries use a FRESH connection-scoped quote (existing broker
   *      seam); LIMIT entries use the signal's requested entry price.
   *
   *  maxLeverageAllowed — SEMANTIC (documented per the task): EFFECTIVE ORDER
   *      LEVERAGE = notional / equity, where notional = entry × quantity ×
   *      contractSize. This is the exposure the ORDER would add relative to
   *      the account's equity — NOT the account's broker-side leverage ratio
   *      (no account-leverage check existed in this engine before Round 5;
   *      the account-side ratio remains the broker/adapter's concern).
   *      Reject when effectiveLeverage >= maxLeverageAllowed (exact).
   *
   * GEOMETRY AVAILABILITY POLICY (per the architect's #316 instruction): if
   * the contract size or a MARKET quote is unavailable for LIVE NEW exposure
   * (LIVE account bound to a non-PAPER_ONLY session), the control fails
   * CLOSED with a typed code. For PAPER/DEMO the unavailability is recorded
   * honestly in appliedRules as UNVERIFIED — no fabricated contract size,
   * no invented pip-value formula (metals report contractSize '1').
   */
  private async enforcePerTradeControls(
    userId: string,
    trade: ProposedTrade,
    profile: RiskProfile,
    session: TradingSession,
    connection: BrokerConnection,
    equity: ExactDecimal,
    quantity: ExactDecimal,
    appliedRules: string[],
    contextSnapshot: RiskContextSnapshot,
    evaluatedAt: Date,
  ): Promise<{ rejection: RiskRejectionResult | null; quoteRef: Record<string, unknown> | null }> {
    const marketEntry = isMarketEntryPrice(trade.entryPrice);
    const geometry = await this.orderGeometry.resolveOrderGeometry({
      userId,
      brokerConnectionId: session.brokerConnectionId,
      instrument: trade.instrument,
      needFreshQuote: marketEntry,
    });

    // LIVE NEW exposure = LIVE account on a session that can dispatch it.
    const liveNewExposure =
      connection.accountType === BrokerMode.LIVE &&
      session.executionMode !== ExecutionMode.PAPER_ONLY;

    // ── entry price for the geometry ──────────────────────────────────────
    let entry: ExactDecimal | null;
    if (marketEntry) {
      if (geometry.freshQuote) {
        entry = geometry.freshQuote;
      } else if (liveNewExposure) {
        appliedRules.push('RISK_GEOMETRY:QUOTE_UNAVAILABLE');
        return {
          rejection: await this.rejectAndRecord(
            userId,
            trade,
            RiskRejectionCode.RISK_QUOTE_UNAVAILABLE,
            'No fresh connection-scoped quote available for this MARKET order — cannot verify the per-trade risk controls (fail-closed)',
            contextSnapshot,
            evaluatedAt,
          ),
          quoteRef: null,
        };
      } else {
        entry = null; // unverified geometry on PAPER/DEMO — recorded below
      }
    } else {
      entry = this.parseOrderDecimal(trade.entryPrice, 'entryPrice');
    }

    // ── contract size ─────────────────────────────────────────────────────
    const contractSize = geometry.contractSize;
    if (!contractSize) {
      if (liveNewExposure) {
        appliedRules.push('RISK_GEOMETRY:CONTRACT_SIZE_UNAVAILABLE');
        return {
          rejection: await this.rejectAndRecord(
            userId,
            trade,
            RiskRejectionCode.CONTRACT_SIZE_UNAVAILABLE,
            `No per-instrument contract size available for ${trade.instrument} — cannot verify the per-trade risk controls (fail-closed)`,
            contextSnapshot,
            evaluatedAt,
          ),
          quoteRef: null,
        };
      }
      // Honest degradation: the controls cannot be verified without a
      // contract-size source; the unverified state is recorded, never hidden.
      appliedRules.push('MAX_TRADE_RISK:GEOMETRY_UNVERIFIED');
      appliedRules.push('LEVERAGE:GEOMETRY_UNVERIFIED');
      return { rejection: null, quoteRef: geometry.quoteRef };
    }
    if (!entry) {
      // contract size known but no usable entry (MARKET quote unavailable on
      // PAPER/DEMO) — the geometry stays unverified for the same reason.
      appliedRules.push('MAX_TRADE_RISK:GEOMETRY_UNVERIFIED');
      appliedRules.push('LEVERAGE:GEOMETRY_UNVERIFIED');
      return { rejection: null, quoteRef: geometry.quoteRef };
    }

    const stop = this.parseOrderDecimal(trade.stopLoss!, 'stopLoss');

    // ── maxTradeRiskPercent: risk at stop vs equity ───────────────────────
    const riskAtStop = entry.sub(stop).abs().mul(quantity).mul(contractSize);
    const maxTradeRiskPercent = this.parseProfileDecimal(
      profile.maxTradeRiskPercent,
      'maxTradeRiskPercent',
    );
    if (!equity.isPositive()) {
      // Equity must be positive for the ratio; a non-positive equity fails
      // closed (it cannot represent verifiable account capacity).
      appliedRules.push('MAX_TRADE_RISK:EQUITY_UNAVAILABLE');
      return {
        rejection: await this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.ACCOUNT_STATE_UNAVAILABLE,
          'Account equity is not positive — cannot verify the per-trade risk percent (fail-closed)',
          contextSnapshot,
          evaluatedAt,
        ),
        quoteRef: geometry.quoteRef,
      };
    }
    const riskPercent = riskAtStop.divUp(equity, RISK_PERCENT_SCALE).mulByPowerOfTen(2);
    if (riskPercent.gte(maxTradeRiskPercent)) {
      appliedRules.push('MAX_TRADE_RISK');
      return {
        rejection: await this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.MAX_TRADE_RISK_EXCEEDED,
          `Risk at stop ${riskAtStop.toFixed(2)} is ${riskPercent.toFixed(2)}% of equity ` +
            `(${equity.toFixed(2)}) — has reached the maxTradeRiskPercent limit (${maxTradeRiskPercent.toString()}%)`,
          contextSnapshot,
          evaluatedAt,
        ),
        quoteRef: geometry.quoteRef,
      };
    }
    appliedRules.push('MAX_TRADE_RISK:OK');

    // ── maxLeverageAllowed: EFFECTIVE ORDER LEVERAGE = notional / equity ──
    const notional = entry.mul(quantity).mul(contractSize);
    const effectiveLeverage = notional.divUp(equity, LEVERAGE_SCALE);
    const maxLeverage = this.parseProfileDecimal(
      String(profile.maxLeverageAllowed),
      'maxLeverageAllowed',
    );
    if (effectiveLeverage.gte(maxLeverage)) {
      appliedRules.push('LEVERAGE');
      return {
        rejection: await this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.LEVERAGE_EXCEEDED,
          `Effective order leverage ${effectiveLeverage.toFixed(2)} (notional ${notional.toFixed(2)} / ` +
            `equity ${equity.toFixed(2)}) has reached the maxLeverageAllowed limit (${profile.maxLeverageAllowed})`,
          contextSnapshot,
          evaluatedAt,
        ),
        quoteRef: geometry.quoteRef,
      };
    }
    appliedRules.push('LEVERAGE:OK');

    return { rejection: null, quoteRef: geometry.quoteRef };
  }

  // ─── Step 8: RiskGrant issuance (#301) ─────────────────────────────────────

  /**
   * Build the canonical digests + authority binding and issue the durable
   * grant through RiskGrantService. Returns the grantId. Any failure throws —
   * the caller rejects (no APPROVED without a durable grant).
   */
  private async issueAuthorityGrant(
    userId: string,
    trade: ProposedTrade,
    profile: RiskProfile,
    session: TradingSession,
    connection: BrokerConnection,
    issuedAt: Date,
    validatedOrder: ValidatedOrder,
    quoteRef: Record<string, unknown> | null,
    liveSnapshot: {
      id: string;
      generation: number;
      observedAt: Date;
      currency: string;
      logicalAccountKey: string;
    } | null,
  ): Promise<string> {
    // Digest of the ProposedTrade MATERIAL fields (issue #301): the exact
    // signal content this approval was derived from.
    const signalPayloadDigest = await digestCanonicalPayload({
      instrument: trade.instrument,
      direction: trade.direction,
      requestedLotSize: normalizeDecimalStringForDigest(trade.requestedLotSize),
      entryPrice: normalizeDecimalStringForDigest(trade.entryPrice),
      stopLoss: normalizeDecimalStringForDigest(trade.stopLoss),
      takeProfit: normalizeDecimalStringForDigest(trade.takeProfit),
      marketRegime: trade.regime ?? null,
      sessionId: session.id,
      brokerConnectionId: session.brokerConnectionId,
    });

    // The EXACT validated order payload (immutable after issuance). MARKET
    // is the only order type this pipeline produces today; the requested
    // price is null for market entries.
    const orderPayload: AuthoritativeOrderPayload = {
      instrument: validatedOrder.instrument,
      direction: validatedOrder.direction,
      quantity: normalizeDecimalStringForDigest(validatedOrder.lotSize) ?? validatedOrder.lotSize,
      orderType: 'MARKET',
      requestedPrice: isMarketEntryPrice(validatedOrder.entryPrice)
        ? null
        : normalizeDecimalStringForDigest(validatedOrder.entryPrice),
      stopLoss: normalizeDecimalStringForDigest(validatedOrder.stopLoss),
      takeProfit: normalizeDecimalStringForDigest(validatedOrder.takeProfit),
      marketRegime: trade.regime ?? null,
    };

    // Digest of the validated order — covers the material execution fields
    // including trailingStopPips + idempotencyKey (per issue #301).
    const orderPayloadDigest = await digestCanonicalPayload({
      instrument: orderPayload.instrument,
      direction: orderPayload.direction,
      quantity: orderPayload.quantity,
      entryPrice: orderPayload.requestedPrice,
      stopLoss: orderPayload.stopLoss,
      takeProfit: orderPayload.takeProfit,
      trailingStopPips: normalizeDecimalStringForDigest(validatedOrder.trailingStopPips),
      idempotencyKey: validatedOrder.idempotencyKey,
      marketRegime: orderPayload.marketRegime,
    });

    // RiskProfile binding: the profile has no version column — bind the id +
    // a content digest of the risk-relevant fields (normalized decimals).
    const riskProfileHash = await digestCanonicalPayload({
      maxDailyLossPercent: normalizeDecimalStringForDigest(profile.maxDailyLossPercent),
      maxDrawdownPercent: normalizeDecimalStringForDigest(profile.maxDrawdownPercent),
      maxOpenTrades: profile.maxOpenTrades,
      maxDailyTrades: profile.maxDailyTrades,
      maxPositionSizeLot: normalizeDecimalStringForDigest(profile.maxPositionSizeLot),
      minStopLossPips: normalizeDecimalStringForDigest(profile.minStopLossPips),
      allowedInstruments: profile.allowedInstruments ?? null,
      maxVolatilityScore: normalizeDecimalStringForDigest(profile.maxVolatilityScore),
      rejectLowLiquidity: profile.rejectLowLiquidity,
      maxTradeRiskPercent: normalizeDecimalStringForDigest(profile.maxTradeRiskPercent),
      maxLeverageAllowed: profile.maxLeverageAllowed,
      allowedTradingModes: profile.allowedTradingModes,
      killSwitchActive: profile.killSwitchActive,
    });

    // User trading-authority generation (issue #300): read the per-user
    // monotonic row; absent row = never bumped = generation 1. (There is no
    // bump service yet — reading the row binds the real value the day one
    // lands, and the session generation binding above covers session-level
    // authority in the meantime.)
    // Round 6 (#300): delegated to the server-authoritative
    // TradingAuthorityService — fail-closed (an unavailable authority store
    // can NEVER be equivalent to generation 1).
    const authorityGeneration = await this.readUserAuthorityGeneration(userId);

    // Round 6 (#363): shared cross-replica control-plane revisions observed
    // at issuance. A failed shared store fails NEW exposure CLOSED (§16) —
    // a stale replica must never execute against newer policy.
    let tradingPolicyRevision: number | null = null;
    let providerVerificationRevision: number | null = null;
    let executionControlRevision: number | null = null;
    try {
      tradingPolicyRevision =
        await this.sharedControlRevisionService.getCurrentTradingPolicyRevision();
      providerVerificationRevision =
        await this.sharedControlRevisionService.getCurrentProviderVerificationRevision();
      executionControlRevision =
        await this.sharedControlRevisionService.getCurrentExecutionControlRevision();
    } catch (err) {
      throw new Error(
        `Shared control-plane revision read failed — NEW exposure fails closed: ${(err as Error).message}`,
      );
    }

    const { grant } = await this.riskGrantService.issueGrant({
      userId,
      signalId: trade.signalId,
      signalPayloadDigest,
      sessionId: session.id,
      sessionGeneration: session.authorityGeneration,
      executionMode: session.executionMode,
      brokerConnectionId: session.brokerConnectionId,
      // Read-only from the EXACT session-bound connection (never discovered).
      // Round 6 (#21) PARTIAL: no per-provider verification evidence
      // fingerprint is persisted on the connection today — bound null rather
      // than fabricated; the shared provider-verification REVISION is bound
      // below and the LIVE verification gates fail closed independently.
      providerBrokerIdentity: connection.providerBrokerIdentity ?? null,
      providerVerificationFingerprint: null,
      riskProfileId: profile.id,
      // Round 6 (#15): the durable monotonic risk-profile revision.
      riskProfileVersion: profile.revision ?? null,
      riskProfileHash,
      // Round 6 (#297/#312): snapshot authority binding — LIVE NEW-exposure
      // carries the durable accepted snapshot (non-null); PAPER/DEMO paths
      // without snapshot provenance bind null explicitly (never fabricated).
      accountSnapshotId: liveSnapshot?.id ?? null,
      accountSnapshotGeneration: liveSnapshot?.generation ?? null,
      accountSnapshotObservedAt: liveSnapshot?.observedAt ?? null,
      authorityGeneration,
      // Round 6 (#299/#15): the risk-profile revision doubles as the
      // kill-switch generation (bumped atomically on kill-switch changes and
      // material edits — a boolean flip can never resurrect old grants).
      killSwitchGeneration: profile.revision ?? null,
      executionControlRevision,
      // Round 6 (#363): shared cross-replica control-plane revisions.
      tradingPolicyRevision,
      providerVerificationRevision,
      // #361 fencing: the credential generation observed at issuance — any
      // rotation between approval and dispatch blocks NEW exposure at the
      // final boundary.
      credentialGeneration: connection.credentialGeneration ?? null,
      orderPayloadDigest,
      orderPayload,
      quoteRef,
      issuedAt,
    });

    return grant.id;
  }

  private async readUserAuthorityGeneration(userId: string): Promise<number> {
    // Round 6 (#300): delegated to the server-authoritative
    // TradingAuthorityService (fail-closed guarded seeding, atomic monotonic
    // CAS bumps, audited reason codes, optional transactional EntityManager).
    // An unavailable authority store is NEVER equivalent to generation 1.
    return this.tradingAuthorityService.getCurrentGeneration(userId);
  }

  // ─── Step 3b: monotonic peak equity (#317) ─────────────────────────────────

  /**
   * Maintain the session's peak equity MONOTONICALLY with a guarded CAS write:
   *
   *   UPDATE trading_sessions
   *      SET peak_equity = :fresh
   *    WHERE id = :id AND (peak_equity IS NULL OR peak_equity <= :fresh)
   *
   * Zero affected rows means a concurrent writer already persisted a HIGHER
   * peak (or this fresh value is not a new peak) — the row is reloaded and
   * the persisted peak is used. The returned peak is therefore never below
   * the persisted monotonic maximum, and drawdown is always measured from
   * the true running peak — never from a stale or writable race loser.
   */
  private async maintainMonotonicPeak(
    sessionId: string,
    freshEquity: ExactDecimal,
  ): Promise<ExactDecimal> {
    const fresh = freshEquity.toString();
    const result = await this.sessionRepo
      .createQueryBuilder()
      .update()
      .set({ peakEquity: fresh })
      .where('id = :id AND (peak_equity IS NULL OR peak_equity <= :fresh)', {
        id: sessionId,
        fresh,
      })
      .execute();
    const affected = (result as { affected?: number }).affected ?? 0;
    if (affected > 0) {
      return freshEquity;
    }
    // Lost the CAS (a higher peak persisted concurrently, or fresh is not a
    // new peak) — reload and use the persisted monotonic peak.
    const reloaded = await this.sessionRepo.findOne({ where: { id: sessionId } });
    const persisted = reloaded ? this.parseSessionDecimal(reloaded.peakEquity) : null;
    if (persisted && persisted.gte(freshEquity)) {
      return persisted;
    }
    // Row unreadable/vanished — fresh is the only known truth; never lower.
    return freshEquity;
  }

  // ─── Public utility methods ───────────────────────────────────────────────

  /**
   * Create a deterministic JSON snapshot of the risk-relevant fields of a
   * RiskProfile for storage in TradingSession.riskProfileSnapshot.
   *
   * Sprint 32: the snapshot represents the risk configuration that governed a
   * session at creation/start time. Future Risk Profile edits must not rewrite
   * history — the snapshot is immutable once stored.
   *
   * The snapshot contains ONLY risk configuration — no credentials, tokens,
   * encrypted broker secrets, or unrelated PII. The structure is a plain JSON
   * object (no methods/classes) so it serializes deterministically to the
   * jsonb column.
   */
  createRiskProfileSnapshot(profile: RiskProfile): Record<string, unknown> {
    return {
      // Account-level limits
      maxDailyLossPercent: profile.maxDailyLossPercent,
      maxDrawdownPercent: profile.maxDrawdownPercent,
      // Position-level limits
      maxOpenTrades: profile.maxOpenTrades,
      maxDailyTrades: profile.maxDailyTrades,
      maxPositionSizeLot: profile.maxPositionSizeLot,
      minStopLossPips: profile.minStopLossPips,
      // Instrument / volatility controls
      allowedInstruments: profile.allowedInstruments,
      maxVolatilityScore: profile.maxVolatilityScore,
      rejectLowLiquidity: profile.rejectLowLiquidity,
      // Sprint 29 onboarding risk controls
      maxTradeRiskPercent: profile.maxTradeRiskPercent,
      maxLeverageAllowed: profile.maxLeverageAllowed,
      allowedTradingModes: profile.allowedTradingModes,
      // Kill switch state at session start
      killSwitchActive: profile.killSwitchActive,
      // Snapshot metadata (NOT the profile's internal id/userId — those are on
      // the session already; we only store risk configuration here)
      snapshotVersion: 1,
      snapshotCreatedAt: new Date().toISOString(),
    };
  }

  /**
   * Check if the kill switch is active for a user.
   * Safe to call frequently — only reads the cached profile.
   */
  async isKillSwitchActive(userId: string): Promise<boolean> {
    const profile = await this.profileRepo.findOne({ where: { userId } });
    return profile?.killSwitchActive ?? false;
  }

  /**
   * Check if the user has an active broker connection.
   */
  async hasBrokerConnection(userId: string): Promise<boolean> {
    return this.brokerService.hasActiveConnection(userId);
  }

  /**
   * Check daily loss limit breach (informational status query — the risk
   * PIPELINE is the enforcement boundary and fails closed; this method
   * reports false when the state cannot be determined).
   *
   * Round 5 (#313/#317): EXACT decimals + the session opening-balance
   * baseline (same arithmetic as the pipeline's Step 3a).
   */
  async hasDailyLossLimitBreached(userId: string): Promise<boolean> {
    try {
      const profile = await this.getOrCreateProfile(userId);
      const authority = await this.sessionResolution.resolveActiveSessionAuthority(userId);
      const session = await this.sessionRepo.findOne({
        where: { id: authority.sessionId, userId },
      });
      if (!session) return false;

      const openingBalance = this.parseSessionDecimal(session.openingBalance);
      if (!openingBalance || !openingBalance.isPositive()) return false;

      const todayLoss = this.parseNumberAsDecimal(
        await this.executionService.getTodayRealisedLoss(userId),
      );
      if (!todayLoss || !todayLoss.isNegative()) return false;

      const maxLossAmount = ExactDecimal.percentOf(
        profile.maxDailyLossPercent,
        openingBalance.toString(),
      );
      return todayLoss.abs().gte(maxLossAmount);
    } catch {
      // Informational query only — the pipeline rejects fail-closed on the
      // same conditions; this method never drives an approval.
      return false;
    }
  }

  // ─── Profile management ───────────────────────────────────────────────────

  async getOrCreateProfile(userId: string): Promise<RiskProfile> {
    const existing = await this.profileRepo.findOne({ where: { userId } });
    if (existing) return existing;

    const profile = this.profileRepo.create({ userId });
    return this.profileRepo.save(profile);
  }

  async updateProfile(userId: string, dto: UpdateRiskProfileDto): Promise<RiskProfile> {
    const profile = await this.getOrCreateProfile(userId);

    if (dto.maxDailyLossPercent !== undefined)
      profile.maxDailyLossPercent = dto.maxDailyLossPercent.toFixed(2);
    if (dto.maxDrawdownPercent !== undefined)
      profile.maxDrawdownPercent = dto.maxDrawdownPercent.toFixed(2);
    if (dto.maxOpenTrades !== undefined) profile.maxOpenTrades = dto.maxOpenTrades;
    if (dto.maxDailyTrades !== undefined) profile.maxDailyTrades = dto.maxDailyTrades;
    if (dto.maxPositionSizeLot !== undefined)
      profile.maxPositionSizeLot = dto.maxPositionSizeLot.toFixed(4);
    if (dto.minStopLossPips !== undefined) profile.minStopLossPips = dto.minStopLossPips.toFixed(2);
    if (dto.allowedInstruments !== undefined) profile.allowedInstruments = dto.allowedInstruments;
    if (dto.maxVolatilityScore !== undefined)
      profile.maxVolatilityScore = dto.maxVolatilityScore.toFixed(2);
    if (dto.rejectLowLiquidity !== undefined) profile.rejectLowLiquidity = dto.rejectLowLiquidity;

    // Sprint 29: new onboarding fields
    if (dto.maxTradeRiskPercent !== undefined)
      profile.maxTradeRiskPercent = dto.maxTradeRiskPercent.toFixed(2);
    if (dto.maxLeverageAllowed !== undefined) profile.maxLeverageAllowed = dto.maxLeverageAllowed;
    if (dto.allowedTradingModes !== undefined)
      profile.allowedTradingModes = dto.allowedTradingModes;

    // Sprint 29: risk acknowledgement — only record when transitioning to true
    const wasAccepted = profile.riskAcknowledgementAccepted;
    if (dto.riskAcknowledgementAccepted !== undefined) {
      profile.riskAcknowledgementAccepted = dto.riskAcknowledgementAccepted;
      if (dto.riskAcknowledgementAccepted && !wasAccepted) {
        profile.riskAcknowledgementAcceptedAt = new Date();
      }
    }

    // Round 6 (#15/#2): material risk-policy edits advance the durable
    // risk-profile revision + TradingAuthorityGeneration and invalidate the
    // user's NEW-exposure authority ATOMICALLY WITH the edit. Display-only
    // edits (outside the material set below) do not bump.
    const materialFields: (keyof UpdateRiskProfileDto)[] = [
      'maxDailyLossPercent',
      'maxDrawdownPercent',
      'maxOpenTrades',
      'maxDailyTrades',
      'maxPositionSizeLot',
      'allowedInstruments',
      'maxTradeRiskPercent',
      'maxLeverageAllowed',
      'allowedTradingModes',
      'riskAcknowledgementAccepted',
    ];
    const materialChange = materialFields.some((field) => dto[field] !== undefined);

    await this.profileRepo.manager.transaction(async (em) => {
      await em.getRepository(RiskProfile).save(profile);
      if (materialChange) {
        await this.bumpProfileRevisionAndAuthority(em, userId, 'RISK_PROFILE_MATERIAL_EDIT');
      }
    });

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.RISK_PROFILE_UPDATED,
      resourceType: 'RiskProfile',
      resourceId: profile.id,
      metadata: { changes: dto },
    });

    // Sprint 29: separate audit for risk acknowledgement acceptance
    if (dto.riskAcknowledgementAccepted && !wasAccepted) {
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.RISK_ACKNOWLEDGEMENT_ACCEPTED,
        resourceType: 'RiskProfile',
        resourceId: profile.id,
        metadata: { acceptedAt: profile.riskAcknowledgementAcceptedAt },
      });
    }

    return profile;
  }

  async toggleKillSwitch(
    userId: string,
    active: boolean,
    reason?: string,
    ipAddress?: string,
  ): Promise<RiskProfile> {
    // Round 6 (#299/#4): the kill-switch fact, the monotonic risk-profile
    // revision (the kill-switch generation), the TradingAuthorityGeneration
    // bump, and the NEW-exposure authority invalidation (ACTIVE grants +
    // PENDING confirmations) ALL commit in ONE transaction. Turning the
    // switch OFF advances authority AGAIN — a boolean flip can never
    // resurrect pre-switch grants (G1 → kill ON → G2 → kill OFF → G3:
    // G1 stays dead).
    const profile = await this.profileRepo.manager.transaction(async (em) => {
      const profiles = em.getRepository(RiskProfile);
      let row = await profiles.findOne({ where: { userId } });
      if (!row) row = profiles.create({ userId });
      row.killSwitchActive = active;
      row.killSwitchReason = reason ?? null;
      await profiles.save(row);

      await this.bumpProfileRevisionAndAuthority(em, userId, 'KILL_SWITCH_TOGGLED');

      return row;
    });

    // Audits follow the durable write (failure never rolls back authority).
    await this.auditService.log({
      actorUserId: userId,
      action: active
        ? AuditAction.RISK_KILL_SWITCH_ACTIVATED
        : AuditAction.RISK_KILL_SWITCH_DEACTIVATED,
      resourceType: 'RiskProfile',
      resourceId: profile.id,
      ipAddress,
      metadata: { active, reason },
      severity: active ? AuditSeverity.WARNING : AuditSeverity.INFO,
    });

    this.logger.log(
      `Kill switch ${active ? 'ACTIVATED' : 'DEACTIVATED'} for user ${userId}. Reason: ${reason ?? 'none'}`,
    );

    return profile;
  }

  /**
   * Round 6 (#15/#2 atomicity): monotonic risk-profile revision CAS +
   * TradingAuthorityGeneration bump + user-scoped NEW-exposure invalidation,
   * all inside the CALLER's transaction. The forbidden pattern is
   * save-fact → commit → best-effort bump later (an execution race).
   */
  private async bumpProfileRevisionAndAuthority(
    em: EntityManager,
    userId: string,
    reason: AuthorityBumpReason,
  ): Promise<void> {
    const profiles = em.getRepository(RiskProfile);
    await profiles
      .createQueryBuilder()
      .update()
      .set({ revision: () => 'COALESCE(revision, 0) + 1', updatedAt: new Date() })
      .where('user_id = :userId', { userId })
      .execute();
    await this.tradingAuthorityService.bumpGeneration(userId, reason, em);
    await this.grantInvalidation.invalidateUserNewExposureAuthority(userId, reason, em);
  }

  async getViolations(userId: string, limit = 50): Promise<RiskViolation[]> {
    return this.violationRepo.find({
      where: { userId },
      order: { evaluatedAt: 'DESC' },
      take: limit,
    });
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Strict exact-decimal parse of a BROKER-sourced string (account state).
   * Returns null on malformed values — call sites fail closed with typed
   * codes (never substitute a default and continue).
   */
  private parseBrokerDecimal(value: string | null | undefined, field: string): ExactDecimal | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = ExactDecimal.tryParse(value);
    if (!parsed) {
      this.logger.warn(`Broker decimal field "${field}" is malformed: "${value}"`);
    }
    return parsed;
  }

  /**
   * Parse a TradingSession numeric column (PostgreSQL returns strings; the
   * sqlite test harness hydrates numerics as numbers — both accepted via
   * their shortest round-trip string).
   */
  private parseSessionDecimal(value: string | number | null | undefined): ExactDecimal | null {
    if (value === null || value === undefined) return null;
    return ExactDecimal.tryParse(typeof value === 'number' ? String(value) : value);
  }

  /**
   * Parse a JS number from a service boundary (daily P&L, volatility score)
   * as the exact decimal of its shortest round-trip string. NaN/Infinity
   * fail closed (null).
   */
  private parseNumberAsDecimal(value: number): ExactDecimal | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return ExactDecimal.tryParse(String(value));
  }

  /**
   * Parse a RiskProfile numeric column — profile fields are trusted config,
   * so a malformed value is an engine/configuration error that throws
   * (caught by the fail-closed wrapper as RISK_ENGINE_ERROR).
   */
  private parseProfileDecimal(value: string | number, field: string): ExactDecimal {
    const parsed =
      typeof value === 'number' ? this.parseNumberAsDecimal(value) : ExactDecimal.tryParse(value);
    if (!parsed) {
      throw new Error(`RiskProfile field "${field}" is not a valid decimal: "${String(value)}"`);
    }
    return parsed;
  }

  /** Parse an order/signal decimal field (fail-closed on malformed). */
  private parseOrderDecimal(value: string, field: string): ExactDecimal {
    const parsed = ExactDecimal.tryParse(value);
    if (!parsed) {
      throw new Error(`ProposedTrade field "${field}" is not a valid decimal: "${String(value)}"`);
    }
    return parsed;
  }

  /** EXACT stop-loss distance check in pips (#313 — no float arithmetic). */
  private checkStopLossDistance(trade: ProposedTrade, profile: RiskProfile): string | null {
    if (!trade.stopLoss || !trade.entryPrice) return null;

    const entry = this.parseOrderDecimal(trade.entryPrice, 'entryPrice');
    const sl = this.parseOrderDecimal(trade.stopLoss, 'stopLoss');
    const minPips = this.parseProfileDecimal(profile.minStopLossPips, 'minStopLossPips');
    const pipSize = ExactDecimal.parse(
      trade.instrument.includes('JPY') ? JPY_PIP_SIZE : DEFAULT_PIP_SIZE,
    );

    const slDistancePips = entry.sub(sl).abs().div(pipSize, { scale: 6, mode: 'HALF_UP' });

    if (slDistancePips.lt(minPips)) {
      return (
        `Stop-loss distance ${slDistancePips.toFixed(1)} pips is below minimum ` +
        `${minPips.toString()} pips for ${trade.instrument}`
      );
    }
    return null;
  }

  /** EXACT take-profit direction check (#313 — no float arithmetic). */
  private checkTakeProfitDirection(trade: ProposedTrade): string | null {
    if (!trade.takeProfit || !trade.entryPrice) return null;

    const entry = this.parseOrderDecimal(trade.entryPrice, 'entryPrice');
    const tp = this.parseOrderDecimal(trade.takeProfit, 'takeProfit');

    if (trade.direction === 'BUY' && tp.lte(entry)) {
      return `Take-profit ${tp.toString()} must be above entry ${entry.toString()} for BUY direction`;
    }
    if (trade.direction === 'SELL' && tp.gte(entry)) {
      return `Take-profit ${tp.toString()} must be below entry ${entry.toString()} for SELL direction`;
    }
    return null;
  }

  /**
   * Heuristic 0–100 risk score (DISPLAY ONLY — never a safety boundary).
   * Exact-decimal parsing keeps the lot ratio deterministic; the composite
   * score intentionally remains a coarse display heuristic.
   */
  private computeRiskScore(trade: ProposedTrade, profile: RiskProfile): number {
    let score = 0;
    const maxLots = this.parseProfileDecimal(profile.maxPositionSizeLot, 'maxPositionSizeLot');
    const requestedLots = this.parseOrderDecimal(trade.requestedLotSize, 'requestedLotSize');

    // Position size relative to max (0–30 points) — exact ratio, quantized
    // DOWN (display heuristic; never overstates the score).
    let ratio: number;
    if (maxLots.isZero()) {
      ratio = 0;
    } else {
      ratio = requestedLots.divDown(maxLots, 6).toApproximateNumber();
    }
    score += Math.min(30, ratio * 30);

    // Volatility (0–40 points)
    if (trade.volatilityScore !== undefined && Number.isFinite(trade.volatilityScore)) {
      score += trade.volatilityScore * 40;
    }

    // Regime risk (0–30 points)
    if (trade.regime === 'HIGH_VOLATILITY') score += 30;
    else if (trade.regime === 'LOW_LIQUIDITY') score += 20;
    else if (trade.regime === 'RANGING') score += 5;

    return Math.min(100, Math.round(score));
  }

  /**
   * Emergency-control gate evaluation (architect correction A1).
   *
   * Evaluates the control plane with whatever context is known at the call
   * site — { userId } early in the pipeline (GLOBAL/USER fail-fast), and the
   * complete { userId, brokerId, brokerConnectionId } context once the
   * session-bound connection has been loaded (all four scopes). Returns
   * the REJECTION decision when a control blocks, or null when allowed.
   * Fail-closed: an unreadable control store rejects the trade.
   */
  private async evaluateControlGate(
    context: { userId: string; brokerId?: string; brokerConnectionId?: string },
    userId: string,
    trade: ProposedTrade,
    contextSnapshot: Partial<RiskContextSnapshot>,
    evaluatedAt: Date,
  ): Promise<RiskRejectionResult | null> {
    const controlPermission = await this.executionControlService
      .checkExecutionPermission(context)
      .catch(() => ({
        allowed: false as const,
        blockedBy: {
          scope: 'GLOBAL' as const,
          scopeKey: null,
          reason: 'EXECUTION_CONTROL_CHECK_FAILED',
        },
      }));

    if (controlPermission.allowed) return null;

    const control = controlPermission.blockedBy;
    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.EXECUTION_CONTROL_BLOCKED,
      resourceType: 'AiSignal',
      resourceId: trade.signalId,
      metadata: {
        scope: control?.scope,
        scopeKey: control?.scopeKey,
        reason: control?.reason,
      },
      severity: AuditSeverity.WARNING,
    });
    return this.rejectAndRecord(
      userId,
      trade,
      RiskRejectionCode.EXECUTION_CONTROL_ACTIVE,
      `Execution blocked by emergency control (scope=${control?.scope}${
        control?.scopeKey ? `, key=${control.scopeKey}` : ''
      }): ${control?.reason}`,
      contextSnapshot as RiskContextSnapshot,
      evaluatedAt,
    );
  }

  private buildRejection(
    signalId: string,
    code: RiskRejectionCode,
    reason: string,
    evaluatedAt: Date,
  ): RiskRejectionResult {
    return {
      decision: 'REJECTED',
      signalId,
      rejectionCode: code,
      rejectionReason: reason,
      evaluatedAt,
    };
  }

  private async rejectAndRecord(
    userId: string,
    trade: ProposedTrade,
    code: RiskRejectionCode,
    reason: string,
    context: RiskContextSnapshot,
    evaluatedAt: Date,
  ): Promise<RiskRejectionResult> {
    const decision: RiskRejectionResult = {
      decision:
        code === RiskRejectionCode.DAILY_LOSS_LIMIT_REACHED ||
        code === RiskRejectionCode.MAX_DRAWDOWN_REACHED
          ? 'SUSPENDED'
          : 'REJECTED',
      signalId: trade.signalId,
      rejectionCode: code,
      rejectionReason: reason,
      evaluatedAt,
    };

    // Record violation asynchronously — don't block the rejection response
    this.violationRepo
      .save(
        this.violationRepo.create({
          userId,
          signalId: trade.signalId,
          rejectionCode: code,
          rejectionReason: reason,
          riskContext: context as unknown as Record<string, unknown>,
        }),
      )
      .catch((err) =>
        this.logger.error(`Failed to record risk violation: ${(err as Error).message}`),
      );

    this.logger.warn(`Signal ${trade.signalId} REJECTED for user ${userId}: [${code}] ${reason}`);

    return decision;
  }
}

// ─── Module-level pure helpers ───────────────────────────────────────────────

/**
 * MARKET entry detection: the strategy pipeline maps "no suggested entry
 * price" (market order) to the literal '0' (see strategy-orchestrator).
 * Absent/empty/'0' entry prices are MARKET entries; anything else is the
 * signal's requested (limit-style) entry price.
 */
function isMarketEntryPrice(entryPrice: string | undefined): boolean {
  if (!entryPrice) return true;
  const trimmed = entryPrice.trim();
  if (trimmed === '' || trimmed === '0') return true;
  return false;
}

/** Recognized market regimes (#330) — anything else is UNKNOWN (fail-closed). */
function isKnownMarketRegime(regime: string | undefined): boolean {
  return (
    regime === 'TRENDING' ||
    regime === 'RANGING' ||
    regime === 'LOW_LIQUIDITY' ||
    regime === 'HIGH_VOLATILITY'
  );
}
