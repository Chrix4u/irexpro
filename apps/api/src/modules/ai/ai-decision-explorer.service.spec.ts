import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditLog, AuditSeverity } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { Trade, TradeStatus } from '../execution/entities/trade.entity';
import { ExecutionReadService } from '../execution/execution-read.service';
import { AiDecisionExplorerService } from './ai-decision-explorer.service';

function auditLog(
  action: AuditAction,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  createdAt: string,
): AuditLog {
  return {
    id: `${action}-${createdAt}`,
    actorUserId: 'user-1',
    actorType: 'USER',
    action,
    resourceType,
    resourceId,
    ipAddress: null,
    userAgent: null,
    metadata,
    severity: AuditSeverity.INFO,
    createdAt: new Date(createdAt),
  } as AuditLog;
}

function trade(signalId: string): Trade {
  return {
    id: 'trade-1',
    userId: 'user-1',
    signalId,
    status: TradeStatus.OPEN,
    openedAt: new Date('2026-08-28T22:00:03.000Z'),
    closedAt: null,
    closeReason: null,
    createdAt: new Date('2026-08-28T22:00:03.000Z'),
  } as Trade;
}

describe('AiDecisionExplorerService', () => {
  const signalId = '11111111-1111-4111-8111-111111111111';
  let auditService: jest.Mocked<
    Pick<AuditService, 'listRecentAiSignalReceipts' | 'listAiSignalLifecycle'>
  >;
  let executionReadService: jest.Mocked<Pick<ExecutionReadService, 'listBySignalIds'>>;
  let service: AiDecisionExplorerService;

  beforeEach(() => {
    auditService = {
      listRecentAiSignalReceipts: jest.fn(),
      listAiSignalLifecycle: jest.fn(),
    };
    executionReadService = {
      listBySignalIds: jest.fn(),
    };
    service = new AiDecisionExplorerService(
      auditService as unknown as AuditService,
      executionReadService as unknown as ExecutionReadService,
    );
  });

  it('composes user-scoped persisted signal, risk, and execution evidence', async () => {
    const received = auditLog(
      AuditAction.AI_SIGNAL_RECEIVED,
      'AiSignal',
      signalId,
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        confidenceScore: 0.82,
        strategyCode: 'TREND_H1',
        modelVersion: 'ensemble-v2.3',
        timeframe: 'H1',
        marketRegime: 'trending',
        volatilityScore: 0.42,
        generatedAt: '2026-08-28T22:00:00.000Z',
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
              availableAt: '2026-08-28T21:59:59.000Z',
              summary: 'High-impact USD CPI event is within the configured risk window.',
            },
          ],
          sourceState: 'AVAILABLE',
          evaluatedAt: '2026-08-28T22:00:00.500Z',
          advisoryOnly: true,
          executionAuthority: false,
        },
      },
      '2026-08-28T22:00:01.000Z',
    );
    const approved = auditLog(
      AuditAction.AI_SIGNAL_RISK_APPROVED,
      'AiSignal',
      signalId,
      { instrument: 'EURUSD', direction: 'BUY' },
      '2026-08-28T22:00:02.000Z',
    );
    const executed = auditLog(
      AuditAction.AI_SIGNAL_EXECUTED,
      'Trade',
      'trade-1',
      { signalId, instrument: 'EURUSD', direction: 'BUY', strategyCode: 'TREND_H1' },
      '2026-08-28T22:00:03.000Z',
    );

    auditService.listRecentAiSignalReceipts.mockResolvedValue([received]);
    auditService.listAiSignalLifecycle.mockResolvedValue([received, approved, executed]);
    executionReadService.listBySignalIds.mockResolvedValue([trade(signalId)]);

    const result = await service.getRecentDecisions('user-1');

    expect(auditService.listRecentAiSignalReceipts).toHaveBeenCalledWith('user-1', 25);
    expect(auditService.listAiSignalLifecycle).toHaveBeenCalledWith('user-1', [signalId]);
    expect(executionReadService.listBySignalIds).toHaveBeenCalledWith('user-1', [signalId]);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      signalId,
      outcome: 'EXECUTION_SUCCEEDED',
      evidence: {
        instrument: 'EURUSD',
        direction: 'BUY',
        confidenceScore: 0.82,
        strategyCode: 'TREND_H1',
        modelVersion: 'ensemble-v2.3',
      },
      agentContext: {
        status: 'BLOCKED',
        consensusDirection: 'NEUTRAL',
        sourceState: 'AVAILABLE',
        advisoryOnly: true,
        executionAuthority: false,
        evidence: [
          expect.objectContaining({
            source: 'MACRO_NEWS',
            stance: 'BLOCK',
          }),
        ],
      },
      risk: {
        decision: 'APPROVED',
        rejectionCode: null,
        rejectionReason: null,
      },
      execution: {
        tradeId: 'trade-1',
        status: 'OPEN',
      },
    });
    expect(result.decisions[0].timeline.map((entry) => entry.stage)).toEqual([
      'SIGNAL',
      'RISK',
      'EXECUTION',
    ]);
  });

  it('does not infer missing historical risk approval from a later execution row', async () => {
    const received = auditLog(
      AuditAction.AI_SIGNAL_RECEIVED,
      'AiSignal',
      signalId,
      { instrument: 'EURUSD', direction: 'BUY' },
      '2026-08-28T22:00:01.000Z',
    );
    const executed = auditLog(
      AuditAction.AI_SIGNAL_EXECUTED,
      'Trade',
      'trade-1',
      { signalId, instrument: 'EURUSD', direction: 'BUY' },
      '2026-08-28T22:00:03.000Z',
    );

    auditService.listRecentAiSignalReceipts.mockResolvedValue([received]);
    auditService.listAiSignalLifecycle.mockResolvedValue([received, executed]);
    executionReadService.listBySignalIds.mockResolvedValue([trade(signalId)]);

    const result = await service.getRecentDecisions('user-1');

    expect(result.decisions[0].outcome).toBe('EXECUTION_SUCCEEDED');
    expect(result.decisions[0].risk.decision).toBe('UNKNOWN');
  });

  it('fails closed on malformed persisted agent context', async () => {
    const received = auditLog(
      AuditAction.AI_SIGNAL_RECEIVED,
      'AiSignal',
      signalId,
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        agentContext: {
          version: 'agent-council-v1',
          status: 'BLOCKED',
          consensusDirection: 'NEUTRAL',
          weightedSupport: 0,
          weightedOpposition: 0,
          disagreementScore: 0,
          evidenceCount: 1,
          rejectedCount: 0,
          evidence: [],
          sourceState: 'UNAVAILABLE',
          evaluatedAt: '2026-08-28T22:00:00.000Z',
          advisoryOnly: true,
          executionAuthority: false,
          secret: 'must-never-project',
        },
      },
      '2026-08-28T22:00:01.000Z',
    );

    auditService.listRecentAiSignalReceipts.mockResolvedValue([received]);
    auditService.listAiSignalLifecycle.mockResolvedValue([received]);
    executionReadService.listBySignalIds.mockResolvedValue([]);

    const result = await service.getRecentDecisions('user-1');

    expect(result.decisions[0].agentContext).toBeNull();
    expect(JSON.stringify(result)).not.toContain('must-never-project');
  });

  it('never projects raw execution error metadata into the browser timeline', async () => {
    const received = auditLog(
      AuditAction.AI_SIGNAL_RECEIVED,
      'AiSignal',
      signalId,
      { instrument: 'EURUSD', direction: 'BUY' },
      '2026-08-28T22:00:01.000Z',
    );
    const failed = auditLog(
      AuditAction.AI_SIGNAL_EXECUTION_FAILED,
      'AiSignal',
      signalId,
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        failureCode: 'EXECUTION_ERROR',
        error: 'private broker stack detail',
      },
      '2026-08-28T22:00:03.000Z',
    );

    auditService.listRecentAiSignalReceipts.mockResolvedValue([received]);
    auditService.listAiSignalLifecycle.mockResolvedValue([received, failed]);
    executionReadService.listBySignalIds.mockResolvedValue([]);

    const result = await service.getRecentDecisions('user-1');
    const serialized = JSON.stringify(result);
    const timeline = result.decisions[0].timeline;

    expect(result.decisions[0].outcome).toBe('EXECUTION_FAILED');
    expect(timeline[timeline.length - 1]?.message).toBe('Execution failed after risk approval');
    expect(serialized).not.toContain('private broker stack detail');
    expect(serialized).not.toContain('error');
  });
});
