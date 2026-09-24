import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { StrategyOrchestratorService } from './strategy-orchestrator.service';
import { AiSignalIdentityGateService } from '../execution/orchestration/signal-identity.gate';
import { SignalIdentityRegistration } from '../execution/orchestration/signal-identity.gate';
import { TradeIntentService } from '../execution/services/trade-intent.service';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { SharedControlRevisionService } from '../execution-authority/shared-control-revision.service';
import { PositionSizingService } from '../execution/services/position-sizing.service';
import { AllocationService } from '../execution/services/allocation.service';
import { RiskService } from '../risk/risk.service';
import { ExecutionService } from '../execution/execution.service';
import { BrokerService } from '../broker/broker.service';
// Round 7.1 (P1 — sizing input freshness): the LIVE fresh-snapshot seam.
import {
  BrokerAccountSnapshotService,
  SnapshotNotFreshError,
} from '../broker/services/broker-account-snapshot.service';
import { BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
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
  /** Round 6 §3/§4: sizing + allocation seam mocks. */
  let sizingMock: { sizePosition: jest.Mock };
  let allocationMock: {
    resolveOrAllocate: jest.Mock;
    releaseAllocationForIntent: jest.Mock;
  };
  /** Round 7.1 (P1): the LIVE fresh-snapshot authority seam (Gate 4.8). */
  let snapshotMock: { resolveFreshSnapshotForNewExposure: jest.Mock };

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
      // (The default connection carries NO accountType — every existing
      // test is a DEMO-class signal, so the Round 7.1 sizing-freshness gate
      // is never entered without an explicit per-test LIVE override.)
      findConnectionById: jest.fn().mockResolvedValue({
        id: 'conn-1',
        logicalAccountKey: 'paper-broker::demo::acct-1',
      }),
      // Round 7.1 (P1 — sizing input freshness): the ONE bounded synchronous
      // provider observation used when a LIVE snapshot is STALE/MISSING.
      observeAccountSnapshotNow: jest.fn().mockResolvedValue(undefined),
      getCurrentPriceForConnection: jest.fn().mockResolvedValue({
        instrument: 'EURUSD',
        bid: '1.10000',
        ask: '1.10010',
        spread: '0.00010',
        timestamp: new Date('2024-01-02T03:37:00.000Z'),
      }),
    };

    // Round 7.1 (P1): the LIVE fresh-snapshot authority resolves by default
    // (fresh) — the DEMO default path never consults it at all.
    snapshotMock = {
      resolveFreshSnapshotForNewExposure: jest
        .fn()
        .mockResolvedValue({ id: 'snap-1', generation: 1, currency: 'USD' }),
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
      recordOrReuseIntent: jest
        .fn()
        .mockImplementation(async (facts: { signalId: string; userId: string }) => ({
          created: true,
          intent: {
            id: `intent-${facts.signalId}`,
            userId: facts.userId,
            signalId: facts.signalId,
            status: 'CREATED',
            expiresAt: new Date(Date.now() + 60_000),
            // Round 7 (P0 allocation-scope fix): the durable intent carries
            // the connection's real logical account key.
            logicalAccountKey: 'paper-broker::demo::acct-1',
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

    // Round 6 §3/§4: sizing derives a proven volume and allocation reserves
    // it (matrices live in their own suites).
    sizingMock = {
      sizePosition: jest.fn().mockResolvedValue({
        lots: '0.05',
        allocatedCapital: '5425.00',
        accountCurrency: 'USD',
        entryPrice: '1.08500',
        inputs: { accountCurrency: 'USD', equity: '10000.00' },
      }),
    };
    allocationMock = {
      resolveOrAllocate: jest.fn().mockResolvedValue({ id: 'alloc-1', status: 'ACTIVE' }),
      releaseAllocationForIntent: jest.fn().mockResolvedValue(undefined),
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
        // Round 6 §3/§4: sizing + allocation at the seam.
        { provide: PositionSizingService, useValue: sizingMock },
        { provide: AllocationService, useValue: allocationMock },
        // Round 7.1 (P1 — sizing input freshness): the LIVE fresh-snapshot
        // authority at the seam (its own matrix lives in
        // broker-account-snapshot.service.spec.ts).
        { provide: BrokerAccountSnapshotService, useValue: snapshotMock },
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

  describe('Research PAPER UAT workflow probe boundary', () => {
    const probeCandidate = () =>
      validCandidate({
        confidenceScore: 0.0224,
        suggestedEntryPrice: 1.2,
        suggestedStopLoss: 1.1985,
        suggestedTakeProfit: 1.202,
        strategyCode: 'uat-workflow-probe-h1',
        metadata: {
          uat_workflow_probe: true,
          production_eligible: false,
          model_confidence_threshold: 0.6,
        },
      });

    it('allows the real low confidence only on the exact PAPER_ONLY internal paper broker and rebases the workflow probe onto its execution quote', async () => {
      (executionService.getActiveSession as jest.Mock).mockResolvedValue({
        ...activeSession(),
        executionMode: ExecutionMode.PAPER_ONLY,
      });
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue({
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'paper-broker',
        accountType: BrokerMode.DEMO,
        logicalAccountKey: 'paper-broker::demo::acct-1',
      });

      const result = await service.processSignal(probeCandidate());

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(brokerService.getCurrentPriceForConnection).toHaveBeenCalledWith(
        'user-1',
        'conn-1',
        'EURUSD',
      );
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedEntryPrice: '1.10005',
          stopLoss: '1.09855',
        }),
      );
      expect(riskService.validateProposedTrade).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          entryPrice: '1.10005',
          stopLoss: '1.09855',
          takeProfit: '1.10205',
        }),
      );
      expect(tradeIntentMock.recordOrReuseIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedEntryPrice: '1.10005',
          metadata: expect.objectContaining({
            uat_execution_probe_rebased: true,
            uat_replay_reference_price: '1.2',
            uat_execution_reference_price: '1.10005',
          }),
        }),
      );
      expect(executionService.executeTrade).toHaveBeenCalled();
    });

    it('does not rebase or advance the paper market for a duplicate UAT signal', async () => {
      (executionService.getActiveSession as jest.Mock).mockResolvedValue({
        ...activeSession(),
        executionMode: ExecutionMode.PAPER_ONLY,
      });
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue({
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'paper-broker',
        accountType: BrokerMode.DEMO,
        logicalAccountKey: 'paper-broker::demo::acct-1',
      });
      identityGateMock.registerOrReuse.mockImplementation(
        async (_userId: string, signal: Record<string, unknown>) =>
          registrationFor(signal, true),
      );
      (executionService.findTradeBySignalId as jest.Mock).mockResolvedValue({
        id: 'trade-existing',
        signalId: 'sig-001',
        status: TradeStatus.OPEN,
      } as Trade);

      const result = await service.processSignal(probeCandidate());

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(result.duplicateOfTrade?.tradeId).toBe('trade-existing');
      expect(brokerService.getCurrentPriceForConnection).not.toHaveBeenCalled();
      expect(sizingMock.sizePosition).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('rejects the same probe on a real-provider DEMO connection', async () => {
      (executionService.getActiveSession as jest.Mock).mockResolvedValue({
        ...activeSession(),
        executionMode: ExecutionMode.PAPER_ONLY,
      });
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue({
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        logicalAccountKey: 'metatrader5::demo::acct-1',
      });

      const result = await service.processSignal(probeCandidate());

      expect(result.outcome).toBe('LOW_CONFIDENCE');
      expect(result.reason).toContain('PAPER_ONLY internal paper-broker');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('rejects the probe when the authoritative session is not PAPER_ONLY', async () => {
      (executionService.getActiveSession as jest.Mock).mockResolvedValue({
        ...activeSession(),
        executionMode: ExecutionMode.FULL_AUTO,
      });
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue({
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'paper-broker',
        accountType: BrokerMode.DEMO,
        logicalAccountKey: 'paper-broker::demo::acct-1',
      });

      const result = await service.processSignal(probeCandidate());

      expect(result.outcome).toBe('LOW_CONFIDENCE');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
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

    it("P0 allocation-scope fix: reserves capital against the intent's REAL logical account key — never a null/synthetic scope", async () => {
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(allocationMock.resolveOrAllocate).toHaveBeenCalledTimes(1);
      const call = allocationMock.resolveOrAllocate.mock.calls[0][0] as {
        intent: { logicalAccountKey: string | null };
        logicalAccountKey: string | null;
      };
      // The REAL per-account scope captured on the durable intent at creation.
      expect(call.logicalAccountKey).toBe('paper-broker::demo::acct-1');
      expect(call.intent.logicalAccountKey).toBe('paper-broker::demo::acct-1');
    });

    it('returns EXECUTION_FAILED when ExecutionService throws', async () => {
      (executionService.executeTrade as jest.Mock).mockRejectedValue(
        new Error('Broker unavailable'),
      );
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('EXECUTION_FAILED');
    });

    it.each([
      ['REJECTED', TradeStatus.REJECTED],
      ['CANCELLED', TradeStatus.CANCELLED],
      ['RECONCILIATION_PENDING', TradeStatus.RECONCILIATION_PENDING],
    ])(
      'does not misreport a returned %s trade as EXECUTION_SUCCEEDED',
      async (_label: string, status: TradeStatus) => {
        (executionService.executeTrade as jest.Mock).mockResolvedValue({
          id: 'trade-terminal',
          status,
        } as Trade);

        const result = await service.processSignal(validCandidate());

        expect(result.outcome).toBe('EXECUTION_FAILED');
        expect(result.tradeId).toBe('trade-terminal');
        expect(result.reason).toBeTruthy();
        expect(auditService.log).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.AI_SIGNAL_EXECUTION_FAILED,
            resourceId: 'trade-terminal',
            metadata: expect.objectContaining({
              failureCode: `EXECUTION_RETURNED_${status}`,
            }),
          }),
        );
      },
    );

    it('returns tradeId on success', async () => {
      const result = await service.processSignal(validCandidate());
      expect(result.tradeId).toBe('trade-1');
    });
  });

  describe('Round 7.1 (P1): sizing authority + LIVE input freshness (Gate 4.8)', () => {
    /** The session-bound LIVE connection (accountType is the gate's switch). */
    const liveConnection = () => ({
      id: 'conn-1',
      userId: 'user-1',
      brokerId: 'metatrader',
      accountType: BrokerMode.LIVE,
      logicalAccountKey: 'metatrader::live::acct-1',
    });

    it('the SIZED volume flows to the Risk Engine — never the AI suggestedVolume (mock-seam regression: the Round 7 P0 allocation bug hid behind this exact seam)', async () => {
      // The AI suggests 9.99 lots; the (mocked) sizing authority derives
      // 0.20 from the risk budget. The Risk Engine must see 0.20.
      sizingMock.sizePosition.mockResolvedValue({
        lots: '0.20',
        allocatedCapital: '21700.00',
        accountCurrency: 'USD',
        entryPrice: '1.08500',
        inputs: { accountCurrency: 'USD', equity: '10000.00' },
      });

      const result = await service.processSignal(validCandidate({ suggestedVolume: 9.99 }));

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      const proposed = (riskService.validateProposedTrade as jest.Mock).mock.calls[0][1];
      expect(proposed.requestedLotSize).toBe('0.20');
      expect(proposed.requestedLotSize).not.toBe('9.99');
      // Provenance only: the durable intent records the RAW AI request (the
      // sizing derivation is recorded with the allocation, not the intent).
      expect(tradeIntentMock.recordOrReuseIntent).toHaveBeenCalledWith(
        expect.objectContaining({ requestedLotSize: '9.99' }),
      );
    });

    it('DEMO connections never consult the snapshot authority (no sizing-time freshness gate — behavior unchanged)', async () => {
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(snapshotMock.resolveFreshSnapshotForNewExposure).not.toHaveBeenCalled();
      expect(brokerService.observeAccountSnapshotNow).not.toHaveBeenCalled();
      expect(sizingMock.sizePosition).toHaveBeenCalledTimes(1);
    });

    it('LIVE + fresh snapshot → no refresh call, sizing proceeds', async () => {
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue(liveConnection());

      const result = await service.processSignal(validCandidate());

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(snapshotMock.resolveFreshSnapshotForNewExposure).toHaveBeenCalledWith('conn-1');
      expect(brokerService.observeAccountSnapshotNow).not.toHaveBeenCalled();
      expect(sizingMock.sizePosition).toHaveBeenCalledTimes(1);
    });

    it('LIVE + stale snapshot → ONE bounded synchronous refresh, re-resolve, sizing proceeds on the refreshed state', async () => {
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue(liveConnection());
      snapshotMock.resolveFreshSnapshotForNewExposure
        .mockRejectedValueOnce(
          new SnapshotNotFreshError(
            { code: 'SNAPSHOT_STALE', ageMs: 45_000, maxAgeMs: 30_000 },
            'conn-1',
          ),
        )
        .mockResolvedValueOnce({ id: 'snap-2', generation: 2, currency: 'USD' });

      const result = await service.processSignal(validCandidate());

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      // Exactly ONE provider observation, then the re-resolve succeeded.
      expect(brokerService.observeAccountSnapshotNow).toHaveBeenCalledTimes(1);
      expect(brokerService.observeAccountSnapshotNow).toHaveBeenCalledWith('user-1', 'conn-1');
      expect(snapshotMock.resolveFreshSnapshotForNewExposure).toHaveBeenCalledTimes(2);
      expect(sizingMock.sizePosition).toHaveBeenCalledTimes(1);
    });

    it('LIVE + refresh leaves the snapshot stale → typed SNAPSHOT_STALE rejection, sizePosition NEVER called (never a stale-equity sizing)', async () => {
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue(liveConnection());
      const stillStale = new SnapshotNotFreshError(
        { code: 'SNAPSHOT_STALE', ageMs: 61_000, maxAgeMs: 30_000 },
        'conn-1',
      );
      snapshotMock.resolveFreshSnapshotForNewExposure
        .mockRejectedValueOnce(
          new SnapshotNotFreshError(
            { code: 'SNAPSHOT_STALE', ageMs: 45_000, maxAgeMs: 30_000 },
            'conn-1',
          ),
        )
        .mockRejectedValueOnce(stillStale);

      const result = await service.processSignal(validCandidate());

      expect(result.outcome).toBe('EXECUTION_FAILED');
      expect(result.reason).toContain('SNAPSHOT_STALE');
      expect(brokerService.observeAccountSnapshotNow).toHaveBeenCalledTimes(1);
      // NEVER a stale-equity sizing: the sizing engine was never invoked.
      expect(sizingMock.sizePosition).not.toHaveBeenCalled();
      expect(allocationMock.resolveOrAllocate).not.toHaveBeenCalled();
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.AI_SIGNAL_EXECUTION_FAILED,
          metadata: expect.objectContaining({ failureCode: 'SNAPSHOT_STALE' }),
        }),
      );
    });

    it('LIVE + the refresh observation itself fails → typed fail-closed rejection, sizePosition NEVER called', async () => {
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue(liveConnection());
      snapshotMock.resolveFreshSnapshotForNewExposure.mockRejectedValueOnce(
        new SnapshotNotFreshError({ code: 'SNAPSHOT_MISSING' }, 'conn-1'),
      );
      (brokerService.observeAccountSnapshotNow as jest.Mock).mockRejectedValueOnce(
        new Error('provider unreachable'),
      );

      const result = await service.processSignal(validCandidate());

      expect(result.outcome).toBe('EXECUTION_FAILED');
      expect(result.reason).toContain('provider unreachable');
      expect(brokerService.observeAccountSnapshotNow).toHaveBeenCalledTimes(1);
      expect(sizingMock.sizePosition).not.toHaveBeenCalled();
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
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
      ['RECONCILIATION_PENDING', TradeStatus.RECONCILIATION_PENDING],
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
