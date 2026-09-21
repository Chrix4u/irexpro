import { Test, TestingModule } from '@nestjs/testing';
import { AiSignalService } from './ai-signal.service';
import { StrategyOrchestratorService } from '../strategy/strategy-orchestrator.service';
import { AiExitOrchestratorService } from '../strategy/ai-exit-orchestrator.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { AiSignalCandidate } from './interfaces/ai-signal-candidate.interface';

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

describe('AiSignalService', () => {
  let module: TestingModule;
  let service: AiSignalService;
  let orchestrator: jest.Mocked<Partial<StrategyOrchestratorService>>;
  let auditService: jest.Mocked<Partial<AuditService>>;
  let eventBus: jest.Mocked<Partial<DomainEventBus>>;

  beforeEach(async () => {
    jest.clearAllMocks();

    orchestrator = {
      processSignal: jest.fn().mockResolvedValue({
        outcome: 'EXECUTION_SUCCEEDED',
        signalId: 'sig-001',
        tradeId: 'trade-1',
      }),
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
        AiSignalService,
        { provide: StrategyOrchestratorService, useValue: orchestrator },
        // Round 6 §10: the exit orchestrator seam (mocked — its own matrix
        // lives in ai-exit-orchestrator.spec.ts).
        {
          provide: AiExitOrchestratorService,
          useValue: { processExitSignal: jest.fn() },
        },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventBus, useValue: eventBus },
      ],
    }).compile();

    service = module.get<AiSignalService>(AiSignalService);
  });

  afterEach(async () => {
    await module.close();
  });

  // ─── validateCandidate() ───────────────────────────────────────────────────

  describe('validateCandidate()', () => {
    it('returns null for a valid candidate', () => {
      expect(service.validateCandidate(validCandidate())).toBeNull();
    });

    it('returns error for missing signalId', () => {
      expect(service.validateCandidate(validCandidate({ signalId: '' }))).toBe('Missing signalId');
    });

    it('returns error for missing userId', () => {
      expect(service.validateCandidate(validCandidate({ userId: '' }))).toBe('Missing userId');
    });

    it('returns error for invalid instrument', () => {
      expect(service.validateCandidate(validCandidate({ instrument: 'X' }))).toBe(
        'Invalid instrument',
      );
    });

    it('returns error for invalid direction', () => {
      expect(service.validateCandidate(validCandidate({ direction: 'HOLD' as 'BUY' }))).toBe(
        'Invalid direction',
      );
    });

    it('returns error for out-of-range confidence score', () => {
      expect(service.validateCandidate(validCandidate({ confidenceScore: 1.5 }))).toContain(
        'confidenceScore',
      );
    });

    it('returns error for missing stopLoss', () => {
      expect(service.validateCandidate(validCandidate({ suggestedStopLoss: 0 }))).toBe(
        'Invalid suggestedStopLoss',
      );
    });

    it('returns error for missing strategyCode', () => {
      expect(service.validateCandidate(validCandidate({ strategyCode: '' }))).toBe(
        'Missing strategyCode',
      );
    });
  });

  // ─── receiveSignal() ───────────────────────────────────────────────────────

  describe('receiveSignal()', () => {
    it('returns SIGNAL_INVALID for invalid candidate without calling orchestrator', async () => {
      const result = await service.receiveSignal(validCandidate({ instrument: '' }));
      expect(result.outcome).toBe('SIGNAL_INVALID');
      expect(orchestrator.processSignal).not.toHaveBeenCalled();
    });

    it('forwards valid candidate to StrategyOrchestrator (not directly to Execution)', async () => {
      await service.receiveSignal(validCandidate());
      expect(orchestrator.processSignal).toHaveBeenCalledWith(
        expect.objectContaining({ signalId: 'sig-001' }),
      );
    });

    it('audit-logs the received signal', async () => {
      await service.receiveSignal(validCandidate());
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AI_SIGNAL_RECEIVED', actorUserId: 'user-1' }),
      );
    });

    it('persists only the whitelisted advisory agent-context projection', async () => {
      await service.receiveSignal(
        validCandidate({
          agentContext: {
            version: 'agent-council-v1',
            status: 'BLOCKED',
            consensusDirection: 'NEUTRAL',
            weightedSupport: 0,
            weightedOpposition: 0,
            disagreementScore: 0,
            evidenceCount: 1,
            rejectedCount: 0,
            evidence: [
              {
                source: 'MACRO_NEWS',
                sourceId: 'macro-event:abc',
                stance: 'BLOCK',
                confidence: 1,
                credibility: 1,
                verifiedSources: 1,
                availableAt: '2026-09-21T02:00:00.000Z',
                summary: 'High-impact USD CPI event is within the configured risk window.',
                providerMetadata: 'must-not-persist',
              } as never,
            ],
            sourceState: 'AVAILABLE',
            evaluatedAt: '2026-09-21T02:00:05.000Z',
            advisoryOnly: true,
            executionAuthority: false,
            hiddenReasoning: 'must-not-persist',
          } as never,
        }),
      );

      const receipt = auditService.log.mock.calls
        .map(([entry]) => entry)
        .find((entry) => entry.action === 'AI_SIGNAL_RECEIVED');
      expect(receipt?.metadata).toMatchObject({
        agentContext: {
          version: 'agent-council-v1',
          status: 'BLOCKED',
          consensusDirection: 'NEUTRAL',
          advisoryOnly: true,
          executionAuthority: false,
          evidence: [
            expect.objectContaining({
              source: 'MACRO_NEWS',
              stance: 'BLOCK',
            }),
          ],
        },
      });
      const serialized = JSON.stringify(receipt?.metadata);
      expect(serialized).not.toContain('providerMetadata');
      expect(serialized).not.toContain('hiddenReasoning');
      expect(serialized).not.toContain('must-not-persist');
    });

    it('drops agent context that attempts to claim execution authority', async () => {
      await service.receiveSignal(
        validCandidate({
          agentContext: {
            version: 'agent-council-v1',
            status: 'INSUFFICIENT',
            consensusDirection: 'NEUTRAL',
            weightedSupport: 0,
            weightedOpposition: 0,
            disagreementScore: 0,
            evidenceCount: 0,
            rejectedCount: 0,
            evidence: [],
            sourceState: 'AVAILABLE',
            evaluatedAt: '2026-09-21T02:00:05.000Z',
            advisoryOnly: true,
            executionAuthority: true,
          } as never,
        }),
      );

      const receipt = auditService.log.mock.calls
        .map(([entry]) => entry)
        .find((entry) => entry.action === 'AI_SIGNAL_RECEIVED');
      expect(receipt?.metadata).not.toHaveProperty('agentContext');
      expect(orchestrator.processSignal).toHaveBeenCalled();
    });

    it('publishes AI_SIGNAL_RECEIVED event', async () => {
      await service.receiveSignal(validCandidate());
      expect(eventBus.publish).toHaveBeenCalledWith(
        'ai.signal.received',
        'user-1',
        expect.objectContaining({ signalId: 'sig-001' }),
      );
    });

    it('returns orchestrator result on success', async () => {
      const result = await service.receiveSignal(validCandidate());
      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(result.tradeId).toBe('trade-1');
    });
  });

  // ─── buildSimulatedCandidate() ────────────────────────────────────────────

  describe('buildSimulatedCandidate()', () => {
    it('assigns a new signalId (UUID)', () => {
      const c1 = service.buildSimulatedCandidate('user-1', {
        instrument: 'EURUSD',
        direction: 'BUY',
      } as AiSignalCandidate);
      const c2 = service.buildSimulatedCandidate('user-1', {
        instrument: 'EURUSD',
        direction: 'BUY',
      } as AiSignalCandidate);
      expect(c1.signalId).toBeTruthy();
      expect(c1.signalId).not.toBe(c2.signalId);
    });

    it('assigns the provided userId', () => {
      const c = service.buildSimulatedCandidate('user-42', {} as AiSignalCandidate);
      expect(c.userId).toBe('user-42');
    });

    it('sets generatedAt to current time', () => {
      const before = new Date();
      const c = service.buildSimulatedCandidate('user-1', {} as AiSignalCandidate);
      expect(c.generatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  // ─── Safety: direct Execution bypass check ────────────────────────────────

  describe('Safety: no direct AI→Execution path', () => {
    it('always goes through StrategyOrchestratorService (not ExecutionService directly)', async () => {
      // The service does not have ExecutionService injected — this test verifies by checking
      // that the only route is through orchestrator.processSignal
      await service.receiveSignal(validCandidate());
      expect(orchestrator.processSignal).toHaveBeenCalledTimes(1);
    });
  });
});
