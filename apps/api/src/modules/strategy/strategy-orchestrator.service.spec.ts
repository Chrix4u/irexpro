import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { StrategyOrchestratorService } from './strategy-orchestrator.service';
import { AiSignalIdentityGateService } from '../execution/orchestration/signal-identity.gate';
import { RiskService } from '../risk/risk.service';
import { ExecutionService } from '../execution/execution.service';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { AiSignalCandidate } from './interfaces/strategy.interface';
import { Trade, TradeStatus } from '../execution/entities/trade.entity';

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
    };

    brokerService = {
      hasActiveConnection: jest.fn().mockResolvedValue(true),
    };

    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    eventBus = {
      publish: jest.fn(),
      subscribe: jest.fn().mockReturnValue(() => {}),
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
          provide: AiSignalIdentityGateService,
          useValue: {
            registerOrReuse: jest
              .fn()
              .mockImplementation(async (_userId: string, signal: Record<string, unknown>) => ({
                signalId: (signal.signalId as string) ?? 'sig-1',
                payloadDigest: 'digest-fixture',
                firstDelivery: true,
              })),
          },
        },
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
