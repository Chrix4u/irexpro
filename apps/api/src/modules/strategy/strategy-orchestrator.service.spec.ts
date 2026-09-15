import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { StrategyOrchestratorService } from './strategy-orchestrator.service';
import { AiSignalIdentityGateService } from '../execution/orchestration/signal-identity.gate';
import { SignalIdentityRegistration } from '../execution/orchestration/signal-identity.gate';
import { TradeIntentService } from '../execution/services/trade-intent.service';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { SharedControlRevisionService } from '../execution-authority/shared-control-revision.service';
import { RiskService } from '../risk/risk.service';
import { ExecutionService } from '../execution/execution.service';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { AiSignalCandidate } from './interfaces/strategy.interface';
import { Trade, TradeStatus } from '../execution/entities/trade.entity';
import { AuditAction } from '../../common/enums/audit-action.enum';

const validCandidate = (overrides: Partial<AiSignalCandidate> = {}): AiSignalCandidate => ({
  signalId: 'sig-001',
  userId: 'user-1',
  tradingSessionId: 'session-1',
  brokerConnectionId: 'conn-1',
  instrument: 'EURUSD',
  direction: 'BUY',
  confidenceScore: 0.8,
  suggestedStopLoss: 1.075,
  suggestedTakeProfit: 1.095,
  suggestedVolume: 0.05,
  timeframe: 'H1',
  strategyCode: 'TREND_V1',
  generatedAt: new Date(),
  modelVersion: '1.0.0',
  ...overrides,
});

const activeSession = (): TradingSession =>
  ({
    id: 'session-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    status: TradingSessionStatus.ACTIVE,
  }) as TradingSession;

const approvedRiskDecision = () => ({
  decision: 'APPROVED' as const,
  signalId: 'sig-001',
  validatedOrder: {
    instrument: 'EURUSD',
    direction: 'BUY',
    lotSize: '0.05',
    entryPrice: '1.08500',
    stopLoss: '1.07500',
    takeProfit: '1.09500',
    idempotencyKey: 'user-1:sig-001',
  },
  appliedRules: ['KILL_SWITCH:OK'],
  riskScore: 25,
  evaluatedAt: new Date(),
});

