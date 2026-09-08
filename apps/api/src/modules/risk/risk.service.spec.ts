import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RiskService } from './risk.service';
import { RiskProfile } from './entities/risk-profile.entity';
import { RiskViolation } from './entities/risk-violation.entity';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import { ProposedTrade, RiskRejectionCode } from './interfaces/risk.interface';
import { DomainEventBus } from '../events/event-bus.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const validTrade = (): ProposedTrade => ({
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
});

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

const mockBrokerService = () => ({
  hasActiveConnection: jest.fn().mockResolvedValue(true),
  findActiveConnectionForUser: jest.fn().mockResolvedValue({ id: 'conn-1' }),
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
});

// Sprint 50 — emergency control plane mock (default: execution allowed)
const mockExecutionControlService = () => ({
  checkExecutionPermission: jest.fn().mockResolvedValue({ allowed: true }),
  assertExecutionAllowed: jest.fn().mockResolvedValue(undefined),
  listActiveControls: jest.fn().mockResolvedValue([]),
});

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('RiskService', () => {
  let module: TestingModule;
  let service: RiskService;
  let profileRepo: ReturnType<typeof mockProfileRepo>;
  let violationRepo: ReturnType<typeof mockViolationRepo>;
  let brokerService: ReturnType<typeof mockBrokerService>;
  let executionControlService: ReturnType<typeof mockExecutionControlService>;
  let auditService: ReturnType<typeof mockAuditService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    module = await Test.createTestingModule({
      providers: [
        RiskService,
        { provide: getRepositoryToken(RiskProfile), useFactory: mockProfileRepo },
        { provide: getRepositoryToken(RiskViolation), useFactory: mockViolationRepo },
        { provide: BrokerService, useFactory: mockBrokerService },
        { provide: AuditService, useFactory: mockAuditService },
        { provide: ExecutionService, useFactory: mockExecutionService },
        { provide: ExecutionControlService, useFactory: mockExecutionControlService },
        {
          provide: DomainEventBus,
          useValue: { publish: jest.fn(), subscribe: jest.fn().mockReturnValue(() => {}) },
        },
      ],
    }).compile();

    service = module.get<RiskService>(RiskService);
    profileRepo = module.get(getRepositoryToken(RiskProfile));
    violationRepo = module.get(getRepositoryToken(RiskViolation));
    brokerService = module.get(BrokerService);
    executionControlService = module.get(ExecutionControlService);
    auditService = module.get(AuditService);
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
      }
    });
  });

  // ─── Step 1: Kill switch ──────────────────────────────────────────────────

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

  // ─── Step 1b: Broker connection ───────────────────────────────────────────

  describe('Step 1a-pre/1c-pre — Emergency control plane: ALL FOUR SCOPES (architect correction A1)', () => {
    beforeEach(() => {
      // The authoritative connection context used by the 1c-pre gate.
      (brokerService.findActiveConnectionForUser as jest.Mock).mockResolvedValue({
        id: 'conn-1',
        brokerId: 'metatrader5',
        accountType: 'DEMO',
      });
    });

    const blocked = (scope: string, scopeKey: string | null, reason = 'incident') => ({
      allowed: false,
      blockedBy: { scope, scopeKey, reason },
    });

    it('evaluates the control plane with the COMPLETE context after connection discovery', async () => {
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

    it('USER scope blocks via the early gate (before broker discovery)', async () => {
      (executionControlService.checkExecutionPermission as jest.Mock).mockResolvedValue(
        blocked('USER', 'user-1', 'account under investigation'),
      );

      const result = await service.validateProposedTrade('user-1', validTrade());
      expect(result.decision).toBe('REJECTED');
      // Blocked BEFORE broker discovery: findActiveConnectionForUser never called
      expect(brokerService.findActiveConnectionForUser).not.toHaveBeenCalled();
    });

    it('an unrelated provider/connection remains unaffected (allowed through both gates)', async () => {
      (brokerService.findActiveConnectionForUser as jest.Mock).mockResolvedValue({
        id: 'conn-other',
        brokerId: 'oanda',
        accountType: 'DEMO',
      });
      (executionControlService.checkExecutionPermission as jest.Mock).mockImplementation(
        async (ctx: { userId: string; brokerId?: string; brokerConnectionId?: string }) =>
          ctx.brokerId === 'metatrader5' || ctx.brokerConnectionId === 'conn-1'
            ? blocked('PROVIDER', 'metatrader5', 'unrelated provider blocked')
            : { allowed: true },
      );

      const result = await service.validateProposedTrade('user-2', validTrade());
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

  describe('Step 1b — Broker connection check', () => {
    it('REJECTS with BROKER_DISCONNECTED when no active broker', async () => {
      (brokerService.hasActiveConnection as jest.Mock).mockResolvedValue(false);

      const result = await service.validateProposedTrade('user-1', validTrade());

      expect(result.decision).toBe('REJECTED');
      if (result.decision === 'REJECTED') {
        expect(result.rejectionCode).toBe(RiskRejectionCode.BROKER_DISCONNECTED);
      }
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
        expect(parseFloat(result.validatedOrder.lotSize)).toBe(0.1);
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

  // ─── Step 6: Volatility ───────────────────────────────────────────────────

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
  });
});
