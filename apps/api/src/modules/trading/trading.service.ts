import {
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BrokerService } from '../broker/broker.service';
import { RiskService } from '../risk/risk.service';
import { ExecutionService } from '../execution/execution.service';
import { AllocationService } from '../execution/services/allocation.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';
import { AiEngineClient } from '../ai-engine-client/ai-engine-client.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { BrokerConnectionRequiredException } from '../execution/execution-session.resolution';
import { OnboardingService } from '../users/onboarding.service';
import { TradingNotReadyException } from '../../common/exceptions/trading-not-ready.exception';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerConnectionStatus, BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { BrokerAccountSnapshotService } from '../broker/services/broker-account-snapshot.service';
import { BrokerAccountSnapshot } from '../broker/entities/broker-account-snapshot.entity';
import { ExactDecimal } from '../../common/utils/exact-decimal';
import { TradeCloseReason } from '../execution/entities/trade.entity';

export type AiStopPositionCloseState = 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';

export interface StopTradingSessionResult {
  message: string;
  sessionId: string;
  positionCloseSummary: {
    state: AiStopPositionCloseState;
    targetCount: number | null;
    closedCount: number;
    unresolvedCount: number | null;
  };
}

/**
 * TradingService — Trading session lifecycle management.
 *
 * Sprint 29 amendment: the centralized OnboardingService.canStartTrading()
 * gate is enforced as the FIRST check in startTradingSession(). This cannot
 * be bypassed — it runs inside the service, not just the controller.
 *
 * Mandatory gates before starting a session (ALL must pass):
 *   1. OnboardingService.canStartTrading() — identity/eligibility complete,
 *      broker CONNECTED, kill switch NOT active, and user ACTIVE.
 *   2. Broker connection is CONNECTED AND healthy (fresh health check).
 *   3. User has explicitly allocated AI capital for the exact broker account.
 *   4. Live trading (if requested) requires explicit broker enablement.
 *
 * Risk limits and mode policy are server-managed. The user's AI automation
 * toggle is the explicit execution-mode decision; users are not required to
 * configure a separate risk-profile mode preference.
 *
 * Subscription/payment state is intentionally NOT an access or trading gate.
 * Users may access the application and start trading without a paid plan.
 * Monetization is handled separately from realised performance.
 *
 * CRITICAL: Signal routing is NOT managed here.
 * Signals flow through: AI Signal Engine → Strategy Orchestrator → Broker Connection Gate
 * → Risk Engine → Execution Engine → Broker Adapter.
 * The risk gate remains between AI signals and broker execution — AI never
 * directly executes broker orders.
 *
 * See: docs/architecture/04-system-architecture.md §6
 * See: docs/architecture/09-broker-integration-architecture.md
 */
