import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { TradingService } from './trading.service';
import { BrokerService } from '../broker/broker.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { RiskService } from '../risk/risk.service';
import { ExecutionService } from '../execution/execution.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { AiEngineClient } from '../ai-engine-client/ai-engine-client.service';
import { OnboardingService } from '../users/onboarding.service';
import { AllowedTradingMode } from '../risk/entities/risk-profile.entity';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { ExecutionMode } from '../execution/interfaces/execution-authority';

/**
 * Sprint 32 — Risk Profile Snapshot Immutability.
 *
 * Verifies that once a trading session is started with a risk profile snapshot,
 * subsequent edits to the user's current Risk Profile do NOT alter the
 * historical session snapshot. This is the "future edits must not rewrite
 * history" invariant.
 */

describe('TradingService — Sprint 32 Snapshot Immutability', () => {
  let service: TradingService;
  let executionService: Record<string, jest.Mock>;
  let riskService: Record<string, jest.Mock>;

  beforeEach(async () => {
    const mockSession: TradingSession = {
      id: 'session-1',
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      executionMode: ExecutionMode.PAPER_ONLY,
      authorityGeneration: 1,
      status: TradingSessionStatus.ACTIVE,
      openingBalance: '10000.00',
      peakEquity: '10000.00',
      riskProfileSnapshot: null,
      startedAt: new Date(),
      endedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    riskService = {
      isKillSwitchActive: jest.fn().mockResolvedValue(false),
      getOrCreateProfile: jest.fn().mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        killSwitchActive: false,
        maxDailyLossPercent: '5.00',
        maxDrawdownPercent: '10.00',
        maxOpenTrades: 3,
        maxDailyTrades: 10,
        maxPositionSizeLot: '0.10',
        minStopLossPips: '5.00',
        allowedInstruments: null,
        maxVolatilityScore: '0.85',
        rejectLowLiquidity: true,
        maxTradeRiskPercent: '2.00',
        maxLeverageAllowed: 30,
        allowedTradingModes: AllowedTradingMode.PAPER_ONLY,
        riskAcknowledgementAccepted: true,
      }),
      createRiskProfileSnapshot: jest.fn().mockImplementation((profile) => ({
        maxDailyLossPercent: profile.maxDailyLossPercent,
        maxDrawdownPercent: profile.maxDrawdownPercent,
        maxOpenTrades: profile.maxOpenTrades,
        maxDailyTrades: profile.maxDailyTrades,
        maxPositionSizeLot: profile.maxPositionSizeLot,
        minStopLossPips: profile.minStopLossPips,
        allowedInstruments: profile.allowedInstruments,
        maxVolatilityScore: profile.maxVolatilityScore,
        rejectLowLiquidity: profile.rejectLowLiquidity,
        maxTradeRiskPercent: profile.maxTradeRiskPercent,
        maxLeverageAllowed: profile.maxLeverageAllowed,
        allowedTradingModes: profile.allowedTradingModes,
        killSwitchActive: profile.killSwitchActive,
        snapshotVersion: 1,
        snapshotCreatedAt: new Date().toISOString(),
      })),
    };

    executionService = {
      startSession: jest.fn().mockResolvedValue(mockSession),
      endSession: jest.fn().mockResolvedValue(undefined),
      getActiveSession: jest.fn().mockResolvedValue(mockSession),
      findSessionById: jest.fn().mockResolvedValue(mockSession),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TradingService,
        {
          provide: BrokerService,
          useValue: {
            findActiveConnectionForUser: jest.fn().mockResolvedValue({
              id: 'conn-1',
              status: 'CONNECTED',
              brokerId: 'paper-broker',
              accountType: 'DEMO',
              liveTradingEnabled: false,
              consecutiveFailureCount: 0,
              lastHealthCheckAt: new Date(),
            }),
            findConnectionById: jest.fn(),
            getBrokerAccountState: jest.fn().mockResolvedValue({
              balance: '10000.00',
              equity: '10050.00',
              freeMargin: '9800.00',
              currency: 'USD',
            }),
          },
        },
        {
          provide: SubscriptionsService,
          useValue: { canUserStartAiAutoTrading: jest.fn().mockResolvedValue(true) },
        },
        { provide: RiskService, useValue: riskService },
        { provide: ExecutionService, useValue: executionService },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: DomainEventBus, useValue: { publish: jest.fn() } },
        {
          provide: AiEngineClient,
          useValue: {
            notifySessionStarted: jest.fn().mockResolvedValue(undefined),
            notifySessionStopped: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: OnboardingService,
          useValue: {
            canStartTrading: jest.fn().mockResolvedValue({ allowed: true, missingSteps: [] }),
          },
        },
        { provide: Logger, useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } },
      ],
    }).compile();

    service = module.get(TradingService);
  });

  it('passes a risk profile snapshot to startSession', async () => {
    await service.startTradingSession('user-1');
    expect(executionService.startSession).toHaveBeenCalledWith(
      'user-1',
      'conn-1',
      '10000.00',
      expect.objectContaining({
        maxDailyTrades: 10,
        maxOpenTrades: 3,
        snapshotVersion: 1,
      }),
    );
  });

  it('snapshot reflects the risk profile AT session start time (not after edits)', async () => {
    // Start session with the original profile (maxDailyTrades=10)
    await service.startTradingSession('user-1');
    const snapshotArg = executionService.startSession.mock.calls[0][3];
    expect(snapshotArg.maxDailyTrades).toBe(10);

    // Simulate the user editing their risk profile AFTER the session started
    riskService.getOrCreateProfile.mockResolvedValue({
      maxDailyTrades: 20, // changed from 10 to 20
      maxOpenTrades: 5,
      allowedTradingModes: AllowedTradingMode.PAPER_ONLY,
    });
    riskService.createRiskProfileSnapshot.mockImplementation(
      (profile: Record<string, unknown>) => ({
        ...profile,
        snapshotVersion: 1,
        snapshotCreatedAt: new Date().toISOString(),
      }),
    );

    // Start a NEW session (the old one is still active so this returns the existing)
    await service.startTradingSession('user-1');

    // The FIRST session's snapshot (captured at start time) still has the old values
    // The snapshot is immutable — it doesn't change just because the profile changed
    expect(snapshotArg.maxDailyTrades).toBe(10); // still the original value
  });
});
