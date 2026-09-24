import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RiskService } from './risk.service';
import { RiskProfile } from './entities/risk-profile.entity';
import { RiskViolation } from './entities/risk-violation.entity';
import { TradingSession } from '../execution/entities/trading-session.entity';
import { TradingAuthorityGeneration } from '../users/entities/trading-authority-generation.entity';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import { ExecutionSessionResolutionService } from '../execution/execution-session.resolution';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { RiskGrantService } from './risk-grant.service';
import { RiskOrderGeometryService } from './risk-order-geometry.service';
import { ExactDecimal } from '../../common/utils/exact-decimal';
import { ProposedTrade, RiskRejectionCode } from './interfaces/risk.interface';
import { DomainEventBus } from '../events/event-bus.service';
import { AllowedTradingMode } from './entities/risk-profile.entity';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { SharedControlRevisionService } from '../execution-authority/shared-control-revision.service';
import { GrantInvalidationService } from '../execution-authority/grant-invalidation.service';
import { DailyRiskPeriodService } from '../execution/services/daily-risk-period.service';
import { BrokerAccountSnapshotService } from '../broker/services/broker-account-snapshot.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const validTrade = (overrides: Partial<ProposedTrade> = {}): ProposedTrade => ({
  signalId: 'sig-s32-001',
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedLotSize: '0.05',
  entryPrice: '1.08500',
  stopLoss: '1.07500',
  takeProfit: '1.09500',
  idempotencyKey: 'idem-s32',
  volatilityScore: 0.4,
  regime: 'TRENDING',
  sessionId: 'session-1',
  sessionGeneration: 1,
  executionMode: ExecutionMode.PAPER_ONLY,
  brokerConnectionId: 'conn-1',
  generatedAt: new Date(),
  ...overrides,
});

const defaultProfile = (): Partial<RiskProfile> => ({
  id: 'profile-1',
  userId: 'user-1',
  killSwitchActive: false,
  killSwitchReason: null,
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
});