describe('StrategyOrchestratorService', () => {
  let module: TestingModule;
  let service: StrategyOrchestratorService;
  let riskService: jest.Mocked<Partial<RiskService>>;
  let executionService: jest.Mocked<Partial<ExecutionService>>;
  let brokerService: jest.Mocked<Partial<BrokerService>>;
  let auditService: jest.Mocked<Partial<AuditService>>;
  let eventBus: jest.Mocked<Partial<DomainEventBus>>;
  let identityGateMock: { registerOrReuse: jest.Mock; markProcessed: jest.Mock };
  /** Round 6 §2: TradeIntent-layer + authority-read mocks (seam level). */
  let tradeIntentMock: {
    recordOrReuseIntent: jest.Mock;
    markRejected: jest.Mock;
    markExecuted: jest.Mock;
  };
  let authorityReadMock: { getCurrentGeneration: jest.Mock };
  let sharedRevisionMock: {
    getCurrentTradingPolicyRevision: jest.Mock;
    getCurrentProviderVerificationRevision: jest.Mock;
    getCurrentExecutionControlRevision: jest.Mock;
  };

  /** Full SignalIdentityRegistration shape (Round 6 mock contract). */
  const registrationFor = (
    signal: Record<string, unknown>,
    duplicate = false,
  ): SignalIdentityRegistration => ({
    identityId: `identity-${String(signal.signalId ?? 'sig-1')}`,
    signalId: String(signal.signalId ?? 'sig-1'),
    payloadDigest: 'digest-fixture',
    duplicate,
    generatedAt:
      signal.generatedAt instanceof Date
        ? signal.generatedAt
        : new Date(String(signal.generatedAt)),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    riskService = {
      validateProposedTrade: jest.fn().mockResolvedValue(approvedRiskDecision()),
    };

    executionService = {
      getActiveSession: jest.fn().mockResolvedValue(activeSession()),
      executeTrade: jest
        .fn()
        .mockResolvedValue({ id: 'trade-1', status: TradeStatus.OPEN } as Trade),
      findTradeBySignalId: jest.fn().mockResolvedValue(null),
    };

    brokerService = {
      hasActiveConnection: jest.fn().mockResolvedValue(true),
      // Round 6 §2: best-effort logical-account-key read at intent intake.
      findConnectionById: jest.fn().mockResolvedValue({
        id: 'conn-1',
        logicalAccountKey: 'paper-broker::demo::acct-1',
      }),
    };

    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    eventBus = {
      publish: jest.fn(),
      subscribe: jest.fn().mockReturnValue(() => {}),
    };

    identityGateMock = {
      registerOrReuse: jest
        .fn()
        .mockImplementation(async (_userId: string, signal: Record<string, unknown>) =>
          registrationFor(signal),
        ),
      markProcessed: jest.fn().mockResolvedValue(undefined),
    };

    // Round 6 §2: the durable TradeIntent layer is mocked at the seam (its
    // own matrix lives in trade-intent.service.spec.ts) — every NEW signal
    // records (or reuses) a CREATED intent with the authority generations
    // CURRENT at creation.
    tradeIntentMock = {
      recordOrReuseIntent: jest.fn().mockImplementation(async (facts: { signalId: string; userId: string }) => ({
        created: true,
        intent: {
          id: `intent-${facts.signalId}`,
          userId: facts.userId,
          signalId: facts.signalId,
          status: 'CREATED',
          expiresAt: new Date(Date.now() + 60_000),
        },
      })),
      markRejected: jest.fn().mockResolvedValue(undefined),
      markExecuted: jest.fn().mockResolvedValue(undefined),
    };

    authorityReadMock = {
      getCurrentGeneration: jest.fn().mockResolvedValue(1),
    };

    sharedRevisionMock = {
      getCurrentTradingPolicyRevision: jest.fn().mockResolvedValue(1),
      getCurrentProviderVerificationRevision: jest.fn().mockResolvedValue(1),
      getCurrentExecutionControlRevision: jest.fn().mockResolvedValue(1),
    };

    module = await Test.createTestingModule({
      providers: [
        StrategyOrchestratorService,
        { provide: RiskService, useValue: riskService },
        { provide: ExecutionService, useValue: executionService },
        { provide: BrokerService, useValue: brokerService },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventBus, useValue: eventBus },
        {
          // Round 5 (task 50-c): the durable signal-identity gate is mocked at
          // the seam (its own matrix lives in signal-identity.gate.spec.ts).
          // Round 6: the mock carries the FULL registration shape incl. the
          // duplicate flag + persisted original generatedAt.
          provide: AiSignalIdentityGateService,
          useValue: identityGateMock,
        },
        // Round 6 §2: TradeIntent layer + authority/revision reads at intent
        // creation (matrices live in their own suites).
        { provide: TradeIntentService, useValue: tradeIntentMock },
        { provide: TradingAuthorityService, useValue: authorityReadMock },
        { provide: SharedControlRevisionService, useValue: sharedRevisionMock },
      ],
    }).compile();

    service = module.get<StrategyOrchestratorService>(StrategyOrchestratorService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await module.close();
  });

  describe('Gate 1: Signal structure validation', () => {
    it('rejects malformed signal missing instrument', async () => {
      const result = await service.processSignal(validCandidate({ instrument: '' }));
      expect(result.outcome).toBe('SIGNAL_INVALID');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
    });

    it('rejects malformed signal missing userId', async () => {
      const result = await service.processSignal(validCandidate({ userId: '' }));
      expect(result.outcome).toBe('SIGNAL_INVALID');
    });

    it('rejects invalid direction', async () => {
      const result = await service.processSignal(validCandidate({ direction: 'HOLD' as 'BUY' }));
      expect(result.outcome).toBe('SIGNAL_INVALID');
    });
  });

  describe('Gate 2: Confidence threshold', () => {
    it('rejects low confidence signal (below 0.6)', async () => {
      const result = await service.processSignal(validCandidate({ confidenceScore: 0.5 }));
      expect(result.outcome).toBe('LOW_CONFIDENCE');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
    });

    it('accepts signal at confidence threshold (0.6)', async () => {
      const result = await service.processSignal(validCandidate({ confidenceScore: 0.6 }));
      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
    });
  });

  describe('Gate 3: Trading session active', () => {
    it('rejects when no active session', async () => {
      (executionService.getActiveSession as jest.Mock).mockResolvedValue(null);
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('SESSION_INACTIVE');
    });

    it('rejects when session ID does not match', async () => {
      (executionService.getActiveSession as jest.Mock).mockResolvedValue({
        ...activeSession(),
        id: 'different-session',
      });
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('SESSION_INACTIVE');
    });
  });

  describe('Free-access regression', () => {
    it('routes an eligible user without consulting any subscription service', async () => {
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(riskService.validateProposedTrade).toHaveBeenCalled();
      expect(executionService.executeTrade).toHaveBeenCalled();
    });
  });

  describe('Gate 4: Broker connection gate', () => {
    it('rejects user without active broker connection', async () => {
      (brokerService.hasActiveConnection as jest.Mock).mockResolvedValue(false);
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('NO_BROKER_CONNECTION');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
    });
  });

  describe('Gate 5: Risk Engine gate', () => {
    it('sends valid signal to RiskService', async () => {
      await service.processSignal(validCandidate());
      expect(riskService.validateProposedTrade).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ signalId: 'sig-001', instrument: 'EURUSD' }),
      );
    });

    it('does not call ExecutionService when RiskService rejects', async () => {
      (riskService.validateProposedTrade as jest.Mock).mockResolvedValue({
        decision: 'REJECTED',
        signalId: 'sig-001',
        rejectionCode: 'KILL_SWITCH_ACTIVE',
        rejectionReason: 'Kill switch',
        evaluatedAt: new Date(),
      });
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('RISK_REJECTED');
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('returns RISK_SUSPENDED when risk decision is SUSPENDED', async () => {
      (riskService.validateProposedTrade as jest.Mock).mockResolvedValue({
        decision: 'SUSPENDED',
        signalId: 'sig-001',
        rejectionCode: 'MAX_DRAWDOWN_REACHED',
        rejectionReason: 'Drawdown limit',
        evaluatedAt: new Date(),
      });
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('RISK_SUSPENDED');
    });

    it('rejects (fail-closed) when RiskService throws an error', async () => {
      (riskService.validateProposedTrade as jest.Mock).mockRejectedValue(
        new Error('Risk Engine crash'),
      );
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('RISK_REJECTED');
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });
  });

  describe('Gate 6: Execution', () => {
    it('calls ExecutionService only when RiskService approves', async () => {
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(executionService.executeTrade).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ decision: 'APPROVED' }),
      );
    });

    it('returns EXECUTION_FAILED when ExecutionService throws', async () => {
      (executionService.executeTrade as jest.Mock).mockRejectedValue(
        new Error('Broker unavailable'),
      );
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('EXECUTION_FAILED');
    });

    it('returns tradeId on success', async () => {
      const result = await service.processSignal(validCandidate());
      expect(result.tradeId).toBe('trade-1');
    });
  });

  describe('Gate 4.6: deterministic duplicate recovery (#302, Round 6)', () => {
    /** Flip the identity-gate seam: this delivery is a DUPLICATE re-delivery. */
    const deliverAsDuplicate = (): void => {
      identityGateMock.registerOrReuse.mockImplementation(
        async (_userId: string, signal: Record<string, unknown>) => registrationFor(signal, true),
      );
    };

    const existingTrade = (status: TradeStatus): Trade =>
      ({ id: 'trade-existing', status, signalId: 'sig-001' }) as Trade;

    it.each([
      ['PENDING', TradeStatus.PENDING],
      ['OPEN', TradeStatus.OPEN],
      ['CLOSED', TradeStatus.CLOSED],
      ['RECONCILIATION_PENDING', TradeStatus.RECONCILIATION_PENDING],
    ])(
      'duplicate with an existing %s trade → EXECUTION_SUCCEEDED + duplicateOfTrade (no fresh evaluation, no dispatch)',
      async (_label: string, status: TradeStatus) => {
        deliverAsDuplicate();
        (executionService.findTradeBySignalId as jest.Mock).mockResolvedValue(
          existingTrade(status),
        );

        const result = await service.processSignal(validCandidate());

        expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
        expect(result.tradeId).toBe('trade-existing');
        expect(result.duplicateOfTrade).toEqual({
          tradeId: 'trade-existing',
          tradeStatus: status,
          recoveredAs: 'EXECUTION_SUCCEEDED',
        });
        // The FIRST delivery's durable outcome is the truth — the duplicate
        // NEVER re-enters risk evaluation or provider dispatch.
        expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
        expect(executionService.executeTrade).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['REJECTED', TradeStatus.REJECTED],
      ['CANCELLED', TradeStatus.CANCELLED],
    ])(
      'duplicate with an existing %s trade → EXECUTION_FAILED + duplicateOfTrade (no fresh evaluation, no dispatch)',
      async (_label: string, status: TradeStatus) => {
        deliverAsDuplicate();
        (executionService.findTradeBySignalId as jest.Mock).mockResolvedValue(
          existingTrade(status),
        );

        const result = await service.processSignal(validCandidate());

        expect(result.outcome).toBe('EXECUTION_FAILED');
        expect(result.tradeId).toBe('trade-existing');
        expect(result.duplicateOfTrade).toEqual({
          tradeId: 'trade-existing',
          tradeStatus: status,
          recoveredAs: 'EXECUTION_FAILED',
        });
        expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
        expect(executionService.executeTrade).not.toHaveBeenCalled();
      },
    );

    it('duplicate with NO existing trade → RISK_REJECTED + duplicateOfTrade{tradeId:null, tradeStatus:REJECTED_PREVIOUSLY} — a retry of a rejected signal stays rejected', async () => {
      deliverAsDuplicate();
      (executionService.findTradeBySignalId as jest.Mock).mockResolvedValue(null);

      const result = await service.processSignal(validCandidate());

      expect(result.outcome).toBe('RISK_REJECTED');
      expect(result.duplicateOfTrade).toEqual({
        tradeId: null,
        tradeStatus: 'REJECTED_PREVIOUSLY',
        recoveredAs: 'RISK_REJECTED',
      });
      expect(result.reason).toContain('previously rejected');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('duplicate recovery lookup FAILURE → fail-closed SIGNAL_INVALID (never a fresh evaluation)', async () => {
      deliverAsDuplicate();
      (executionService.findTradeBySignalId as jest.Mock).mockRejectedValue(
        new Error('trade store unavailable'),
      );

      const result = await service.processSignal(validCandidate());

      expect(result.outcome).toBe('SIGNAL_INVALID');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('audits the suppressed duplicate via AI_SIGNAL_IGNORED (DUPLICATE_SIGNAL_RECOVERED) with existing trade id/status + original generatedAt, and emits the domain event', async () => {
      deliverAsDuplicate();
      (executionService.findTradeBySignalId as jest.Mock).mockResolvedValue(
        existingTrade(TradeStatus.OPEN),
      );

      await service.processSignal(validCandidate());

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.AI_SIGNAL_IGNORED,
          resourceType: 'AiSignal',
          resourceId: 'sig-001',
          metadata: expect.objectContaining({
            outcome: 'EXECUTION_SUCCEEDED',
            reasonCode: 'DUPLICATE_SIGNAL_RECOVERED',
            existingTradeId: 'trade-existing',
            existingTradeStatus: TradeStatus.OPEN,
            originalGeneratedAt: expect.any(String),
          }),
        }),
      );
      expect(eventBus.publish).toHaveBeenCalledWith(
        'ai.signal.ignored',
        'user-1',
        expect.objectContaining({
          signalId: 'sig-001',
          existingTradeId: 'trade-existing',
          existingTradeStatus: TradeStatus.OPEN,
        }),
      );
    });
  });

  describe('Safety regression', () => {
    it('never calls ExecutionService without a prior RiskService approval', async () => {
      (riskService.validateProposedTrade as jest.Mock).mockResolvedValue({
        decision: 'REJECTED',
        signalId: 'sig-001',
        rejectionCode: 'POSITION_SIZE_EXCEEDED',
        rejectionReason: 'Too large',
        evaluatedAt: new Date(),
      });

      await service.processSignal(validCandidate());
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('emits AI_SIGNAL_IGNORED domain event for low-confidence signals', async () => {
      await service.processSignal(validCandidate({ confidenceScore: 0.3 }));
      expect(eventBus.publish).toHaveBeenCalledWith(
        'ai.signal.ignored',
        'user-1',
        expect.objectContaining({ signalId: 'sig-001' }),
      );
    });
  });
});
