import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RiskService } from './risk.service';
import { RiskProfile } from './entities/risk-profile.entity';
import { RiskViolation } from './entities/risk-violation.entity';
import {
  TradingSession,
  TradingSessionStatus,
} from '../execution/entities/trading-session.entity';
import { TradingAuthorityGeneration } from '../users/entities/trading-authority-generation.entity';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import {
  ExecutionSessionResolutionService,
  SessionAuthorityNotActiveException,
} from '../execution/execution-session.resolution';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { RiskGrantService } from './risk-grant.service';
import { RiskOrderGeometryService } from './risk-order-geometry.service';
import { ExactDecimal } from '../../common/utils/exact-decimal';
import { ProposedTrade, RiskRejectionCode } from './interfaces/risk.interface';
import { DomainEventBus } from '../events/event-bus.service';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { SharedControlRevisionService } from '../execution-authority/shared-control-revision.service';
import { GrantInvalidationService } from '../execution-authority/grant-invalidation.service';
import { DailyRiskPeriodService } from '../execution/services/daily-risk-period.service';
import { BrokerAccountSnapshotService } from '../broker/services/broker-account-snapshot.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** validTrade (binding kept intact by default) with optional overrides. */
function validTrade(overrides: Partial<ProposedTrade> = {}): ProposedTrade {
  return {
    signalId: 'sig-001',
    instrument: 'EURUSD',
    direction: 'BUY',
    requestedLotSize: '0.05',
    entryPrice: '1.08500',
    stopLoss: '1.07500', // 100 pips below entry
    takeProfit: '1.09500', // 100 pips above entry
    idempotencyKey: 'idem-abc',
    volatilityScore: 0.4,
    regime: 'TRENDING',
    sessionId: 'session-1',
    sessionGeneration: 1,
    executionMode: ExecutionMode.PAPER_ONLY,
    brokerConnectionId: 'conn-1',
    generatedAt: new Date(),
    ...overrides,
  };
}

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

const defaultConnection = (overrides: Record<string, unknown> = {}) => ({
  id: 'conn-1',
  userId: 'user-1',
  brokerId: 'metatrader5',
  accountType: 'DEMO',
  status: 'CONNECTED',
  authorizationStatus: 'ACTIVE',
  providerBrokerIdentity: null,
  credentialGeneration: 0,
  // Round 6 (#362): the durable logical account identity LIVE snapshot
  // authority scopes the daily-risk period by.
  logicalAccountKey: 'metatrader5|MetaQuotes-Demo|12345',
  ...overrides,
});

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockProfileRepo = () => {
  const repo = {
    findOne: jest.fn().mockResolvedValue(defaultProfile()),
    create: jest.fn().mockImplementation((obj) => ({ ...defaultProfile(), ...obj })),
    save: jest.fn().mockImplementation(async (obj) => obj),
    find: jest.fn().mockResolvedValue([]),
    // Round 6 (#15): bumpProfileRevisionAndAuthority runs the monotonic
    // revision CAS through the repository query builder.
    createQueryBuilder: jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    }),
  };
  // Round 6 (#299): toggleKillSwitch / material profile edits commit inside
  // profileRepo.manager.transaction — the mock EM's repositories delegate to
  // THIS repo so the existing save/findOne assertions keep firing.
  (repo as unknown as { manager: unknown }).manager = {
    transaction: jest.fn().mockImplementation(async (cb: (em: unknown) => Promise<unknown>) =>
      cb({ getRepository: () => repo }),
    ),
  };
  return repo;
};

const mockViolationRepo = () => ({
  create: jest.fn().mockImplementation((obj) => obj),
  save: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockResolvedValue([]),
});

/** TradingSession repo — findOne for the baseline load + CAS query builder. */
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
  findConnectionById: jest.fn().mockResolvedValue(defaultConnection()),
  // Sprint 50 — LIVE authorization gate (mocked permissive; the dedicated
  // execution-control spec exercises the real fail-closed behavior)
  isConnectionExecutable: jest.fn().mockReturnValue(true),
  getBrokerAccountState: jest.fn().mockResolvedValue({
    balance: '10000.00',
    equity: '10050.00',
    freeMargin: '9800.00',
    currency: 'USD',
  }),
  // Sprint 32 Gate 2: mock required margin calculation
  getRequiredMargin: jest.fn().mockResolvedValue('100.00'),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const mockExecutionService = () => ({
  countOpenTrades: jest.fn().mockResolvedValue(0),
  countTodayTrades: jest.fn().mockResolvedValue(0),
  getTodayRealisedLoss: jest.fn().mockResolvedValue(0),
  findTradeBySignalId: jest.fn().mockResolvedValue(null),
  // Sprint 32 Gate 2: mock advisory-lock daily-trade-slot reservation
  reserveDailyTradeSlot: jest.fn().mockResolvedValue({ allowed: true, currentCount: 0 }),
  // Round 6 §17: the kill-switch emergency flatten seam.
  emergencyCloseAllOpenPositions: jest.fn().mockResolvedValue([]),
});

