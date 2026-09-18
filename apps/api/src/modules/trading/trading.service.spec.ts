import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TradingService } from './trading.service';
import { BrokerService } from '../broker/broker.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { RiskService } from '../risk/risk.service';
import { ExecutionService } from '../execution/execution.service';
import { AllocationService } from '../execution/services/allocation.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { AiEngineClient } from '../ai-engine-client/ai-engine-client.service';
import { OnboardingService } from '../users/onboarding.service';
import { TradingNotReadyException } from '../../common/exceptions/trading-not-ready.exception';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { BrokerConnectionRequiredException } from '../execution/execution-session.resolution';
import { AllowedTradingMode } from '../risk/entities/risk-profile.entity';
import { BrokerAccountSnapshotService } from '../broker/services/broker-account-snapshot.service';
import { BrokerConnectionStatus } from '../broker/interfaces/broker-adapter.interface';
import { TradeCloseReason, TradeStatus } from '../execution/entities/trade.entity';

/**
 * TradingService tests — Sprint 29 amendment + free-access regression +
 * Round 5 session-authority gates (#295/#298).
 *
 * Verifies the centralized canStartTrading() gate is enforced INSIDE
 * startTradingSession() and cannot be bypassed. Also verifies:
 *   - subscription state is NOT an access/trading prerequisite
 *   - structured 403 TRADING_NOT_READY error with missingSteps
 *   - requested execution mode enforcement against riskProfile.allowedTradingModes
 *   - the EXACT broker connection is required (no discovery fallback)
 *   - broker health freshness check (stale → reject)
 *   - live trading requires explicit broker enablement
 *   - no session row created on rejected requests
 *   - positive test: session starts only when required safety conditions pass
 */
const mockSession = (overrides: Partial<TradingSession> = {}): TradingSession =>
  ({
    id: 'session-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    executionMode: ExecutionMode.PAPER_ONLY,
    authorityGeneration: 1,
    status: TradingSessionStatus.ACTIVE,
    openingBalance: '10000.00',
    peakEquity: '10000.00',
    startedAt: new Date(),
    endedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    riskProfileSnapshot: null,
    ...overrides,
  }) as TradingSession;

function buildHealthyConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    userId: 'user-1',
    brokerId: 'paper-broker',
    brokerName: 'Paper Trading Broker',
    status: BrokerConnectionStatus.CONNECTED,
    lastHealthCheckAt: new Date(),
    consecutiveFailureCount: 0,
    liveTradingEnabled: false,
    demoValidated: true,
    ...overrides,
  };
}

/** Round 6 (§6): a coherent accepted account-snapshot fixture. */
function buildAcceptedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap-1',
    generation: 7,
    connectionId: 'conn-1',
    currency: 'EUR',
    balance: '12000.00',
    equity: '12100.00',
    providerObservedAt: new Date(),
    acceptedAt: new Date(),
    ...overrides,
  };
}

