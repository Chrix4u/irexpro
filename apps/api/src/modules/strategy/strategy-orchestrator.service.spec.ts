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
    executionMode: ExecutionMode.PAPER_ONLY,
    peakEquity: '10000.00',
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
    findBySignal: jest.Mock;
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
    getUserCapitalAllocationState: jest.Mock;
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
      findBySignal: jest.fn().mockResolvedValue({
        id: 'intent-sig-001',
        userId: 'user-1',
        signalId: 'sig-001',
        status: 'CREATED',
      }),
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
      getUserCapitalAllocationState: jest.fn().mockResolvedValue({
        brokerConnectionId: 'conn-1',
        logicalAccountKey: 'paper-broker::demo::acct-1',
        accountCurrency: 'USD',
        brokerEquity: '10000',
        hasAllocation: true,
        allocatedCapital: '1000',
        committedCapital: '0',
        inFlightCommitments: '0',
        pendingOrderCommitments: '0',
        openPositionCommitments: '0',
        availableCapital: '1000',
      }),
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

    it('enforces a higher scheduler-carried execution confidence floor', async () => {
      const candidate = validCandidate({
        confidenceScore: 0.65,
        metadata: {
          model_confidence_threshold: 0.7,
        },
      });

      const result = await service.processSignal(candidate);

      expect(result.outcome).toBe('LOW_CONFIDENCE');
      expect(result.reason).toContain('threshold 0.7');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
    });

    it('never allows metadata to lower the production confidence floor below 0.6', async () => {
      const candidate = validCandidate({
        confidenceScore: 0.59,
        metadata: {
          model_confidence_threshold: 0.3,
        },
      });

      const result = await service.processSignal(candidate);

      expect(result.outcome).toBe('LOW_CONFIDENCE');
      expect(result.reason).toContain('threshold 0.6');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
    });

    it('accepts signal at confidence threshold (0.6) and carries strategy timeframe into risk', async () => {
      const result = await service.processSignal(
        validCandidate({ confidenceScore: 0.6, timeframe: 'M1' }),
      );
      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(riskService.validateProposedTrade).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ strategyTimeframe: 'M1' }),
      );
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
        { strategyTimeframe: 'H1' },
      );
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          entryType: 'MARKET',
          requestedEntryPrice: null,
          stopLoss: '1.09855',
          requestedLotUpperBound: String(probeCandidate().suggestedVolume),
        }),
      );
      expect(riskService.validateProposedTrade).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          entryPrice: '0',
          stopLoss: '1.09855',
          takeProfit: '1.10205',
        }),
      );
      expect(tradeIntentMock.recordOrReuseIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedEntryPrice: null,
          metadata: expect.objectContaining({
            execution_entry_type: 'MARKET',
            signal_suggested_entry_price: '1.2',
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
        async (_userId: string, signal: Record<string, unknown>) => registrationFor(signal, true),
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

  describe('External provider PAPER-only boundary', () => {
    const externalCandidate = () =>
      validCandidate({
        confidenceScore: 0.72,
        strategyCode: 'external-tradingview-relay-trend-v1',
        modelVersion: 'external-provider/tradingview-relay/paper-only-v1',
        metadata: {
          signal_source: 'EXTERNAL_PROVIDER',
          external_provider_code: 'tradingview-relay',
          external_provider_paper_only: true,
          production_eligible: false,
        },
      });

    it('allows a certified-shape external signal only on the exact internal PAPER broker', async () => {
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

      const result = await service.processSignal(externalCandidate());

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(riskService.validateProposedTrade).toHaveBeenCalled();
      expect(executionService.executeTrade).toHaveBeenCalled();
    });

    it('rejects an external provider signal on FULL_AUTO even with a paper broker connection', async () => {
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

      const result = await service.processSignal(externalCandidate());

      expect(result.outcome).toBe('SIGNAL_INVALID');
      expect(result.reason).toContain('PAPER_ONLY');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('allows only the server-promoted M1 tactical model on an activated real-provider DEMO FULL_AUTO session and applies professional sizing', async () => {
      (executionService.getActiveSession as jest.Mock).mockResolvedValue({
        ...activeSession(),
        executionMode: ExecutionMode.FULL_AUTO,
      });
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue({
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        authorizationStatus: 'ACTIVE',
        demoValidated: true,
        liveTradingEnabled: false,
        logicalAccountKey: 'metatrader5::demo::acct-1',
      });

      const result = await service.processSignal(
        validCandidate({
          confidenceScore: 0.72,
          timeframe: 'M1',
          strategyCode: 'external-irexpro-m1-tactical',
          modelVersion: 'external-provider/irexpro-m1-tactical/m1-tactical-v1',
          suggestedVolume: 0.5,
          metadata: {
            signal_source: 'EXTERNAL_PROVIDER',
            external_provider_code: 'irexpro-m1-tactical',
            external_provider_paper_only: true,
            position_sizing_tier: 'BASE',
            production_eligible: false,
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(allocationMock.getUserCapitalAllocationState).toHaveBeenCalledWith('user-1', 'conn-1');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedLotUpperBound: '0.5',
          paperAllocationSizing: expect.objectContaining({
            executionMode: ExecutionMode.FULL_AUTO,
            confidenceTier: 'BASE',
            minimumExecutableLot: '0.2',
          }),
        }),
      );
      expect(riskService.validateProposedTrade).toHaveBeenCalled();
      expect(executionService.executeTrade).toHaveBeenCalled();
    });

    it('allows only the server-promoted multi-model ensemble tuple on an activated real-provider DEMO FULL_AUTO session', async () => {
      (executionService.getActiveSession as jest.Mock).mockResolvedValue({
        ...activeSession(),
        executionMode: ExecutionMode.FULL_AUTO,
      });
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue({
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'ctrader',
        accountType: BrokerMode.DEMO,
        authorizationStatus: 'ACTIVE',
        demoValidated: true,
        liveTradingEnabled: false,
        logicalAccountKey: 'ctrader::demo::acct-1',
      });

      const result = await service.processSignal(
        validCandidate({
          confidenceScore: 0.72,
          timeframe: 'M1',
          strategyCode: 'external-irexpro-multimodel-ensemble',
          modelVersion: 'external-provider/irexpro-multimodel-ensemble-v1/demo-v1',
          suggestedVolume: 0.5,
          metadata: {
            signal_source: 'EXTERNAL_PROVIDER',
            external_provider_code: 'irexpro-multimodel-ensemble-v1',
            external_provider_paper_only: true,
            position_sizing_tier: 'BASE',
            production_eligible: false,
            primary_engine_code: 'irexpro-multimodel-ensemble-v1',
            multimodel_execution_authority: 'DEMO_FULL_AUTO_PROMOTED',
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(allocationMock.getUserCapitalAllocationState).toHaveBeenCalledWith('user-1', 'conn-1');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedLotUpperBound: '0.5',
          paperAllocationSizing: expect.objectContaining({
            executionMode: ExecutionMode.FULL_AUTO,
            confidenceTier: 'BASE',
            minimumExecutableLot: '0.2',
          }),
        }),
      );
      expect(allocationMock.resolveOrAllocate).toHaveBeenCalledWith(
        expect.objectContaining({
          executionMode: ExecutionMode.FULL_AUTO,
          enforceConcentrationCaps: false,
        }),
      );
      expect(riskService.validateProposedTrade).toHaveBeenCalled();
      expect(executionService.executeTrade).toHaveBeenCalled();
    });

    it('keeps the promoted multi-model tuple fail-closed on a LIVE broker account', async () => {
      (executionService.getActiveSession as jest.Mock).mockResolvedValue({
        ...activeSession(),
        executionMode: ExecutionMode.FULL_AUTO,
      });
      (brokerService.findConnectionById as jest.Mock).mockResolvedValue({
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'ctrader',
        accountType: BrokerMode.LIVE,
        authorizationStatus: 'ACTIVE',
        demoValidated: false,
        liveTradingEnabled: true,
        logicalAccountKey: 'ctrader::live::acct-1',
      });

      const result = await service.processSignal(
        validCandidate({
          confidenceScore: 0.72,
          timeframe: 'M1',
          strategyCode: 'external-irexpro-multimodel-ensemble',
          modelVersion: 'external-provider/irexpro-multimodel-ensemble-v1/demo-v1',
          suggestedVolume: 0.5,
          metadata: {
            signal_source: 'EXTERNAL_PROVIDER',
            external_provider_code: 'irexpro-multimodel-ensemble-v1',
            external_provider_paper_only: true,
            position_sizing_tier: 'BASE',
            production_eligible: false,
            primary_engine_code: 'irexpro-multimodel-ensemble-v1',
            multimodel_execution_authority: 'DEMO_FULL_AUTO_PROMOTED',
          },
        }),
      );

      expect(result.outcome).toBe('SIGNAL_INVALID');
      expect(result.reason).toContain('DEMO');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('rejects an external provider signal on a real-provider DEMO connection', async () => {
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

      const result = await service.processSignal(externalCandidate());

      expect(result.outcome).toBe('SIGNAL_INVALID');
      expect(result.reason).toContain('paper-broker');
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

    it('maps adaptive DISLOCATED state into the conservative risk-engine regime vocabulary', async () => {
      await service.processSignal(validCandidate({ marketRegime: 'DISLOCATED' }));

      expect(riskService.validateProposedTrade).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          signalId: 'sig-001',
          regime: 'HIGH_VOLATILITY',
        }),
      );
    });

    it.each([
      ['TREND_HEALTHY', 'TRENDING'],
      ['TREND_EXTENDED', 'TRENDING'],
      ['TREND_WEAK', 'TRENDING'],
      ['RANGE', 'RANGING'],
      ['TRANSITION', 'HIGH_VOLATILITY'],
      ['REVERSAL', 'HIGH_VOLATILITY'],
      ['HIGH_VOLATILITY', 'HIGH_VOLATILITY'],
      ['DISLOCATED', 'HIGH_VOLATILITY'],
      ['ROLLOVER_RISK', 'LOW_LIQUIDITY'],
      ['UNKNOWN', undefined],
    ] as const)(
      'maps adaptive market state %s to risk regime %s',
      async (marketRegime, expectedRegime) => {
        await service.processSignal(validCandidate({ marketRegime }));

        expect(riskService.validateProposedTrade).toHaveBeenCalledWith(
          'user-1',
          expect.objectContaining({ regime: expectedRegime }),
        );
      },
    );

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

    it('rejects (fail-closed) when RiskService throws an error and terminalizes the durable intent', async () => {
      (riskService.validateProposedTrade as jest.Mock).mockRejectedValue(
        new Error('Risk Engine crash'),
      );
      const result = await service.processSignal(validCandidate());
      expect(result.outcome).toBe('RISK_REJECTED');
      expect(tradeIntentMock.markRejected).toHaveBeenCalledWith('intent-sig-001');
      expect(allocationMock.releaseAllocationForIntent).toHaveBeenCalledWith(
        'intent-sig-001',
        'RISK_ENGINE_ERROR',
      );
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
        executionMode: ExecutionMode;
      };
      // The REAL per-account scope captured on the durable intent at creation.
      expect(call.logicalAccountKey).toBe('paper-broker::demo::acct-1');
      expect(call.intent.logicalAccountKey).toBe('paper-broker::demo::acct-1');
      expect(call.executionMode).toBe(ExecutionMode.PAPER_ONLY);
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

    it('treats a model suggested entry as provenance while the executable signal remains MARKET', async () => {
      const result = await service.processSignal(
        validCandidate({
          suggestedEntryPrice: 1.0845,
          suggestedStopLoss: 1.075,
          suggestedTakeProfit: 1.095,
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          entryType: 'MARKET',
          requestedEntryPrice: null,
        }),
      );
      expect(riskService.validateProposedTrade).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ entryPrice: '0' }),
      );
      expect(tradeIntentMock.recordOrReuseIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedEntryPrice: null,
          metadata: expect.objectContaining({
            execution_entry_type: 'MARKET',
            signal_suggested_entry_price: 1.0845,
          }),
        }),
      );
    });

    it('enforces the 0.20 PAPER product floor through authoritative sizing', async () => {
      const result = await service.processSignal(
        validCandidate({
          metadata: {
            external_provider_paper_only: true,
            position_sizing_tier: 'VERY_STRONG',
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(allocationMock.getUserCapitalAllocationState).toHaveBeenCalledWith('user-1', 'conn-1');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          paperAllocationSizing: {
            executionMode: ExecutionMode.PAPER_ONLY,
            allocatedCapital: '1000',
            confidenceTier: 'VERY_STRONG',
            sessionPeakEquity: '10000.00',
            minimumExecutableLot: '0.2',
          },
        }),
      );
    });

    it('passes the 0.10 PAPER floor only for an explicitly eligible opportunity scout', async () => {
      const result = await service.processSignal(
        validCandidate({
          suggestedVolume: 0.1,
          metadata: {
            external_provider_paper_only: true,
            position_sizing_tier: 'RESEARCH',
            paper_opportunity_scout_eligible: true,
            paper_opportunity_scout_reason: 'OPPORTUNITY_SCOUT',
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedLotUpperBound: '0.1',
          paperAllocationSizing: expect.objectContaining({
            confidenceTier: 'RESEARCH',
            minimumExecutableLot: '0.1',
          }),
        }),
      );
    });

    it('passes the 0.10 PAPER floor for an evidence-qualified M1 tactical scout', async () => {
      const result = await service.processSignal(
        validCandidate({
          signalId: 'sig-m1-scout',
          timeframe: 'M1',
          strategyCode: 'external-irexpro-m1-tactical',
          suggestedVolume: 0.1,
          metadata: {
            external_provider_paper_only: true,
            position_sizing_tier: 'RESEARCH',
            m1_evidence_qualified_scout_eligible: true,
            m1_tactical_route: 'M1_EARLY_TRANSITION',
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedLotUpperBound: '0.1',
          paperAllocationSizing: expect.objectContaining({
            confidenceTier: 'RESEARCH',
            minimumExecutableLot: '0.1',
          }),
        }),
      );
    });

    it('passes a 0.05 PAPER floor for an explicitly provisional M1 tactical scout', async () => {
      const result = await service.processSignal(
        validCandidate({
          signalId: 'sig-m1-provisional-scout',
          timeframe: 'M1',
          strategyCode: 'external-irexpro-m1-tactical',
          suggestedVolume: 0.05,
          metadata: {
            external_provider_paper_only: true,
            position_sizing_tier: 'RESEARCH',
            m1_evidence_qualified_scout_eligible: true,
            m1_tactical_route: 'M1_EARLY_TRANSITION',
            m1_scout_reliability_tier: 'PROVISIONAL',
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedLotUpperBound: '0.05',
          paperAllocationSizing: expect.objectContaining({
            confidenceTier: 'RESEARCH',
            minimumExecutableLot: '0.05',
          }),
        }),
      );
    });

    it('does not honor the M1 scout flag on the wrong timeframe', async () => {
      const result = await service.processSignal(
        validCandidate({
          signalId: 'sig-forged-m1-timeframe',
          timeframe: 'M5',
          strategyCode: 'external-irexpro-m1-tactical',
          suggestedVolume: 0.2,
          metadata: {
            external_provider_paper_only: true,
            position_sizing_tier: 'RESEARCH',
            m1_evidence_qualified_scout_eligible: true,
            m1_tactical_route: 'M1_EARLY_TRANSITION',
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          paperAllocationSizing: expect.objectContaining({ minimumExecutableLot: '0.2' }),
        }),
      );
    });

    it('does not honor the M1 scout flag for another strategy', async () => {
      const result = await service.processSignal(
        validCandidate({
          signalId: 'sig-forged-m1-strategy',
          timeframe: 'M1',
          strategyCode: 'external-other-strategy',
          suggestedVolume: 0.2,
          metadata: {
            external_provider_paper_only: true,
            position_sizing_tier: 'RESEARCH',
            m1_evidence_qualified_scout_eligible: true,
            m1_tactical_route: 'M1_EARLY_TRANSITION',
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          paperAllocationSizing: expect.objectContaining({ minimumExecutableLot: '0.2' }),
        }),
      );
    });

    it('marks the durable TradeIntent REJECTED when sizing fails closed', async () => {
      const sizingError = Object.assign(
        new Error('risk-budget volume 0.19000000 is below the PAPER policy minimum 0.2'),
        { code: 'POSITION_SIZE_BELOW_POLICY_MINIMUM' },
      );
      sizingMock.sizePosition.mockRejectedValueOnce(sizingError);

      const result = await service.processSignal(validCandidate());

      expect(result).toMatchObject({
        outcome: 'EXECUTION_FAILED',
        signalId: 'sig-001',
      });
      expect(result.reason).toContain('POSITION_SIZE_BELOW_POLICY_MINIMUM');
      expect(tradeIntentMock.markRejected).toHaveBeenCalledTimes(1);
      expect(tradeIntentMock.markRejected).toHaveBeenCalledWith('intent-sig-001');
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('passes adaptive PAPER risk multiplier into authoritative sizing', async () => {
      const result = await service.processSignal(
        validCandidate({
          metadata: {
            external_provider_paper_only: true,
            position_sizing_tier: 'BASE',
            adaptive_risk_multiplier: 1.25,
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          paperAllocationSizing: expect.objectContaining({
            adaptiveRiskMultiplier: '1.25',
          }),
        }),
      );
    });

    it('carries PAPER MARKET reference geometry through sizing and risk', async () => {
      sizingMock.sizePosition.mockResolvedValue({
        lots: '0.39',
        allocatedCapital: '436.00',
        accountCurrency: 'USD',
        entryPrice: '1.10010',
        inputs: {
          accountCurrency: 'USD',
          equity: '10000',
          allocationAwarePaper: true,
          riskReferenceEntryPrice: '1.1',
        },
      });

      const result = await service.processSignal(
        validCandidate({
          direction: 'SELL',
          suggestedEntryPrice: 1.1,
          suggestedStopLoss: 1.10051,
          suggestedTakeProfit: 1.09949,
          metadata: {
            external_provider_paper_only: true,
            position_sizing_tier: 'BASE',
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(sizingMock.sizePosition).toHaveBeenCalledWith(
        expect.objectContaining({
          paperAllocationSizing: expect.objectContaining({
            marketReferenceEntryPrice: '1.1',
          }),
        }),
      );
      expect(riskService.validateProposedTrade).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          allocationAwarePaperSizing: true,
          paperMarketReferenceEntryPrice: '1.1',
        }),
      );
    });

    it('carries allocation-aware PAPER sizing provenance into the Risk Engine', async () => {
      sizingMock.sizePosition.mockResolvedValue({
        lots: '0.20',
        allocatedCapital: '200.00',
        accountCurrency: 'USD',
        entryPrice: '1.08500',
        inputs: {
          accountCurrency: 'USD',
          equity: '10000',
          allocationAwarePaper: true,
        },
      });

      const result = await service.processSignal(
        validCandidate({
          metadata: {
            external_provider_paper_only: true,
            position_sizing_tier: 'BASE',
          },
        }),
      );

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(riskService.validateProposedTrade).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          requestedLotSize: '0.20',
          allocationAwarePaperSizing: true,
        }),
      );
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
      expect(allocationMock.getUserCapitalAllocationState).not.toHaveBeenCalled();
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

    it('duplicate with NO trade and NO durable intent resumes the exact pre-intent retry without a second provider dispatch path', async () => {
      deliverAsDuplicate();
      (executionService.findTradeBySignalId as jest.Mock).mockResolvedValue(null);
      tradeIntentMock.findBySignal.mockResolvedValue(null);

      const result = await service.processSignal(validCandidate());

      expect(result.outcome).toBe('EXECUTION_SUCCEEDED');
      expect(tradeIntentMock.findBySignal).toHaveBeenCalledWith('user-1', 'sig-001');
      expect(tradeIntentMock.recordOrReuseIntent).toHaveBeenCalledTimes(1);
      expect(riskService.validateProposedTrade).toHaveBeenCalledTimes(1);
      expect(executionService.executeTrade).toHaveBeenCalledTimes(1);
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