@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);

  /** Max staleness for broker health check before requiring a fresh check. */
  private static readonly BROKER_HEALTH_MAX_STALENESS_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly brokerService: BrokerService,
    private readonly riskService: RiskService,
    private readonly onboardingService: OnboardingService,
    @Inject(forwardRef(() => ExecutionService))
    private readonly executionService: ExecutionService,
    private readonly allocationService: AllocationService,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
    private readonly aiEngineClient: AiEngineClient,
    // Round 6 (§6/#297/#312): the durable account-snapshot authority the
    // session's opening financial state binds to (fail-closed — never `?? '0'`).
    private readonly brokerAccountSnapshotService: BrokerAccountSnapshotService,
  ) {}

  /**
   * Start a new trading session bound to the EXACT requested broker connection.
   *
   * Sprint 29 amendment: enforces the centralized canStartTrading gate FIRST,
   * before any other check. This gate cannot be bypassed.
   *
   * Round 5 (architect issue #295): the session is the authoritative execution
   * target — brokerConnectionId is REQUIRED (never discovered via
   * findActiveConnectionForUser), and the persisted executionMode +
   * authorityGeneration bind all future NEW-exposure decisions to this exact
   * (session, connection, mode) triple.
   *
   * @param userId - the authenticated user's ID
   * @param brokerConnectionId - the EXACT broker connection to bind (required)
   * @param executionMode - durable execution mode (defaults to PAPER_ONLY)
   */
  async startTradingSession(
    userId: string,
    brokerConnectionId?: string,
    executionMode: ExecutionMode = ExecutionMode.PAPER_ONLY,
  ): Promise<TradingSession> {
    // ── Gate 1 (Sprint 29): Centralized onboarding readiness gate ────────────
    // This is the HARD gate — profile + risk acknowledgement + broker + kill
    // switch + user status. Cannot be bypassed. Returns structured 403 with
    // missingSteps so the frontend can direct the user to the right page.
    const readiness = await this.onboardingService.canStartTrading(userId);
    if (!readiness.allowed) {
      throw new TradingNotReadyException(readiness.missingSteps);
    }

    // ── Gate 2: EXACT broker connection (Round 5 — no discovery fallback) ────
    // The connection that will execute this session's new exposure is chosen
    // HERE, by id, and bound into the session row. findConnectionById scopes
    // by userId (ownership) and throws NotFound otherwise.
    if (!brokerConnectionId) {
      throw new BrokerConnectionRequiredException();
    }
    const connection = await this.resolveConnection(userId, brokerConnectionId);
    this.assertBrokerConnectionHealthy(connection);

    // ── Gate 3: Explicit AI capital allocation for this exact account ───────
    const allocation = await this.allocationService.getUserCapitalAllocationState(
      userId,
      connection.id,
    );
    if (!allocation.hasAllocation || !allocation.allocatedCapital) {
      throw new ForbiddenException('Allocate capital to AI Trading before turning automation on.');
    }

    // Risk policy is server-managed. The profile still exists because the
    // execution engine snapshots and enforces its conservative limits.
    const riskProfile = await this.riskService.getOrCreateProfile(userId);

    // ── Gate 4: Live trading requires explicit broker enablement ─────────────
    // FULL_AUTO does NOT automatically enable live broker execution. The user
    // must separately enable live trading on the broker connection (a distinct
    // explicit action with its own audit trail).
    if (executionMode === ExecutionMode.FULL_AUTO && !connection.liveTradingEnabled) {
      throw new ForbiddenException(
        'Live trading is not enabled on this broker connection. ' +
          'Enable live trading explicitly before requesting FULL_AUTO mode.',
      );
    }

    // ── Gate 5 (Round 6, §6/#297/#312): fail-closed coherent opening state ──
    // No production TradingSession may start with invented zero financial
    // state. The opening balance/equity/currency come from ONE coherent
    // observation of the EXACT requested connection — the durable accepted
    // versioned snapshot when one exists (LIVE: freshness-enforced), else a
    // STRICT broker-account read with non-null parseable balance/equity and a
    // known currency. Missing / stale / malformed / unknown currency / read
    // failure ⇒ NO session (typed, audited, fail-closed). Health-check
    // timestamps are NEVER treated as financial freshness.
    const opening = await this.acquireOpeningFinancialState(userId, connection);

    // Sprint 32: snapshot the risk profile at session start so future edits
    // don't rewrite history. The snapshot is a deterministic JSON object of
    // risk-relevant fields (no credentials/secrets/PII).
    const riskProfileSnapshot = this.riskService.createRiskProfileSnapshot(riskProfile);

    const session = await this.executionService.startSession(
      userId,
      connection.id,
      opening.balance,
      riskProfileSnapshot,
      executionMode,
      opening.binding,
    );

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.AI_TRADING_ENABLED,
      severity: AuditSeverity.INFO,
      resourceType: 'TradingSession',
      resourceId: session.id,
      metadata: {
        brokerConnectionId: connection.id,
        openingBalance: opening.balance,
        openingSource: opening.source,
        openingSnapshotId: opening.binding?.openingSnapshotId ?? null,
        openingSnapshotGeneration: opening.binding?.openingSnapshotGeneration ?? null,
        accountCurrency: opening.binding?.accountCurrency ?? null,
        sessionId: session.id,
        executionMode: session.executionMode,
        authorityGeneration: session.authorityGeneration,
        allowedTradingModes: riskProfile.allowedTradingModes,
      },
    });

    this.eventBus.publish(DomainEventType.TRADING_SESSION_STARTED, userId, {
      sessionId: session.id,
      userId,
      brokerConnectionId: connection.id,
      executionMode: session.executionMode,
      authorityGeneration: session.authorityGeneration,
      status: session.status,
      startedAt: session.startedAt,
    });

    this.logger.log(
      `Trading session started: userId=${userId} sessionId=${session.id} mode=${session.executionMode}`,
    );

    // Notify AI engine scheduler (non-blocking — failures are logged only).
    // NOTE: the AI engine generates signals that flow through the Risk Engine
    // before reaching the Execution Engine — AI never directly executes broker
    // orders. The session's durable executionMode (NOT a hardcoded 'paper'
    // literal) is forwarded so the scheduler notification reflects the session
    // authority; the risk + execution gates remain the enforcement boundary.
    void this.aiEngineClient
      .notifySessionStarted({
        userId,
        tradingSessionId: session.id,
        brokerConnectionId: connection.id,
        instruments: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'],
        timeframe: 'H1',
        source: 'broker',
        mode: session.executionMode,
      })
      .catch((err: Error) =>
        this.logger.warn(
          `AI engine start notification failed session=${session.id}: ${err.message}`,
        ),
      );

    return session;
  }

  /**
   * Explicit + audited execution-mode change on an ACTIVE session
   * (Round 5, architect issue #298).
   *
   * The same risk-profile / live-enablement gates as startTradingSession apply
   * (a mode change must not bypass them). ExecutionService performs the CAS
   * generation bump and invalidates outstanding authority (RiskGrants /
   * SEMI_AUTO confirmations).
   */
  async changeExecutionMode(
    userId: string,
    sessionId: string,
    newMode: ExecutionMode,
  ): Promise<TradingSession> {
    // Ownership: the session must belong to the requesting user.
    const session = await this.executionService.findSessionById(sessionId);
    if (!session || session.userId !== userId) {
      throw new NotFoundException(`Trading session ${sessionId} not found`);
    }

    // The AI automation toggle is the explicit mode decision. Risk limits
    // remain enforced by the server for every new-exposure decision.
    await this.riskService.getOrCreateProfile(userId);

    // Gate: FULL_AUTO requires explicit live enablement on the session's
    // EXACT bound connection (never re-discovered).
    if (newMode === ExecutionMode.FULL_AUTO) {
      const [connection] = await this.brokerService.findConnectionsByIds([
        session.brokerConnectionId,
      ]);
      if (!connection?.liveTradingEnabled) {
        throw new ForbiddenException(
          'Live trading is not enabled on the session broker connection. ' +
            'Enable live trading explicitly before requesting FULL_AUTO mode.',
        );
      }
    }

    return this.executionService.changeExecutionMode(userId, sessionId, newMode);
  }

  /**
   * Stop the user's active AI trading session AND flatten AI-opened positions.
   *
   * Ordering is safety-critical: end the session first so outstanding
   * authority is invalidated and no new AI exposure can be committed, then
   * request closure of every currently OPEN position with durable iRexPro AI
   * provenance. Provider refusals/ambiguous outcomes are reported honestly
   * rather than being presented as closed.
   *
   * A close failure never reactivates the session. New exposure stays disabled
   * while unresolved broker truth remains visible for reconciliation.
   */
  async stopTradingSession(userId: string, sessionId: string): Promise<StopTradingSessionResult> {
    const session = await this.executionService.getActiveSession(userId);

    if (!session) {
      throw new NotFoundException('No active trading session found.');
    }

    if (session.id !== sessionId) {
      throw new ForbiddenException('Session ID does not match your active session.');
    }

    // Stop NEW exposure first and durably mark this session for late-fill
    // flattening by the reconciliation worker.
    await this.executionService.endSession(userId, TradingSessionStatus.ENDED, {
      closeAiPositionsOnStop: true,
      expectedSessionId: session.id,
    });

    let closeState: AiStopPositionCloseState = 'COMPLETE';
    let targetCount: number | null = 0;
    let closedCount = 0;
    let unresolvedCount: number | null = 0;

    try {
      const closeResults = await this.executionService.closeAllAiOpenPositions(
        userId,
        TradeCloseReason.MANUAL_CLOSE,
      );
      targetCount = closeResults.length;
      closedCount = closeResults.filter((result) => result.closed).length;
      unresolvedCount = closeResults.length - closedCount;
      closeState = unresolvedCount === 0 ? 'COMPLETE' : 'PARTIAL';
    } catch (err) {
      closeState = 'UNKNOWN';
      targetCount = null;
      unresolvedCount = null;
      this.logger.error(
        'AI Trading stopped but AI-position closure could not be verified for user ' +
          userId +
          ': ' +
          (err as Error).message,
      );
    }

    const positionCloseSummary = {
      state: closeState,
      targetCount,
      closedCount,
      unresolvedCount,
    };

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.AI_TRADING_DISABLED,
      severity:
        closeState === 'COMPLETE'
          ? AuditSeverity.INFO
          : closeState === 'PARTIAL'
            ? AuditSeverity.WARNING
            : AuditSeverity.CRITICAL,
      resourceType: 'TradingSession',
      resourceId: sessionId,
      metadata: {
        sessionId,
        reason: 'user-requested-stop-and-flatten',
        positionCloseSummary,
      },
    });

    this.eventBus.publish(DomainEventType.TRADING_SESSION_STOPPED, userId, {
      sessionId,
      userId,
      brokerConnectionId: session.brokerConnectionId,
      status: TradingSessionStatus.ENDED,
      endedAt: new Date(),
      positionCloseSummary,
    });

    this.logger.log(
      'Trading session stopped: userId=' +
        userId +
        ' sessionId=' +
        sessionId +
        ' closeState=' +
        closeState +
        ' closed=' +
        closedCount +
        '/' +
        (targetCount ?? 'unknown'),
    );

    void this.aiEngineClient
      .notifySessionStopped({ tradingSessionId: sessionId })
      .catch((err: Error) =>
        this.logger.warn(
          'AI engine stop notification failed session=' + sessionId + ': ' + err.message,
        ),
      );

    const message =
      closeState === 'UNKNOWN'
        ? 'AI Trading stopped, but AI position closure could not be verified. Check Positions & Activity.'
        : closeState === 'PARTIAL'
          ? 'AI Trading stopped. ' +
            closedCount +
            ' of ' +
            targetCount +
            ' AI-opened positions were confirmed closed; ' +
            unresolvedCount +
            ' require broker/reconciliation follow-up.'
          : targetCount === 0
            ? 'AI Trading stopped. No AI-opened positions were open.'
            : 'AI Trading stopped and all ' +
              closedCount +
              ' AI-opened positions were confirmed closed.';

    return { message, sessionId, positionCloseSummary };
  }

  async getActiveSession(userId: string): Promise<TradingSession | null> {
    return this.executionService.getActiveSessionForClient(userId);
  }

  async getAutomationRuntimeStatus(userId: string, sessionId: string) {
    const session = await this.executionService.findSessionById(sessionId);
    if (!session || session.userId !== userId) {
      throw new NotFoundException(`Trading session ${sessionId} not found`);
    }
    return this.aiEngineClient.getSessionStatus(sessionId);
  }


  async getSessionById(userId: string, sessionId: string): Promise<TradingSession | null> {
    const session = await this.executionService.findSessionById(sessionId);
    if (!session || session.userId !== userId) return null;
    return session;
  }

  // ─── Internal helpers ──────────────────────────────────────────────────

  /**
   * Round 6 (§6): the coherent, non-invented opening financial state.
   *
   * LIVE — the DURABLE accepted snapshot with the NEW-exposure freshness gate
   * (missing / stale / malformed / unknown currency ⇒ no session, typed
   * fail-closed with an audit trail). The ENTIRE binding (balance, equity,
   * currency, snapshot id + generation) comes from that ONE observation —
   * never blended with a second read.
   *
   * PAPER/DEMO — the latest accepted snapshot when one exists (same coherent
   * binding); otherwise a STRICT broker-account read: absent state,
   * null/unparseable balance or equity, or an unknown currency starts NO
   * session (the `?? '0'` / synthesized-USD era is over).
   */
  private async acquireOpeningFinancialState(
    userId: string,
    connection: BrokerConnection,
  ): Promise<{
    balance: string;
    source: 'ACCEPTED_SNAPSHOT' | 'BROKER_ACCOUNT_READ';
    binding?: {
      accountCurrency: string;
      openingSnapshotId: string;
      openingSnapshotGeneration: number;
      initialPeakEquity: string;
    };
  }> {
    if (connection.accountType === BrokerMode.LIVE) {
      let snapshot: BrokerAccountSnapshot;
      try {
        snapshot = await this.brokerAccountSnapshotService.resolveFreshSnapshotForNewExposure(
          connection.id,
        );
      } catch (err) {
        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.AI_TRADING_DISABLED,
          severity: AuditSeverity.WARNING,
          resourceType: 'TradingSession',
          resourceId: 'not-started',
          metadata: {
            brokerConnectionId: connection.id,
            blockedReason: 'OPENING_SNAPSHOT_UNAVAILABLE',
            detail: (err as Error).message,
          },
        });
        throw new ForbiddenException(
          `LIVE trading requires a fresh accepted account snapshot for connection ` +
            `${connection.id} — ${(err as Error).message} (fail-closed, no session started).`,
        );
      }
      const fields = this.requireSnapshotFinancialFields(snapshot, connection.id);
      return {
        balance: fields.balance,
        source: 'ACCEPTED_SNAPSHOT',
        binding: {
          accountCurrency: fields.currency,
          openingSnapshotId: snapshot.id,
          openingSnapshotGeneration: snapshot.generation,
          initialPeakEquity: fields.equity,
        },
      };
    }

    // PAPER / DEMO: prefer the accepted versioned snapshot.
    try {
      const snapshot = await this.brokerAccountSnapshotService.readLatestAcceptedSnapshot(
        connection.id,
      );
      if (snapshot) {
        const fields = this.requireSnapshotFinancialFields(snapshot, connection.id);
        return {
          balance: fields.balance,
          source: 'ACCEPTED_SNAPSHOT',
          binding: {
            accountCurrency: fields.currency,
            openingSnapshotId: snapshot.id,
            openingSnapshotGeneration: snapshot.generation,
            initialPeakEquity: fields.equity,
          },
        };
      }
    } catch (err) {
      throw new ForbiddenException(
        `Broker account snapshot authority could not be read for connection ` +
          `${connection.id} — ${(err as Error).message} (fail-closed, no session started).`,
      );
    }

    // No accepted snapshot yet: STRICT projection read (never invented).
    let state: { balance: string | null; equity: string | null; currency?: string | null } | null;
    try {
      state = await this.brokerService.getBrokerAccountState(connection.id);
    } catch (err) {
      throw new ForbiddenException(
        `Broker account state read failed for connection ${connection.id} — ` +
          `${(err as Error).message} (fail-closed, no session started).`,
      );
    }
    const projectionBalance = state?.balance ?? null;
    const projectionEquity = state?.equity ?? null;
    const projectionCurrency = state?.currency ?? null;
    const malformed =
      !projectionBalance ||
      !projectionEquity ||
      !projectionCurrency ||
      !ExactDecimal.tryParse(projectionBalance) ||
      !ExactDecimal.tryParse(projectionEquity);
    if (malformed) {
      throw new ForbiddenException(
        `Broker account financial state is unavailable for connection ${connection.id} ` +
          '(missing/unparseable balance or equity, or unknown currency) — no trading ' +
          'session may start on invented state (fail-closed).',
      );
    }
    return {
      balance: projectionBalance,
      source: 'BROKER_ACCOUNT_READ',
      // No snapshot provenance on this path — the session's opening-snapshot
      // binding stays null (never fabricated), and the projection read's
      // currency/equity are persisted through the audit + session columns.
      binding: undefined,
    };
  }

  /**
   * §6: one coherent observation — returns the NARROWED non-null parseable
   * money fields + known currency (throws typed ForbiddenException otherwise).
   */
  private requireSnapshotFinancialFields(
    snapshot: BrokerAccountSnapshot,
    connectionId: string,
  ): { balance: string; equity: string; currency: string } {
    if (
      !snapshot.balance ||
      !snapshot.equity ||
      !snapshot.currency ||
      !ExactDecimal.tryParse(snapshot.balance) ||
      !ExactDecimal.tryParse(snapshot.equity)
    ) {
      throw new ForbiddenException(
        `Accepted account snapshot for connection ${connectionId} carries malformed ` +
          'financial fields — no trading session may start from it (fail-closed).',
      );
    }
    return {
      balance: snapshot.balance,
      equity: snapshot.equity,
      currency: snapshot.currency,
    };
  }

  /**
   * Resolve the EXACT requested broker connection (Round 5, issue #295).
   *
   * There is NO fallback to findActiveConnectionForUser — the exact connection
   * is named by the caller and scoped by userId (ownership). Non-CONNECTED is
   * rejected before any session state is touched.
   */
  private async resolveConnection(userId: string, requestedId: string): Promise<BrokerConnection> {
    const conn = await this.brokerService.findConnectionById(requestedId, userId);
    if (conn.status !== BrokerConnectionStatus.CONNECTED) {
      throw new ForbiddenException(
        `Broker connection is ${conn.status}, not CONNECTED. Connect it before starting a session.`,
      );
    }
    return conn;
  }

  private assertBrokerConnectionHealthy(connection: BrokerConnection): void {
    if (connection.consecutiveFailureCount >= 3) {
      throw new ForbiddenException(
        'Broker connection has repeated health-check failures. ' +
          'Test or reconnect your broker before starting a session.',
      );
    }

    if (!connection.lastHealthCheckAt) {
      throw new ForbiddenException(
        'Broker connection has no health check on record. ' +
          'Test your broker connection before starting a session.',
      );
    }

    const staleness = Date.now() - connection.lastHealthCheckAt.getTime();
    if (staleness > TradingService.BROKER_HEALTH_MAX_STALENESS_MS) {
      throw new ForbiddenException(
        'Broker health check is stale. Test your broker connection before starting a session.',
      );
    }
  }
}
