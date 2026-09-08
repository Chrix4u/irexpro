import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RiskProfile } from './entities/risk-profile.entity';
import { RiskViolation } from './entities/risk-violation.entity';
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
import { BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { UpdateRiskProfileDto } from './dto/update-risk-profile.dto';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';

/** Default pip size for standard 5-digit pairs (EURUSD, GBPUSD, etc.) */
const DEFAULT_PIP_SIZE = 0.0001;
/** Default pip size for JPY pairs (USDJPY, GBPJPY, etc.) */
const JPY_PIP_SIZE = 0.01;

/**
 * RiskService — The mandatory, non-bypassable pre-trade validation gateway.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CORE INVARIANT — NEVER VIOLATE:
 *   1. validateProposedTrade() MUST be called before ANY broker order
 *   2. Only APPROVED decisions allow execution to proceed
 *   3. The pipeline is FAIL CLOSED — any internal error = REJECTED
 *   4. APPROVED decisions cannot be fabricated — they must come from this service
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Validation pipeline (8 steps):
 *   Step 1: Pre-conditions (kill switch, broker connection)
 *   Step 2: Load risk context (profile + broker state)
 *   Step 3: Account-level checks (daily loss, drawdown, margin)
 *   Step 4: Position-level checks (concurrent trades, position size, instrument)
 *   Step 5: Order integrity (mandatory SL/TP, SL distance, TP direction)
 *   Step 6: Volatility and regime checks
 *   Step 7: Duplicate prevention (idempotency)
 *   Step 8: Emit APPROVED decision
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
    private brokerService: BrokerService,
    private auditService: AuditService,
    @Inject(forwardRef(() => ExecutionService))
    private executionService: ExecutionService,
    private readonly executionControlService: ExecutionControlService,
    private readonly eventBus: DomainEventBus,
  ) {}

  // ─── Main validation entry point ──────────────────────────────────────────

  /**
   * Validate a proposed trade signal through the complete 8-step risk pipeline.
   *
   * This is the ONLY entry point for trade validation. It must be called
   * before every order, without exception.
   *
   * Returns:
   *   APPROVED   — trade may proceed to ExecutionService
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

  // ─── 8-Step pipeline ──────────────────────────────────────────────────────

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
    };

    // ── Step 1: Pre-condition checks (fail fast) ────────────────────────────

    // 1a-pre. Emergency control plane (Sprint 50, Directive §28) — checked
    // FIRST so GLOBAL/USER-level disable affects newly submitted work
    // immediately, before any broker/connection discovery. Fail-closed: an
    // unreadable control store blocks execution.
    //
    // Architect correction A1: this EARLY check covers the GLOBAL and USER
    // scopes only (no connection context is known yet). After the
    // authoritative broker connection is discovered (1c), the pipeline
    // re-evaluates the control plane with the COMPLETE context —
    // user + provider + broker connection — so all four scopes are
    // genuinely enforced at the risk boundary, not just documented.
    const earlyControlRejection = await this.evaluateControlGate(
      { userId },
      userId,
      trade,
      contextSnapshot,
      evaluatedAt,
    );
    if (earlyControlRejection) return earlyControlRejection;
    appliedRules.push('EXECUTION_CONTROL:OK');

    // 1a. Kill switch (checked FIRST — fastest possible rejection)
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

    // 1b. Broker connection check
    const hasBroker = await this.brokerService.hasActiveConnection(userId);
    contextSnapshot.brokerConnected = hasBroker;

    if (!hasBroker) {
      appliedRules.push('BROKER_CONNECTION');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.BROKER_DISCONNECTED,
        'No active broker connection — cannot place orders',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('BROKER_CONNECTION:OK');

    // 1c. Discover the authoritative connection. LIVE authorization gate
    // (Sprint 50, Directive §16): when the user's active connection is a LIVE
    // account, its authorization state machine must be ACTIVE (the only
    // executable state). DEMO/PAPER connections keep the existing behavior —
    // LIVE isolation fails closed here, never falls back to a lower-friction
    // path.
    const activeConnection = await this.brokerService.findActiveConnectionForUser(userId);

    // 1c-pre. Emergency control plane — COMPLETE four-scope context
    // (architect correction A1): now that the authoritative broker connection
    // is known, re-evaluate the control plane against user + provider +
    // broker connection. This is the gate that genuinely enforces PROVIDER
    // and BROKER_CONNECTION scopes in the risk pipeline (with the structured
    // RiskViolation + audit trail), not only at the downstream dispatch
    // boundary.
    if (activeConnection) {
      const fullControlRejection = await this.evaluateControlGate(
        {
          userId,
          brokerId: activeConnection.brokerId,
          brokerConnectionId: activeConnection.id,
        },
        userId,
        trade,
        contextSnapshot,
        evaluatedAt,
      );
      if (fullControlRejection) return fullControlRejection;
      appliedRules.push('EXECUTION_CONTROL_FULL_CONTEXT:OK');
    }

    if (
      activeConnection &&
      activeConnection.accountType === BrokerMode.LIVE &&
      !this.brokerService.isConnectionExecutable(activeConnection)
    ) {
      appliedRules.push('LIVE_AUTHORIZATION');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.LIVE_AUTHORIZATION_REQUIRED,
        `LIVE connection ${activeConnection.id} authorization status is ` +
          `${activeConnection.authorizationStatus} — live execution requires ACTIVE`,
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }
    appliedRules.push('LIVE_AUTHORIZATION:OK');

    // ── Step 2: Load broker account state ──────────────────────────────────

    let brokerBalance: string | undefined;
    let brokerEquity: string | undefined;
    let brokerFreeMargin: string | undefined;

    try {
      const activeConn = await this.brokerService.findActiveConnectionForUser(userId);
      if (activeConn) {
        const account = await this.brokerService.getBrokerAccountState(activeConn.id);
        brokerBalance = account?.balance;
        brokerEquity = account?.equity;
        brokerFreeMargin = account?.freeMargin;
        contextSnapshot.brokerBalance = brokerBalance;
        contextSnapshot.brokerEquity = brokerEquity;
      }
    } catch (err) {
      this.logger.warn(
        `Could not load broker account state for user ${userId}: ${(err as Error).message}`,
      );
    }

    // ── Step 3: Account-level checks ───────────────────────────────────────

    // 3a. Daily loss limit
    try {
      const todayLoss = await this.executionService.getTodayRealisedLoss(userId);
      if (brokerBalance && todayLoss < 0) {
        const balance = parseFloat(brokerBalance);
        const maxLossAmount = balance * (parseFloat(profile.maxDailyLossPercent) / 100);
        if (Math.abs(todayLoss) >= maxLossAmount) {
          appliedRules.push('DAILY_LOSS_LIMIT');
          return this.rejectAndRecord(
            userId,
            trade,
            RiskRejectionCode.DAILY_LOSS_LIMIT_REACHED,
            `Daily loss ${Math.abs(todayLoss).toFixed(2)} has reached limit ` +
              `(${profile.maxDailyLossPercent}% = ${maxLossAmount.toFixed(2)} of balance)`,
            contextSnapshot as RiskContextSnapshot,
            evaluatedAt,
          );
        }
        contextSnapshot.dailyRealisedPnl = todayLoss.toFixed(2);
      }
      appliedRules.push('DAILY_LOSS_LIMIT:OK');
    } catch {
      appliedRules.push('DAILY_LOSS_LIMIT:SKIPPED');
    }

    // 3b. Max drawdown
    if (brokerBalance && brokerEquity) {
      const balance = parseFloat(brokerBalance);
      const equity = parseFloat(brokerEquity);
      const drawdownPct = balance > 0 ? ((balance - equity) / balance) * 100 : 0;
      const maxDrawdown = parseFloat(profile.maxDrawdownPercent);
      if (drawdownPct >= maxDrawdown) {
        appliedRules.push('MAX_DRAWDOWN');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.MAX_DRAWDOWN_REACHED,
          `Drawdown ${drawdownPct.toFixed(2)}% has reached limit ${maxDrawdown}%`,
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }
      appliedRules.push('MAX_DRAWDOWN:OK');
    } else {
      appliedRules.push('MAX_DRAWDOWN:SKIPPED');
    }

    // 3c. Margin / account capacity check
    // Sprint 32 Gate 2: capability-aware margin validation through the broker
    // abstraction. The Risk Engine does NOT contain broker-specific margin
    // formulas — it delegates to BrokerService.getRequiredMargin() which uses
    // the adapter's getRequiredMargin() (broker-specific rules).
    //
    // For LIVE execution: compares requiredMargin vs available freeMargin.
    // If requiredMargin > freeMargin → reject with INSUFFICIENT_MARGIN.
    // If requiredMargin cannot be established (null) → fail closed.
    // If account state is missing/malformed → fail closed.
    //
    // For PAPER execution: the paper broker adapter provides deterministic
    // simulated margin calculation. The same comparison applies.
    //
    // No arbitrary safety multipliers (e.g. 0.95) are used — the comparison
    // is requiredMargin > freeMargin (strict greater-than). This is the
    // documented policy: the account must have at least the required margin.
    if (brokerFreeMargin !== undefined && brokerFreeMargin !== null) {
      const freeMargin = parseFloat(brokerFreeMargin);
      if (Number.isNaN(freeMargin) || !Number.isFinite(freeMargin)) {
        appliedRules.push('MARGIN_CHECK:ERROR');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.INSUFFICIENT_MARGIN,
          `Broker free margin is malformed ("${brokerFreeMargin}") — cannot verify account capacity`,
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }

      // Get required margin through the broker abstraction
      const activeConn = await this.brokerService.findActiveConnectionForUser(userId);
      if (!activeConn) {
        appliedRules.push('MARGIN_CHECK:NO_CONNECTION');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.INSUFFICIENT_MARGIN,
          'No active broker connection — cannot calculate required margin',
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }

      let requiredMargin: string | null = null;
      try {
        requiredMargin = await this.brokerService.getRequiredMargin(activeConn.id, {
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

      const reqMargin = parseFloat(requiredMargin);
      if (Number.isNaN(reqMargin) || !Number.isFinite(reqMargin)) {
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

      if (reqMargin > freeMargin) {
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
    } else {
      // No account state available — fail closed
      appliedRules.push('MARGIN_CHECK:UNAVAILABLE');
      return this.rejectAndRecord(
        userId,
        trade,
        RiskRejectionCode.INSUFFICIENT_MARGIN,
        'Broker account state unavailable — cannot verify margin capacity (fail-closed)',
        contextSnapshot as RiskContextSnapshot,
        evaluatedAt,
      );
    }

    // ── Step 4: Position-level checks ──────────────────────────────────────

    // 4a. Max concurrent trades
    try {
      const openCount = await this.executionService.countOpenTrades(userId);
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
    } catch {
      appliedRules.push('CONCURRENT_TRADES:SKIPPED');
    }

    // 4b. Max daily trades
    // Sprint 32: enforce the daily trade limit. Counts trades actually OPENED
    // today (UTC day boundary), excluding PENDING and REJECTED — avoids
    // double-counting retries and risk-rejected attempts. Concurrency-safe via
    // the DB unique constraint on idempotency_key (prevents duplicate execution).
    try {
      const todayTrades = await this.executionService.countTodayTrades(userId);
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
    } catch {
      // Fail closed: if we cannot count today's trades, we cannot safely enforce
      // the limit. Reject rather than risk exceeding the daily cap.
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

    // 4c. Position size check
    const requestedLots = parseFloat(trade.requestedLotSize);
    const maxLots = parseFloat(profile.maxPositionSizeLot);
    let effectiveLotSize = trade.requestedLotSize;

    if (requestedLots > maxLots) {
      // Soft reduction: cap to max, don't reject outright
      effectiveLotSize = profile.maxPositionSizeLot;
      this.logger.log(
        `Signal ${trade.signalId}: lot size reduced from ${requestedLots} to ${maxLots} (maxPositionSizeLot)`,
      );
      appliedRules.push(`POSITION_SIZE:REDUCED_${requestedLots}_TO_${maxLots}`);

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.RISK_POSITION_SIZE_REDUCED,
        metadata: {
          signalId: trade.signalId,
          requestedLots,
          cappedLots: maxLots,
          instrument: trade.instrument,
        },
      });
    } else {
      appliedRules.push('POSITION_SIZE:OK');
    }

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

    // 5c. Stop-loss distance check (minimum pips from entry)
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

    // 5d. Take-profit direction validity
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

    // ── Step 6: Volatility and regime checks ───────────────────────────────

    if (trade.volatilityScore !== undefined) {
      const maxVol = parseFloat(profile.maxVolatilityScore);
      if (trade.volatilityScore > maxVol) {
        appliedRules.push('VOLATILITY');
        return this.rejectAndRecord(
          userId,
          trade,
          RiskRejectionCode.HIGH_VOLATILITY,
          `Volatility score ${trade.volatilityScore.toFixed(2)} exceeds threshold ${maxVol}`,
          contextSnapshot as RiskContextSnapshot,
          evaluatedAt,
        );
      }
      appliedRules.push('VOLATILITY:OK');
    }

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
    appliedRules.push('REGIME:OK');

    // ── Step 7: Duplicate prevention (risk layer) ─────────────────────────
    // Sprint 32: the Execution layer has an atomic DB unique-constraint check
    // on idempotency_key (SHA-256 of userId:instrument:direction:signalId).
    // The Risk layer additionally checks for an EXISTING trade with this
    // signalId — if one already exists, the signal is a duplicate and we
    // reject early with DUPLICATE_SIGNAL (before reaching execution).
    //
    // This is a defense-in-depth check: even if the orchestrator retries a
    // signal (network retry, queue redelivery), the Risk layer will reject
    // the duplicate rather than letting it through to execution where the DB
    // constraint would catch it. The difference: a DUPLICATE_SIGNAL rejection
    // is visible to the caller with a clear code; a DB constraint violation
    // surfaces as a generic error.
    try {
      const existingTrade = await this.executionService.findTradeBySignalId(trade.signalId, userId);
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
    } catch {
      // Fail closed: if we cannot check for duplicates, reject rather than risk
      // double-execution. The Execution layer's DB constraint is the final
      // safety net, but the Risk layer should not approve if it cannot verify.
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

    // ── Step 8: APPROVED ───────────────────────────────────────────────────

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
    };

    this.logger.log(
      `Signal ${trade.signalId} APPROVED for user ${userId} ` +
        `(instrument=${trade.instrument}, lots=${effectiveLotSize}, rules=${appliedRules.length})`,
    );

    this.eventBus.publish(DomainEventType.RISK_SIGNAL_APPROVED, userId, {
      userId,
      instrument: trade.instrument,
      direction: trade.direction,
      decision: 'APPROVED',
    });

    return result;
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
   * Check daily loss limit breach.
   * Uses live Trade data from ExecutionService.
   */
  async hasDailyLossLimitBreached(userId: string): Promise<boolean> {
    try {
      const profile = await this.getOrCreateProfile(userId);
      const activeConn = await this.brokerService.findActiveConnectionForUser(userId);
      if (!activeConn) return false;

      const account = await this.brokerService.getBrokerAccountState(activeConn.id);
      if (!account?.balance) return false;

      const todayLoss = await this.executionService.getTodayRealisedLoss(userId);
      if (todayLoss >= 0) return false;

      const balance = parseFloat(account.balance);
      const maxLossAmount = balance * (parseFloat(profile.maxDailyLossPercent) / 100);
      return Math.abs(todayLoss) >= maxLossAmount;
    } catch {
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

    await this.profileRepo.save(profile);

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
    const profile = await this.getOrCreateProfile(userId);
    profile.killSwitchActive = active;
    profile.killSwitchReason = reason ?? null;
    await this.profileRepo.save(profile);

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

  async getViolations(userId: string, limit = 50): Promise<RiskViolation[]> {
    return this.violationRepo.find({
      where: { userId },
      order: { evaluatedAt: 'DESC' },
      take: limit,
    });
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private checkStopLossDistance(trade: ProposedTrade, profile: RiskProfile): string | null {
    if (!trade.stopLoss || !trade.entryPrice) return null;

    const entry = parseFloat(trade.entryPrice);
    const sl = parseFloat(trade.stopLoss);
    const minPips = parseFloat(profile.minStopLossPips);
    const pipSize = trade.instrument.includes('JPY') ? JPY_PIP_SIZE : DEFAULT_PIP_SIZE;

    const slDistancePips = Math.abs(entry - sl) / pipSize;

    if (slDistancePips < minPips) {
      return (
        `Stop-loss distance ${slDistancePips.toFixed(1)} pips is below minimum ` +
        `${minPips} pips for ${trade.instrument}`
      );
    }
    return null;
  }

  private checkTakeProfitDirection(trade: ProposedTrade): string | null {
    if (!trade.takeProfit || !trade.entryPrice) return null;

    const entry = parseFloat(trade.entryPrice);
    const tp = parseFloat(trade.takeProfit);

    if (trade.direction === 'BUY' && tp <= entry) {
      return `Take-profit ${tp} must be above entry ${entry} for BUY direction`;
    }
    if (trade.direction === 'SELL' && tp >= entry) {
      return `Take-profit ${tp} must be below entry ${entry} for SELL direction`;
    }
    return null;
  }

  private computeRiskScore(trade: ProposedTrade, profile: RiskProfile): number {
    let score = 0;
    const maxLots = parseFloat(profile.maxPositionSizeLot);
    const requestedLots = parseFloat(trade.requestedLotSize);

    // Position size relative to max (0–30 points)
    score += Math.min(30, (requestedLots / maxLots) * 30);

    // Volatility (0–40 points)
    if (trade.volatilityScore !== undefined) {
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
   * authoritative connection has been discovered (all four scopes). Returns
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