describe('TradingService (Sprint 29 amendment — centralized readiness gate)', () => {
  let module: TestingModule;
  let service: TradingService;
  let brokerService: Record<string, jest.Mock>;
  let subscriptionsService: Record<string, jest.Mock>;
  let riskService: Record<string, jest.Mock>;
  let executionService: Record<string, jest.Mock>;
  let allocationService: Record<string, jest.Mock>;
  let auditService: Record<string, jest.Mock>;
  let eventBus: Record<string, jest.Mock>;
  let aiEngineClient: Record<string, jest.Mock>;
  let onboardingService: Record<string, jest.Mock>;
  let brokerAccountSnapshotService: Record<string, jest.Mock>;

  beforeEach(async () => {
    jest.clearAllMocks();

    brokerService = {
      hasActiveConnection: jest.fn().mockResolvedValue(true),
      // Round 5 (#295): kept as a NEVER-CALLED regression sentinel — session
      // start must bind the EXACT requested connection, never discovery.
      findActiveConnectionForUser: jest.fn(),
      findConnectionsByIds: jest.fn().mockResolvedValue([buildHealthyConnection()]),
      findConnectionById: jest.fn().mockResolvedValue(buildHealthyConnection()),
      getBrokerAccountState: jest.fn().mockResolvedValue({
        balance: '10000.00',
        equity: '10000.00',
        freeMargin: '9000.00',
        currency: 'USD',
      }),
    };

    // Round 6 (§6/#297/#312): the durable account-snapshot authority seam.
    // Default: no accepted snapshot (the strict projection read path); the
    // §6 tests below override these implementations per scenario.
    brokerAccountSnapshotService = {
      readLatestAcceptedSnapshot: jest.fn().mockResolvedValue(null),
      resolveFreshSnapshotForNewExposure: jest.fn(),
    };

    // Deliberately retained as an unused external capability so the regression
    // test can prove TradingService never consults subscription state.
    subscriptionsService = {
      canUserStartAiAutoTrading: jest.fn().mockResolvedValue(true),
    };

    riskService = {
      isKillSwitchActive: jest.fn().mockResolvedValue(false),
      getOrCreateProfile: jest.fn().mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        allowedTradingModes: AllowedTradingMode.PAPER_ONLY,
        riskAcknowledgementAccepted: true,
      }),
      createRiskProfileSnapshot: jest.fn().mockImplementation((profile) => ({
        maxDailyTrades: profile.maxDailyTrades ?? 10,
        maxOpenTrades: profile.maxOpenTrades ?? 3,
        snapshotVersion: 1,
        snapshotCreatedAt: new Date().toISOString(),
      })),
    };

    allocationService = {
      getUserCapitalAllocationState: jest.fn().mockResolvedValue({
        brokerConnectionId: 'conn-1',
        logicalAccountKey: 'paper-broker|demo|account-1',
        accountCurrency: 'USD',
        brokerEquity: '10000',
        hasAllocation: true,
        allocatedCapital: '1000',
        committedCapital: '0',
        availableCapital: '1000',
      }),
    };

    executionService = {
      startSession: jest.fn().mockResolvedValue(mockSession()),
      endSession: jest.fn().mockResolvedValue(undefined),
      getActiveSession: jest.fn().mockResolvedValue(mockSession()),
      findSessionById: jest.fn().mockResolvedValue(mockSession()),
      changeExecutionMode: jest
        .fn()
        .mockResolvedValue(
          mockSession({ executionMode: ExecutionMode.SEMI_AUTO, authorityGeneration: 2 }),
        ),
      closeAllAiOpenPositions: jest.fn().mockResolvedValue([]),
    };

    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    eventBus = { publish: jest.fn(), subscribe: jest.fn().mockReturnValue(() => {}) };
    aiEngineClient = {
      isSchedulerIntegrationEnabled: jest.fn().mockReturnValue(true),
      notifySessionStarted: jest.fn().mockResolvedValue(undefined),
      notifySessionStopped: jest.fn().mockResolvedValue(undefined),
    };

    onboardingService = {
      canStartTrading: jest.fn().mockResolvedValue({ allowed: true, missingSteps: [] }),
      getOnboardingStatus: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        TradingService,
        { provide: BrokerService, useValue: brokerService },
        // Compatibility-only provider: TradingService must not inject or call it.
        { provide: SubscriptionsService, useValue: subscriptionsService },
        { provide: RiskService, useValue: riskService },
        { provide: ExecutionService, useValue: executionService },
        { provide: AllocationService, useValue: allocationService },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventBus, useValue: eventBus },
        { provide: AiEngineClient, useValue: aiEngineClient },
        { provide: OnboardingService, useValue: onboardingService },
        { provide: BrokerAccountSnapshotService, useValue: brokerAccountSnapshotService },
      ],
    }).compile();

    service = module.get<TradingService>(TradingService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('startTradingSession — centralized canStartTrading gate', () => {
    it('should call OnboardingService.canStartTrading() as the FIRST gate', async () => {
      await service.startTradingSession('user-1', 'conn-1');
      expect(onboardingService.canStartTrading).toHaveBeenCalledWith('user-1');
    });

    it('should throw TradingNotReadyException when profile is incomplete', async () => {
      onboardingService.canStartTrading.mockResolvedValue({
        allowed: false,
        missingSteps: ['PROFILE', 'RISK_PROFILE', 'BROKER_CONNECTION'],
      });
      await expect(service.startTradingSession('user-1')).rejects.toThrow(TradingNotReadyException);
    });

    it('should throw TradingNotReadyException when risk profile missing', async () => {
      onboardingService.canStartTrading.mockResolvedValue({
        allowed: false,
        missingSteps: ['RISK_PROFILE'],
      });
      await expect(service.startTradingSession('user-1')).rejects.toThrow(TradingNotReadyException);
    });

    it('should throw TradingNotReadyException when risk acknowledgement is false', async () => {
      onboardingService.canStartTrading.mockResolvedValue({
        allowed: false,
        missingSteps: ['RISK_PROFILE'],
      });
      await expect(service.startTradingSession('user-1')).rejects.toThrow(TradingNotReadyException);
    });

    it('should throw TradingNotReadyException when broker is disconnected', async () => {
      onboardingService.canStartTrading.mockResolvedValue({
        allowed: false,
        missingSteps: ['BROKER_CONNECTION'],
      });
      await expect(service.startTradingSession('user-1')).rejects.toThrow(TradingNotReadyException);
    });

    it('should throw TradingNotReadyException when kill switch is active', async () => {
      onboardingService.canStartTrading.mockResolvedValue({ allowed: false, missingSteps: [] });
      await expect(service.startTradingSession('user-1')).rejects.toThrow(TradingNotReadyException);
    });

    it('should throw TradingNotReadyException when user is SUSPENDED', async () => {
      onboardingService.canStartTrading.mockResolvedValue({ allowed: false, missingSteps: [] });
      await expect(service.startTradingSession('user-1')).rejects.toThrow(TradingNotReadyException);
    });

    it('should return structured 403 with missingSteps in the response', async () => {
      onboardingService.canStartTrading.mockResolvedValue({
        allowed: false,
        missingSteps: ['PROFILE', 'RISK_PROFILE'],
      });

      try {
        await service.startTradingSession('user-1');
        fail('Expected TradingNotReadyException');
      } catch (err) {
        expect(err).toBeInstanceOf(TradingNotReadyException);
        const response = (err as TradingNotReadyException).getResponse() as {
          statusCode: number;
          code: string;
          message: string;
          missingSteps: string[];
        };
        expect(response.statusCode).toBe(403);
        expect(response.code).toBe('TRADING_NOT_READY');
        expect(response.message).toBe('Your trading setup is not ready.');
        expect(response.missingSteps).toEqual(['PROFILE', 'RISK_PROFILE']);
      }
    });

    it('should NOT create a session row when readiness gate fails', async () => {
      onboardingService.canStartTrading.mockResolvedValue({
        allowed: false,
        missingSteps: ['PROFILE'],
      });
      await expect(service.startTradingSession('user-1')).rejects.toThrow();
      expect(executionService.startSession).not.toHaveBeenCalled();
    });

    it('should NOT notify AI engine when readiness gate fails', async () => {
      onboardingService.canStartTrading.mockResolvedValue({
        allowed: false,
        missingSteps: ['PROFILE'],
      });
      await expect(service.startTradingSession('user-1')).rejects.toThrow();
      expect(aiEngineClient.notifySessionStarted).not.toHaveBeenCalled();
    });
  });

  describe('startTradingSession — free access regression', () => {
    it('should not require or consult an active subscription', async () => {
      subscriptionsService.canUserStartAiAutoTrading.mockResolvedValue(false);

      const session = await service.startTradingSession('user-1', 'conn-1');

      expect(session.id).toBe('session-1');
      expect(subscriptionsService.canUserStartAiAutoTrading).not.toHaveBeenCalled();
      expect(executionService.startSession).toHaveBeenCalled();
    });
  });

  describe('startTradingSession — Round 5 exact-connection binding (#295)', () => {
    it('rejects with a typed error when brokerConnectionId is omitted (no discovery fallback)', async () => {
      await expect(service.startTradingSession('user-1')).rejects.toThrow(
        BrokerConnectionRequiredException,
      );
      expect(executionService.startSession).not.toHaveBeenCalled();
    });

    it('NEVER calls findActiveConnectionForUser — the connection is resolved by exact id', async () => {
      await service.startTradingSession('user-1', 'conn-1');
      expect(brokerService.findActiveConnectionForUser).not.toHaveBeenCalled();
      expect(brokerService.findConnectionById).toHaveBeenCalledWith('conn-1', 'user-1');
    });

    it('rejects when the exact connection is not CONNECTED', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        buildHealthyConnection({ status: BrokerConnectionStatus.DISCONNECTED }),
      );
      await expect(service.startTradingSession('user-1', 'conn-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(executionService.startSession).not.toHaveBeenCalled();
    });

    it('passes the executionMode through to ExecutionService.startSession', async () => {
      riskService.getOrCreateProfile.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        allowedTradingModes: AllowedTradingMode.SEMI_AUTO,
        riskAcknowledgementAccepted: true,
      } as never);
      await service.startTradingSession('user-1', 'conn-1', ExecutionMode.SEMI_AUTO);
      expect(executionService.startSession).toHaveBeenCalledWith(
        'user-1',
        'conn-1',
        '10000.00',
        expect.objectContaining({ snapshotVersion: 1 }),
        ExecutionMode.SEMI_AUTO,
        // Round 6 (§6): no accepted snapshot on this path — no fabricated binding.
        undefined,
      );
    });
  });

  describe('startTradingSession — broker health freshness', () => {
    it('should reject when broker has no health check on record', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        buildHealthyConnection({ lastHealthCheckAt: null }),
      );
      await expect(service.startTradingSession('user-1', 'conn-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(executionService.startSession).not.toHaveBeenCalled();
    });

    it('should reject when broker health check is stale (> 5 minutes)', async () => {
      const stale = new Date(Date.now() - 10 * 60 * 1000);
      brokerService.findConnectionById.mockResolvedValue(
        buildHealthyConnection({ lastHealthCheckAt: stale }),
      );
      await expect(service.startTradingSession('user-1', 'conn-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should reject when broker has 3+ consecutive failures', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        buildHealthyConnection({ consecutiveFailureCount: 3 }),
      );
      await expect(service.startTradingSession('user-1', 'conn-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should accept when broker health check is fresh (< 5 minutes)', async () => {
      const fresh = new Date(Date.now() - 60 * 1000);
      brokerService.findConnectionById.mockResolvedValue(
        buildHealthyConnection({ lastHealthCheckAt: fresh }),
      );
      const session = await service.startTradingSession('user-1', 'conn-1');
      expect(session.id).toBe('session-1');
    });
  });

  // ─── Round 6 (§6/#297/#312): fail-closed coherent opening state ────────────

  describe('startTradingSession — Round 6 fail-closed opening financial state (§6)', () => {
    it('PAPER connection with an accepted snapshot binds it (currency/id/generation/peak)', async () => {
      brokerAccountSnapshotService.readLatestAcceptedSnapshot.mockResolvedValue(
        buildAcceptedSnapshot(),
      );

      await service.startTradingSession('user-1', 'conn-1');

      expect(executionService.startSession).toHaveBeenCalledWith(
        'user-1',
        'conn-1',
        '12000.00',
        expect.objectContaining({ snapshotVersion: 1 }),
        ExecutionMode.PAPER_ONLY,
        expect.objectContaining({
          accountCurrency: 'EUR',
          openingSnapshotId: 'snap-1',
          openingSnapshotGeneration: 7,
          initialPeakEquity: '12100.00',
        }),
      );
      // The projection read is NEVER blended into a snapshot-backed opening.
      expect(brokerService.getBrokerAccountState).not.toHaveBeenCalled();
    });

    it('PAPER connection without a snapshot uses the STRICT projection read (5-arg contract, no invented zero)', async () => {
      brokerAccountSnapshotService.readLatestAcceptedSnapshot.mockResolvedValue(null);

      await service.startTradingSession('user-1', 'conn-1');

      expect(brokerService.getBrokerAccountState).toHaveBeenCalledWith('conn-1');
      expect(executionService.startSession).toHaveBeenCalledWith(
        'user-1',
        'conn-1',
        '10000.00',
        expect.objectContaining({ snapshotVersion: 1 }),
        ExecutionMode.PAPER_ONLY,
        undefined,
      );
    });

    it('PAPER connection with NO snapshot and a MISSING balance starts NO session (fail-closed)', async () => {
      brokerAccountSnapshotService.readLatestAcceptedSnapshot.mockResolvedValue(null);
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: null,
        equity: '10000.00',
        freeMargin: '9000.00',
        currency: 'USD',
      });

      await expect(service.startTradingSession('user-1', 'conn-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(executionService.startSession).not.toHaveBeenCalled();
    });

    it('PAPER connection with NO snapshot and an UNKNOWN currency starts NO session (fail-closed)', async () => {
      brokerAccountSnapshotService.readLatestAcceptedSnapshot.mockResolvedValue(null);
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10000.00',
        freeMargin: '9000.00',
        currency: null,
      });

      await expect(service.startTradingSession('user-1', 'conn-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(executionService.startSession).not.toHaveBeenCalled();
    });

    it('LIVE connection with NO fresh snapshot starts NO session (fail-closed, audited)', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        buildHealthyConnection({ accountType: 'LIVE' }),
      );
      brokerAccountSnapshotService.resolveFreshSnapshotForNewExposure.mockRejectedValue(
        new Error('SNAPSHOT_STALE'),
      );

      await expect(service.startTradingSession('user-1', 'conn-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(executionService.startSession).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ blockedReason: 'OPENING_SNAPSHOT_UNAVAILABLE' }),
        }),
      );
    });

    it('LIVE connection with a fresh accepted snapshot binds it as the opening authority', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        buildHealthyConnection({ accountType: 'LIVE' }),
      );
      brokerAccountSnapshotService.resolveFreshSnapshotForNewExposure.mockResolvedValue(
        buildAcceptedSnapshot({ currency: 'USD', balance: '50000.00', equity: '50100.00' }),
      );

      await service.startTradingSession('user-1', 'conn-1');

      expect(executionService.startSession).toHaveBeenCalledWith(
        'user-1',
        'conn-1',
        '50000.00',
        expect.objectContaining({ snapshotVersion: 1 }),
        ExecutionMode.PAPER_ONLY,
        expect.objectContaining({
          accountCurrency: 'USD',
          openingSnapshotId: 'snap-1',
          openingSnapshotGeneration: 7,
          initialPeakEquity: '50100.00',
        }),
      );
    });
  });

  describe('startTradingSession — automation mode authority', () => {
    it('allows PAPER_ONLY for paper/demo automation', async () => {
      const session = await service.startTradingSession(
        'user-1',
        'conn-1',
        ExecutionMode.PAPER_ONLY,
      );
      expect(session.id).toBe('session-1');
    });

    it('does not require a separate risk-profile preference for SEMI_AUTO', async () => {
      riskService.getOrCreateProfile.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        allowedTradingModes: AllowedTradingMode.PAPER_ONLY,
        riskAcknowledgementAccepted: false,
      } as never);
      const session = await service.startTradingSession(
        'user-1',
        'conn-1',
        ExecutionMode.SEMI_AUTO,
      );
      expect(session.id).toBe('session-1');
    });

    it('rejects FULL_AUTO when live trading is not enabled on broker connection', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        buildHealthyConnection({ liveTradingEnabled: false }),
      );
      await expect(
        service.startTradingSession('user-1', 'conn-1', ExecutionMode.FULL_AUTO),
      ).rejects.toThrow(ForbiddenException);
      expect(executionService.startSession).not.toHaveBeenCalled();
    });

    it('allows FULL_AUTO when the exact broker connection is live-enabled', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        buildHealthyConnection({ liveTradingEnabled: true }),
      );
      const session = await service.startTradingSession(
        'user-1',
        'conn-1',
        ExecutionMode.FULL_AUTO,
      );
      expect(session.id).toBe('session-1');
    });

    it('should default to PAPER_ONLY when no mode is requested', async () => {
      const session = await service.startTradingSession('user-1', 'conn-1');
      expect(session.id).toBe('session-1');
      expect(executionService.startSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        ExecutionMode.PAPER_ONLY,
        // No accepted account snapshot exists on the default fixture path.
        undefined,
      );
    });
  });

  describe('startTradingSession — positive test (all conditions met)', () => {
    it('should create a session only when all required safety conditions are satisfied', async () => {
      const session = await service.startTradingSession('user-1', 'conn-1');

      expect(session.id).toBe('session-1');
      expect(executionService.startSession).toHaveBeenCalledWith(
        'user-1',
        'conn-1',
        '10000.00',
        expect.objectContaining({
          maxDailyTrades: expect.any(Number),
          maxOpenTrades: expect.any(Number),
          snapshotVersion: 1,
        }),
        ExecutionMode.PAPER_ONLY,
        // Round 6 (§6): no accepted snapshot on this path — no fabricated binding.
        undefined,
      );
      expect(subscriptionsService.canUserStartAiAutoTrading).not.toHaveBeenCalled();
      expect(brokerService.findActiveConnectionForUser).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-1',
          action: 'AI_TRADING_ENABLED',
          metadata: expect.objectContaining({
            executionMode: ExecutionMode.PAPER_ONLY,
            authorityGeneration: 1,
          }),
        }),
      );
      expect(eventBus.publish).toHaveBeenCalledWith(
        'trading.session.started',
        'user-1',
        expect.objectContaining({ sessionId: 'session-1' }),
      );
      // Round 5 (#298): the AI engine notification carries the SESSION's
      // durable executionMode — never a hardcoded 'paper' literal.
      expect(aiEngineClient.notifySessionStarted).toHaveBeenCalledWith(
        expect.objectContaining({ mode: ExecutionMode.PAPER_ONLY }),
      );
    });
  });

  describe('changeExecutionMode() — Round 5 audited mode change (#298)', () => {
    it('delegates to ExecutionService.changeExecutionMode with the requested mode', async () => {
      riskService.getOrCreateProfile.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        allowedTradingModes: AllowedTradingMode.SEMI_AUTO,
        riskAcknowledgementAccepted: true,
      } as never);
      const updated = await service.changeExecutionMode(
        'user-1',
        'session-1',
        ExecutionMode.SEMI_AUTO,
      );
      expect(executionService.changeExecutionMode).toHaveBeenCalledWith(
        'user-1',
        'session-1',
        ExecutionMode.SEMI_AUTO,
      );
      expect(updated.authorityGeneration).toBe(2);
      expect(updated.executionMode).toBe(ExecutionMode.SEMI_AUTO);
    });

    it('throws NotFoundException when the session does not exist', async () => {
      executionService.findSessionById.mockResolvedValue(null);
      await expect(
        service.changeExecutionMode('user-1', 'session-1', ExecutionMode.SEMI_AUTO),
      ).rejects.toThrow(NotFoundException);
      expect(executionService.changeExecutionMode).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the session belongs to another user', async () => {
      executionService.findSessionById.mockResolvedValue(mockSession({ userId: 'other-user' }));
      await expect(
        service.changeExecutionMode('user-1', 'session-1', ExecutionMode.SEMI_AUTO),
      ).rejects.toThrow(NotFoundException);
      expect(executionService.changeExecutionMode).not.toHaveBeenCalled();
    });

    it('does not require a separate risk-profile mode preference for an explicit mode change', async () => {
      riskService.getOrCreateProfile.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        allowedTradingModes: AllowedTradingMode.PAPER_ONLY,
        riskAcknowledgementAccepted: false,
      } as never);
      await service.changeExecutionMode('user-1', 'session-1', ExecutionMode.SEMI_AUTO);
      expect(executionService.changeExecutionMode).toHaveBeenCalledWith(
        'user-1',
        'session-1',
        ExecutionMode.SEMI_AUTO,
      );
    });

    it('rejects FULL_AUTO when live trading is not enabled on the session connection', async () => {
      riskService.getOrCreateProfile.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        allowedTradingModes: AllowedTradingMode.FULL_AUTO,
        riskAcknowledgementAccepted: true,
      } as never);
      brokerService.findConnectionsByIds.mockResolvedValue([
        buildHealthyConnection({ liveTradingEnabled: false }),
      ]);
      await expect(
        service.changeExecutionMode('user-1', 'session-1', ExecutionMode.FULL_AUTO),
      ).rejects.toThrow(ForbiddenException);
      expect(executionService.changeExecutionMode).not.toHaveBeenCalled();
    });

    it('allows FULL_AUTO when live trading is enabled on the session connection', async () => {
      riskService.getOrCreateProfile.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        allowedTradingModes: AllowedTradingMode.FULL_AUTO,
        riskAcknowledgementAccepted: true,
      } as never);
      brokerService.findConnectionsByIds.mockResolvedValue([
        buildHealthyConnection({ liveTradingEnabled: true }),
      ]);
      await service.changeExecutionMode('user-1', 'session-1', ExecutionMode.FULL_AUTO);
      expect(executionService.changeExecutionMode).toHaveBeenCalledWith(
        'user-1',
        'session-1',
        ExecutionMode.FULL_AUTO,
      );
    });
  });

  describe('stopTradingSession()', () => {
    it('ends execution authority BEFORE requesting AI-position closure', async () => {
      await service.stopTradingSession('user-1', 'session-1');

      expect(executionService.endSession).toHaveBeenCalledWith(
        'user-1',
        TradingSessionStatus.ENDED,
      );
      expect(executionService.closeAllAiOpenPositions).toHaveBeenCalledWith(
        'user-1',
        TradeCloseReason.MANUAL_CLOSE,
      );
      expect(executionService.endSession.mock.invocationCallOrder[0]).toBeLessThan(
        executionService.closeAllAiOpenPositions.mock.invocationCallOrder[0],
      );
    });

    it('returns COMPLETE only when every AI-opened position is confirmed closed', async () => {
      executionService.closeAllAiOpenPositions.mockResolvedValue([
        { tradeId: 'trade-1', closed: true, status: TradeStatus.CLOSED },
        { tradeId: 'trade-2', closed: true, status: TradeStatus.CLOSED },
      ]);

      const result = await service.stopTradingSession('user-1', 'session-1');

      expect(result.positionCloseSummary).toEqual({
        state: 'COMPLETE',
        targetCount: 2,
        closedCount: 2,
        unresolvedCount: 0,
      });
      expect(result.message).toMatch(/all 2 AI-opened positions were confirmed closed/i);
    });

    it('returns PARTIAL without reactivating AI Trading when a broker close is unresolved', async () => {
      executionService.closeAllAiOpenPositions.mockResolvedValue([
        { tradeId: 'trade-1', closed: true, status: TradeStatus.CLOSED },
        { tradeId: 'trade-2', closed: false, status: TradeStatus.RECONCILIATION_PENDING },
      ]);

      const result = await service.stopTradingSession('user-1', 'session-1');

      expect(result.positionCloseSummary).toEqual({
        state: 'PARTIAL',
        targetCount: 2,
        closedCount: 1,
        unresolvedCount: 1,
      });
      expect(executionService.endSession).toHaveBeenCalledTimes(1);
    });

    it('returns UNKNOWN when the flatten cannot be verified but keeps the session ENDED', async () => {
      executionService.closeAllAiOpenPositions.mockRejectedValue(
        new Error('trade store unavailable'),
      );

      const result = await service.stopTradingSession('user-1', 'session-1');

      expect(result.positionCloseSummary).toEqual({
        state: 'UNKNOWN',
        targetCount: null,
        closedCount: 0,
        unresolvedCount: null,
      });
      expect(executionService.endSession).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when no active session', async () => {
      executionService.getActiveSession.mockResolvedValue(null);
      await expect(service.stopTradingSession('user-1', 'session-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(executionService.closeAllAiOpenPositions).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when session ID does not match', async () => {
      await expect(service.stopTradingSession('user-1', 'other-session')).rejects.toThrow(
        ForbiddenException,
      );
      expect(executionService.closeAllAiOpenPositions).not.toHaveBeenCalled();
    });

    it('audit-logs the stop-and-flatten summary', async () => {
      await service.stopTradingSession('user-1', 'session-1');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-1',
          action: 'AI_TRADING_DISABLED',
          metadata: expect.objectContaining({
            reason: 'user-requested-stop-and-flatten',
            positionCloseSummary: expect.objectContaining({ state: 'COMPLETE' }),
          }),
        }),
      );
    });
  });

  describe('getActiveSession() + getSessionById()', () => {
    it('returns the active session', async () => {
      const session = await service.getActiveSession('user-1');
      expect(session?.id).toBe('session-1');
    });

    it('returns null when no session', async () => {
      executionService.getActiveSession.mockResolvedValue(null);
      const session = await service.getActiveSession('user-1');
      expect(session).toBeNull();
    });

    it('returns session owned by user', async () => {
      const session = await service.getSessionById('user-1', 'session-1');
      expect(session?.id).toBe('session-1');
    });

    it('returns null for session owned by a different user', async () => {
      executionService.findSessionById.mockResolvedValue(mockSession({ userId: 'other-user' }));
      const session = await service.getSessionById('user-1', 'session-1');
      expect(session).toBeNull();
    });
  });
});