const defaultSession = (overrides: Partial<TradingSession> = {}): TradingSession =>
  ({
    id: 'session-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    executionMode: ExecutionMode.PAPER_ONLY,
    authorityGeneration: 1,
    status: 'ACTIVE',
    openingBalance: '10000.00',
    peakEquity: '10000.00',
    riskProfileSnapshot: null,
    startedAt: new Date(),
    endedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as TradingSession;

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockProfileRepo = () => ({
  findOne: jest.fn().mockResolvedValue(defaultProfile()),
  create: jest.fn().mockImplementation((obj) => ({ ...defaultProfile(), ...obj })),
  save: jest.fn().mockImplementation(async (obj) => obj),
  find: jest.fn().mockResolvedValue([]),
});

const mockViolationRepo = () => ({
  create: jest.fn().mockImplementation((obj) => obj),
  save: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockResolvedValue([]),
});

const mockSessionRepo = () => ({
  findOne: jest.fn().mockResolvedValue(defaultSession()),
  create: jest.fn().mockImplementation((obj) => obj),
  save: jest.fn().mockImplementation(async (obj) => obj),
  createQueryBuilder: jest.fn().mockReturnValue({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  }),
});

const mockAuthorityGenerationRepo = () => ({
  findOne: jest.fn().mockResolvedValue(null),
});

const mockBrokerService = () => ({
  hasActiveConnection: jest.fn().mockResolvedValue(true),
  findConnectionById: jest.fn().mockResolvedValue({
    id: 'conn-1',
    userId: 'user-1',
    brokerId: 'metatrader5',
    accountType: 'DEMO',
    status: 'CONNECTED',
    authorizationStatus: 'ACTIVE',
    providerBrokerIdentity: null,
    credentialGeneration: 0,
    logicalAccountKey: 'metatrader5|MetaQuotes-Demo|12345',
  }),
  // Sprint 50 — LIVE authorization gate (mocked permissive)
  isConnectionExecutable: jest.fn().mockReturnValue(true),
  getBrokerAccountState: jest.fn().mockResolvedValue({
    balance: '10000.00',
    equity: '10050.00',
    freeMargin: '9800.00',
    currency: 'USD',
  }),
  getRequiredMargin: jest.fn().mockResolvedValue('100.00'),
});

// Sprint 50 — emergency control plane mock (default: execution allowed)
const mockExecutionControlService = () => ({
  checkExecutionPermission: jest.fn().mockResolvedValue({ allowed: true }),
  assertExecutionAllowed: jest.fn().mockResolvedValue(undefined),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const mockExecutionService = () => ({
  countOpenTrades: jest.fn().mockResolvedValue(0),
  countTodayTrades: jest.fn().mockResolvedValue(0),
  getTodayRealisedLoss: jest.fn().mockResolvedValue(0),
  findTradeBySignalId: jest.fn().mockResolvedValue(null),
  reserveDailyTradeSlot: jest.fn().mockResolvedValue({ allowed: true, currentCount: 0 }),
});

const mockSessionResolution = () => ({
  resolveActiveSessionAuthority: jest.fn().mockResolvedValue({
    sessionId: 'session-1',
    sessionGeneration: 1,
    executionMode: ExecutionMode.PAPER_ONLY,
    brokerConnectionId: 'conn-1',
  }),
});

const mockRiskGrantService = () => ({
  issueGrant: jest.fn().mockResolvedValue({
    grant: { id: 'grant-s32-1', expiresAt: new Date(Date.now() + 60_000) },
    reused: false,
  }),
  consumeGrantAtomic: jest.fn(),
  invalidateGrantsForSession: jest.fn().mockResolvedValue(0),
});

const mockOrderGeometry = () => ({
  resolveOrderGeometry: jest.fn().mockResolvedValue({
    contractSize: ExactDecimal.parse('100000'),
    freshQuote: null,
    quoteRef: null,
  }),
});

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('RiskService — Sprint 32 Production Hardening', () => {
  let service: RiskService;
  let executionService: ReturnType<typeof mockExecutionService>;
  let brokerService: ReturnType<typeof mockBrokerService>;

  beforeEach(async () => {
    executionService = mockExecutionService();
    brokerService = mockBrokerService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiskService,
        { provide: getRepositoryToken(RiskProfile), useValue: mockProfileRepo() },
        { provide: getRepositoryToken(RiskViolation), useValue: mockViolationRepo() },
        { provide: getRepositoryToken(TradingSession), useValue: mockSessionRepo() },
        {
          provide: getRepositoryToken(TradingAuthorityGeneration),
          useValue: mockAuthorityGenerationRepo(),
        },
        { provide: BrokerService, useValue: brokerService },
        { provide: AuditService, useValue: mockAuditService() },
        { provide: ExecutionService, useValue: executionService },
        { provide: ExecutionControlService, useValue: mockExecutionControlService() },
        { provide: ExecutionSessionResolutionService, useValue: mockSessionResolution() },
        { provide: RiskGrantService, useValue: mockRiskGrantService() },
        { provide: RiskOrderGeometryService, useValue: mockOrderGeometry() },
        { provide: DomainEventBus, useValue: { publish: jest.fn() } },
        { provide: Logger, useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } },
        // ── Round 6: the unified execution-authority seams (leaf mocks) ──────
        {
          provide: TradingAuthorityService,
          useValue: {
            getCurrentGeneration: jest.fn().mockResolvedValue(1),
            bumpGeneration: jest.fn().mockResolvedValue(2),
          },
        },
        {
          provide: SharedControlRevisionService,
          useValue: {
            getCurrentTradingPolicyRevision: jest.fn().mockResolvedValue(1),
            getCurrentProviderVerificationRevision: jest.fn().mockResolvedValue(1),
            getCurrentExecutionControlRevision: jest.fn().mockResolvedValue(1),
          },
        },
        {
          provide: DailyRiskPeriodService,
          useValue: {
            getTodayRealisedLossExact: jest.fn().mockResolvedValue({ total: '0', complete: true }),
          },
        },
        {
          provide: GrantInvalidationService,
          useValue: {
            invalidateUserNewExposureAuthority: jest
              .fn()
              .mockResolvedValue({ invalidatedGrants: 0, revokedConfirmations: 0 }),
          },
        },
        { provide: BrokerAccountSnapshotService, useValue: {} },
        { provide: ModuleRef, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get(RiskService);
  });

  // ── Part C: Daily trade count is not a risk throttle ────────────────────────

  describe('Step 4b — Unbounded daily trade count', () => {
    it('does not query or enforce a daily trade-count cap', async () => {
      executionService.countTodayTrades.mockRejectedValue(
        new Error('legacy count path must not be consulted'),
      );

      const decision = await service.validateProposedTrade('user-1', validTrade());

      expect(decision.decision).toBe('APPROVED');
      expect(executionService.countTodayTrades).not.toHaveBeenCalled();
      if (decision.decision === 'APPROVED') {
        expect(decision.appliedRules).toContain('DAILY_TRADE_COUNT:UNBOUNDED');
      }
    });
  });

  // ── Part D: Margin / account capacity ─────────────────────────────────────

  describe('Step 3c — Margin / account capacity', () => {
    it('approves when required margin is within available freeMargin', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });
      // Mock required margin is 100.00 (from mockBrokerService default)
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('APPROVED');
    });

    it('margin EXACT boundary: requiredMargin == freeMargin PASSES (equality is enough)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '100.00',
        currency: 'USD',
      });
      brokerService.getRequiredMargin.mockResolvedValue('100.00');
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('APPROVED');
    });

    it('rejects with INSUFFICIENT_MARGIN when freeMargin is negative', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '-200.00',
        currency: 'USD',
      });
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        // Sprint 32 Gate 2: the new capability-aware check compares required
        // margin vs free margin. Required margin (100.00) > free margin (-200.00).
        expect(decision.rejectionReason).toContain('exceeds');
      }
    });

    it('rejects with INSUFFICIENT_MARGIN when freeMargin is malformed (NaN)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: 'not-a-number',
        currency: 'USD',
      });
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('malformed');
      }
    });

    it('rejects with INSUFFICIENT_MARGIN when freeMargin is zero and order requires margin', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '0',
        currency: 'USD',
      });
      const decision = await service.validateProposedTrade('user-1', validTrade());
      // Sprint 32 Gate 2: with zero free margin, any required margin > 0
      // exceeds the available capacity → reject.
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('exceeds');
      }
    });

    // ── Sprint 32 Gate 4: explicit named tests for ALL fail-closed cases ──

    it('LIVE fail-closed: accountInfo missing/null (typed ACCOUNT_STATE_UNAVAILABLE)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue(null);
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.ACCOUNT_STATE_UNAVAILABLE);
        expect(decision.rejectionReason).toContain('unavailable');
      }
    });

    it('LIVE fail-closed: freeMargin null', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: null as unknown as string,
        currency: 'USD',
      });
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('unavailable');
      }
    });

    it('LIVE fail-closed: freeMargin NaN', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: 'not-a-number',
        currency: 'USD',
      });
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('malformed');
      }
    });

    it('LIVE fail-closed: freeMargin Infinity/non-finite', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: 'Infinity',
        currency: 'USD',
      });
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('malformed');
      }
    });

    it('LIVE fail-closed: MetaAPI calculateMargin returns null', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });
      brokerService.getRequiredMargin.mockResolvedValue(null);
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('unavailable');
      }
    });

    it('LIVE fail-closed: MetaAPI calculateMargin returns malformed result', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });
      brokerService.getRequiredMargin.mockResolvedValue('not-a-number');
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('malformed');
      }
    });

    it('LIVE fail-closed: MetaAPI calculateMargin provider error (throws)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });
      brokerService.getRequiredMargin.mockRejectedValue(new Error('MetaAPI timeout'));
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('adapter error');
      }
    });

    it('LIVE fail-closed: no broker connection for margin calculation', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });
      // getRequiredMargin returns null because the connection lookup fails
      // (the broker connection check at Step 1b passes, but the margin
      // calculation path cannot find the connection — simulated by having
      // getRequiredMargin return null, which is the CAPABILITY_UNAVAILABLE case)
      brokerService.getRequiredMargin.mockResolvedValue(null);
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('unavailable');
      }
    });

    it('LIVE: required margin > free margin → INSUFFICIENT_MARGIN', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '50.00', // less than required 100.00
        currency: 'USD',
      });
      brokerService.getRequiredMargin.mockResolvedValue('100.00');
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('exceeds');
      }
    });

    it('LIVE: sufficient margin → APPROVED', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '9800.00', // more than required 100.00
        currency: 'USD',
      });
      brokerService.getRequiredMargin.mockResolvedValue('100.00');
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('APPROVED');
    });

    it('PAPER: deterministic paper margin calculation works (approves)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });
      brokerService.getRequiredMargin.mockResolvedValue('100.00');
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('APPROVED');
    });

    it('PAPER: insufficient simulated margin rejects', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '50.00',
        currency: 'USD',
      });
      brokerService.getRequiredMargin.mockResolvedValue('200.00');
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
      }
    });

    it('PAPER: malformed simulation data rejects', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: 'bad-data',
        currency: 'USD',
      });
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.INSUFFICIENT_MARGIN);
        expect(decision.rejectionReason).toContain('malformed');
      }
    });
  });

  // ── Part A: Idempotency (Risk layer) ──────────────────────────────────────

  describe('Step 7 — Duplicate signal prevention', () => {
    it('rejects with DUPLICATE_SIGNAL when a trade already exists for the signalId', async () => {
      executionService.findTradeBySignalId.mockResolvedValue({
        id: 'trade-existing',
        status: 'OPEN',
      });
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.DUPLICATE_SIGNAL);
        expect(decision.rejectionReason).toContain('sig-s32-001');
      }
    });

    it('approves when no existing trade for the signalId', async () => {
      executionService.findTradeBySignalId.mockResolvedValue(null);
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('APPROVED');
    });

    it('fails closed with RISK_ENGINE_ERROR when findTradeBySignalId throws', async () => {
      executionService.findTradeBySignalId.mockRejectedValue(new Error('DB error'));
      const decision = await service.validateProposedTrade('user-1', validTrade());
      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.RISK_ENGINE_ERROR);
        expect(decision.rejectionReason).toContain('idempotency');
      }
    });
  });

  // ── Part B: Risk profile snapshot ──────────────────────────────────────────

  describe('createRiskProfileSnapshot', () => {
    it('returns a JSON object with risk-relevant fields', () => {
      const profile = defaultProfile() as RiskProfile;
      const snapshot = service.createRiskProfileSnapshot(profile);
      expect(snapshot).toEqual(
        expect.objectContaining({
          maxDailyLossPercent: '5.00',
          maxDrawdownPercent: '10.00',
          maxOpenTrades: 3,
          maxDailyTrades: 10,
          maxPositionSizeLot: '0.10',
          minStopLossPips: '5.00',
          maxVolatilityScore: '0.85',
          rejectLowLiquidity: true,
          maxTradeRiskPercent: '2.00',
          maxLeverageAllowed: 30,
          allowedTradingModes: AllowedTradingMode.PAPER_ONLY,
          killSwitchActive: false,
          snapshotVersion: 1,
        }),
      );
    });

    it('does NOT include credentials, tokens, or secrets', () => {
      const profile = defaultProfile() as RiskProfile;
      const snapshot = service.createRiskProfileSnapshot(profile);
      const snapshotStr = JSON.stringify(snapshot);
      // Must not contain credential-related fields
      expect(snapshotStr).not.toMatch(
        /password|secret|token|apiKey|apiSecret|credential|encrypted/i,
      );
    });

    it('does NOT include the profile internal id or userId (those are on the session)', () => {
      const profile = defaultProfile() as RiskProfile;
      const snapshot = service.createRiskProfileSnapshot(profile);
      expect(snapshot).not.toHaveProperty('id');
      expect(snapshot).not.toHaveProperty('userId');
    });

    it('is deterministic — same profile produces the same fields (except timestamp)', () => {
      const profile = defaultProfile() as RiskProfile;
      const snapshot1 = service.createRiskProfileSnapshot(profile);
      const snapshot2 = service.createRiskProfileSnapshot(profile);
      // All fields except snapshotCreatedAt should match
      const { snapshotCreatedAt: _ignored1, ...rest1 } = snapshot1;
      const { snapshotCreatedAt: _ignored2, ...rest2 } = snapshot2;
      void _ignored1;
      void _ignored2;
      expect(rest1).toEqual(rest2);
    });
  });
});