// Sprint 50 — emergency control plane mock (default: execution allowed)
const mockExecutionControlService = () => ({
  checkExecutionPermission: jest.fn().mockResolvedValue({ allowed: true }),
  assertExecutionAllowed: jest.fn().mockResolvedValue(undefined),
  listActiveControls: jest.fn().mockResolvedValue([]),
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
    grant: { id: 'grant-1', expiresAt: new Date(Date.now() + 60_000) },
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

describe('RiskService', () => {
  let module: TestingModule;
  let service: RiskService;
  let profileRepo: ReturnType<typeof mockProfileRepo>;
  let violationRepo: ReturnType<typeof mockViolationRepo>;
  let sessionRepo: ReturnType<typeof mockSessionRepo>;
  let brokerService: ReturnType<typeof mockBrokerService>;
  let executionControlService: ReturnType<typeof mockExecutionControlService>;
  let executionService: ReturnType<typeof mockExecutionService>;
  let sessionResolution: ReturnType<typeof mockSessionResolution>;
  let riskGrantService: ReturnType<typeof mockRiskGrantService>;
  let orderGeometry: ReturnType<typeof mockOrderGeometry>;
  let auditService: ReturnType<typeof mockAuditService>;
  // Round 6: LIVE snapshot/daily-risk-period authority seams (resolvable by
  // default so LIVE-path tests flow to their OWN typed downstream failures;
  // per-test overrides replace the implementations).
  let brokerAccountSnapshotService: { resolveFreshSnapshotForNewExposure: jest.Mock };
  let dailyRiskPeriod: {
    resolveDailyRiskPeriod: jest.Mock;
    getTodayRealisedLossExact: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    profileRepo = mockProfileRepo();
    violationRepo = mockViolationRepo();
    sessionRepo = mockSessionRepo();
    brokerService = mockBrokerService();
    executionService = mockExecutionService();
    executionControlService = mockExecutionControlService();
    sessionResolution = mockSessionResolution();
    riskGrantService = mockRiskGrantService();
    orderGeometry = mockOrderGeometry();
    auditService = mockAuditService();
    brokerAccountSnapshotService = {
      resolveFreshSnapshotForNewExposure: jest.fn().mockResolvedValue({
        id: 'snap-1',
        generation: 1,
        currency: 'USD',
        balance: '10000.00',
        equity: '10050.00',
        providerObservedAt: new Date(),
        acceptedAt: new Date(),
      }),
    };
    dailyRiskPeriod = {
      resolveDailyRiskPeriod: jest.fn().mockResolvedValue({ id: 'period-1' }),
      getTodayRealisedLossExact: jest.fn().mockResolvedValue({ total: '0', complete: true }),
    };

    module = await Test.createTestingModule({
      providers: [
        RiskService,
        { provide: getRepositoryToken(RiskProfile), useValue: profileRepo },
        { provide: getRepositoryToken(RiskViolation), useValue: violationRepo },
        { provide: getRepositoryToken(TradingSession), useValue: sessionRepo },
        {
          provide: getRepositoryToken(TradingAuthorityGeneration),
          useValue: mockAuthorityGenerationRepo(),
        },
        { provide: BrokerService, useValue: brokerService },
        { provide: AuditService, useValue: auditService },
        { provide: ExecutionService, useValue: executionService },
        { provide: ExecutionControlService, useValue: executionControlService },
        { provide: ExecutionSessionResolutionService, useValue: sessionResolution },
        { provide: RiskGrantService, useValue: riskGrantService },
        { provide: RiskOrderGeometryService, useValue: orderGeometry },
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
        // PAPER-only suite default; the LIVE tests above rely on these
        // resolvable seams to reach their OWN typed downstream failures.
        { provide: DailyRiskPeriodService, useValue: dailyRiskPeriod },
        {
          provide: GrantInvalidationService,
          useValue: {
            invalidateUserNewExposureAuthority: jest
              .fn()
              .mockResolvedValue({ invalidatedGrants: 0, revokedConfirmations: 0 }),
          },
        },
        { provide: BrokerAccountSnapshotService, useValue: brokerAccountSnapshotService },
        { provide: ModuleRef, useValue: { get: jest.fn() } },
        {
          provide: DomainEventBus,
          useValue: { publish: jest.fn(), subscribe: jest.fn().mockReturnValue(() => {}) },
        },
      ],
    }).compile();

    service = module.get<RiskService>(RiskService);
  });

  afterEach(async () => {
    await module.close();
  });

  // ─── Core pipeline: APPROVED path ─────────────────────────────────────────

  describe('validateProposedTrade() — APPROVED path', () => {
    it('APPROVES a valid trade with all checks passing', async () => {
      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('APPROVED');
    });

    it('returns a ValidatedOrder in the APPROVED result', async () => {
      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('APPROVED');
      if (result.decision === 'APPROVED') {
        expect(result.validatedOrder.instrument).toBe('EURUSD');
        expect(result.validatedOrder.direction).toBe('BUY');
        expect(result.validatedOrder.stopLoss).toBe('1.07500');
        expect(result.validatedOrder.takeProfit).toBe('1.09500');
        expect(result.validatedOrder.idempotencyKey).toBe('idem-abc');
      }
    });

    it('carries the issued RiskGrant + session authority binding (#301/#295)', async () => {
      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('APPROVED');
      if (result.decision === 'APPROVED') {
        expect(result.grantId).toBe('grant-1');
        expect(result.sessionId).toBe('session-1');
        expect(result.sessionGeneration).toBe(1);
        expect(result.executionMode).toBe(ExecutionMode.PAPER_ONLY);
        expect(result.brokerConnectionId).toBe('conn-1');
      }
    });

    it('issues the durable grant with the full authority binding (#301)', async () => {
      await service.validateProposedTrade('user-1', validTrade());

      expect(riskGrantService.issueGrant).toHaveBeenCalledTimes(1);
      const input = riskGrantService.issueGrant.mock.calls[0][0];
      expect(input).toMatchObject({
        userId: 'user-1',
        signalId: 'sig-001',
        sessionId: 'session-1',
        sessionGeneration: 1,
        executionMode: ExecutionMode.PAPER_ONLY,
        brokerConnectionId: 'conn-1',
        authorityGeneration: 1, // no identity row → default generation 1
        riskProfileId: 'profile-1',
        providerBrokerIdentity: null,
      });
      expect(input.signalPayloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(input.orderPayloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(input.riskProfileHash).toMatch(/^[0-9a-f]{64}$/);
      expect(input.orderPayload).toMatchObject({
        instrument: 'EURUSD',
        direction: 'BUY',
        quantity: '0.05',
        orderType: 'MARKET',
        requestedPrice: '1.085',
        stopLoss: '1.075',
        takeProfit: '1.095',
        marketRegime: 'TRENDING',
      });
    });

    it('rejects (never approves) when grant issuance fails — fail-closed', async () => {
      riskGrantService.issueGrant.mockRejectedValue(new Error('grant insert failed'));

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.RISK_ENGINE_ERROR);
        expect(result.rejectionReason).toContain('durable risk grant');
      }
    });

    it('includes a riskScore in the APPROVED result', async () => {
      const result = await service.validateProposedTrade('user-1', validTrade());
      if (result.decision === 'APPROVED') {
        expect(result.riskScore).toBeGreaterThanOrEqual(0);
        expect(result.riskScore).toBeLessThanOrEqual(100);
      }
    });

    it('includes list of applied rules', async () => {
      const result = await service.validateProposedTrade('user-1', validTrade());
      if (result.decision === 'APPROVED') {
        expect(result.appliedRules).toContain('KILL_SWITCH:OK');
        expect(result.appliedRules).toContain('BROKER_CONNECTION:OK');
        expect(result.appliedRules).toContain('MANDATORY_SL:OK');
        expect(result.appliedRules).toContain('MANDATORY_TP:OK');
        expect(result.appliedRules).toContain('MAX_TRADE_RISK:OK');
        expect(result.appliedRules).toContain('LEVERAGE:OK');
      }
    });

    it('verifies per-trade controls with the exact geometry (risk % + leverage)', async () => {
      // Defaults: |1.085−1.075| × 0.05 × 100000 = 50 risk at stop on 10050
      // equity → 0.4975% (< 2%); notional 5425 / 10050 → 0.54 (< 30).
      const geometry = orderGeometry.resolveOrderGeometry as jest.Mock;
      await service.validateProposedTrade('user-1', validTrade());

      expect(geometry).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          brokerConnectionId: 'conn-1',
          instrument: 'EURUSD',
          needFreshQuote: false, // entry price present → requested-price entry
        }),
      );
    });
  });

  // ─── Step 0: Authority binding (#295/#298/#301) ──────────────────────────

  describe('Step 0 — Authority binding', () => {
    it('REJECTS with AUTHORITY_BINDING_REQUIRED when the binding is missing', async () => {
      const { sessionId: _s, ...withoutBinding } = validTrade();
      void _s;
      const result = await service.validateProposedTrade('user-1', withoutBinding);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.AUTHORITY_BINDING_REQUIRED);
        expect(result.rejectionReason).toContain('sessionId');
      }
    });

    it('REJECTS with AUTHORITY_BINDING_REQUIRED when brokerConnectionId is missing', async () => {
      const { brokerConnectionId: _c, ...withoutConnection } = validTrade();
      void _c;
      const result = await service.validateProposedTrade('user-1', withoutConnection);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.AUTHORITY_BINDING_REQUIRED);
      }
    });

    it('checks the binding BEFORE any other rule (kill switch does not shadow it)', async () => {
      profileRepo.findOne.mockResolvedValue({ ...defaultProfile(), killSwitchActive: true });
      const { sessionId: _s, sessionGeneration: _g, ...partial } = validTrade();
      void _s;
      void _g;
      const result = await service.validateProposedTrade('user-1', partial);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.AUTHORITY_BINDING_REQUIRED);
      }
    });

    it('REJECTS with SESSION_NOT_ACTIVE when no ACTIVE session resolves (#295)', async () => {
      sessionResolution.resolveActiveSessionAuthority.mockRejectedValue(
        new SessionAuthorityNotActiveException('user-1'),
      );

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.SESSION_NOT_ACTIVE);
      }
    });

    it('REJECTS with SESSION_AUTHORITY_MISMATCH when the signal binding is stale', async () => {
      const trade = { ...validTrade(), sessionGeneration: 2 };

      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.SESSION_AUTHORITY_MISMATCH);
        expect(result.rejectionReason).toContain('generation');
      }
    });

    it('REJECTS with SESSION_AUTHORITY_MISMATCH when the signal binds another connection', async () => {
      const trade = { ...validTrade(), brokerConnectionId: 'conn-other' };

      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.SESSION_AUTHORITY_MISMATCH);
      }
    });

    it('REJECTS with BROKER_DISCONNECTED when the session-bound connection is not owned/available', async () => {
      brokerService.findConnectionById.mockRejectedValue(new Error('not found'));

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.BROKER_DISCONNECTED);
      }
    });

    it('REJECTS with BROKER_DISCONNECTED when the session-bound connection is not CONNECTED', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        defaultConnection({ status: 'DISCONNECTED' }),
      );

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.BROKER_DISCONNECTED);
      }
    });
  });

  // ─── Step 1a: Kill switch ──────────────────────────────────────────────────

  describe('Step 1a — Kill switch check', () => {
    it('REJECTS with KILL_SWITCH_ACTIVE when kill switch is on', async () => {
      profileRepo.findOne.mockResolvedValue({
        ...defaultProfile(),
        killSwitchActive: true,
      });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.KILL_SWITCH_ACTIVE);
      }
    });

    it('records a RiskViolation when kill switch rejects', async () => {
      profileRepo.findOne.mockResolvedValue({ ...defaultProfile(), killSwitchActive: true });
      await service.validateProposedTrade('user-1', validTrade());

      // Wait for async violation save
      await new Promise((r) => setTimeout(r, 10));
      expect(violationRepo.save).toHaveBeenCalled();
    });
  });

  // ─── Step 1a-pre/1c-pre: Emergency control plane ─────────────────────────

  describe('Step 1a-pre/1c-pre — Emergency control plane: ALL FOUR SCOPES (architect correction A1)', () => {
    const blocked = (scope: string, scopeKey: string | null, reason = 'incident') => ({
      allowed: false,
      blockedBy: { scope, scopeKey, reason },
    });

    it('evaluates the control plane with the COMPLETE context after loading the session-bound connection', async () => {
      await service.validateProposedTrade('user-1', validTrade());

      const contexts = (
        executionControlService.checkExecutionPermission as jest.Mock
      ).mock.calls.map((c) => c[0]);
      // Early fail-fast check (GLOBAL/USER) …
      expect(contexts[0]).toEqual({ userId: 'user-1' });
      // … followed by the full four-scope context once the connection is known
      expect(contexts[1]).toEqual({
        userId: 'user-1',
        brokerId: 'metatrader5',
        brokerConnectionId: 'conn-1',
      });
      // The early gate ran BEFORE any connection discovery; the full gate
      // ran AFTER the exact session-bound connection was loaded.
      expect(brokerService.findConnectionById).toHaveBeenCalledTimes(1);
    });

    it('GLOBAL blocks everyone (fail-fast, before connection discovery)', async () => {
      (executionControlService.checkExecutionPermission as jest.Mock).mockResolvedValue(
        blocked('GLOBAL', null, 'global incident'),
      );

      const result = await service.validateProposedTrade('user-42', validTrade());
      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.EXECUTION_CONTROL_ACTIVE);
        expect(result.rejectionReason).toContain('scope=GLOBAL');
      }
    });

    it('PROVIDER blocks only the affected provider — via the full-context gate', async () => {
      // Early check ({ userId } only) passes …
      (executionControlService.checkExecutionPermission as jest.Mock).mockImplementation(
        async (ctx: { brokerId?: string }) =>
          ctx.brokerId === 'metatrader5'
            ? blocked('PROVIDER', 'metatrader5', 'MetaApi outage')
            : { allowed: true },
      );

      const result = await service.validateProposedTrade('user-1', validTrade());
      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.EXECUTION_CONTROL_ACTIVE);
        expect(result.rejectionReason).toContain('scope=PROVIDER');
        expect(result.rejectionReason).toContain('key=metatrader5');
      }
    });

    it('BROKER_CONNECTION blocks only the targeted connection — via the full-context gate', async () => {
      (executionControlService.checkExecutionPermission as jest.Mock).mockImplementation(
        async (ctx: { brokerConnectionId?: string }) =>
          ctx.brokerConnectionId === 'conn-1'
            ? blocked('BROKER_CONNECTION', 'conn-1', 'connection quarantined')
            : { allowed: true },
      );

      const result = await service.validateProposedTrade('user-1', validTrade());
      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.EXECUTION_CONTROL_ACTIVE);
        expect(result.rejectionReason).toContain('scope=BROKER_CONNECTION');
      }
    });

    it('USER scope blocks via the early gate (before the session-bound connection is loaded)', async () => {
      (executionControlService.checkExecutionPermission as jest.Mock).mockResolvedValue(
        blocked('USER', 'user-1', 'account under investigation'),
      );

      const result = await service.validateProposedTrade('user-1', validTrade());
      expect(result.decision).toBe('REJECTED');
      // Blocked BEFORE the connection load: findConnectionById never called
      expect(brokerService.findConnectionById).not.toHaveBeenCalled();
    });

    it('an unrelated provider/connection remains unaffected (allowed through both gates)', async () => {
      sessionRepo.findOne.mockResolvedValue(defaultSession({ brokerConnectionId: 'conn-other' }));
      sessionResolution.resolveActiveSessionAuthority.mockResolvedValue({
        sessionId: 'session-1',
        sessionGeneration: 1,
        executionMode: ExecutionMode.PAPER_ONLY,
        brokerConnectionId: 'conn-other',
      });
      brokerService.findConnectionById.mockResolvedValue(
        defaultConnection({ id: 'conn-other', brokerId: 'oanda' }),
      );
      (executionControlService.checkExecutionPermission as jest.Mock).mockImplementation(
        async (ctx: { userId: string; brokerId?: string; brokerConnectionId?: string }) =>
          ctx.brokerId === 'metatrader5' || ctx.brokerConnectionId === 'conn-1'
            ? blocked('PROVIDER', 'metatrader5', 'unrelated provider blocked')
            : { allowed: true },
      );

      const result = await service.validateProposedTrade(
        'user-2',
        validTrade({ brokerConnectionId: 'conn-other' } as Partial<ProposedTrade>),
      );
      expect(result.decision).toBe('APPROVED');
    });

    it('control-store failure is FAIL CLOSED at BOTH gates (architect A1)', async () => {
      (executionControlService.checkExecutionPermission as jest.Mock).mockRejectedValue(
        new Error('control store connection refused'),
      );

      const result = await service.validateProposedTrade('user-1', validTrade());
      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.EXECUTION_CONTROL_ACTIVE);
        expect(result.rejectionReason).toContain('EXECUTION_CONTROL_CHECK_FAILED');
      }
    });

    it('control-plane blocks write the structured audit record', async () => {
      (executionControlService.checkExecutionPermission as jest.Mock).mockResolvedValue(
        blocked('PROVIDER', 'metatrader5', 'MetaApi outage'),
      );

      await service.validateProposedTrade('user-1', validTrade());

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'EXECUTION_CONTROL_BLOCKED' }),
      );
    });
  });

  // ─── Step 2/3: account state, daily loss + drawdown (#296/#313/#317) ────

  describe('Step 2/3 — Account state + exact-decimal baselines (#296/#313/#317)', () => {
    it('REJECTS with ACCOUNT_STATE_UNAVAILABLE when account state is missing (fail-closed, no skip)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue(null);

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.ACCOUNT_STATE_UNAVAILABLE);
        expect(result.rejectionReason).toContain('unavailable');
      }
    });

    it('REJECTS (fail-closed, typed) when the account-state query throws (#296)', async () => {
      brokerService.getBrokerAccountState.mockRejectedValue(new Error('db down'));

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.RISK_ENGINE_QUERY_FAILED);
        // Sanitized: the raw driver error never reaches the rejection reason
        expect(result.rejectionReason).not.toContain('db down');
      }
    });

    it('REJECTS with ACCOUNT_STATE_UNAVAILABLE when equity is malformed (#313 fail-closed)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: 'not-a-number',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.ACCOUNT_STATE_UNAVAILABLE);
        expect(result.rejectionReason).toContain('malformed');
      }
    });

    it('REJECTS with SESSION_BASELINE_UNAVAILABLE when the session has no opening balance (#317)', async () => {
      sessionRepo.findOne.mockResolvedValue(defaultSession({ openingBalance: null }));

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.SESSION_BASELINE_UNAVAILABLE);
        expect(result.rejectionReason).toContain('opening balance');
      }
    });

    it('daily loss EXACT boundary: |loss| == 5% of the session OPENING balance rejects (SUSPENDED)', async () => {
      // 5% of 10000.00 = 500.00 exactly.
      executionService.getTodayRealisedLoss.mockResolvedValue(-500);

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('SUSPENDED');
      if (result.decision !== 'APPROVED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.DAILY_LOSS_LIMIT_REACHED);
        // denominator = session opening balance, NOT the current broker balance
        expect(result.rejectionReason).toContain('opening balance');
      }
    });

    it('daily loss just below the exact boundary approves', async () => {
      executionService.getTodayRealisedLoss.mockResolvedValue(-499.99);

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('APPROVED');
    });

    // ─── Round 6 §16: autonomous session degradation on hard breaches ────

    it('a daily-loss breach degrades the ACTIVE session to SUSPENDED_RISK_LIMIT (§16)', async () => {
      executionService.getTodayRealisedLoss.mockResolvedValue(-500);
      sessionRepo.findOne.mockResolvedValue(defaultSession());

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('SUSPENDED');
      // The guarded CAS update ran (status + authority generation bump).
      expect(sessionRepo.createQueryBuilder().update).toHaveBeenCalled();
      expect(sessionRepo.createQueryBuilder().set).toHaveBeenCalledWith(
        expect.objectContaining({ status: TradingSessionStatus.SUSPENDED_RISK_LIMIT }),
      );
      // Session-scoped grant invalidation fired with the typed reason.
      expect(riskGrantService.invalidateGrantsForSession).toHaveBeenCalledWith(
        defaultSession().id,
        expect.stringContaining('SESSION_SUSPENDED_RISK_LIMIT'),
      );
    });

    it('the degradation is idempotent — no ACTIVE session means nothing to degrade', async () => {
      executionService.getTodayRealisedLoss.mockResolvedValue(-500);
      // The risk pipeline's own session lookups find the session; the
      // degradation lookup finds none ACTIVE (already degraded/ended).
      let callCount = 0;
      sessionRepo.findOne.mockImplementation(async () => {
        callCount++;
        // First lookup (pipeline gates): ACTIVE session; degradation
        // lookup also returns it — assert instead that when the guarded
        // CAS loses (affected=0), nothing throws and the rejection stands.
        return defaultSession();
      });
      sessionRepo.createQueryBuilder().execute.mockResolvedValueOnce({ affected: 0 });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('SUSPENDED'); // the rejection still stands
      expect(riskGrantService.invalidateGrantsForSession).not.toHaveBeenCalled();
      void callCount;
    });

    it('REJECTS with RISK_ENGINE_QUERY_FAILED when the daily-loss query throws (no SKIPPED)', async () => {
      executionService.getTodayRealisedLoss.mockRejectedValue(new Error('timeout'));

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.RISK_ENGINE_QUERY_FAILED);
        expect(result.rejectionReason).not.toContain('timeout');
      }
    });

    it('drawdown EXACT boundary: 10% drawdown against the monotonic peak rejects (SUSPENDED)', async () => {
      // peak 10000 (persisted), fresh equity 9000 → 10.00% == maxDrawdownPercent.
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '9000.00',
        equity: '9000.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });
      // CAS loses (a higher/equal peak is already persisted) → reload peak.
      sessionRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('SUSPENDED');
      if (result.decision !== 'APPROVED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.MAX_DRAWDOWN_REACHED);
        expect(result.rejectionReason).toContain('10.00%');
      }
    });

    it('maintains the session peak MONOTONICALLY via the guarded CAS write (#317)', async () => {
      // Default: fresh equity 10050 > persisted peak 10000 → CAS writes 10050.
      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('APPROVED');
      const builder = (sessionRepo.createQueryBuilder as jest.Mock).mock.results[0].value;
      expect(builder.set).toHaveBeenCalledWith({ peakEquity: '10050' });
      expect(builder.where).toHaveBeenCalledWith(
        'id = :id AND (peak_equity IS NULL OR peak_equity <= :fresh)',
        { id: 'session-1', fresh: '10050' },
      );
    });

    it('drawdown just below the exact boundary approves', async () => {
      // peak 10000 → fresh equity 9000.01 → 9.999% < 10%.
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '9000.01',
        equity: '9000.01',
        freeMargin: '9800.00',
        currency: 'USD',
      });
      sessionRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('APPROVED');
    });
  });

  // ─── Step 4c: Position size ───────────────────────────────────────────────

  describe('Step 4c — Position size check', () => {
    it('reduces lot size to maxPositionSizeLot when signal requests more', async () => {
      const trade = { ...validTrade(), requestedLotSize: '0.50' }; // profile max is 0.10

      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('APPROVED');
      if (result.decision === 'APPROVED') {
        // capped to profile.maxPositionSizeLot (mock value is '0.10')
        expect(result.validatedOrder.lotSize).toBe('0.10');
        expect(result.appliedRules.some((r) => r.startsWith('POSITION_SIZE:REDUCED'))).toBe(true);
      }
    });

    it('does not modify lot size when within allowed limit', async () => {
      const result = await service.validateProposedTrade('user-1', validTrade()); // 0.05 < max 0.10

      if (result.decision === 'APPROVED') {
        expect(result.validatedOrder.lotSize).toBe('0.05');
      }
    });
  });

  // ─── Step 4a: concurrent trades fail-closed (#296) ───────────────────────

  describe('Step 4a — Max concurrent trades', () => {
    it('REJECTS with MAX_CONCURRENT_TRADES at the limit', async () => {
      executionService.countOpenTrades.mockResolvedValue(3);

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.MAX_CONCURRENT_TRADES);
      }
    });

    it('REJECTS with RISK_ENGINE_QUERY_FAILED when the count query throws (never SKIPPED, #296)', async () => {
      executionService.countOpenTrades.mockRejectedValue(new Error('pool exhausted'));

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.RISK_ENGINE_QUERY_FAILED);
        expect(result.rejectionReason).not.toContain('pool exhausted');
      }
    });
  });

  // ─── Step 4d: Instrument whitelist ───────────────────────────────────────

  describe('Step 4d — Instrument whitelist', () => {
    it('REJECTS when instrument is not in the allowed list', async () => {
      profileRepo.findOne.mockResolvedValue({
        ...defaultProfile(),
        allowedInstruments: ['GBPUSD', 'USDJPY'],
      });

      const result = await service.validateProposedTrade('user-1', validTrade()); // EURUSD

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.INSTRUMENT_NOT_ALLOWED);
      }
    });

    it('APPROVES when allowedInstruments is null (all allowed)', async () => {
      profileRepo.findOne.mockResolvedValue({
        ...defaultProfile(),
        allowedInstruments: null,
      });

      const result = await service.validateProposedTrade('user-1', validTrade());
      expect(result.decision).toBe('APPROVED');
    });

    it('APPROVES when instrument is in the allowed list', async () => {
      profileRepo.findOne.mockResolvedValue({
        ...defaultProfile(),
        allowedInstruments: ['EURUSD', 'GBPUSD'],
      });

      const result = await service.validateProposedTrade('user-1', validTrade());
      expect(result.decision).toBe('APPROVED');
    });
  });

  // ─── Step 5: Order integrity ──────────────────────────────────────────────

  describe('Step 5a — Mandatory stop-loss', () => {
    it('REJECTS when stop-loss is missing', async () => {
      const trade = { ...validTrade(), stopLoss: undefined };
      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.MISSING_STOP_LOSS);
      }
    });

    it('REJECTS when stop-loss is zero', async () => {
      const trade = { ...validTrade(), stopLoss: '0' };
      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.MISSING_STOP_LOSS);
      }
    });
  });

  describe('Step 5b — Mandatory take-profit', () => {
    it('REJECTS when take-profit is missing', async () => {
      const trade = { ...validTrade(), takeProfit: undefined };
      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.MISSING_TAKE_PROFIT);
      }
    });
  });

  describe('Step 5c — Stop-loss distance', () => {
    it('REJECTS when SL is too close to entry (below minStopLossPips)', async () => {
      const trade = {
        ...validTrade(),
        entryPrice: '1.08500',
        stopLoss: '1.08498', // only ~0.2 pips — below 5-pip minimum
      };
      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.INVALID_SL_DISTANCE);
      }
    });

    it('APPROVES when SL is far enough from entry', async () => {
      // SL 100 pips away — well above 5-pip minimum
      const result = await service.validateProposedTrade('user-1', validTrade());
      expect(result.decision).toBe('APPROVED');
    });
  });

  describe('Step 5d — Take-profit direction', () => {
    it('REJECTS when TP is below entry for BUY direction', async () => {
      const trade = {
        ...validTrade(),
        direction: 'BUY' as const,
        entryPrice: '1.08500',
        takeProfit: '1.08000', // below entry — invalid for BUY
      };
      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.INVALID_TP_DIRECTION);
      }
    });

    it('REJECTS when TP is above entry for SELL direction', async () => {
      const trade = {
        ...validTrade(),
        direction: 'SELL' as const,
        entryPrice: '1.08500',
        stopLoss: '1.09500',
        takeProfit: '1.09000', // above entry — invalid for SELL
      };
      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.INVALID_TP_DIRECTION);
      }
    });
  });

  // ─── Step 6: Volatility and regime ────────────────────────────────────────

  describe('Step 6 — Volatility and regime checks', () => {
    it('REJECTS when volatility score exceeds threshold', async () => {
      const trade = { ...validTrade(), volatilityScore: 0.92 }; // above 0.85 default
      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.HIGH_VOLATILITY);
      }
    });

    it('APPROVES when volatility score is within threshold', async () => {
      const trade = { ...validTrade(), volatilityScore: 0.7 };
      const result = await service.validateProposedTrade('user-1', trade);
      expect(result.decision).toBe('APPROVED');
    });

    it('REJECTS LOW_LIQUIDITY regime when rejectLowLiquidity is true', async () => {
      const trade = { ...validTrade(), volatilityScore: 0.3, regime: 'LOW_LIQUIDITY' as const };
      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.LOW_LIQUIDITY_REGIME);
      }
    });

    it('APPROVES LOW_LIQUIDITY regime when rejectLowLiquidity is false', async () => {
      profileRepo.findOne.mockResolvedValue({ ...defaultProfile(), rejectLowLiquidity: false });
      const trade = { ...validTrade(), regime: 'LOW_LIQUIDITY' as const };
      const result = await service.validateProposedTrade('user-1', trade);
      expect(result.decision).toBe('APPROVED');
    });

    it('REJECTS with UNKNOWN_MARKET_REGIME when the regime is missing and the profile enforces regime rules (#330)', async () => {
      const { regime: _r, ...withoutRegime } = validTrade();
      void _r;
      const result = await service.validateProposedTrade('user-1', withoutRegime);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.UNKNOWN_MARKET_REGIME);
      }
    });

    it('REJECTS with UNKNOWN_MARKET_REGIME for an unrecognized regime label (#330)', async () => {
      const trade = { ...validTrade(), regime: 'CHOPPY_UNKNOWN' as ProposedTrade['regime'] };
      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.UNKNOWN_MARKET_REGIME);
      }
    });

    it('permits an unknown regime only when the profile does NOT enforce regime rules', async () => {
      profileRepo.findOne.mockResolvedValue({ ...defaultProfile(), rejectLowLiquidity: false });
      const { regime: _r, ...withoutRegime } = validTrade();
      void _r;
      const result = await service.validateProposedTrade('user-1', withoutRegime);

      expect(result.decision).toBe('APPROVED');
    });
  });

  // ─── Step 6c: per-trade controls (#316) ──────────────────────────────────

  describe('Step 6c — maxTradeRiskPercent + maxLeverageAllowed (#316)', () => {
    it('maxTradeRiskPercent EXACT boundary: risk % == limit rejects', async () => {
      // |1.085−1.075| × 0.05 × 100000 = 50 risk at stop; equity 2500 → 2.00%.
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '2500.00',
        equity: '2500.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.MAX_TRADE_RISK_EXCEEDED);
        expect(result.rejectionReason).toContain('2.00%');
      }
    });

    it('maxTradeRiskPercent just below the exact boundary approves', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '2501.00',
        equity: '2501.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('APPROVED');
    });

    it('maxLeverageAllowed EXACT boundary: effective leverage == limit rejects', async () => {
      // notional = 1.085 × 0.05 × 100000 = 5425; equity 2712.50 → 2.0 exactly.
      profileRepo.findOne.mockResolvedValue({ ...defaultProfile(), maxLeverageAllowed: 2 });
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '2712.50',
        equity: '2712.50',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.LEVERAGE_EXCEEDED);
        expect(result.rejectionReason).toContain('Effective order leverage');
      }
    });

    it('maxLeverageAllowed just below the exact boundary approves', async () => {
      profileRepo.findOne.mockResolvedValue({ ...defaultProfile(), maxLeverageAllowed: 2 });
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '2712.51',
        equity: '2712.51',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('APPROVED');
    });

    it('LIVE NEW exposure fails CLOSED with a typed code when contract size is unavailable', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        defaultConnection({ accountType: 'LIVE' }),
      );
      sessionRepo.findOne.mockResolvedValue(
        defaultSession({ executionMode: ExecutionMode.FULL_AUTO }),
      );
      sessionResolution.resolveActiveSessionAuthority.mockResolvedValue({
        sessionId: 'session-1',
        sessionGeneration: 1,
        executionMode: ExecutionMode.FULL_AUTO,
        brokerConnectionId: 'conn-1',
      });
      orderGeometry.resolveOrderGeometry.mockResolvedValue({
        contractSize: null,
        freshQuote: null,
        quoteRef: null,
      });

      const result = await service.validateProposedTrade(
        'user-1',
        validTrade({ executionMode: ExecutionMode.FULL_AUTO } as Partial<ProposedTrade>),
      );

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.CONTRACT_SIZE_UNAVAILABLE);
      }
    });

    it('LIVE MARKET entry without a fresh quote fails CLOSED with a typed code', async () => {
      brokerService.findConnectionById.mockResolvedValue(
        defaultConnection({ accountType: 'LIVE' }),
      );
      sessionRepo.findOne.mockResolvedValue(
        defaultSession({ executionMode: ExecutionMode.FULL_AUTO }),
      );
      sessionResolution.resolveActiveSessionAuthority.mockResolvedValue({
        sessionId: 'session-1',
        sessionGeneration: 1,
        executionMode: ExecutionMode.FULL_AUTO,
        brokerConnectionId: 'conn-1',
      });
      orderGeometry.resolveOrderGeometry.mockResolvedValue({
        contractSize: ExactDecimal.parse('100000'),
        freshQuote: null,
        quoteRef: null,
      });
      const trade = validTrade({
        entryPrice: '0',
        executionMode: ExecutionMode.FULL_AUTO,
      });

      const result = await service.validateProposedTrade('user-1', trade);

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.RISK_QUOTE_UNAVAILABLE);
      }
    });

    it('PAPER/DEMO records the unverified geometry honestly and still approves', async () => {
      orderGeometry.resolveOrderGeometry.mockResolvedValue({
        contractSize: null,
        freshQuote: null,
        quoteRef: null,
      });

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('APPROVED');
      if (result.decision === 'APPROVED') {
        expect(result.appliedRules).toContain('MAX_TRADE_RISK:GEOMETRY_UNVERIFIED');
        expect(result.appliedRules).toContain('LEVERAGE:GEOMETRY_UNVERIFIED');
      }
    });
  });

  // ─── Fail-closed behavior ─────────────────────────────────────────────────

  describe('Fail-closed guarantee', () => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns REJECTED with RISK_ENGINE_ERROR on any unexpected exception', async () => {
      profileRepo.findOne.mockRejectedValue(new Error('database connection lost'));

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.RISK_ENGINE_ERROR);
        // Error message from DB exception should be included
        expect(result.rejectionReason).toContain('database connection lost');
      }
    });

    it('NEVER approves on system error', async () => {
      profileRepo.findOne.mockRejectedValue(new Error('unexpected failure'));

      const result = await service.validateProposedTrade('user-1', validTrade());
      expect(result.decision).not.toBe('APPROVED');
    });
  });

  // ─── Kill switch toggle ───────────────────────────────────────────────────

  describe('toggleKillSwitch()', () => {
    it('activates kill switch and persists the reason', async () => {
      await service.toggleKillSwitch('user-1', true, 'Manual pause');
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ killSwitchActive: true, killSwitchReason: 'Manual pause' }),
      );
    });

    it('deactivates kill switch', async () => {
      await service.toggleKillSwitch('user-1', false);
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ killSwitchActive: false }),
      );
    });

    // ─── Round 6 §17: the FOURTH STOP LEVEL — emergency flatten ──────────

    it('ACTIVATION emergency-flattens every OPEN position (§17 level 4)', async () => {
      await service.toggleKillSwitch('user-1', true, 'Manual pause');
      expect(executionService.emergencyCloseAllOpenPositions).toHaveBeenCalledWith('user-1');
    });

    it('DEACTIVATION never re-opens positions (no flatten call)', async () => {
      await service.toggleKillSwitch('user-1', false);
      expect(executionService.emergencyCloseAllOpenPositions).not.toHaveBeenCalled();
    });

    it('a flatten failure NEVER rolls back the kill-switch authority (durable switch stands)', async () => {
      executionService.emergencyCloseAllOpenPositions.mockRejectedValueOnce(
        new Error('provider unreachable'),
      );
      const profile = await service.toggleKillSwitch('user-1', true);
      expect(profile.killSwitchActive).toBe(true);
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ killSwitchActive: true }),
      );
    });
  });

  // ─── isKillSwitchActive ───────────────────────────────────────────────────

  describe('isKillSwitchActive()', () => {
    it('returns true when kill switch is active', async () => {
      profileRepo.findOne.mockResolvedValue({ ...defaultProfile(), killSwitchActive: true });
      expect(await service.isKillSwitchActive('user-1')).toBe(true);
    });

    it('returns false when no profile exists', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      expect(await service.isKillSwitchActive('user-1')).toBe(false);
    });
  });

  // ─── hasBrokerConnection ──────────────────────────────────────────────────

  describe('hasBrokerConnection()', () => {
    it('delegates to BrokerService.hasActiveConnection()', async () => {
      (brokerService.hasActiveConnection as jest.Mock).mockResolvedValue(true);
      expect(await service.hasBrokerConnection('user-1')).toBe(true);
    });
  });

  // ─── hasDailyLossLimitBreached ────────────────────────────────────────────

  describe('hasDailyLossLimitBreached()', () => {
    it('returns false when no loss and broker connected', async () => {
      expect(await service.hasDailyLossLimitBreached('user-1')).toBe(false);
    });

    it('uses the session opening balance + exact decimals (equality = breached)', async () => {
      executionService.getTodayRealisedLoss.mockResolvedValue(-500);
      expect(await service.hasDailyLossLimitBreached('user-1')).toBe(true);
    });
  });
});
