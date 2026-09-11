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
import { AllowedTradingMode } from '../risk/entities/risk-profile.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerConnectionStatus } from '../broker/interfaces/broker-adapter.interface';

/**
 * TradingService — Trading session lifecycle management.
 *
 * Sprint 29 amendment: the centralized OnboardingService.canStartTrading()
 * gate is enforced as the FIRST check in startTradingSession(). This cannot
 * be bypassed — it runs inside the service, not just the controller.
 *
 * Mandatory gates before starting a session (ALL must pass):
 *   1. OnboardingService.canStartTrading() — profile complete + risk
 *      acknowledgement accepted + broker CONNECTED + kill switch NOT active
 *      + user ACTIVE. Returns structured 403 TRADING_NOT_READY + missingSteps.
 *   2. Broker connection is CONNECTED AND healthy (fresh health check)
 *   3. Requested trading mode is permitted by riskProfile.allowedTradingModes
 *   4. Live trading (if requested) requires explicit broker enablement
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
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
    private readonly aiEngineClient: AiEngineClient,
  ) {}

  /** ExecutionMode → the risk-profile AllowedTradingMode it must satisfy. */
  private static readonly ALLOWED_MODE_BY_EXECUTION_MODE: Record<
    ExecutionMode,
    AllowedTradingMode
  > = {
    [ExecutionMode.PAPER_ONLY]: AllowedTradingMode.PAPER_ONLY,
    [ExecutionMode.SEMI_AUTO]: AllowedTradingMode.SEMI_AUTO,
    [ExecutionMode.FULL_AUTO]: AllowedTradingMode.FULL_AUTO,
  };

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

    // ── Gate 3: Requested execution mode must be permitted by risk profile ───
    const riskProfile = await this.riskService.getOrCreateProfile(userId);
    this.assertRequestedModeAllowed(
      TradingService.ALLOWED_MODE_BY_EXECUTION_MODE[executionMode],
      riskProfile.allowedTradingModes,
    );

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

    // ── Start session via ExecutionService ───────────────────────────────────
    const brokerState = await this.brokerService.getBrokerAccountState(connection.id);
    const openingBalance = brokerState?.balance ?? '0';

    // Sprint 32: snapshot the risk profile at session start so future edits
    // don't rewrite history. The snapshot is a deterministic JSON object of
    // risk-relevant fields (no credentials/secrets/PII).
    const riskProfileSnapshot = this.riskService.createRiskProfileSnapshot(riskProfile);

    const session = await this.executionService.startSession(
      userId,
      connection.id,
      openingBalance,
      riskProfileSnapshot,
      executionMode,
    );

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.AI_TRADING_ENABLED,
      severity: AuditSeverity.INFO,
      resourceType: 'TradingSession',
      resourceId: session.id,
      metadata: {
        brokerConnectionId: connection.id,
        openingBalance,
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
        instruments: ['EURUSD'],
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

    // Gate: the requested mode must be permitted by the risk profile.
    const riskProfile = await this.riskService.getOrCreateProfile(userId);
    this.assertRequestedModeAllowed(
      TradingService.ALLOWED_MODE_BY_EXECUTION_MODE[newMode],
      riskProfile.allowedTradingModes,
    );

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

  /** Stop the user's active trading session. */
  async stopTradingSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.executionService.getActiveSession(userId);

    if (!session) {
      throw new NotFoundException('No active trading session found.');
    }

    if (session.id !== sessionId) {
      throw new ForbiddenException('Session ID does not match your active session.');
    }

    await this.executionService.endSession(userId, TradingSessionStatus.ENDED);

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.AI_TRADING_DISABLED,
      severity: AuditSeverity.INFO,
      resourceType: 'TradingSession',
      resourceId: sessionId,
      metadata: { sessionId, reason: 'user-requested-stop' },
    });

    this.eventBus.publish(DomainEventType.TRADING_SESSION_STOPPED, userId, {
      sessionId,
      userId,
      brokerConnectionId: session.brokerConnectionId,
      status: TradingSessionStatus.ENDED,
      endedAt: new Date(),
    });

    this.logger.log(`Trading session stopped: userId=${userId} sessionId=${sessionId}`);

    void this.aiEngineClient
      .notifySessionStopped({ tradingSessionId: sessionId })
      .catch((err: Error) =>
        this.logger.warn(`AI engine stop notification failed session=${sessionId}: ${err.message}`),
      );
  }

  async getActiveSession(userId: string): Promise<TradingSession | null> {
    return this.executionService.getActiveSession(userId);
  }

  async getSessionById(userId: string, sessionId: string): Promise<TradingSession | null> {
    const session = await this.executionService.findSessionById(sessionId);
    if (!session || session.userId !== userId) return null;
    return session;
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

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

  private assertRequestedModeAllowed(
    requested: AllowedTradingMode,
    allowed: AllowedTradingMode,
  ): void {
    if (requested === AllowedTradingMode.PAPER_ONLY) {
      return;
    }

    if (requested === AllowedTradingMode.SEMI_AUTO) {
      if (allowed === AllowedTradingMode.PAPER_ONLY) {
        throw new ForbiddenException(
          'Your risk profile only allows PAPER_ONLY mode. ' +
            'Update your risk profile to enable SEMI_AUTO.',
        );
      }
      return;
    }

    if (requested === AllowedTradingMode.FULL_AUTO) {
      if (allowed !== AllowedTradingMode.FULL_AUTO) {
        throw new ForbiddenException(
          'Your risk profile does not allow FULL_AUTO mode. ' +
            'Update your risk profile to enable FULL_AUTO.',
        );
      }
      return;
    }

    throw new ForbiddenException(`Unsupported trading mode: ${requested}`);
  }
}
